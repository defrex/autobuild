//! Release-line admission, matching core/store/remote/compatibility.ts.
use super::error::OperatorError;
use axum::http::HeaderMap;
use semver::Version;

pub const VERSION_HEADER: &str = "x-autobuild-version";
pub const PROTOCOL_HEADER: &str = "x-autobuild-protocol-version";
pub const PROTOCOL_VERSION: &str = "5";

pub fn service_version() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../../../../package.json"))
        .expect("repository package manifest")["version"]
        .as_str()
        .expect("package version")
        .to_owned()
}
fn release(value: &str) -> Option<Version> {
    // node-semver's parser is capped at 256 bytes and safe-integer components.
    if value.len() > 256 || value.contains('+') {
        return None;
    }
    let parsed = Version::parse(value).ok()?;
    if parsed.to_string() != value
        || [parsed.major, parsed.minor, parsed.patch]
            .into_iter()
            .any(|n| n > 9_007_199_254_740_991)
    {
        return None;
    }
    Some(parsed)
}
pub fn identity_error(
    client: Option<&str>,
    protocol: Option<&str>,
    service: &str,
    service_protocol: &str,
) -> Option<String> {
    let server = release(service).expect("canonical service version");
    let minimum = server.minor.saturating_sub(2);
    let range = format!(
        ">={}.{}.0 <{}.{}.0",
        server.major,
        minimum,
        server.major,
        server.minor + 1
    );
    let description = format!("service Autobuild {service} supports clients {range}");
    let parsed = client.and_then(release);
    let advice = match parsed.as_ref() {
        None => Some(format!("{description}; supply a canonical Autobuild client version")),
        Some(v) if (v.major,v.minor) < (server.major,minimum) => Some(format!("{description}; upgrade the project's Autobuild into {range}")),
        Some(v) if (v.major,v.minor) >= (server.major,server.minor+1) => Some(format!("{description}; upgrade the service to at least {}.{}.0 before upgrading projects (service first)",v.major,v.minor)),
        _ => None,
    };
    let expected = parsed.as_ref().and_then(|v| {
        if (v.major, v.minor) == (server.major, server.minor) {
            Some(service_protocol)
        } else {
            match (v.major, v.minor) {
                (0, 9..=13) => Some("3"),
                (0, 14) => Some("4"),
                _ => None,
            }
        }
    });
    if advice.is_none() && expected.is_some() && expected == protocol {
        return None;
    }
    Some(format!("remote store version mismatch: client Autobuild {} protocol {}; server Autobuild {service} protocol {service_protocol}; {}",client.unwrap_or("(missing)"),protocol.unwrap_or("(missing)"),advice.unwrap_or_else(||format!("supported clients {range}; unsupported protocol identity"))))
}
pub fn check_identity(headers: &HeaderMap) -> Result<(), OperatorError> {
    let value = |name| headers.get(name).and_then(|v| v.to_str().ok());
    match identity_error(
        value(VERSION_HEADER),
        value(PROTOCOL_HEADER),
        &service_version(),
        PROTOCOL_VERSION,
    ) {
        None => Ok(()),
        Some(error) => Err(OperatorError::new(409, "conflict", error)),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn historical_lines_keep_their_protocol_identity() {
        for (client, protocol) in [
            ("0.13.99", "3"),
            ("0.14.1", "4"),
            ("0.15.0", "5"),
            ("0.13.0-beta.0", "3"),
        ] {
            assert_eq!(
                identity_error(Some(client), Some(protocol), "0.15.0", "5"),
                None
            );
        }
        assert!(identity_error(Some("0.14.1"), Some("5"), "0.15.0", "5")
            .unwrap()
            .ends_with("unsupported protocol identity"));
        assert!(identity_error(Some("0.12.9"), Some("3"), "0.15.0", "5")
            .unwrap()
            .contains("upgrade the project's Autobuild"));
        assert!(identity_error(Some("0.16.0"), Some("5"), "0.15.0", "5")
            .unwrap()
            .contains("service first"));
    }
    #[test]
    fn current_major_has_no_invented_historical_identity() {
        assert_eq!(identity_error(Some("1.0.1"), Some("5"), "1.0.1", "5"), None);
        assert!(identity_error(Some("2.0.0"), Some("5"), "2.1.0", "5")
            .unwrap()
            .ends_with("unsupported protocol identity"));
        for client in ["v1.0.1", " 1.0.1", "1.0.01", "1.0.1+build", "1.0.1-01"] {
            assert!(identity_error(Some(client), Some("5"), "1.0.1", "5")
                .unwrap()
                .contains("canonical Autobuild client version"));
        }
    }
}

#[cfg(test)]
mod oracle_tests {
    use super::*;
    #[test]
    fn identity_failures_match_typescript_http_corpus() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/operator-corpus.json")).unwrap();
        let mut count = 0;
        for fixture in corpus["fixtures"].as_array().unwrap() {
            if !fixture["scenario"]["id"]
                .as_str()
                .unwrap()
                .starts_with("identity-")
            {
                continue;
            }
            for observation in fixture["observations"].as_array().unwrap() {
                let request = &observation["request"];
                let current_version = service_version();
                let actual = identity_error(
                    request
                        .get("version")
                        .map_or(Some(current_version.as_str()), |value| value.as_str()),
                    request
                        .get("protocol")
                        .map_or(Some(PROTOCOL_VERSION), |value| value.as_str()),
                    &service_version(),
                    PROTOCOL_VERSION,
                )
                .unwrap();
                assert_eq!(observation["status"], 409);
                assert_eq!(
                    observation["body"],
                    serde_json::json!({"kind":"conflict","error":actual}),
                    "{}",
                    fixture["scenario"]["id"]
                );
                count += 1;
            }
        }
        assert!(count >= 4);
    }
}
