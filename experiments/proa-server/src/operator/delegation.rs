//! The existing machine credential delegation seam, independent of operator
//! authority. Every issuance samples authoritative lifecycle facts again.
use super::{
    auth::{self, AuthBackend, Delegation, NativeAuth, Principal},
    error::OperatorError,
    protocol,
};
use crate::{
    app::AppState,
    data::{postgres::Scope, reader::DataReader, writer::PostgresWriter},
};
use axum::{
    body::Bytes, extract::State, http::HeaderMap, response::IntoResponse, routing::post, Extension,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Sha256;

pub fn router() -> Router<AppState> {
    router_with_clock(std::sync::Arc::new(Utc::now))
}
pub fn router_with_clock(clock: super::http::HttpClock) -> Router<AppState> {
    Router::new()
        .route("/credentials/delegate", post(handle))
        .layer(Extension(clock))
}
async fn handle(
    State(state): State<AppState>,
    Extension(clock): Extension<super::http::HttpClock>,
    headers: HeaderMap,
    bytes: Bytes,
) -> axum::response::Response {
    // Identity and issuance availability belong to the remote store router,
    // whose failures use its application/json response convention. Once the
    // delegation handler is entered its own JSON responses include charset.
    let router_error = |error: OperatorError| {
        let mut response = error.into_response();
        response.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("application/json"),
        );
        response
    };
    if let Err(error) = protocol::check_identity(&headers) {
        return router_error(error);
    }
    let (Some(reader), Some(writer), Some(secret)) = (
        state.data.as_deref(),
        state.writer.as_deref(),
        state.operator_secret.as_deref(),
    ) else {
        return router_error(OperatorError::not_found("credential issuance unavailable"));
    };
    let result = async {
        let now = clock();
        let backend = NativeAuth { reader, writer };
        // Authentication intentionally precedes body decoding on this seam.
        let principal =
            auth::authenticate(&headers, secret, now.timestamp_millis(), &backend).await?;
        let target = decode_target(&bytes)?;
        let token = issue(reader, writer, &principal, &target, secret, now).await?;
        Ok::<_, OperatorError>(Json(json!({"token":token})))
    }
    .await;
    match result {
        Ok(response) => (
            [(
                axum::http::header::CONTENT_TYPE,
                "application/json;charset=utf-8",
            )],
            response,
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub kind: String,
    pub id: String,
    pub repo: Option<String>,
    pub execution: Option<String>,
    pub session: Option<String>,
    pub lease_holder: Option<String>,
}
pub fn decode_target(bytes: &[u8]) -> Result<Target, OperatorError> {
    let value: Value = super::request_schema::decode_json(bytes)
        .map_err(|_| OperatorError::validation("invalid JSON"))?;
    let invalid = || OperatorError::validation("invalid delegation target");
    let object = value.as_object().ok_or_else(invalid)?;
    let kind = value["kind"].as_str().ok_or_else(invalid)?;
    let keys: &[&str] = match kind {
        "build-runner" => &["kind", "id"],
        "build-phase" => &["kind", "id", "session"],
        "harvest-runner" => &["kind", "id", "repo", "execution", "leaseHolder"],
        "harvest-phase" => &["kind", "id", "repo", "session"],
        _ => return Err(invalid()),
    };
    if object.len() != keys.len()
        || !keys
            .iter()
            .all(|key| value[*key].as_str().is_some_and(|value| !value.is_empty()))
    {
        return Err(invalid());
    }
    Ok(Target {
        kind: kind.into(),
        id: value["id"].as_str().unwrap().into(),
        repo: value["repo"].as_str().map(str::to_owned),
        execution: value["execution"].as_str().map(str::to_owned),
        session: value["session"].as_str().map(str::to_owned),
        lease_holder: value["leaseHolder"].as_str().map(str::to_owned),
    })
}
fn key(id: &str) -> String {
    format!("id:{id}")
}
pub fn prepare_claims(
    principal: &Principal,
    target: &Target,
    repo: &str,
    facts: &Value,
    lease_holder: Option<&str>,
    now_ms: i64,
) -> Result<Delegation, OperatorError> {
    principal.require_project(repo)?;
    if matches!(principal, Principal::Internal { .. }) {
        return Err(OperatorError::auth(
            403,
            "operator authority cannot delegate machine credentials",
        ));
    }
    if let Principal::Delegated { claims } = principal {
        auth::require_narrowing(claims, &target.kind, &target.id, None)?;
    }
    if target
        .lease_holder
        .as_deref()
        .is_some_and(|holder| Some(holder) != lease_holder)
    {
        return Err(OperatorError::auth(
            403,
            "harvest holder does not own the repository lease",
        ));
    }
    let execution = target.execution.clone().or_else(|| match principal {
        Principal::Delegated { claims } => claims.execution.clone(),
        _ => None,
    });
    let build = target.kind.starts_with("build");
    let anchor = if let Some(session) = &target.session {
        let binding = if build {
            &facts["sessions"][key(session)]
        } else {
            &facts["sessions"][key(&target.id)][key(session)]
        };
        binding["starts"]
            .as_array()
            .and_then(|starts| starts.first())
            .and_then(Value::as_i64)
    } else if build {
        facts["lastSeq"].as_i64().filter(|seq| *seq != 0)
    } else {
        execution.as_deref().and_then(|execution| {
            facts["authorizations"][key(&target.id)][key(execution)]["seq"].as_i64()
        })
    };
    if let Principal::Delegated { claims } = principal {
        auth::require_narrowing(claims, &target.kind, &target.id, anchor)?;
    }
    let anchor = anchor.ok_or_else(|| OperatorError::auth(404, "lifecycle binding unavailable"))?;
    let claims = Delegation {
        repo: repo.into(),
        kind: target.kind.clone(),
        id: target.id.clone(),
        anchor,
        session: target.session.clone(),
        execution,
        lease_holder: target.lease_holder.clone(),
    };
    if !auth::evaluate_delegation_facts(&claims, facts, now_ms) {
        return Err(OperatorError::auth(403, "lifecycle binding ended"));
    }
    Ok(claims)
}
pub async fn issue(
    reader: &DataReader,
    writer: &PostgresWriter,
    principal: &Principal,
    target: &Target,
    secret: &str,
    now: DateTime<Utc>,
) -> Result<String, OperatorError> {
    let build = target.kind.starts_with("build");
    let repo = if build {
        let connection = writer
            .client()
            .await
            .map_err(|_| OperatorError::internal())?;
        connection
            .client
            .query_opt("SELECT repo FROM builds WHERE slug=$1", &[&target.id])
            .await
            .map_err(|_| OperatorError::internal())?
            .map(|row| row.get::<_, String>(0))
    } else {
        target.repo.clone()
    }
    .ok_or_else(|| OperatorError::auth(404, "resource unavailable"))?;
    principal.require_project(&repo)?;
    if matches!(principal, Principal::Internal { .. }) {
        return Err(OperatorError::auth(
            403,
            "operator authority cannot delegate machine credentials",
        ));
    }
    if let Principal::Delegated { claims } = principal {
        auth::require_narrowing(claims, &target.kind, &target.id, None)?;
    }
    let lease = if target.lease_holder.is_some() {
        let connection = writer
            .client()
            .await
            .map_err(|_| OperatorError::internal())?;
        connection
            .client
            .query_opt(
                "SELECT lease_holder,lease_expires_at FROM repo_streams WHERE repo=$1",
                &[&repo],
            )
            .await
            .map_err(|_| OperatorError::internal())?
            .and_then(|row| {
                let holder: Option<String> = row.get(0);
                let expires: Option<DateTime<Utc>> = row.get(1);
                if expires.is_some() {
                    holder
                } else {
                    None
                }
            })
    } else {
        None
    };
    if target
        .lease_holder
        .as_deref()
        .is_some_and(|holder| Some(holder) != lease.as_deref())
    {
        return Err(OperatorError::auth(
            403,
            "harvest holder does not own the repository lease",
        ));
    }
    let events = reader
        .postgres()
        .events(
            &repo,
            if build {
                Scope::Build(&target.id)
            } else {
                Scope::Repository
            },
            0,
        )
        .await
        .map_err(|_| OperatorError::internal())?;
    let facts = auth::delegation_facts_from_events(build, &events)?;
    let claims = prepare_claims(
        principal,
        target,
        &repo,
        &facts,
        lease.as_deref(),
        now.timestamp_millis(),
    )?;
    // createDelegationHandler rereads lifecycle after constructing the binding.
    let backend = NativeAuth { reader, writer };
    if !backend
        .delegation_active(&claims, now.timestamp_millis())
        .await?
    {
        return Err(OperatorError::auth(403, "lifecycle binding ended"));
    }
    Ok(mint(secret, &claims))
}
/// Match JSON.stringify's field order as well as its token cryptography.
pub fn mint(secret: &str, claims: &Delegation) -> String {
    #[derive(Serialize)]
    struct Ordered<'a> {
        repo: &'a str,
        kind: &'a str,
        id: &'a str,
        anchor: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        execution: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        session: Option<&'a str>,
        #[serde(rename = "leaseHolder", skip_serializing_if = "Option::is_none")]
        lease_holder: Option<&'a str>,
    }
    #[derive(Serialize)]
    struct Token<'a> {
        version: u8,
        delegation: Ordered<'a>,
    }
    let raw = Token {
        version: 2,
        delegation: Ordered {
            repo: &claims.repo,
            kind: &claims.kind,
            id: &claims.id,
            anchor: claims.anchor,
            execution: claims.execution.as_deref(),
            session: claims.session.as_deref(),
            lease_holder: claims.lease_holder.as_deref(),
        },
    };
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&raw).expect("claims serialize"));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(payload.as_bytes());
    format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_target_errors_are_transport_specific_and_do_not_transform_ids() {
        assert_eq!(decode_target(b"{").unwrap_err().error, "invalid JSON");
        for value in [
            json!({"kind":"build-runner","id":"b","session":"s"}),
            json!({"kind":"build-phase","id":"b"}),
            json!({"kind":"build-runner","id":""}),
            json!({"kind":"harvest-runner","repo":"r","id":"h","execution":"x","leaseHolder":null}),
        ] {
            assert_eq!(
                decode_target(&serde_json::to_vec(&value).unwrap())
                    .unwrap_err()
                    .error,
                "invalid delegation target"
            );
        }
        assert_eq!(
            decode_target(br#"{"kind":"build-runner","id":" b "}"#)
                .unwrap()
                .id,
            " b "
        );
    }
    #[test]
    fn issued_grants_match_typescript_lifecycle_policy_and_token_bytes() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/delegation-corpus.json")).unwrap();
        let mut checked = 0;
        for fixture in corpus["fixtures"].as_array().unwrap() {
            let scenario = &fixture["scenario"];
            let id = scenario["id"].as_str().unwrap();
            let raw = &scenario["principal"];
            let principal = match raw["kind"].as_str().unwrap() {
                "admin" => Principal::Admin {
                    user: raw["user"].as_str().unwrap().into(),
                },
                "internal" => Principal::Internal {
                    repo: raw["repo"].as_str().unwrap().into(),
                    user: raw["user"].as_str().unwrap().into(),
                    via: None,
                },
                "delegated" => Principal::Delegated {
                    claims: serde_json::from_value(raw["delegation"].clone()).unwrap(),
                },
                _ => panic!("unexpected principal"),
            };
            let target = decode_target(&serde_json::to_vec(&scenario["target"]).unwrap()).unwrap();
            let now = DateTime::parse_from_rfc3339(fixture["now"].as_str().unwrap()).unwrap();
            let result = prepare_claims(
                &principal,
                &target,
                fixture["repo"].as_str().unwrap(),
                &fixture["facts"],
                fixture["leaseHolder"].as_str(),
                now.timestamp_millis(),
            );
            match result {
                Ok(claims) => {
                    assert_eq!(fixture["status"], 200, "{id}");
                    let token = mint(fixture["secret"].as_str().unwrap(), &claims);
                    assert_eq!(
                        token,
                        fixture["body"]["token"].as_str().unwrap(),
                        "{id}: signed bytes"
                    );
                    assert_eq!(
                        auth::verify_token(
                            fixture["secret"].as_str().unwrap(),
                            &token,
                            now.timestamp_millis()
                        ),
                        Some(auth::SignedScope::Delegated(claims)),
                        "{id}: verifier roundtrip"
                    );
                }
                Err(error) => {
                    assert_eq!(json!(error.status), fixture["status"], "{id}");
                    assert_eq!(
                        serde_json::to_value(error).unwrap(),
                        fixture["body"],
                        "{id}"
                    );
                }
            }
            checked += 1;
        }
        assert_eq!(checked, 16);
    }
}
