//! Exact Zod issue shapes for the read subset of hostedTicketRequestSchemas.
use crate::protocol::error::ProtocolError;
use serde_json::{json, Value};

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn object<'a>(
    value: Option<&'a Value>,
    path: &[Value],
    issues: &mut Vec<Value>,
) -> Option<&'a serde_json::Map<String, Value>> {
    match value.and_then(Value::as_object) {
        Some(value) => Some(value),
        None => {
            issues.push(json!({"expected":"object","code":"invalid_type","path":path,"message":format!("Invalid input: expected object, received {}",received(value))}));
            None
        }
    }
}
fn string(value: Option<&Value>, path: &[Value], nonempty: bool, issues: &mut Vec<Value>) {
    match value.and_then(Value::as_str) {
        Some("") if nonempty => issues.push(json!({"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":path,"message":"Too small: expected string to have >=1 characters"})),
        Some(_) => (),
        None => issues.push(json!({"expected":"string","code":"invalid_type","path":path,"message":format!("Invalid input: expected string, received {}",received(value))})),
    }
}
fn unknown(
    value: &serde_json::Map<String, Value>,
    allowed: &[&str],
    path: &[Value],
    issues: &mut Vec<Value>,
) {
    let keys = value
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return;
    }
    let names = keys
        .iter()
        .map(|key| serde_json::to_string(key).unwrap())
        .collect::<Vec<_>>()
        .join(", ");
    issues.push(json!({"code":"unrecognized_keys","keys":keys,"path":path,"message":format!("Unrecognized key{}: {names}",if keys.len()==1 {""} else {"s"})}));
}
fn strings(value: Option<&Value>, path: &[Value], nonempty: bool, issues: &mut Vec<Value>) {
    match value.and_then(Value::as_array) {
        Some(items) => for (index,item) in items.iter().enumerate() {
            let mut path=path.to_vec(); path.push(json!(index)); string(Some(item), &path, nonempty, issues);
        },
        None => issues.push(json!({"expected":"array","code":"invalid_type","path":path,"message":format!("Invalid input: expected array, received {}",received(value))})),
    }
}
pub(super) fn issues(operation: &str, raw: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    if let Some(envelope) = object(Some(raw), &[], &mut issues) {
        if let Some(context) = object(envelope.get("context"), &[json!("context")], &mut issues) {
            string(
                context.get("teamKey"),
                &[json!("context"), json!("teamKey")],
                true,
                &mut issues,
            );
            for key in ["repo", "claimedState", "createState"] {
                if let Some(value) = context.get(key) {
                    string(
                        Some(value),
                        &[json!("context"), json!(key)],
                        true,
                        &mut issues,
                    );
                }
            }
            unknown(
                context,
                &["teamKey", "repo", "claimedState", "createState"],
                &[json!("context")],
                &mut issues,
            );
        }
        if let Some(input) = object(envelope.get("input"), &[json!("input")], &mut issues) {
            match operation {
                "states" => unknown(input, &[], &[json!("input")], &mut issues),
                "get" => {
                    string(
                        input.get("id"),
                        &[json!("input"), json!("id")],
                        true,
                        &mut issues,
                    );
                    unknown(input, &["id"], &[json!("input")], &mut issues);
                }
                "list-ready" => {
                    if let Some(labels) = input.get("labels") {
                        strings(
                            Some(labels),
                            &[json!("input"), json!("labels")],
                            false,
                            &mut issues,
                        );
                    }
                    if let Some(state) = input.get("state") {
                        string(
                            Some(state),
                            &[json!("input"), json!("state")],
                            false,
                            &mut issues,
                        );
                    }
                    unknown(input, &["labels", "state"], &[json!("input")], &mut issues);
                }
                "dependency-states" => {
                    strings(
                        input.get("ids"),
                        &[json!("input"), json!("ids")],
                        true,
                        &mut issues,
                    );
                    unknown(input, &["ids"], &[json!("input")], &mut issues);
                }
                _ => unreachable!("read operations only"),
            }
        }
        unknown(envelope, &["context", "input"], &[], &mut issues);
    }
    issues
}
pub(super) fn validate(operation: &str, raw: &Value) -> Result<(), ProtocolError> {
    let issues = issues(operation, raw);
    if issues.is_empty() {
        Ok(())
    } else {
        Err(ProtocolError::validation(format!(
            "invalid request body: {}",
            serde_json::to_string_pretty(&issues).unwrap()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_read_request_matches_exported_typescript_schema_oracle() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../../fixtures/ticket-protocol.json")).unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let operation = case["operation"].as_str().unwrap();
            if !crate::protocol::tickets::READ_OPERATIONS.contains(&operation) {
                continue;
            }
            let actual = issues(operation, &case["request"]);
            let expected = case.get("issues").cloned().unwrap_or_else(|| json!([]));
            assert_eq!(json!(actual), expected, "{} {}", operation, case["name"]);
        }
    }
}
