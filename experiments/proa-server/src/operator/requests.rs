//! Session request names share the source-derived strict operator validator.
use super::error::OperatorError;
use serde_json::Value;
pub fn session_body(bytes: &[u8], operation: &str) -> Result<Value, OperatorError> {
    let name = match operation {
        "create" => "sessionCreateRequestSchema",
        "message" => "sessionMessageRequestSchema",
        "wake" => "sessionWakeRequestSchema",
        "approval" => "sessionApprovalRequestSchema",
        _ => return Err(OperatorError::internal()),
    };
    super::request_schema::parse(name, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replays_typescript_session_validation_bytes() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/operator-corpus.json")).unwrap();
        let mut count = 0;
        for fixture in corpus["fixtures"].as_array().unwrap() {
            let id = fixture["scenario"]["id"].as_str().unwrap();
            let operation = if id.starts_with("session-create") {
                "create"
            } else if id.starts_with("session-message") {
                "message"
            } else if id == "session-wake-invalid" {
                "wake"
            } else {
                continue;
            };
            let observation = &fixture["observations"][0];
            if observation["status"] != 400 {
                continue;
            }
            let request = &fixture["scenario"]["requests"][0];
            let bytes = match request["rawBody"].as_str() {
                Some(raw) => raw.as_bytes().to_vec(),
                None => serde_json::to_vec(&request["body"]).unwrap(),
            };
            let error = session_body(&bytes, operation).unwrap_err();
            assert_eq!(
                serde_json::to_value(error).unwrap(),
                observation["body"],
                "{id}"
            );
            count += 1;
        }
        assert!(count >= 5);
    }
}
