//! Machine credentials are not browser cookies. The backend is called afresh on
//! every request: implementations must never cache registration or revocation.
use super::{error::OperatorError, protocol};
use axum::http::HeaderMap;
use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig},
    Engine,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin};

type HmacSha256 = Hmac<Sha256>;
pub const RETIRED_CREDENTIAL_MESSAGE: &str = "credential format changed; obtain a project credential from the owner using ab-hosted-store credentials issue REPOSITORY --user IDENTITY";
pub type AuthFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, OperatorError>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credential {
    pub repo: String,
    pub user: String,
    pub purpose: String,
}
pub trait AuthBackend: Send + Sync {
    /// Authenticate the stored SHA-256 digest, expiry, revocation and fresh
    /// project registration; update last use with the adapter's 60s throttle.
    /// A removed project is an auth 403, not an absent credential.
    fn credential<'a>(&'a self, token: &'a str, now_ms: i64) -> AuthFuture<'a, Option<Credential>>;
    fn project_registered<'a>(&'a self, repo: &'a str) -> AuthFuture<'a, bool>;
    /// Validate durable anchor/session/execution facts with terminal grace.
    fn delegation_active<'a>(&'a self, claims: &'a Delegation, now_ms: i64)
        -> AuthFuture<'a, bool>;
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delegation {
    pub repo: String,
    pub kind: String,
    pub id: String,
    pub anchor: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<String>,
    #[serde(rename = "leaseHolder", skip_serializing_if = "Option::is_none")]
    pub lease_holder: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Principal {
    Project {
        repo: String,
        user: String,
        purpose: String,
    },
    Internal {
        repo: String,
        user: String,
        via: Option<Value>,
    },
    Admin {
        user: String,
    },
    Delegated {
        claims: Delegation,
    },
}
impl Principal {
    pub fn user(&self) -> &str {
        match self {
            Self::Project { user, .. } | Self::Internal { user, .. } | Self::Admin { user } => user,
            Self::Delegated { .. } => "delegated",
        }
    }
    pub fn via(&self) -> Option<&Value> {
        match self {
            Self::Internal { via, .. } => via.as_ref(),
            _ => None,
        }
    }
    pub fn require_project(&self, repo: &str) -> Result<(), OperatorError> {
        let bound = match self {
            Self::Project { repo, .. } | Self::Internal { repo, .. } => Some(repo.as_str()),
            Self::Delegated { claims } => Some(claims.repo.as_str()),
            Self::Admin { .. } => None,
        };
        if bound.is_some_and(|bound| bound != repo) {
            Err(OperatorError::auth(403, "wrong project"))
        } else {
            Ok(())
        }
    }
    pub fn require_operator(&self) -> Result<(), OperatorError> {
        match self {
            Self::Delegated { .. } => Err(OperatorError::auth(
                403,
                "delegated credentials may not access operator operations",
            )),
            Self::Project { purpose, .. } if purpose == "dispatcher" => Err(OperatorError::auth(
                403,
                "dispatcher credential may not access operator operations",
            )),
            _ => Ok(()),
        }
    }
    pub fn actor(&self) -> Value {
        let mut actor = serde_json::json!({"kind":"human","user":self.user()});
        if let Some(via) = self.via() {
            actor["via"] = via.clone();
        }
        actor
    }
}

/// Strict opaque format. Secret text is hashed as ASCII hex, not decoded bytes.
/// Do not log either the input or the parsed id/digest.
pub fn parse_project_token(token: &str) -> Option<(&str, [u8; 32])> {
    let rest = token.strip_prefix("abp_1_")?;
    let (id, secret) = rest.split_once('_')?;
    if id.len() != 32
        || secret.len() != 64
        || !id
            .bytes()
            .chain(secret.bytes())
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
    {
        return None;
    }
    Some((id, Sha256::digest(secret.as_bytes()).into()))
}
pub fn digest_matches(expected_hex: &str, actual: &[u8; 32]) -> bool {
    let mut expected = [0u8; 32];
    if expected_hex.len() != 64 {
        return false;
    }
    for (index, pair) in expected_hex
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .enumerate()
    {
        let digit = |v: u8| match v {
            b'0'..=b'9' => Some(v - b'0'),
            b'a'..=b'f' => Some(v - b'a' + 10),
            b'A'..=b'F' => Some(v - b'A' + 10),
            _ => None,
        };
        let Some(high) = digit(pair[0]) else {
            return false;
        };
        let Some(low) = digit(pair[1]) else {
            return false;
        };
        expected[index] = high * 16 + low;
    }
    // hmac verification uses a constant-time equality primitive. A fixed public
    // key keeps the digest comparison independent of secret byte position.
    let mut a = HmacSha256::new_from_slice(b"credential-digest-compare").expect("valid key");
    a.update(&expected);
    let mut b = HmacSha256::new_from_slice(b"credential-digest-compare").expect("valid key");
    b.update(actual);
    a.verify_slice(&b.finalize().into_bytes()).is_ok()
}

#[derive(Debug, Clone, PartialEq)]
pub enum SignedScope {
    Internal {
        repo: String,
        user: String,
        via: Option<Value>,
    },
    Admin {
        user: String,
    },
    Delegated(Delegation),
    Retired,
}
fn exact(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|o| {
        required.iter().all(|key| o.contains_key(*key))
            && o.keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}
// ECMAScript String.trim / RegExp \s differ from Rust Unicode whitespace
// (notably BOM is whitespace in JS; NEXT LINE is not).
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn identity(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty() && s != "*")
}
fn integer(value: &Value) -> Option<i64> {
    let value = value.as_f64()?;
    (value.is_finite()
        && value.fract() == 0.0
        && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&value))
    .then_some(value as i64)
}
fn via(value: &Value) -> bool {
    match value["kind"].as_str() {
        Some("session") => exact(value, &["kind", "id"], &[]) && nonempty(&value["id"]),
        Some("mcp") => exact(value, &["kind", "client"], &[]) && nonempty(&value["client"]),
        _ => false,
    }
}
fn optional_via(value: &Value) -> bool {
    value.get("via").is_none_or(via)
}
fn base64url(value: &str) -> Option<Vec<u8>> {
    // Buffer.from(..., 'base64url') accepts the standard alphabet, whitespace,
    // omitted padding, and noncanonical trailing bits. Mirror that decoder.
    let clean: String = value
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            '-' => Some('+'),
            '_' => Some('/'),
            c if c.is_ascii_alphanumeric() || c == '+' || c == '/' => Some(c),
            _ => None,
        })
        .collect();
    GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(clean)
    .ok()
}
pub fn verify_token(secret: &str, token: &str, now_ms: i64) -> Option<SignedScope> {
    let mut parts = token.split('.');
    let payload = parts.next()?;
    let signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let signature = base64url(signature)?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;
    let bytes = base64url(payload)?;
    // Node replaces malformed UTF-8 before JSON.parse.
    let raw: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    if integer(&raw["version"]) == Some(2) && exact(&raw, &["version", "delegation"], &[]) {
        let d = &raw["delegation"];
        if !exact(
            d,
            &["repo", "kind", "id", "anchor"],
            &["session", "execution", "leaseHolder"],
        ) || !identity(&d["repo"])
            || !identity(&d["id"])
        {
            return None;
        }
        let kind = d["kind"].as_str()?;
        if ![
            "build-runner",
            "build-phase",
            "harvest-runner",
            "harvest-phase",
        ]
        .contains(&kind)
            || !integer(&d["anchor"]).is_some_and(|a| a > 0)
        {
            return None;
        }
        for field in ["session", "execution", "leaseHolder"] {
            if d.get(field).is_some_and(|v| !identity(v)) {
                return None;
            }
        }
        if kind.ends_with("-phase") != d.get("session").is_some()
            || kind.starts_with("harvest") != d.get("execution").is_some()
        {
            return None;
        }
        return Some(SignedScope::Delegated(Delegation {
            repo: d["repo"].as_str()?.into(),
            kind: kind.into(),
            id: d["id"].as_str()?.into(),
            anchor: integer(&d["anchor"])?,
            session: d["session"].as_str().map(str::to_owned),
            execution: d["execution"].as_str().map(str::to_owned),
            lease_holder: d["leaseHolder"].as_str().map(str::to_owned),
        }));
    }
    if integer(&raw["exp"])? <= now_ms {
        return None;
    }
    if integer(&raw["version"]) == Some(1)
        && exact(&raw, &["version", "internalOperator", "exp"], &["via"])
        && exact(&raw["internalOperator"], &["user", "repo"], &[])
        && nonempty(&raw["internalOperator"]["repo"])
        && optional_via(&raw)
    {
        let user = raw["internalOperator"]["user"]
            .as_str()?
            .trim_matches(js_space);
        if user.is_empty() {
            return None;
        }
        return Some(SignedScope::Internal {
            repo: raw["internalOperator"]["repo"].as_str()?.into(),
            user: user.into(),
            via: raw.get("via").cloned(),
        });
    }
    if integer(&raw["version"]) == Some(1)
        && exact(&raw, &["version", "ownerAdmin", "exp"], &[])
        && exact(&raw["ownerAdmin"], &["user"], &[])
    {
        let user = raw["ownerAdmin"]["user"].as_str()?.trim_matches(js_space);
        if user.is_empty() {
            return None;
        }
        return Some(SignedScope::Admin { user: user.into() });
    }
    let common = nonempty(&raw["session"]);
    let legacy_build =
        exact(&raw, &["build", "session", "exp"], &[]) && nonempty(&raw["build"]) && common;
    let resource = exact(&raw, &["resource", "session", "exp"], &["via"])
        && exact(&raw["resource"], &["kind", "id"], &[])
        && matches!(
            raw["resource"]["kind"].as_str(),
            Some("build" | "repo" | "session")
        )
        && nonempty(&raw["resource"]["id"])
        && common
        && optional_via(&raw);
    let operator = exact(&raw, &["operator", "exp"], &["via"])
        && exact(&raw["operator"], &["user"], &[])
        && raw["operator"]["user"]
            .as_str()
            .is_some_and(|user| !user.trim_matches(js_space).is_empty())
        && optional_via(&raw);
    let deployment =
        exact(&raw, &["operator", "session", "exp"], &[]) && raw["operator"] == true && common;
    (legacy_build || resource || operator || deployment).then_some(SignedScope::Retired)
}

pub async fn authenticate(
    headers: &HeaderMap,
    secret: &str,
    now_ms: i64,
    backend: &dyn AuthBackend,
) -> Result<Principal, OperatorError> {
    let authorization = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    // /^Bearer\s+(.+)$/i: whitespace is required after the scheme, and token
    // bytes (including trailing spaces) are otherwise not trimmed.
    let token = authorization
        .get(..6)
        .filter(|s| s.eq_ignore_ascii_case("bearer"))
        .and_then(|_| authorization.get(6..))
        .and_then(|rest| {
            rest.chars()
                .next()
                .filter(|c| js_space(*c))
                .map(|_| rest.trim_start_matches(js_space))
        })
        .filter(|token| !token.is_empty());
    let Some(token) = token else {
        return Err(OperatorError::auth(401, "missing bearer credential"));
    };
    if token.starts_with("abp_") {
        let credential = backend
            .credential(token, now_ms)
            .await?
            .ok_or_else(|| OperatorError::auth(401, "unknown or revoked credential"))?;
        return Ok(Principal::Project {
            repo: credential.repo,
            user: credential.user,
            purpose: credential.purpose,
        });
    }
    match verify_token(secret, token, now_ms) {
        Some(SignedScope::Admin { user }) => Ok(Principal::Admin { user }),
        Some(SignedScope::Internal { repo, user, via }) => {
            if !backend.project_registered(&repo).await? {
                return Err(OperatorError::auth(403, "project not registered"));
            }
            Ok(Principal::Internal { repo, user, via })
        }
        Some(SignedScope::Delegated(claims)) => {
            if !backend.project_registered(&claims.repo).await? {
                return Err(OperatorError::auth(403, "project not registered"));
            }
            if !backend.delegation_active(&claims, now_ms).await? {
                return Err(OperatorError::auth(
                    401,
                    "delegated credential ended or unavailable",
                ));
            }
            Ok(Principal::Delegated { claims })
        }
        _ => Err(OperatorError::auth(401, RETIRED_CREDENTIAL_MESSAGE)),
    }
}
/// Call before parsing operation bodies or performing resource lookups. For an
/// admin only, registration of the path project is additionally required.
pub async fn authenticate_operator(
    headers: &HeaderMap,
    repo: &str,
    secret: &str,
    now_ms: i64,
    backend: &dyn AuthBackend,
) -> Result<Principal, OperatorError> {
    protocol::check_identity(headers)?;
    let principal = authenticate(headers, secret, now_ms, backend).await?;
    principal.require_operator()?;
    principal.require_project(repo)?;
    if matches!(principal, Principal::Admin { .. }) && !backend.project_registered(repo).await? {
        return Err(OperatorError::auth(403, "project not registered"));
    }
    Ok(principal)
}

pub const DELEGATION_TERMINAL_GRACE_MS: i64 = 60_000;
/// Pure counterpart of evaluateDelegationFacts. The supplied facts must be
/// produced from the authoritative, contiguous log in the same repository.
/// Build ownership is checked by the caller before supplying build facts.
pub fn evaluate_delegation_facts(claims: &Delegation, facts: &Value, now_ms: i64) -> bool {
    let Some(last) = integer(&facts["lastSeq"]) else {
        return false;
    };
    if claims.anchor < 1 || claims.anchor > last {
        return false;
    }
    let key = |id: &str| format!("id:{id}");
    let mut endings: Vec<&Value> = Vec::new();
    if facts.get("terminals").is_some() {
        let session = claims
            .session
            .as_ref()
            .and_then(|id| facts["sessions"].get(key(id)));
        if claims.session.is_some()
            && !session
                .and_then(|s| s["starts"].as_array())
                .is_some_and(|starts| starts.iter().any(|s| integer(s) == Some(claims.anchor)))
        {
            return false;
        }
        let Some(terminals) = facts["terminals"].as_array() else {
            return false;
        };
        for ending in terminals.iter().chain(
            session
                .and_then(|s| s["endings"].as_array())
                .into_iter()
                .flatten(),
        ) {
            if integer(&ending["seq"]).is_some_and(|seq| seq >= claims.anchor) {
                endings.push(&ending["at"]);
            }
        }
        if !terminals.is_empty() && endings.is_empty() {
            return false;
        }
    } else {
        let Some(execution) = claims.execution.as_ref() else {
            return false;
        };
        let run_key = key(&claims.id);
        let execution_key = key(execution);
        let Some(authorized) = facts["authorizations"][&run_key].get(&execution_key) else {
            return false;
        };
        let Some(authorized_seq) = integer(&authorized["seq"]) else {
            return false;
        };
        if facts["runs"][&run_key] != true {
            return false;
        }
        if claims.kind == "harvest-runner"
            && (claims.anchor != authorized_seq
                || claims.lease_holder.as_deref() != authorized["leaseHolder"].as_str())
        {
            return false;
        }
        let session = claims
            .session
            .as_ref()
            .and_then(|id| facts["sessions"][&run_key].get(key(id)));
        if claims.session.is_some()
            && (!session
                .and_then(|s| s["starts"].as_array())
                .is_some_and(|starts| starts.iter().any(|s| integer(s) == Some(claims.anchor)))
                || session.is_some_and(|s| s["suspended"] == true))
        {
            return false;
        }
        endings.extend(
            facts["releases"][&execution_key]
                .as_array()
                .into_iter()
                .flatten(),
        );
        for ending in facts["endings"][&run_key]
            .as_array()
            .into_iter()
            .flatten()
            .chain(
                session
                    .and_then(|s| s["endings"].as_array())
                    .into_iter()
                    .flatten(),
            )
        {
            if integer(&ending["seq"]).is_some_and(|seq| seq >= authorized_seq) {
                endings.push(&ending["at"]);
            }
        }
    }
    endings.into_iter().all(|at| {
        at.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|at| {
                now_ms
                    < at.timestamp_millis()
                        .saturating_add(DELEGATION_TERMINAL_GRACE_MS)
            })
    })
}
/// Delegating runner authority to a phase must preserve resource/family and may
/// not authorize a session that started before the runner's durable anchor.
pub fn require_narrowing(
    parent: &Delegation,
    target_kind: &str,
    target_id: &str,
    anchor: Option<i64>,
) -> Result<(), OperatorError> {
    if !parent.kind.ends_with("-runner")
        || !target_kind.ends_with("-phase")
        || parent.id != target_id
        || parent.kind.split('-').next() != target_kind.split('-').next()
    {
        return Err(OperatorError::auth(
            403,
            "delegation cannot widen authority",
        ));
    }
    if anchor.is_some_and(|anchor| anchor < parent.anchor) {
        return Err(OperatorError::auth(
            403,
            "session predates runner authority",
        ));
    }
    Ok(())
}

/// Database adapter joining the separate writer and SELECT-only reader. It
/// rereads lifecycle events for every grant check, never a process-local lease.
pub struct NativeAuth<'a> {
    pub writer: &'a crate::data::writer::PostgresWriter,
    pub reader: &'a crate::data::reader::DataReader,
}
fn write_error(error: crate::data::writer::WriteError) -> OperatorError {
    match error {
        crate::data::writer::WriteError::ProjectNotRegistered => {
            OperatorError::auth(403, "project not registered")
        }
        _ => OperatorError::internal(),
    }
}
impl AuthBackend for NativeAuth<'_> {
    fn credential<'a>(&'a self, token: &'a str, now_ms: i64) -> AuthFuture<'a, Option<Credential>> {
        Box::pin(async move {
            let now = chrono::DateTime::from_timestamp_millis(now_ms)
                .ok_or_else(OperatorError::internal)?;
            self.writer
                .authenticate_credential(token, now)
                .await
                .map_err(write_error)?
                .map(|value| {
                    Ok(Credential {
                        repo: value["repo"]
                            .as_str()
                            .ok_or_else(OperatorError::internal)?
                            .into(),
                        user: value["createdBy"]
                            .as_str()
                            .ok_or_else(OperatorError::internal)?
                            .into(),
                        purpose: value["purpose"]
                            .as_str()
                            .ok_or_else(OperatorError::internal)?
                            .into(),
                    })
                })
                .transpose()
        })
    }
    fn project_registered<'a>(&'a self, repo: &'a str) -> AuthFuture<'a, bool> {
        Box::pin(async move {
            self.writer
                .project_registered(repo)
                .await
                .map_err(write_error)
        })
    }
    fn delegation_active<'a>(
        &'a self,
        claims: &'a Delegation,
        now_ms: i64,
    ) -> AuthFuture<'a, bool> {
        Box::pin(async move {
            use crate::data::{error::DataError, postgres::Scope};
            let scope = if claims.kind.starts_with("build") {
                Scope::Build(&claims.id)
            } else {
                Scope::Repository
            };
            // Scoped SQL hides foreign builds before reading their logs.
            let events = match self.reader.postgres().events(&claims.repo, scope, 0).await {
                Ok(events) => events,
                Err(DataError::MissingScope { .. }) => return Ok(false),
                Err(_) => return Err(OperatorError::internal()),
            };
            let facts = delegation_facts_from_events(claims.kind.starts_with("build"), &events)?;
            Ok(evaluate_delegation_facts(claims, &facts, now_ms))
        })
    }
}
/// The same compact lifecycle reduction used by core/kernel/service-facts.ts.
/// Sequence continuity is required because integer anchors rely on it.
pub fn delegation_facts_from_events(build: bool, events: &[Value]) -> Result<Value, OperatorError> {
    use serde_json::json;
    let mut facts = if build {
        json!({"lastSeq":0,"sessions":{},"terminals":[]})
    } else {
        json!({"lastSeq":0,"runs":{},"sessions":{},"authorizations":{},"releases":{},"endings":{}})
    };
    for (index, event) in events.iter().enumerate() {
        let seq = integer(&event["seq"]).ok_or_else(OperatorError::internal)?;
        if seq != index as i64 + 1 {
            return Err(OperatorError::internal());
        }
        facts["lastSeq"] = json!(seq);
        let kind = event["type"].as_str().ok_or_else(OperatorError::internal)?;
        let relevant = if build {
            matches!(
                kind,
                "session.started" | "session.ended" | "build.completed" | "build.aborted"
            )
        } else {
            matches!(
                kind,
                "harvest.started"
                    | "harvest.execution.authorized"
                    | "harvest.session.started"
                    | "harvest.session.ended"
                    | "harvest.session.suspended"
                    | "harvest.execution.released"
                    | "harvest.execution.ended"
                    | "harvest.completed"
                    | "harvest.escalated"
                    | "harvest.recovery-exhausted"
                    | "harvest.failed"
            )
        };
        // service-facts ignores unrelated events, including future advisory
        // vocabulary. Such events still advance the contiguous anchor range.
        if !relevant {
            continue;
        }
        let event = crate::data::events::decode(
            if build {
                crate::data::reducers::Scope::Build
            } else {
                crate::data::reducers::Scope::Repository
            },
            event,
        )
        .map_err(|_| OperatorError::internal())?;
        let payload = &event["payload"];
        let key = |field: &str| {
            payload[field]
                .as_str()
                .map(|id| format!("id:{id}"))
                .ok_or_else(OperatorError::internal)
        };
        let ending = json!({"seq":seq,"at":event["ts"]});
        if build {
            match kind {
                "session.started" | "session.ended" => {
                    let key = key("session")?;
                    let session = facts["sessions"]
                        .as_object_mut()
                        .unwrap()
                        .entry(key)
                        .or_insert_with(|| json!({"starts":[],"endings":[]}));
                    if kind == "session.started" {
                        session["starts"].as_array_mut().unwrap().push(json!(seq));
                    } else {
                        session["endings"].as_array_mut().unwrap().push(ending);
                    }
                }
                "build.completed" | "build.aborted" => {
                    facts["terminals"].as_array_mut().unwrap().push(ending)
                }
                _ => {}
            }
            continue;
        }
        match kind {
            "harvest.started" => {
                facts["runs"][key("run")?] = json!(true);
            }
            "harvest.execution.authorized" => {
                let run = facts["authorizations"]
                    .as_object_mut()
                    .unwrap()
                    .entry(key("run")?)
                    .or_insert_with(|| json!({}));
                run.as_object_mut()
                    .unwrap()
                    .entry(key("execution")?)
                    .or_insert_with(|| json!({"seq":seq,"leaseHolder":payload["leaseHolder"]}));
            }
            "harvest.session.started" | "harvest.session.ended" | "harvest.session.suspended" => {
                let run = facts["sessions"]
                    .as_object_mut()
                    .unwrap()
                    .entry(key("run")?)
                    .or_insert_with(|| json!({}));
                let session = run
                    .as_object_mut()
                    .unwrap()
                    .entry(key("session")?)
                    .or_insert_with(|| json!({"starts":[],"endings":[]}));
                if kind == "harvest.session.started" {
                    session["starts"].as_array_mut().unwrap().push(json!(seq));
                } else {
                    session["endings"].as_array_mut().unwrap().push(ending);
                    if kind == "harvest.session.suspended" {
                        session["suspended"] = json!(true);
                    }
                }
            }
            "harvest.execution.released" | "harvest.execution.ended" => {
                facts["releases"]
                    .as_object_mut()
                    .unwrap()
                    .entry(key("execution")?)
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap()
                    .push(event["ts"].clone());
            }
            "harvest.completed"
            | "harvest.escalated"
            | "harvest.recovery-exhausted"
            | "harvest.failed"
                if kind != "harvest.failed" || payload["willRetry"] != true =>
            {
                facts["endings"]
                    .as_object_mut()
                    .unwrap()
                    .entry(key("run")?)
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap()
                    .push(ending);
            }
            _ => {}
        }
    }
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    const REPO: &str = "https://github.com/acme/app";
    const INTERNAL:&str="eyJ2ZXJzaW9uIjoxLCJpbnRlcm5hbE9wZXJhdG9yIjp7InVzZXIiOiIgT3BlcmF0b3JARXhhbXBsZS5jb20gIiwicmVwbyI6Imh0dHBzOi8vZ2l0aHViLmNvbS9hY21lL2FwcCJ9LCJleHAiOjIwMDAsInZpYSI6eyJraW5kIjoibWNwIiwiY2xpZW50IjoidGVzdC1jbGllbnQifX0.6v707o2Oh6RkrLCI8lnkH0HGHDxWyQ_XXeR304p8axM";
    fn mint(raw: Value) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.to_string());
        let mut mac = HmacSha256::new_from_slice(b"test-secret").unwrap();
        mac.update(payload.as_bytes());
        format!(
            "{payload}.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }
    fn claims(kind: &str) -> Delegation {
        Delegation {
            repo: REPO.into(),
            kind: kind.into(),
            id: "build".into(),
            anchor: 1,
            session: None,
            execution: None,
            lease_holder: None,
        }
    }
    struct Backend {
        registered: AtomicBool,
        credential_live: AtomicBool,
        active: AtomicBool,
        calls: AtomicUsize,
    }
    impl Backend {
        fn new() -> Self {
            Self {
                registered: AtomicBool::new(true),
                credential_live: AtomicBool::new(true),
                active: AtomicBool::new(true),
                calls: AtomicUsize::new(0),
            }
        }
    }
    impl AuthBackend for Backend {
        fn credential<'a>(&'a self, _: &'a str, _: i64) -> AuthFuture<'a, Option<Credential>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(self
                    .credential_live
                    .load(Ordering::SeqCst)
                    .then(|| Credential {
                        repo: REPO.into(),
                        user: "owner".into(),
                        purpose: "project-owner".into(),
                    }))
            })
        }
        fn project_registered<'a>(&'a self, _: &'a str) -> AuthFuture<'a, bool> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(self.registered.load(Ordering::SeqCst))
            })
        }
        fn delegation_active<'a>(&'a self, _: &'a Delegation, _: i64) -> AuthFuture<'a, bool> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(self.active.load(Ordering::SeqCst))
            })
        }
    }
    fn headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        headers.insert(
            protocol::VERSION_HEADER,
            protocol::service_version().parse().unwrap(),
        );
        headers.insert(protocol::PROTOCOL_HEADER, "5".parse().unwrap());
        headers
    }
    #[test]
    fn verifies_actual_typescript_token_and_preserves_attribution() {
        assert_eq!(
            verify_token("test-secret", INTERNAL, 1000),
            Some(SignedScope::Internal {
                repo: REPO.into(),
                user: "Operator@Example.com".into(),
                via: Some(json!({"kind":"mcp","client":"test-client"}))
            })
        );
        assert_eq!(verify_token("test-secret", INTERNAL, 2000), None);
        assert_eq!(verify_token("wrong-secret", INTERNAL, 1000), None);
        assert_eq!(
            verify_token("test-secret", &format!("{INTERNAL}x"), 1000),
            None
        );
        let token = mint(json!({"version":1,"ownerAdmin":{"user":" owner "},"exp":2000.0}));
        assert_eq!(
            verify_token("test-secret", &token, 1000),
            Some(SignedScope::Admin {
                user: "owner".into()
            })
        );
        for raw in [
            json!({"version":1,"ownerAdmin":{"user":" "},"exp":2000}),
            json!({"version":1,"ownerAdmin":{"user":"owner"},"exp":2000,"via":{"kind":"mcp","client":"x"}}),
            json!({"version":1,"internalOperator":{"user":"owner","repo":REPO},"exp":2000,"via":{"kind":"session","id":"x","extra":true}}),
        ] {
            assert_eq!(verify_token("test-secret", &mint(raw), 1000), None);
        }
    }
    #[test]
    fn project_format_digest_and_boundaries() {
        let token = format!("abp_1_{}_{}", "a".repeat(32), "b".repeat(64));
        let (id, digest) = parse_project_token(&token).unwrap();
        assert_eq!(id, "a".repeat(32));
        let expected = format!("{:x}", Sha256::digest("b".repeat(64)));
        assert!(digest_matches(&expected, &digest));
        assert!(!digest_matches(&"0".repeat(64), &digest));
        assert!(!digest_matches("invalid", &digest));
        for bad in [
            token.to_uppercase(),
            format!("{token}_extra"),
            format!("{token} "),
            token[1..].to_owned(),
        ] {
            assert!(parse_project_token(&bad).is_none());
        }
        let principal = Principal::Internal {
            repo: REPO.into(),
            user: "owner".into(),
            via: Some(json!({"kind":"session","id":"s"})),
        };
        assert_eq!(
            principal.actor(),
            json!({"kind":"human","user":"owner","via":{"kind":"session","id":"s"}})
        );
        assert_eq!(
            principal.require_project("foreign").unwrap_err(),
            OperatorError::auth(403, "wrong project")
        );
        assert!(Principal::Project {
            repo: REPO.into(),
            user: "owner".into(),
            purpose: "dispatcher".into()
        }
        .require_operator()
        .is_err());
    }
    #[tokio::test]
    async fn identity_precedes_auth_and_revocation_is_fresh() {
        let backend = Backend::new();
        let mut request = headers(INTERNAL);
        request.remove(protocol::VERSION_HEADER);
        assert_eq!(
            authenticate_operator(&request, REPO, "test-secret", 1000, &backend)
                .await
                .unwrap_err()
                .status,
            409
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        let request = headers("abp_fake");
        assert_eq!(
            authenticate_operator(&request, REPO, "test-secret", 1000, &backend)
                .await
                .unwrap()
                .user(),
            "owner"
        );
        backend.credential_live.store(false, Ordering::SeqCst);
        assert_eq!(
            authenticate_operator(&request, REPO, "test-secret", 1000, &backend)
                .await
                .unwrap_err(),
            OperatorError::auth(401, "unknown or revoked credential")
        );
        let request = headers(INTERNAL);
        backend.registered.store(false, Ordering::SeqCst);
        assert_eq!(
            authenticate_operator(&request, REPO, "test-secret", 1000, &backend)
                .await
                .unwrap_err(),
            OperatorError::auth(403, "project not registered")
        );
    }
    #[tokio::test]
    async fn signed_grants_are_separate_from_operator_authority() {
        let backend = Backend::new();
        let token = mint(
            json!({"version":2,"delegation":{"repo":REPO,"kind":"build-runner","id":"build","anchor":1}}),
        );
        assert_eq!(
            authenticate_operator(&headers(&token), REPO, "test-secret", 1000, &backend)
                .await
                .unwrap_err(),
            OperatorError::auth(
                403,
                "delegated credentials may not access operator operations"
            )
        );
        backend.active.store(false, Ordering::SeqCst);
        assert_eq!(
            authenticate_operator(&headers(&token), REPO, "test-secret", 1000, &backend)
                .await
                .unwrap_err(),
            OperatorError::auth(401, "delegated credential ended or unavailable")
        );
        let retired = mint(json!({"operator":{"user":"owner"},"exp":2000}));
        assert_eq!(
            authenticate_operator(&headers(&retired), REPO, "test-secret", 1000, &backend)
                .await
                .unwrap_err(),
            OperatorError::auth(401, RETIRED_CREDENTIAL_MESSAGE)
        );
        let admin = mint(json!({"version":1,"ownerAdmin":{"user":"owner"},"exp":2000}));
        assert!(
            authenticate_operator(&headers(&admin), "foreign", "test-secret", 1000, &backend)
                .await
                .is_ok()
        );
        backend.registered.store(false, Ordering::SeqCst);
        assert_eq!(
            authenticate_operator(&headers(&admin), "foreign", "test-secret", 1000, &backend)
                .await
                .unwrap_err(),
            OperatorError::auth(403, "project not registered")
        );
    }
    #[test]
    fn durable_build_anchors_and_terminal_grace() {
        let mut c = claims("build-phase");
        c.session = Some("s".into());
        let mut facts =
            json!({"lastSeq":3,"sessions":{"id:s":{"starts":[1],"endings":[]}},"terminals":[]});
        assert!(evaluate_delegation_facts(&c, &facts, 1000));
        c.anchor = 2;
        assert!(!evaluate_delegation_facts(&c, &facts, 1000));
        c.anchor = 1;
        facts["terminals"] = json!([{"seq":3,"at":"1970-01-01T00:00:01.000Z"}]);
        assert!(evaluate_delegation_facts(&c, &facts, 60_999));
        assert!(!evaluate_delegation_facts(&c, &facts, 61_000));
        facts["terminals"][0]["at"] = json!("invalid");
        assert!(!evaluate_delegation_facts(&c, &facts, 1000));
    }
    #[test]
    fn harvest_execution_session_suspension_and_nonwidening() {
        let mut c = claims("harvest-runner");
        c.execution = Some("e".into());
        c.lease_holder = Some("holder".into());
        let facts = json!({"lastSeq":4,"runs":{"id:build":true},"authorizations":{"id:build":{"id:e":{"seq":1,"leaseHolder":"holder"}}},"sessions":{"id:build":{"id:s":{"starts":[2],"endings":[]}}},"releases":{},"endings":{}});
        assert!(evaluate_delegation_facts(&c, &facts, 1000));
        c.lease_holder = Some("other".into());
        assert!(!evaluate_delegation_facts(&c, &facts, 1000));
        c.lease_holder = Some("holder".into());
        assert!(require_narrowing(&c, "harvest-phase", "build", Some(2)).is_ok());
        assert!(require_narrowing(&c, "build-phase", "build", Some(2)).is_err());
        assert!(require_narrowing(&c, "harvest-phase", "foreign", Some(2)).is_err());
        assert!(require_narrowing(&c, "harvest-phase", "build", Some(0)).is_err());
        c.kind = "harvest-phase".into();
        c.anchor = 2;
        c.session = Some("s".into());
        assert!(evaluate_delegation_facts(&c, &facts, 1000));
        let mut suspended = facts;
        suspended["sessions"]["id:build"]["id:s"]["suspended"] = json!(true);
        assert!(!evaluate_delegation_facts(&c, &suspended, 1000));
    }
    #[test]
    fn lifecycle_reduction_keeps_unknown_events_as_valid_anchors() {
        let event = |seq, kind, payload| json!({"build":"build","seq":seq,"type":kind,"ts":"1970-01-01T00:00:01.000Z","actor":{"kind":"kernel"},"payload":payload});
        let events = vec![
            event(
                1,
                "session.started",
                json!({"session":"s","role":"implement","runner":"fake","phase":"implement"}),
            ),
            event(2, "future.advisory", json!({})),
            event(3, "build.completed", json!({"outcome":"merged"})),
        ];
        let facts = delegation_facts_from_events(true, &events).unwrap();
        assert_eq!(
            facts,
            json!({"lastSeq":3,"sessions":{"id:s":{"starts":[1],"endings":[]}},"terminals":[{"seq":3,"at":"1970-01-01T00:00:01.000Z"}]})
        );
        let mut c = claims("build-phase");
        c.session = Some("s".into());
        assert!(evaluate_delegation_facts(&c, &facts, 60_999));
        assert!(!evaluate_delegation_facts(&c, &facts, 61_000));
        let mut malformed = events.clone();
        malformed[1]["seq"] = json!(4);
        assert!(delegation_facts_from_events(true, &malformed).is_err());
        malformed = events;
        malformed[0]["payload"] = json!({"session":"s"});
        assert!(delegation_facts_from_events(true, &malformed).is_err());
    }
}
