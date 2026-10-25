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
fn custom(path: &[Value], message: &str, issues: &mut Vec<Value>) {
    issues.push(json!({"code":"custom","path":path,"message":message}));
}
fn enumeration(value: Option<&Value>, path: &[Value], values: &[&str], issues: &mut Vec<Value>) {
    if !value
        .and_then(Value::as_str)
        .is_some_and(|v| values.contains(&v))
    {
        let names = values
            .iter()
            .map(|v| format!("\"{v}\""))
            .collect::<Vec<_>>()
            .join("|");
        issues.push(json!({"code":"invalid_value","values":values,"path":path,"message":format!("Invalid option: expected one of {names}")}));
    }
}
fn patch(value: Option<&Value>, path: &[Value], draft: bool, issues: &mut Vec<Value>) {
    let Some(input) = object(value, path, issues) else {
        return;
    };
    for key in ["kind", "target", "title", "body", "labels", "blockedBy"] {
        if key == "blockedBy" && !draft {
            continue;
        }
        let value = input.get(key);
        if value.is_none() && (!draft || !["title", "body"].contains(&key)) {
            continue;
        }
        let mut p = path.to_vec();
        p.push(json!(key));
        match key {
            "kind" => enumeration(value, &p, &["work", "node"], issues),
            "target" => {
                if value != Some(&Value::Null) {
                    string(value, &p, false, issues);
                    if value
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.trim_matches(crate::operator::auth::js_space).is_empty())
                    {
                        custom(&p, "Invalid input", issues);
                    }
                }
            }
            "labels" | "blockedBy" => strings(value, &p, false, issues),
            _ => string(value, &p, false, issues),
        }
    }
    unknown(
        input,
        if draft {
            &["kind", "target", "title", "body", "labels", "blockedBy"]
        } else {
            &["kind", "target", "title", "body", "labels"]
        },
        path,
        issues,
    );
    // Zod refinements run after non-aborting issues (unknown keys), but not
    // after a field's invalid type. This empty-object branch has no such issue.
    if !draft && input.is_empty() {
        custom(path, "update must name at least one field", issues);
    }
}
fn mutation(value: Option<&Value>, path: &[Value], issues: &mut Vec<Value>) {
    let Some(input) = object(value, path, issues) else {
        return;
    };
    let mut p = path.to_vec();
    p.push(json!("kind"));
    match input.get("kind").and_then(Value::as_str) {
        Some("update")=>{p.pop();p.push(json!("patch"));patch(input.get("patch"),&p,false,issues);unknown(input,&["kind","patch"],path,issues);},
        Some("transition")=>{p.pop();p.push(json!("state"));string(input.get("state"),&p,true,issues);unknown(input,&["kind","state"],path,issues);},
        Some("blockers")=>{
            p.pop();p.push(json!("operation"));enumeration(input.get("operation"),&p,&["block","unblock"],issues);
            p.pop();p.push(json!("ids"));strings(input.get("ids"),&p,true,issues);unknown(input,&["kind","operation","ids"],path,issues);
        },
        _=>issues.push(json!({"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":"kind","options":["update","transition","blockers"],"path":p,"message":"Invalid discriminator value. Expected 'update' | 'transition' | 'blockers'"})),
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
                "get" | "claim" => {
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
                "add-state" => {
                    string(
                        input.get("name"),
                        &[json!("input"), json!("name")],
                        false,
                        &mut issues,
                    );
                    if let Some(about) = input.get("about") {
                        string(
                            Some(about),
                            &[json!("input"), json!("about")],
                            false,
                            &mut issues,
                        );
                    }
                    unknown(input, &["name", "about"], &[json!("input")], &mut issues);
                }
                "comment" | "transition" | "add-blocker" | "remove-blocker" => {
                    string(
                        input.get("id"),
                        &[json!("input"), json!("id")],
                        true,
                        &mut issues,
                    );
                    let key = match operation {
                        "comment" => "body",
                        "transition" => "state",
                        _ => "blockerId",
                    };
                    string(
                        input.get(key),
                        &[json!("input"), json!(key)],
                        key != "body",
                        &mut issues,
                    );
                    unknown(input, &["id", key], &[json!("input")], &mut issues);
                }
                "update" => {
                    string(
                        input.get("id"),
                        &[json!("input"), json!("id")],
                        true,
                        &mut issues,
                    );
                    patch(
                        input.get("patch"),
                        &[json!("input"), json!("patch")],
                        false,
                        &mut issues,
                    );
                    unknown(input, &["id", "patch"], &[json!("input")], &mut issues);
                }
                "create" => {
                    patch(
                        input.get("draft"),
                        &[json!("input"), json!("draft")],
                        true,
                        &mut issues,
                    );
                    if let Some(options) = input.get("options") {
                        if let Some(options) = object(
                            Some(options),
                            &[json!("input"), json!("options")],
                            &mut issues,
                        ) {
                            for key in ["requestedId", "state", "idempotencyKey"] {
                                if let Some(v) = options.get(key) {
                                    string(
                                        Some(v),
                                        &[json!("input"), json!("options"), json!(key)],
                                        key == "requestedId",
                                        &mut issues,
                                    );
                                }
                            }
                            unknown(
                                options,
                                &["requestedId", "state", "idempotencyKey"],
                                &[json!("input"), json!("options")],
                                &mut issues,
                            );
                        }
                    }
                    unknown(input, &["draft", "options"], &[json!("input")], &mut issues);
                }
                "mutate-if-revision" => {
                    string(
                        input.get("id"),
                        &[json!("input"), json!("id")],
                        true,
                        &mut issues,
                    );
                    let path = [json!("input"), json!("expectedRevision")];
                    string(input.get("expectedRevision"), &path, false, &mut issues);
                    if input
                        .get("expectedRevision")
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.trim_matches(crate::operator::auth::js_space).is_empty())
                    {
                        custom(&path, "Invalid input", &mut issues);
                    }
                    mutation(
                        input.get("mutation"),
                        &[json!("input"), json!("mutation")],
                        &mut issues,
                    );
                    unknown(
                        input,
                        &["id", "expectedRevision", "mutation"],
                        &[json!("input")],
                        &mut issues,
                    );
                }
                _ => unreachable!("known hosted ticket operations"),
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
            let actual = issues(operation, &case["request"]);
            let expected = case.get("issues").cloned().unwrap_or_else(|| json!([]));
            assert_eq!(json!(actual), expected, "{} {}", operation, case["name"]);
        }
    }
}
