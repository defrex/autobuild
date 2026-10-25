//! Delegated authority derives from current durable lifecycle facts on every request.
use super::{
    auth::ProjectPrincipal,
    error::ProtocolError,
    store::{records::Scope, Store},
    token::DelegationClaims,
};
use serde_json::{json, Value};
#[path = "delegation_lifecycle.rs"]
mod lifecycle;
pub use lifecycle::{evaluate_delegation_facts, issuance_anchor};
#[derive(Clone, Debug)]
pub enum Principal {
    Project(ProjectPrincipal),
    Delegated(DelegationClaims),
    Internal {
        repo: String,
        user: String,
        via: Option<Value>,
    },
    Admin {
        user: String,
    },
}
fn auth(status: u16, message: &str) -> ProtocolError {
    ProtocolError::new(status, "auth", message)
}
fn claims(c: &DelegationClaims) -> Value {
    serde_json::to_value(c).expect("plain claims")
}
impl Principal {
    pub fn repo(&self) -> Option<&str> {
        match self {
            Self::Project(p) => Some(&p.repo),
            Self::Delegated(p) => Some(&p.repo),
            Self::Internal { repo, .. } => Some(repo),
            Self::Admin { .. } => None,
        }
    }
    pub fn require_project(&self, repo: &str) -> Result<(), ProtocolError> {
        if self.repo().is_some_and(|r| r != repo) {
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
pub async fn registered(store: &Store, repo: &str) -> Result<bool, ProtocolError> {
    let connection = store.database.client().await?;
    let row = connection
        .query_opt(
            "SELECT action FROM project_journal WHERE repo = $1 ORDER BY seq DESC LIMIT 1",
            &[&repo],
        )
        .await?;
    Ok(row.is_some_and(|r| r.get::<_, String>(0) == "added"))
}
pub async fn delegation_facts(store: &Store, c: &Value) -> Result<Value, ProtocolError> {
    let scope = if c["kind"].as_str().unwrap_or("").starts_with("build") {
        Scope::Build(c["id"].as_str().unwrap_or(""))
    } else {
        Scope::Repo(c["repo"].as_str().unwrap_or(""))
    };
    let reducer = if matches!(scope, Scope::Build(_)) {
        "buildDelegation"
    } else {
        "harvestDelegation"
    };
    let answer = store
        .get_reducer_value(scope, &json!({"reducer":reducer}))
        .await
        .map_err(|error| {
            if error.status.as_u16() == 404 {
                ProtocolError::new(500, "internal", "unknown reducer scope")
            } else {
                error
            }
        })?;
    Ok(answer["value"].clone())
}
pub async fn delegation_active(
    store: &Store,
    c: &Value,
    now_ms: i64,
) -> Result<bool, ProtocolError> {
    if c["kind"].as_str().unwrap_or("").starts_with("build") {
        let record = store
            .get_record(Scope::Build(c["id"].as_str().unwrap_or("")))
            .await?;
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
        scope.id().to_owned()
    } else {
        let record = store.get_record(scope).await?;
        let repo = record["repo"].as_str().ok_or_else(unavailable)?;
        if Some(repo) != p.repo() {
            return Err(unavailable());
        }
        repo.to_owned()
    };
    p.require_project(&repo)
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
    let kind = g["kind"].as_str().unwrap_or("");
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
    if !mutation_needs_body(p, scope, method, path, raw_path)? {
        return Ok(());
    }
    let Principal::Delegated(c) = p else {
        return Ok(());
    };
    let g = claims(c);
    let kind = g["kind"].as_str().unwrap_or("");
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
        && super::validation::validate_request("eventWrite", body).is_ok()
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
    let owns = |label: &str| {
        let prefix = format!(
            "harvest:{}:{}:",
            g["id"].as_str().unwrap_or(""),
            g["execution"].as_str().unwrap_or("")
        );
        if let Some(session) = g["session"].as_str() {
            label == format!("{prefix}session:{session}")
        } else {
            label.starts_with(&prefix)
        }
    };
    if path.first().is_some_and(|s| s == "streams") || rest.starts_with("streams") {
        if path.len() == 3 && path.first().is_some_and(|s| s == "repos") {
            return if body["label"].as_str().is_some_and(owns) {
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
        return if record["label"].as_str().is_some_and(owns) {
            Ok(())
        } else {
            Err(deny())
        };
    }
    let artifact_ok = |a: &Value| {
        a["metadata"]["run"] == g["id"]
            && a["kind"].as_str().is_some_and(|k| {
                [
                    "harvest-proposals",
                    "harvest-review",
                    "harvest-report",
                    "harvest-transcript",
                ]
                .contains(&k)
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
    let t = event["type"].as_str().unwrap_or("");
    if rest == "events"
        && t == "harvest.execution.ended"
        && kind == "harvest-runner"
        && event["payload"]["run"] == g["id"]
        && event["payload"]["execution"] == g["execution"]
    {
        return Ok(());
    }
    if !t.starts_with("harvest.")
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
        .contains(&t)
    {
        return Err(deny());
    }
    if g["session"].as_str().is_some()
        && event["payload"]["session"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && g["session"] != s)
    {
        return Err(deny());
    }
    enforce_via(p, &event["actor"])?;
    if rest == "deposits" {
        match body.get("artifacts") {
            Some(Value::Array(items)) => {
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
            Some(Value::String(text)) if text.is_empty() => (),
            Some(Value::String(_)) => return Err(deny()),
            value => {
                let message = match value {
                    None => "undefined is not an object (evaluating 'artifact of body.artifacts')",
                    Some(Value::Null) => {
                        "null is not an object (evaluating 'artifact of body.artifacts')"
                    }
                    Some(Value::Bool(true)) => "true is not iterable",
                    Some(Value::Bool(false)) => "false is not iterable",
                    Some(Value::Number(_)) => "number is not iterable",
                    _ => "{} is not iterable",
                };
                return Err(ProtocolError::new(500, "internal", message));
            }
        }
    }

    Ok(())
}
pub fn enforce_via(p: &Principal, actor: &Value) -> Result<Value, ProtocolError> {
    if let Principal::Delegated(c) = p {
        let g = claims(c);
        if g["session"].as_str().is_some()
            && actor["kind"] == "agent"
            && actor["session"] != g["session"]
        {
            return Err(auth(403, "wrong delegated session"));
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
            // TypeScript compares JSON.stringify bytes, including key order.
            let candidate_json = candidate.to_string();
            let via_json = via.to_string();
            if candidate_json != via_json {
                return Err(auth(
                    403,
                    &format!(
                        "token carries via {via}; it may not write events claiming via {candidate}"
                    ),
                ));
            }
        }
        let mut actor = actor.clone();
        actor["via"] = via.clone();
        return Ok(actor);
    }
    Ok(actor.clone())
}
/// Body already validated strictly by crypto agent target schema. Returns claims
/// Value for conversion/mint, and deliberately rechecks active facts at end.
pub async fn issue_claims(
    store: &Store,
    p: &Principal,
    target: &Value,
    now_ms: i64,
) -> Result<Value, ProtocolError> {
    let kind = target["kind"].as_str().unwrap_or("");
    let id = target["id"].as_str().unwrap_or("");
    let build = if kind.starts_with("build") {
        store.get_record(Scope::Build(id)).await?
    } else {
        Value::Null
    };
    let repo = build["repo"]
        .as_str()
        .or_else(|| target["repo"].as_str())
        .ok_or_else(|| auth(404, "resource unavailable"))?;
    p.require_project(repo)?;
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
        let pk = parent["kind"].as_str().unwrap_or("");
        if !pk.ends_with("-runner")
            || !kind.ends_with("-phase")
            || parent["id"] != target["id"]
            || pk.split('-').next() != kind.split('-').next()
        {
            return Err(auth(403, "delegation cannot widen authority"));
        }
    }
    if target.get("leaseHolder").is_some() {
        let record = store.get_record(Scope::Repo(repo)).await?;
        if record["lease"]["holder"] != target["leaseHolder"] {
            return Err(auth(
                403,
                "harvest holder does not own the repository lease",
            ));
        }
    }
    let execution = target["execution"]
        .as_str()
        .or_else(|| parent.as_ref().and_then(|p| p["execution"].as_str()));
    let mut c = json!({"repo":repo,"kind":kind,"id":id});
    let facts = delegation_facts(store, &c).await?;
    let anchor = issuance_anchor(target, &facts, execution);
    if parent
        .as_ref()
        .is_some_and(|p| anchor.is_some_and(|a| a < p["anchor"].as_i64().unwrap_or(0)))
    {
        return Err(auth(403, "session predates runner authority"));
    }
    c["anchor"] = json!(anchor.ok_or_else(|| auth(404, "lifecycle binding unavailable"))?);
    if let Some(execution) = execution {
        if !execution.is_empty() {
            c["execution"] = json!(execution)
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
