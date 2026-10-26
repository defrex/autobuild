//! Release-line admission, matching core/store/remote/compatibility.ts.
use super::error::OperatorError;
use axum::http::HeaderMap;

pub const VERSION_HEADER: &str = "x-autobuild-version";
pub const PROTOCOL_HEADER: &str = "x-autobuild-protocol-version";
pub fn protocol_version() -> &'static str {
    &crate::protocol::identity::ServiceIdentity::current().protocol_version
}

pub fn service_version() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../../../../package.json"))
        .expect("repository package manifest")["version"]
        .as_str()
        .expect("package version")
        .to_owned()
}
pub fn identity_error(
    client: Option<&str>,
    protocol: Option<&str>,
    service: &str,
    service_protocol: &str,
) -> Option<String> {
    crate::protocol::identity::client_identity_error(client, protocol, service, service_protocol)
        .expect("canonical service version")
}
pub fn check_identity(headers: &HeaderMap) -> Result<(), OperatorError> {
    let value = |name| headers.get(name).and_then(|v| v.to_str().ok());
    match identity_error(
        value(VERSION_HEADER),
        value(PROTOCOL_HEADER),
        &service_version(),
        protocol_version(),
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
                        .map_or(Some(protocol_version()), |value| value.as_str()),
                    &service_version(),
                    protocol_version(),
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
