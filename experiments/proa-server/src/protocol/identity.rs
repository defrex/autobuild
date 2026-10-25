//! Release-line compatibility for machine requests. The current service identity
//! and historical wire table are generated from the TypeScript distribution;
//! decisions are made here, without a runtime TypeScript oracle.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const GENERATED: &str = include_str!("../../fixtures/protocol-identity.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReleaseVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

fn component(value: &str) -> Option<u64> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return None;
    }
    value.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE_INTEGER)
}

/// Mirrors the canonical `releaseVersion` guard, including semver's 256-byte
/// ceiling, safe numeric components and leading-zero rules for prereleases.
pub fn release_version(value: Option<&str>) -> Option<ReleaseVersion> {
    let value = value?;
    if value.len() > 256 {
        return None;
    }
    let (base, prerelease) = match value.split_once('-') {
        Some((base, suffix)) => (base, Some(suffix)),
        None => (value, None),
    };
    let mut components = base.split('.');
    let result = ReleaseVersion {
        major: component(components.next()?)?,
        minor: component(components.next()?)?,
        patch: component(components.next()?)?,
    };
    if components.next().is_some() {
        return None;
    }
    if let Some(suffix) = prerelease {
        for id in suffix.split('.') {
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || (id.len() > 1
                    && id.starts_with('0')
                    && id.bytes().all(|byte| byte.is_ascii_digit()))
            {
                return None;
            }
        }
    }
    Some(result)
}

pub fn stable_version(value: Option<&str>) -> Option<ReleaseVersion> {
    let value = value?;
    if value.contains('-') {
        return None;
    }
    release_version(Some(value))
}

pub fn client_supports_integration_audit_pending(value: Option<&str>) -> bool {
    release_version(value).is_some_and(|parsed| parsed.major > 0 || parsed.minor >= 14)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportedClientRange {
    pub min_version: String,
    pub max_version_exclusive: String,
}

pub fn supported_client_range(service: &str) -> Result<SupportedClientRange, &'static str> {
    let version =
        release_version(Some(service)).ok_or("service must have a canonical release version")?;
    Ok(SupportedClientRange {
        min_version: format!("{}.{}.0", version.major, version.minor.saturating_sub(2)),
        max_version_exclusive: format!("{}.{}.0", version.major, version.minor + 1),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientClassification {
    Supported,
    Older,
    Newer,
    Invalid,
}

pub fn classify_client(value: Option<&str>, range: &SupportedClientRange) -> ClientClassification {
    let Some(parsed) = release_version(value) else {
        return ClientClassification::Invalid;
    };
    // Generated and constructor-created ranges are canonical stable versions.
    let Some(min) = stable_version(Some(&range.min_version)) else {
        return ClientClassification::Invalid;
    };
    let Some(max) = stable_version(Some(&range.max_version_exclusive)) else {
        return ClientClassification::Invalid;
    };
    let line = (parsed.major, parsed.minor, 0);
    if line < (min.major, min.minor, min.patch) {
        ClientClassification::Older
    } else if line >= (max.major, max.minor, max.patch) {
        ClientClassification::Newer
    } else {
        ClientClassification::Supported
    }
}

pub fn format_client_range(range: &SupportedClientRange) -> String {
    format!(">={} <{}", range.min_version, range.max_version_exclusive)
}

pub fn compatibility_advice(
    client: Option<&str>,
    service: &str,
    range: &SupportedClientRange,
) -> Option<String> {
    let classification = classify_client(client, range);
    let description = format!(
        "service Autobuild {service} supports clients {}",
        format_client_range(range)
    );
    match classification {
        ClientClassification::Supported => None,
        ClientClassification::Newer => {
            let version = release_version(client).expect("classified canonical version");
            Some(format!("{description}; upgrade the service to at least {}.{}.0 before upgrading projects (service first)", version.major, version.minor))
        }
        ClientClassification::Older => Some(format!(
            "{description}; upgrade the project's Autobuild into {}",
            format_client_range(range)
        )),
        ClientClassification::Invalid => Some(format!(
            "{description}; supply a canonical Autobuild client version"
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceIdentity {
    pub autobuild_version: String,
    pub protocol_version: String,
    pub catalog_identity: String,
    pub supported_client_range: SupportedClientRange,
    pub release_line_protocols: BTreeMap<String, String>,
}
impl ServiceIdentity {
    pub fn current() -> &'static Self {
        #[derive(Deserialize)]
        struct Input {
            service: ServiceIdentity,
        }
        static IDENTITY: OnceLock<ServiceIdentity> = OnceLock::new();
        IDENTITY.get_or_init(|| {
            serde_json::from_str::<Input>(GENERATED)
                .expect("checked generated protocol identity")
                .service
        })
    }
}

pub fn client_identity_error(
    client: Option<&str>,
    protocol: Option<&str>,
    service_version: &str,
    service_protocol: &str,
) -> Result<Option<String>, &'static str> {
    let range = supported_client_range(service_version)?;
    let service = release_version(Some(service_version))
        .ok_or("service must have a canonical release version")?;
    let advice = compatibility_advice(client, service_version, &range);
    let expected = release_version(client).and_then(|parsed| {
        if parsed.major == service.major && parsed.minor == service.minor {
            Some(service_protocol)
        } else {
            ServiceIdentity::current()
                .release_line_protocols
                .get(&format!("{}.{}", parsed.major, parsed.minor))
                .map(String::as_str)
        }
    });
    if advice.is_none() && expected.is_some() && protocol == expected {
        return Ok(None);
    }
    let message = advice.unwrap_or_else(|| {
        format!(
            "supported clients {}; unsupported protocol identity",
            format_client_range(&range)
        )
    });
    Ok(Some(format!(
        "remote store version mismatch: client Autobuild {} protocol {}; server Autobuild {service_version} protocol {service_protocol}; {message}",
        client.unwrap_or("(missing)"), protocol.unwrap_or("(missing)")
    )))
}

/// Public liveness response: no backend, auth, or client identity dependency.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolHealth<'a> {
    pub ok: bool,
    pub autobuild_version: &'a str,
    pub protocol_version: &'a str,
    pub supported_client_range: &'a SupportedClientRange,
}

pub fn health_body() -> ProtocolHealth<'static> {
    let identity = ServiceIdentity::current();
    ProtocolHealth {
        ok: true,
        autobuild_version: &identity.autobuild_version,
        protocol_version: &identity.protocol_version,
        supported_client_range: &identity.supported_client_range,
    }
}

pub async fn health() -> axum::Json<ProtocolHealth<'static>> {
    axum::Json(health_body())
}

pub fn current_identity_error(client: Option<&str>, protocol: Option<&str>) -> Option<String> {
    let identity = ServiceIdentity::current();
    client_identity_error(
        client,
        protocol,
        &identity.autobuild_version,
        &identity.protocol_version,
    )
    .expect("generated service version is canonical")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn generated_typescript_release_and_audit_oracles_match() {
        let input: Value = serde_json::from_str(GENERATED).unwrap();
        for row in input["versions"].as_array().unwrap() {
            let value = row["input"].as_str();
            assert_eq!(
                json!(release_version(value).is_some()),
                row["release"],
                "{row}"
            );
            assert_eq!(
                json!(stable_version(value).is_some()),
                row["stable"],
                "{row}"
            );
            assert_eq!(
                json!(client_supports_integration_audit_pending(value)),
                row["integrationAuditPending"],
                "{row}"
            );
        }
    }

    #[test]
    fn generated_typescript_ranges_classifications_and_advice_match() {
        let input: Value = serde_json::from_str(GENERATED).unwrap();
        for row in input["ranges"].as_array().unwrap() {
            let service = row["serviceVersion"].as_str().unwrap();
            let range = supported_client_range(service).unwrap();
            assert_eq!(json!(range), row["range"]);
            for client in row["clients"].as_array().unwrap() {
                let version = client["client"].as_str();
                assert_eq!(
                    json!(classify_client(version, &range)),
                    client["classification"],
                    "{row}"
                );
                assert_eq!(
                    json!(compatibility_advice(version, service, &range)),
                    client["advice"],
                    "{client}"
                );
            }
        }
    }

    #[test]
    fn generated_typescript_identity_errors_and_refusal_bodies_match() {
        let input: Value = serde_json::from_str(GENERATED).unwrap();
        for row in input["identities"].as_array().unwrap() {
            let error = client_identity_error(
                row["client"].as_str(),
                row["protocol"].as_str(),
                row["serviceVersion"].as_str().unwrap(),
                row["serviceProtocol"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(json!(error), row["error"], "{row}");
            assert_eq!(
                json!(if error.is_some() { 409 } else { 200 }),
                row["status"]
            );
            let body = error.map(|error| json!({"kind": "conflict", "error": error}));
            assert_eq!(json!(body), row["body"]);
        }
    }

    #[tokio::test]
    async fn health_http_matches_public_typescript_shape_without_backend() {
        use axum::{body::Body, http::Request, routing::get, Router};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let response = Router::new()
            .route("/health", get(health))
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "application/json");
        for header in [
            "x-autobuild-version",
            "x-autobuild-protocol-version",
            "x-autobuild-catalog-identity",
        ] {
            assert!(!response.headers().contains_key(header));
        }
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let input: Value = serde_json::from_str(GENERATED).unwrap();
        assert_eq!(body, input["health"]);
    }

    #[test]
    fn current_identity_and_invalid_service_versions() {
        let identity = ServiceIdentity::current();
        assert_eq!(
            supported_client_range(&identity.autobuild_version).unwrap(),
            identity.supported_client_range
        );
        assert_eq!(
            current_identity_error(
                Some(&identity.autobuild_version),
                Some(&identity.protocol_version)
            ),
            None
        );
        assert_eq!(identity.catalog_identity.len(), 64);
        assert!(supported_client_range("1.0.0+build").is_err());
    }
}
