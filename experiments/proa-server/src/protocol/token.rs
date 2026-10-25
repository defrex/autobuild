//! HMAC-signed lifecycle token wire format, independent of authorization.
//! Signed tokens carry no backend authority until fresh registration/lifecycle
//! checks succeed. v2 grants have no exp; old shapes remain classifiable only.
use crate::protocol::js_json::{parse_js_json, serializable};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelegationKind {
    BuildRunner,
    BuildPhase,
    HarvestRunner,
    HarvestPhase,
}
impl DelegationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BuildRunner => "build-runner",
            Self::BuildPhase => "build-phase",
            Self::HarvestRunner => "harvest-runner",
            Self::HarvestPhase => "harvest-phase",
        }
    }
    pub fn is_phase(self) -> bool {
        matches!(self, Self::BuildPhase | Self::HarvestPhase)
    }
    pub fn is_build(self) -> bool {
        matches!(self, Self::BuildRunner | Self::BuildPhase)
    }
    pub fn is_runner(self) -> bool {
        !self.is_phase()
    }
    fn parse(kind: &str) -> Option<Self> {
        Some(match kind {
            "build-runner" => Self::BuildRunner,
            "build-phase" => Self::BuildPhase,
            "harvest-runner" => Self::HarvestRunner,
            "harvest-phase" => Self::HarvestPhase,
            _ => return None,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationClaims {
    pub repo: String,
    pub kind: DelegationKind,
    pub id: String,
    pub anchor: i64,
    // Production issuance constructs execution before session. Maintaining that
    // order makes its JSON/HMAC wire bytes identical to the TS handler.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_holder: Option<String>,
}
impl DelegationClaims {
    pub fn as_value(&self) -> Value {
        serde_json::to_value(self).expect("serializable delegated claims")
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Via {
    Session { id: String },
    Mcp { client: String },
}
#[derive(Clone, Debug, PartialEq)]
pub enum SignedScope {
    Delegated(DelegationClaims),
    Internal {
        user: String,
        repo: String,
        exp: i64,
        via: Option<Via>,
    },
    Admin {
        user: String,
        exp: i64,
    },
    Retired(Value),
}
impl SignedScope {
    pub fn as_value(&self) -> Value {
        match self {
            Self::Delegated(claims) => json!({"version":2,"delegation":claims}),
            Self::Internal {
                user,
                repo,
                exp,
                via,
            } => {
                let mut v =
                    json!({"version":1,"internalOperator":{"user":user,"repo":repo},"exp":exp});
                if let Some(via) = via {
                    v["via"] = serde_json::to_value(via).unwrap();
                }
                v
            }
            Self::Admin { user, exp } => json!({"version":1,"ownerAdmin":{"user":user},"exp":exp}),
            Self::Retired(v) => v.clone(),
        }
    }
}
fn keys(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        required.iter().all(|key| object.contains_key(*key))
            && object
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}
fn nonempty(value: &Value) -> Option<String> {
    value.as_str().filter(|v| !v.is_empty()).map(str::to_owned)
}
fn exact_identity(value: &Value) -> Option<String> {
    nonempty(value).filter(|v| v != "*")
}
fn optional_identity(value: &Value, key: &str) -> Option<Option<String>> {
    match value.get(key) {
        None => Some(None),
        Some(v) => exact_identity(v).map(Some),
    }
}
fn integer(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE)
        .map(|n| n as i64)
}
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn user(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|v| v.trim_matches(js_space))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
fn via(value: &Value) -> Option<Via> {
    match value["kind"].as_str()? {
        "session" if keys(value, &["kind", "id"], &[]) => Some(Via::Session {
            id: nonempty(&value["id"])?,
        }),
        "mcp" if keys(value, &["kind", "client"], &[]) => Some(Via::Mcp {
            client: nonempty(&value["client"])?,
        }),
        _ => None,
    }
}
fn optional_via(value: &Value) -> Option<Option<Via>> {
    match value.get("via") {
        None => Some(None),
        Some(v) => via(v).map(Some),
    }
}
/// Same strict schema and cross-field refinement as delegatedClaims. Do not
/// over-constrain leaseHolder: TS permits it on every grant kind.
pub fn parse_delegation_claims(value: &Value) -> Option<DelegationClaims> {
    if !keys(
        value,
        &["repo", "kind", "id", "anchor"],
        &["session", "execution", "leaseHolder"],
    ) {
        return None;
    }
    let kind = DelegationKind::parse(value["kind"].as_str()?)?;
    let anchor = integer(&value["anchor"]).filter(|n| *n > 0)?;
    let session = optional_identity(value, "session")?;
    let execution = optional_identity(value, "execution")?;
    let lease_holder = optional_identity(value, "leaseHolder")?;
    if kind.is_phase() != session.is_some() || !kind.is_build() != execution.is_some() {
        return None;
    }
    Some(DelegationClaims {
        repo: exact_identity(&value["repo"])?,
        kind,
        id: exact_identity(&value["id"])?,
        anchor,
        session,
        execution,
        lease_holder,
    })
}
fn parse_scope(value: &Value, now_ms: i64) -> Option<SignedScope> {
    if value["version"].as_f64() == Some(2.0) {
        return keys(value, &["version", "delegation"], &[])
            .then(|| parse_delegation_claims(&value["delegation"]))
            .flatten()
            .map(SignedScope::Delegated);
    }
    let exp = integer(&value["exp"])?;
    if exp <= now_ms {
        return None;
    }
    if value["version"].as_f64() == Some(1.0) {
        if keys(value, &["version", "internalOperator", "exp"], &["via"])
            && keys(&value["internalOperator"], &["user", "repo"], &[])
        {
            return Some(SignedScope::Internal {
                user: user(&value["internalOperator"]["user"])?,
                repo: nonempty(&value["internalOperator"]["repo"])?,
                exp,
                via: optional_via(value)?,
            });
        }
        if keys(value, &["version", "ownerAdmin", "exp"], &[])
            && keys(&value["ownerAdmin"], &["user"], &[])
        {
            return Some(SignedScope::Admin {
                user: user(&value["ownerAdmin"]["user"])?,
                exp,
            });
        }
        return None;
    }
    if keys(value, &["build", "session", "exp"], &[]) {
        return Some(SignedScope::Retired(
            json!({"build":nonempty(&value["build"])?,"session":nonempty(&value["session"])?,"exp":exp}),
        ));
    }
    if keys(value, &["resource", "session", "exp"], &["via"])
        && keys(&value["resource"], &["kind", "id"], &[])
        && matches!(
            value["resource"]["kind"].as_str(),
            Some("build" | "repo" | "session")
        )
    {
        let mut v = json!({"resource":{"kind":value["resource"]["kind"],"id":nonempty(&value["resource"]["id"])?},"session":nonempty(&value["session"])?,"exp":exp});
        if let Some(via) = optional_via(value)? {
            v["via"] = serde_json::to_value(via).ok()?;
        }
        return Some(SignedScope::Retired(v));
    }
    if keys(value, &["operator", "exp"], &["via"]) && keys(&value["operator"], &["user"], &[]) {
        let mut v = json!({"operator":{"user":user(&value["operator"]["user"]) ?},"exp":exp});
        if let Some(via) = optional_via(value)? {
            v["via"] = serde_json::to_value(via).ok()?;
        }
        return Some(SignedScope::Retired(v));
    }
    if keys(value, &["operator", "session", "exp"], &[]) && value["operator"] == true {
        return Some(SignedScope::Retired(
            json!({"operator":true,"session":nonempty(&value["session"])?,"exp":exp}),
        ));
    }
    None
}
fn signature(secret: &str, payload: &str) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts arbitrary key lengths");
    mac.update(payload.as_bytes());
    mac.finalize().into_bytes().into()
}
/// Node Buffer.from(text,'base64url') accepts both alphabets, ignores invalid
/// characters, permits nonzero trailing bits and stops at the first '='. It
/// reads UTF-16 low bytes (e.g. U+0141 behaves as 'A'), not UTF-8 bytes.
fn decode_buffer_base64url(text: &str) -> Vec<u8> {
    let mut value = 0u32;
    let mut bits = 0usize;
    let mut out = Vec::new();
    for unit in text.encode_utf16() {
        let byte = unit as u8;
        if byte == b'=' {
            break;
        }
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        value = (value << 6) | u32::from(digit);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((value >> bits) as u8);
            value &= (1 << bits) - 1;
        }
    }
    out
}
/// Bad signature, malformed scope schema or expiration returns None without
/// exposing why. Classification of accepted historical forms stays separate
/// from machine authorization, which must reject Retired and Internal forms.
pub fn verify_token(secret: &str, token: &str, now_ms: i64) -> Option<SignedScope> {
    let (payload, provided) = token.split_once('.')?;
    if provided.contains('.') {
        return None;
    }
    let expected = signature(secret, payload);
    let provided = decode_buffer_base64url(provided);
    if provided.len() != expected.len() || !bool::from(expected.as_slice().ct_eq(&provided)) {
        return None;
    }
    let bytes = decode_buffer_base64url(payload);
    let text = String::from_utf8_lossy(&bytes);
    let raw = parse_js_json(text.as_bytes()).ok()?;
    parse_scope(&raw, now_ms)
}
#[derive(Serialize)]
struct Grant<'a> {
    version: u8,
    delegation: &'a DelegationClaims,
}
pub fn mint_delegated_token(secret: &str, claims: &DelegationClaims) -> String {
    let scope = serializable(
        serde_json::to_value(Grant {
            version: 2,
            delegation: claims,
        })
        .expect("serializable grant"),
    );
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&scope).expect("serializable grant"));
    let signature = URL_SAFE_NO_PAD.encode(signature(secret, &payload));
    format!("{payload}.{signature}")
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DelegationTarget {
    BuildRunner {
        id: String,
    },
    BuildPhase {
        id: String,
        session: String,
    },
    HarvestRunner {
        execution: String,
        repo: String,
        id: String,
        #[serde(rename = "leaseHolder")]
        lease_holder: String,
    },
    HarvestPhase {
        repo: String,
        id: String,
        session: String,
    },
}
pub fn parse_target(value: &Value) -> Option<DelegationTarget> {
    Some(match value["kind"].as_str()? {
        "build-runner" if keys(value, &["kind", "id"], &[]) => DelegationTarget::BuildRunner {
            id: nonempty(&value["id"])?,
        },
        "build-phase" if keys(value, &["kind", "id", "session"], &[]) => {
            DelegationTarget::BuildPhase {
                id: nonempty(&value["id"])?,
                session: nonempty(&value["session"])?,
            }
        }
        "harvest-runner"
            if keys(
                value,
                &["kind", "execution", "repo", "id", "leaseHolder"],
                &[],
            ) =>
        {
            DelegationTarget::HarvestRunner {
                execution: nonempty(&value["execution"])?,
                repo: nonempty(&value["repo"])?,
                id: nonempty(&value["id"])?,
                lease_holder: nonempty(&value["leaseHolder"])?,
            }
        }
        "harvest-phase" if keys(value, &["kind", "repo", "id", "session"], &[]) => {
            DelegationTarget::HarvestPhase {
                repo: nonempty(&value["repo"])?,
                id: nonempty(&value["id"])?,
                session: nonempty(&value["session"])?,
            }
        }
        _ => return None,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_scope_interoperability_matches_typescript() {
        let fixture = parse_js_json(include_bytes!("../../fixtures/protocol-tokens.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = verify_token(
                case["secret"].as_str().unwrap(),
                case["token"].as_str().unwrap(),
                case["now"].as_i64().unwrap(),
            )
            .map(|scope| scope.as_value())
            .unwrap_or(Value::Null);
            assert_eq!(actual, case["expected"], "{}", case["id"]);
        }
        for case in fixture["mint"].as_array().unwrap() {
            let claims = parse_delegation_claims(&case["input"]["delegation"]).unwrap();
            assert_eq!(
                mint_delegated_token(case["secret"].as_str().unwrap(), &claims),
                case["token"].as_str().unwrap()
            );
        }
        for case in fixture["targets"].as_array().unwrap() {
            let actual = parse_target(&case["input"])
                .map(|target| serde_json::to_value(target).unwrap())
                .unwrap_or(Value::Null);
            assert_eq!(actual, case["accepted"]);
        }
    }
}
