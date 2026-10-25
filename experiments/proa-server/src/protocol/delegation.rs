//! Delegated authority derives from current durable lifecycle facts on every request.
use super::{
    auth::ProjectPrincipal,
    error::ProtocolError,
    store::{records::Scope, Store},
    token::DelegationClaims,
};
use super::{
    js_postgres::PgText,
    js_value::{JsJson as J, JsString as S},
};
use serde_json::{json, Value};
#[path = "delegation_lifecycle.rs"]
mod lifecycle;
pub use lifecycle::{evaluate_delegation_facts, issuance_anchor};
#[derive(Clone, Debug)]
pub enum Principal {
    Project(ProjectPrincipal),
    Delegated(DelegationClaims),
    Internal { repo: S, user: S, via: Option<J> },
    Admin { user: S },
}
fn auth(status: u16, message: &str) -> ProtocolError {
    ProtocolError::new(status, "auth", message)
}
fn claims(c: &DelegationClaims) -> J {
    c.as_js_value()
}
impl Principal {
    pub fn repo(&self) -> Option<S> {
        match self {
            Self::Project(p) => Some(S::from(p.repo.as_str())),
            Self::Delegated(p) => Some(p.repo.clone()),
            Self::Internal { repo, .. } => Some(repo.clone()),
            Self::Admin { .. } => None,
        }
    }
    pub fn require_project(&self, repo: &str) -> Result<(), ProtocolError> {
        self.require_project_js(&S::from(repo))
    }
    pub fn require_project_js(&self, repo: &S) -> Result<(), ProtocolError> {
        if self.repo().is_some_and(|r| r != *repo) {
            Err(auth(403, "wrong project"))
        } else {
            Ok(())
        }
    }
    pub fn require_machine_access(&self) -> Result<(), ProtocolError> {
        if matches!(self, Self::Internal { .. }) {
            Err(auth(
                403,
                "internal operator credential may only access operator routes",
            ))
        } else {
            Ok(())
        }
    }
}
pub async fn registered(store: &Store, repo: &S) -> Result<bool, ProtocolError> {
    let connection = store.database.client().await?;
    let row = connection
        .query_opt(
            "SELECT action FROM project_journal WHERE repo = $1 ORDER BY seq DESC LIMIT 1",
            &[&PgText(repo)],
        )
        .await?;
    Ok(row.is_some_and(|r| r.get::<_, String>(0) == "added"))
}
async fn record_js(store: &Store, scope: Scope<'_>, id: &S) -> Result<J, ProtocolError> {
    let client = store.database.client().await?;
    let row = client
        .query_opt(
            &format!("SELECT * FROM {} WHERE {}=$1", scope.table(), scope.key()),
            &[&PgText(id)],
        )
        .await?;
    row.map(|row| super::store::records::record_lossless(&row, scope))
        .transpose()
        .map(|v| v.unwrap_or(J::Null))
}
pub async fn delegation_facts(store: &Store, c: &J) -> Result<J, ProtocolError> {
    let build = c["kind"].as_string().is_some_and(|s| {
        s.units()
            .starts_with(&"build".encode_utf16().collect::<Vec<_>>())
    });
    let scope = if build {
        Scope::Build("")
    } else {
        Scope::Repo("")
    };
    let id = c[if build { "id" } else { "repo" }]
        .as_string()
        .ok_or_else(ProtocolError::internal)?;
    let reducer = if build {
        "buildDelegation"
    } else {
        "harvestDelegation"
    };
    let resolved = super::reducer_values::resolve_lossless(
        scope,
        &J::from_serde(&json!({"reducer":reducer})),
    )?;
    let mut client = store.database.client().await?;
    let tx = client
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await?;
    if tx
        .query_opt(
            &format!("SELECT 1 FROM {} WHERE {}=$1", scope.table(), scope.key()),
            &[&PgText(id)],
        )
        .await?
        .is_none()
    {
        return Err(ProtocolError::new(500, "internal", "unknown reducer scope"));
    }
    let rows = tx
        .query(
            &format!(
                "SELECT * FROM {} WHERE {}=$1 ORDER BY seq",
                scope.events(),
                scope.event_key()
            ),
            &[&PgText(id)],
        )
        .await?;
    let events = rows
        .iter()
        .map(|row| super::store::events::event_record_lossless(row, scope))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, event) in events.iter().enumerate() {
        if event["seq"].as_i64() != Some(index as i64 + 1) {
            return Err(ProtocolError::new(
                500,
                "internal",
                "noncontiguous reducer log",
            ));
        }
    }
    let value = super::reducer_values::reduce_events_lossless(scope, &resolved, &events)?;
    tx.commit().await?;
    Ok(value)
}
pub async fn delegation_active(store: &Store, c: &J, now_ms: i64) -> Result<bool, ProtocolError> {
    if c["kind"].as_string().is_some_and(|s| {
        s.units()
            .starts_with(&"build".encode_utf16().collect::<Vec<_>>())
    }) {
        let id = c["id"].as_string().ok_or_else(ProtocolError::internal)?;
        let record = record_js(store, Scope::Build(""), id).await?;
        if record["repo"] != c["repo"] {
            return Ok(false);
        }
    }
    let facts = delegation_facts(store, c).await?;
    Ok(evaluate_delegation_facts(c, &facts, now_ms))
}
pub async fn authenticate_delegated(
    store: &Store,
    c: DelegationClaims,
    now_ms: i64,
) -> Result<Principal, ProtocolError> {
    if !registered(store, &c.repo).await? {
        return Err(auth(403, "project not registered"));
    }
    if !delegation_active(store, &claims(&c), now_ms).await? {
        return Err(auth(401, "delegated credential ended or unavailable"));
    }
    Ok(Principal::Delegated(c))
}
fn unavailable() -> ProtocolError {
    ProtocolError::new(
        404,
        "not-found",
        "resource unavailable: unknown resource or wrong project",
    )
}
/// Run before parsing mutation bodies. Scope=None means collection/admin.
pub async fn authorize_resource(
    store: &Store,
    p: &Principal,
    scope: Option<Scope<'_>>,
    method: &str,
) -> Result<(), ProtocolError> {
    p.require_machine_access()?;
    if matches!(p, Principal::Admin { .. }) {
        return Ok(());
    }
    let Some(scope) = scope else {
        if matches!(p, Principal::Delegated(_)) && method != "GET" {
            return Err(auth(
                403,
                "delegated credential cannot administer repositories",
            ));
        }
        return Ok(());
    };
    let repo = if matches!(scope, Scope::Repo(_)) {
        S::from(scope.id())
    } else {
        let record = store.get_record_lossless(scope).await?;
        let repo = record["repo"].as_string().ok_or_else(unavailable)?;
        if p.repo().is_none_or(|r| r != *repo) {
            return Err(unavailable());
        }
        repo.clone()
    };
    p.require_project_js(&repo)
}
/// Early delegated write gate. `true` requires cloned raw JSON and the later
/// mutation classifier; `false` completes authorization without reading a body.
pub fn mutation_needs_body(
    p: &Principal,
    scope: Scope<'_>,
    method: &str,
    path: &[String],
    raw_path: &str,
) -> Result<bool, ProtocolError> {
    let Principal::Delegated(c) = p else {
        return Ok(false);
    };
    let g = claims(c);
    let kind = c.kind.as_str();
    let value_read = method == "POST"
        && raw_path.ends_with("/reducer-values")
        && !matches!(scope, Scope::Session(_));
    if matches!(scope, Scope::Build(_))
        && method != "GET"
        && !value_read
        && (!kind.starts_with("build") || g["id"] != scope.id())
    {
        return Err(auth(403, "write outside delegated build"));
    }
    if matches!(scope, Scope::Build(_)) && path.get(2).is_some_and(|s| s == "node-writer") {
        return Err(auth(
            403,
            "delegated executions cannot acquire node writer authority",
        ));
    }
    if method == "GET"
        || (method == "POST"
            && raw_path.ends_with("/reducer-values")
            && !matches!(scope, Scope::Session(_)))
    {
        return Ok(false);
    }
    if matches!(scope, Scope::Build(_)) {
        return if kind.starts_with("build") && g["id"] == scope.id() {
            Ok(false)
        } else {
            Err(auth(403, "write outside delegated build"))
        };
    }
    let build_repo_exception = matches!(scope, Scope::Repo(_))
        && kind.starts_with("build")
        && method == "POST"
        && raw_path.split('/').skip(3).collect::<Vec<_>>().join("/") == "events";
    if build_repo_exception || (matches!(scope, Scope::Repo(_)) && kind.starts_with("harvest")) {
        Ok(true)
    } else {
        Err(auth(403, "write outside delegated resource"))
    }
}
/// Path is decoded nonempty URL segments. Body is raw parsed JSON from clone,
/// not catalog-validated. Call only after resource authorization. Route code
/// must call this BEFORE generic readBody except enforce_via below.
pub async fn authorize_mutation(
    store: &Store,
    p: &Principal,
    scope: Scope<'_>,
    method: &str,
    path: &[String],
    raw_path: &str,
    body: &Value,
) -> Result<(), ProtocolError> {
    authorize_mutation_js(
        store,
        p,
        scope,
        method,
        path,
        raw_path,
        &J::from_serde(body),
    )
    .await
}
pub async fn authorize_mutation_js(
    store: &Store,
    p: &Principal,
    scope: Scope<'_>,
    method: &str,
    path: &[String],
    raw_path: &str,
    body: &J,
) -> Result<(), ProtocolError> {
    if !mutation_needs_body(p, scope, method, path, raw_path)? {
        return Ok(());
    }
    let Principal::Delegated(c) = p else {
        return Ok(());
    };
    let g = claims(c);
    let kind = c.kind.as_str();
    if matches!(scope, Scope::Build(_)) && path.get(2).is_some_and(|s| s == "node-writer") {
        return Err(auth(
            403,
            "delegated executions cannot acquire node writer authority",
        ));
    }
    if method == "GET"
        || (method == "POST"
            && raw_path.ends_with("/reducer-values")
            && !matches!(scope, Scope::Session(_)))
    {
        return Ok(());
    }
    if matches!(scope, Scope::Build(_)) {
        return if kind.starts_with("build") && g["id"] == scope.id() {
            Ok(())
        } else {
            Err(auth(403, "write outside delegated build"))
        };
    }
    let rest = path
        .iter()
        .skip(2)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("/");
    if matches!(scope, Scope::Repo(_))
        && kind.starts_with("build")
        && method == "POST"
        && raw_path.split('/').skip(3).collect::<Vec<_>>().join("/") == "events"
        && super::validation::lossless::validate_request("eventWrite", body).is_ok()
        && body["actor"]["kind"] == "kernel"
        && body["type"] == "dispatcher.forge-degraded"
    {
        return Ok(());
    }
    if !matches!(scope, Scope::Repo(_)) || !kind.starts_with("harvest") {
        return Err(auth(403, "write outside delegated resource"));
    }
    let deny = || auth(403, "write outside delegated harvest run");
    if body.is_null() {
        let field = match rest.as_str() {
            "lease/heartbeat" | "lease/claim" if kind == "harvest-runner" => Some("holder"),
            "artifacts" => Some("metadata"),
            "streams" => Some("label"),
            "events/conditional" | "deposits" => Some("event"),
            _ => None,
        };
        if let Some(field) = field {
            return Err(ProtocolError::new(
                500,
                "internal",
                format!("null is not an object (evaluating 'body.{field}')"),
            ));
        }
    }

    if rest == "lease/heartbeat" || rest == "lease/claim" {
        return if kind == "harvest-runner" && body["holder"] == g["leaseHolder"] {
            Ok(())
        } else {
            Err(deny())
        };
    }
    let owns = |label: &S| {
        let mut prefix = S::from("harvest:").0;
        prefix.extend_from_slice(c.id.units());
        prefix.push(58);
        if let Some(execution) = &c.execution {
            prefix.extend_from_slice(execution.units())
        }
        prefix.push(58);
        if let Some(session) = &c.session {
            prefix.extend("session:".encode_utf16());
            prefix.extend_from_slice(session.units());
            label.units() == prefix
        } else {
            label.units().starts_with(&prefix)
        }
    };
    if path.first().is_some_and(|s| s == "streams") || rest.starts_with("streams") {
        if path.len() == 3 && path.first().is_some_and(|s| s == "repos") {
            return if body["label"].as_string().is_some_and(owns) {
                Ok(())
            } else {
                Err(deny())
            };
        }
        let id = if path.first().is_some_and(|s| s == "streams") {
            path.get(1)
        } else {
            path.get(3)
        }
        .map(String::as_str)
        .unwrap_or("");
        let record = store.get_stream(id).await?;
        return if record["label"]
            .as_str()
            .map(S::from)
            .as_ref()
            .is_some_and(owns)
        {
            Ok(())
        } else {
            Err(deny())
        };
    }
    let artifact_ok = |a: &J| {
        a["metadata"]["run"] == g["id"]
            && a["kind"].as_string().is_some_and(|k| {
                [
                    "harvest-proposals",
                    "harvest-review",
                    "harvest-report",
                    "harvest-transcript",
                ]
                .iter()
                .any(|name| k.eq_str(name))
            })
    };
    if rest == "artifacts" {
        return if artifact_ok(body) {
            Ok(())
        } else {
            Err(deny())
        };
    }
    if !["events", "events/conditional", "deposits"].contains(&rest.as_str()) {
        return Err(deny());
    }
    let event = if rest == "events" {
        body
    } else {
        &body["event"]
    };
    if event
        .get("type")
        .is_some_and(|t| !t.is_null() && !t.is_string())
    {
        return Err(ProtocolError::new(500,"internal","event?.type?.startsWith is not a function. (In 'event?.type?.startsWith(\"harvest.\")', 'event?.type?.startsWith' is undefined)"));
    }
    let empty = S::default();
    let t = event["type"].as_string().unwrap_or(&empty);
    if rest == "events"
        && t.eq_ascii("harvest.execution.ended")
        && kind == "harvest-runner"
        && event["payload"]["run"] == g["id"]
        && event["payload"]["execution"] == g["execution"]
    {
        return Ok(());
    }
    if !t
        .units()
        .starts_with(&"harvest.".encode_utf16().collect::<Vec<_>>())
        || event["payload"]["run"] != g["id"]
        || [
            "harvest.started",
            "harvest.resumed",
            "harvest.recovery-requested",
            "harvest.recovery-exhausted",
            "harvest.execution.started",
            "harvest.execution.released",
            "harvest.execution.authorized",
            "harvest.execution.ended",
        ]
        .iter()
        .any(|name| t.eq_str(name))
    {
        return Err(deny());
    }
    if g["session"].as_string().is_some()
        && event["payload"]["session"]
            .as_string()
            .is_some_and(|s| !s.is_empty() && g["session"].as_string() != Some(s))
    {
        return Err(deny());
    }
    enforce_via_js(p, &event["actor"])?;
    if rest == "deposits" {
        match body.get("artifacts") {
            Some(J::Array(items)) => {
                for artifact in items {
                    if artifact.is_null() {
                        return Err(ProtocolError::new(
                            500,
                            "internal",
                            "null is not an object (evaluating 'artifact.metadata')",
                        ));
                    }
                    if !artifact_ok(artifact) {
                        return Err(deny());
                    }
                }
            }
            Some(J::String(text)) if text.is_empty() => (),
            Some(J::String(_)) => return Err(deny()),
            value => {
                let message = match value {
                    None => "undefined is not an object (evaluating 'artifact of body.artifacts')",
                    Some(J::Null) => {
                        "null is not an object (evaluating 'artifact of body.artifacts')"
                    }
                    Some(J::Bool(true)) => "true is not iterable",
                    Some(J::Bool(false)) => "false is not iterable",
                    Some(J::Number(_)) => "number is not iterable",
                    _ => "{} is not iterable",
                };
                return Err(ProtocolError::new(500, "internal", message));
            }
        }
    }

    Ok(())
}
pub fn enforce_via_js(p: &Principal, actor: &J) -> Result<J, ProtocolError> {
    if let Principal::Delegated(c) = p {
        if let Some(session) = &c.session {
            if actor["kind"] == "agent" && actor["session"].as_string() != Some(session) {
                return Err(auth(403, "wrong delegated session"));
            }
        }
    }
    let via = if let Principal::Internal { via, .. } = p {
        via.as_ref()
    } else {
        None
    };
    if actor["kind"] != "human" {
        return Ok(actor.clone());
    }
    if actor.get("via").is_some() && via.is_none() {
        return Err(auth(
            403,
            "token carries no via; it may not write delegated events",
        ));
    }
    if let Some(via) = via {
        if let Some(candidate) = actor.get("via") {
            let candidate_json = candidate.stringify();
            let via_json = via.stringify();
            if candidate_json != via_json {
                return Err(auth(403,&format!("token carries via {via_json}; it may not write events claiming via {candidate_json}")));
            }
        }
        let mut actor = actor.clone();
        actor["via"] = via.clone();
        return Ok(actor);
    }
    Ok(actor.clone())
}
pub fn enforce_via(p: &Principal, actor: &Value) -> Result<Value, ProtocolError> {
    enforce_via_js(p, &J::from_serde(actor))?
        .to_serde_checked()
        .map_err(|_| ProtocolError::internal())
}

/// Body already validated strictly by crypto agent target schema. Returns claims
/// Value for conversion/mint, and deliberately rechecks active facts at end.
pub async fn issue_claims(
    store: &Store,
    p: &Principal,
    target: &J,
    now_ms: i64,
) -> Result<J, ProtocolError> {
    let kind = target["kind"]
        .as_string()
        .and_then(|s| s.to_scalar().ok())
        .ok_or_else(ProtocolError::internal)?;
    let id = target["id"]
        .as_string()
        .ok_or_else(ProtocolError::internal)?;
    let build = if kind.starts_with("build") {
        record_js(store, Scope::Build(""), id).await?
    } else {
        J::Null
    };
    let repo = build["repo"]
        .as_string()
        .cloned()
        .or_else(|| target["repo"].as_string().cloned())
        .ok_or_else(|| auth(404, "resource unavailable"))?;
    p.require_project_js(&repo)?;
    if matches!(p, Principal::Internal { .. }) {
        return Err(auth(
            403,
            "operator authority cannot delegate machine credentials",
        ));
    }
    let parent = if let Principal::Delegated(c) = p {
        Some(claims(c))
    } else {
        None
    };
    if let Some(parent) = &parent {
        let pk = parent["kind"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .ok_or_else(ProtocolError::internal)?;
        if !pk.ends_with("-runner")
            || !kind.ends_with("-phase")
            || parent["id"] != target["id"]
            || pk.split('-').next() != kind.split('-').next()
        {
            return Err(auth(403, "delegation cannot widen authority"));
        }
    }
    if target.get("leaseHolder").is_some() {
        let record = record_js(store, Scope::Repo(""), &repo).await?;
        if record["lease"]["holder"] != target["leaseHolder"] {
            return Err(auth(
                403,
                "harvest holder does not own the repository lease",
            ));
        }
    }
    let execution = target["execution"]
        .as_string()
        .or_else(|| parent.as_ref().and_then(|p| p["execution"].as_string()));
    let mut c = J::Object(vec![
        (S::from("repo"), J::String(repo)),
        (S::from("kind"), J::String(S::from(kind))),
        (S::from("id"), J::String(id.clone())),
    ]);
    let facts = delegation_facts(store, &c).await?;
    let anchor = issuance_anchor(target, &facts, execution);
    if parent
        .as_ref()
        .is_some_and(|p| anchor.is_some_and(|a| a < p["anchor"].as_i64().unwrap_or(0)))
    {
        return Err(auth(403, "session predates runner authority"));
    }
    c["anchor"] =
        J::Number(anchor.ok_or_else(|| auth(404, "lifecycle binding unavailable"))? as f64);
    if let Some(execution) = execution {
        if !execution.is_empty() {
            c["execution"] = J::String(execution.clone())
        }
    }
    for field in ["session", "leaseHolder"] {
        if let Some(v) = target.get(field) {
            c[field] = v.clone()
        }
    }
    if !delegation_active(store, &c, now_ms).await? {
        return Err(auth(403, "lifecycle binding ended"));
    }
    Ok(c)
}

/// Request.clone().json() authority checks expose JSON errors as internal failures.
pub fn parse_authority_body(bytes: &[u8]) -> Result<Value, ProtocolError> {
    super::js_json::parse_js_json(bytes).map_err(|e| {
        let text = String::from_utf8_lossy(bytes);
        let raw = text.trim();
        let message = e.to_string();
        let detail = if raw
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .ends_with(",]")
        {
            "Unexpected comma at the end of array expression".to_string()
        } else if message.starts_with("EOF while parsing an object") {
            "Expected '}'".to_string()
        } else if message.starts_with("EOF while parsing a string") {
            "Unterminated string".to_string()
        } else if message.starts_with("EOF") {
            "Unexpected EOF".to_string()
        } else if message.starts_with("expected `:`") {
            "Expected ':' before value in object property definition".to_string()
        } else if message.starts_with("trailing comma") && raw.ends_with(']') {
            "Unexpected comma at the end of array expression".to_string()
        } else if message.starts_with("key must be a string")
            || message.starts_with("trailing comma")
        {
            if raw.contains(',') {
                "Property name must be a string literal".to_string()
            } else {
                "Expected '}'".to_string()
            }
        } else if message.starts_with("trailing characters") {
            "Unable to parse JSON string".to_string()
        } else {
            let col = e.column().saturating_sub(1).min(text.len());
            let bytes = text.as_bytes();
            let mut start = col;
            while start > 0 && bytes[start - 1].is_ascii_alphabetic() {
                start -= 1
            }
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_alphabetic() {
                end += 1
            }
            if end > start {
                format!("Unexpected identifier \"{}\"", &text[start..end])
            } else if let Some(c) = text.get(col..).and_then(|s| s.chars().next()) {
                format!("Unexpected token '{c}'")
            } else {
                "Unable to parse JSON string".to_string()
            }
        };
        ProtocolError::new(500, "internal", format!("JSON Parse error: {detail}"))
    })
}

/// Lossless Request.clone().json() with the existing Bun SyntaxError contract.
pub fn parse_authority_body_js(bytes: &[u8]) -> Result<J, ProtocolError> {
    match super::js_value::parse_http(bytes) {
        Ok(value) => Ok(value),
        Err(_) => {
            let decoded = super::js_value::decode_http_utf8(bytes);
            let diagnostic = super::js_value::grammar_diagnostic_text(&decoded);
            match parse_authority_body(diagnostic.as_bytes()) {
                Err(error) => Err(error),
                Ok(_) => Err(ProtocolError::new(
                    500,
                    "internal",
                    "JSON Parse error: Unable to parse JSON string",
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actor_identity_and_injected_via_preserve_original_units() {
        let scope = super::super::js_value::parse(
            br#"{"repo":"repo","kind":"build-phase","id":"build","anchor":1,"session":"\ud800"}"#,
        )
        .unwrap();
        let principal = Principal::Delegated(
            super::super::token::parse_delegation_claims_lossless(&scope).unwrap(),
        );
        let actor =
            super::super::js_value::parse(br#"{"kind":"agent","role":"plan","session":"\ud800"}"#)
                .unwrap();
        assert_eq!(enforce_via_js(&principal, &actor).unwrap(), actor);
        let mut replacement = actor;
        replacement["session"] = J::String(S::from("�"));
        assert_eq!(
            enforce_via_js(&principal, &replacement)
                .unwrap_err()
                .status
                .as_u16(),
            403
        );
        let via = super::super::js_value::parse(br#"{"kind":"session","id":"\ud800"}"#).unwrap();
        let principal = Principal::Internal {
            repo: S::from("repo"),
            user: S::from("operator"),
            via: Some(via.clone()),
        };
        let actor = J::from_serde(&json!({"kind":"human","user":"operator"}));
        let injected = enforce_via_js(&principal, &actor).unwrap();
        assert_eq!(injected["via"], via);
        assert!(injected.to_serde_checked().is_err());
        let mut alternate = actor;
        alternate["via"] =
            super::super::js_value::parse(br#"{"id":"\ud800","kind":"session"}"#).unwrap();
        assert_eq!(
            enforce_via_js(&principal, &alternate)
                .unwrap_err()
                .status
                .as_u16(),
            403
        );
    }
    #[test]
    fn authority_parser_keeps_strings_but_preserves_source_syntax_errors() {
        let parsed = parse_authority_body_js(br#"{"ignored":"\ud800"}"#).unwrap();
        assert_eq!(parsed["ignored"].as_string().unwrap().units(), &[0xd800]);
        assert_eq!(
            parse_authority_body_js(b"\xef\xbb\xbf\"\xff\"").unwrap(),
            J::String(S::from("�"))
        );
        for raw in [b"{".as_slice(), b"[, ]", b"{\"a\" 1}", b"\"unterminated"] {
            let a = parse_authority_body(raw).unwrap_err();
            let b = parse_authority_body_js(raw).unwrap_err();
            assert_eq!(a.status, b.status);
            assert_eq!(a.kind, b.kind);
            assert_eq!(a.error, b.error);
        }
    }
}
