//! HMAC-signed lifecycle token wire format, independent of authorization.
//! Signed tokens carry no backend authority until fresh registration/lifecycle
//! checks succeed. v2 grants have no exp; old shapes remain classifiable only.
use crate::protocol::js_value::{JsJson as J, JsString as S};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegationClaims {
    pub repo: S,
    pub kind: DelegationKind,
    pub id: S,
    pub anchor: i64,
    pub execution: Option<S>,
    pub session: Option<S>,
    pub lease_holder: Option<S>,
}
fn object(values: impl IntoIterator<Item = (&'static str, J)>) -> J {
    J::Object(values.into_iter().map(|(k, v)| (S::from(k), v)).collect())
}
fn string(s: &S) -> J {
    J::String(s.clone())
}
fn integer_json(n: i64) -> J {
    J::Number(n as f64)
}
impl DelegationClaims {
    pub fn as_js_value(&self) -> J {
        let mut v = object([
            ("repo", string(&self.repo)),
            ("kind", J::String(S::from(self.kind.as_str()))),
            ("id", string(&self.id)),
            ("anchor", integer_json(self.anchor)),
        ]);
        for (key, value) in [
            ("session", &self.session),
            ("execution", &self.execution),
            ("leaseHolder", &self.lease_holder),
        ] {
            if let Some(value) = value {
                v[key] = string(value)
            }
        }
        v
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Via {
    Session { id: S },
    Mcp { client: S },
}
impl Via {
    pub fn as_js_value(&self) -> J {
        match self {
            Self::Session { id } => {
                object([("kind", J::String(S::from("session"))), ("id", string(id))])
            }
            Self::Mcp { client } => object([
                ("kind", J::String(S::from("mcp"))),
                ("client", string(client)),
            ]),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum SignedScope {
    Delegated(DelegationClaims),
    Internal {
        user: S,
        repo: S,
        exp: i64,
        via: Option<Via>,
    },
    Admin {
        user: S,
        exp: i64,
    },
    Retired(J),
}
impl SignedScope {
    pub fn as_js_value(&self) -> J {
        match self {
            Self::Delegated(c) => {
                object([("version", J::Number(2.0)), ("delegation", c.as_js_value())])
            }
            Self::Internal {
                user,
                repo,
                exp,
                via,
            } => {
                let mut v = object([
                    ("version", J::Number(1.0)),
                    (
                        "internalOperator",
                        object([("user", string(user)), ("repo", string(repo))]),
                    ),
                    ("exp", integer_json(*exp)),
                ]);
                if let Some(via) = via {
                    v["via"] = via.as_js_value()
                }
                v
            }
            Self::Admin { user, exp } => object([
                ("version", J::Number(1.0)),
                ("ownerAdmin", object([("user", string(user))])),
                ("exp", integer_json(*exp)),
            ]),
            Self::Retired(v) => v.clone(),
        }
    }
}
fn keys(value: &J, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        required.iter().all(|key| value.get(key).is_some())
            && object
                .iter()
                .all(|(key, _)| required.iter().chain(optional).any(|name| key.eq_str(name)))
    })
}
fn nonempty(value: &J) -> Option<S> {
    value.as_string().filter(|v| !v.is_empty()).cloned()
}
fn exact_identity(value: &J) -> Option<S> {
    nonempty(value).filter(|v| !v.eq_ascii("*"))
}
fn optional_identity(value: &J, key: &str) -> Option<Option<S>> {
    match value.get(key) {
        None => Some(None),
        Some(v) => exact_identity(v).map(Some),
    }
}
fn integer(value: &J) -> Option<i64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE)
        .map(|n| n as i64)
}
fn user(value: &J) -> Option<S> {
    value.as_string().map(S::trim_js).filter(|v| !v.is_empty())
}
fn scalar(value: &J) -> Option<String> {
    value.as_string()?.to_scalar().ok()
}
fn via(value: &J) -> Option<Via> {
    match scalar(&value["kind"])?.as_str() {
        "session" if keys(value, &["kind", "id"], &[]) => Some(Via::Session {
            id: nonempty(&value["id"])?,
        }),
        "mcp" if keys(value, &["kind", "client"], &[]) => Some(Via::Mcp {
            client: nonempty(&value["client"])?,
        }),
        _ => None,
    }
}
fn optional_via(value: &J) -> Option<Option<Via>> {
    match value.get("via") {
        None => Some(None),
        Some(v) => via(v).map(Some),
    }
}
pub fn parse_delegation_claims(value: &Value) -> Option<DelegationClaims> {
    parse_delegation_claims_lossless(&J::from_serde(value))
}
pub fn parse_delegation_claims_lossless(value: &J) -> Option<DelegationClaims> {
    if !keys(
        value,
        &["repo", "kind", "id", "anchor"],
        &["session", "execution", "leaseHolder"],
    ) {
        return None;
    }
    let kind = DelegationKind::parse(&scalar(&value["kind"])?)?;
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
        execution,
        session,
        lease_holder,
    })
}
fn parse_scope(value: &J, now_ms: i64) -> Option<SignedScope> {
    if value["version"].as_f64() == Some(2.0) {
        return keys(value, &["version", "delegation"], &[])
            .then(|| parse_delegation_claims_lossless(&value["delegation"]))
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
        return Some(SignedScope::Retired(object([
            ("build", string(&nonempty(&value["build"])?)),
            ("session", string(&nonempty(&value["session"])?)),
            ("exp", integer_json(exp)),
        ])));
    }
    if keys(value, &["resource", "session", "exp"], &["via"])
        && keys(&value["resource"], &["kind", "id"], &[])
        && matches!(
            scalar(&value["resource"]["kind"]).as_deref(),
            Some("build" | "repo" | "session")
        )
    {
        let mut v = object([
            (
                "resource",
                object([
                    ("kind", value["resource"]["kind"].clone()),
                    ("id", string(&nonempty(&value["resource"]["id"])?)),
                ]),
            ),
            ("session", string(&nonempty(&value["session"])?)),
            ("exp", integer_json(exp)),
        ]);
        if let Some(via) = optional_via(value)? {
            v["via"] = via.as_js_value()
        }
        return Some(SignedScope::Retired(v));
    }
    if keys(value, &["operator", "exp"], &["via"]) && keys(&value["operator"], &["user"], &[]) {
        let mut v = object([
            (
                "operator",
                object([("user", string(&user(&value["operator"]["user"])?))]),
            ),
            ("exp", integer_json(exp)),
        ]);
        if let Some(via) = optional_via(value)? {
            v["via"] = via.as_js_value()
        }
        return Some(SignedScope::Retired(v));
    }
    if keys(value, &["operator", "session", "exp"], &[])
        && value["operator"].as_bool() == Some(true)
    {
        return Some(SignedScope::Retired(object([
            ("operator", J::Bool(true)),
            ("session", string(&nonempty(&value["session"])?)),
            ("exp", integer_json(exp)),
        ])));
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
    let raw = super::js_value::parse(text.as_bytes()).ok()?;
    parse_scope(&raw, now_ms)
}
/// Raw scope minting preserves caller insertion order, as JSON.stringify does.
pub fn mint_js_token(secret: &str, scope: &J) -> String {
    let payload = URL_SAFE_NO_PAD.encode(scope.stringify().as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(signature(secret, &payload));
    format!("{payload}.{signature}")
}
pub fn mint_delegated_token(secret: &str, claims: &DelegationClaims) -> String {
    // Issuance constructs execution before session; verification returns Zod's
    // schema order. The two contracts deliberately have separate serializers.
    let mut value = object([
        ("repo", string(&claims.repo)),
        ("kind", J::String(S::from(claims.kind.as_str()))),
        ("id", string(&claims.id)),
        ("anchor", integer_json(claims.anchor)),
    ]);
    for (key, field) in [
        ("execution", &claims.execution),
        ("session", &claims.session),
        ("leaseHolder", &claims.lease_holder),
    ] {
        if let Some(field) = field {
            value[key] = string(field)
        }
    }
    mint_js_token(
        secret,
        &object([("version", J::Number(2.0)), ("delegation", value)]),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DelegationTarget {
    BuildRunner {
        id: S,
    },
    BuildPhase {
        id: S,
        session: S,
    },
    HarvestRunner {
        execution: S,
        repo: S,
        id: S,
        lease_holder: S,
    },
    HarvestPhase {
        repo: S,
        id: S,
        session: S,
    },
}
impl DelegationTarget {
    pub fn as_js_value(&self) -> J {
        match self {
            Self::BuildRunner { id } => object([
                ("kind", J::String(S::from("build-runner"))),
                ("id", string(id)),
            ]),
            Self::BuildPhase { id, session } => object([
                ("kind", J::String(S::from("build-phase"))),
                ("id", string(id)),
                ("session", string(session)),
            ]),
            Self::HarvestRunner {
                execution,
                repo,
                id,
                lease_holder,
            } => object([
                ("kind", J::String(S::from("harvest-runner"))),
                ("execution", string(execution)),
                ("repo", string(repo)),
                ("id", string(id)),
                ("leaseHolder", string(lease_holder)),
            ]),
            Self::HarvestPhase { repo, id, session } => object([
                ("kind", J::String(S::from("harvest-phase"))),
                ("repo", string(repo)),
                ("id", string(id)),
                ("session", string(session)),
            ]),
        }
    }
}
pub fn parse_target(value: &Value) -> Option<DelegationTarget> {
    parse_target_lossless(&J::from_serde(value))
}
pub fn parse_target_lossless(value: &J) -> Option<DelegationTarget> {
    Some(match scalar(&value["kind"])?.as_str() {
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
    use crate::protocol::js_json::parse_js_json;
    #[test]
    fn signed_scope_interoperability_matches_typescript() {
        let fixture = parse_js_json(include_bytes!("../../fixtures/protocol-tokens.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = verify_token(
                case["secret"].as_str().unwrap(),
                case["token"].as_str().unwrap(),
                case["now"].as_i64().unwrap(),
            )
            .map(|scope| scope.as_js_value().to_serde_checked().unwrap())
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
                .map(|target| target.as_js_value().to_serde_checked().unwrap())
                .unwrap_or(Value::Null);
            assert_eq!(actual, case["accepted"]);
        }
    }
    #[test]
    fn signed_unicode_scopes_match_javascript_without_replacement() {
        let fixture =
            parse_js_json(include_bytes!("../../fixtures/protocol-token-unicode.json")).unwrap();
        for row in fixture["verify"].as_array().unwrap() {
            let parsed = verify_token(
                row["secret"].as_str().unwrap(),
                row["token"].as_str().unwrap(),
                row["now"].as_i64().unwrap(),
            )
            .map(|v| v.as_js_value())
            .unwrap_or(J::Null);
            let expected: Vec<u16> = row["expectedUnits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect();
            assert_eq!(
                parsed.stringify().encode_utf16().collect::<Vec<_>>(),
                expected,
                "{} verify",
                row["name"]
            );
        }
        for row in fixture["mint"].as_array().unwrap() {
            let scope =
                super::super::js_value::parse(row["input"].as_str().unwrap().as_bytes()).unwrap();
            assert_eq!(
                mint_js_token(row["secret"].as_str().unwrap(), &scope),
                row["token"].as_str().unwrap(),
                "{} mint",
                row["name"]
            );
        }
        for row in fixture["targets"].as_array().unwrap() {
            let input =
                super::super::js_value::parse(row["input"].as_str().unwrap().as_bytes()).unwrap();
            let actual = parse_target_lossless(&input)
                .map(|v| v.as_js_value())
                .unwrap_or(J::Null);
            let expected: Vec<u16> = row["expectedUnits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect();
            assert_eq!(
                actual.stringify().encode_utf16().collect::<Vec<_>>(),
                expected,
                "{} target",
                row["name"]
            );
        }
        assert!(fixture["verify"].as_array().unwrap().len() >= 100);
    }
}
