//! Strict actor/type prefix of the append validator.
//!
//! This gate is deliberately NOT a complete write validator: callers must still
//! validate payloads, compatibility and cross-field rules before mutation. It
//! never invokes the forward-compatible stored-event decoder.
pub mod lossless;
pub mod lossless_writes;
pub mod session;
pub mod writes;
use serde_json::{json, Value};
use std::sync::OnceLock;

#[derive(Clone, Copy)]
pub enum WriteScope {
    Build,
    Repository,
    Session,
}
impl WriteScope {
    fn name(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Repository => "repository",
            Self::Session => "session",
        }
    }
}
fn rules() -> &'static Value {
    static RULES: OnceLock<Value> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/protocol-write-rules.json"))
            .expect("generated actor/type catalog")
    })
}
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
fn string_field(object: &Value, key: &str, path: &[&str], issues: &mut Vec<Value>) {
    let value = object.get(key);
    match value.and_then(Value::as_str) {
        Some("") => issues.push(json!({
            "origin": "string", "code": "too_small", "minimum": 1,
            "inclusive": true, "path": path,
            "message": "Too small: expected string to have >=1 characters"
        })),
        Some(_) => (),
        None => issues.push(json!({
            "expected": "string", "code": "invalid_type", "path": path,
            "message": format!("Invalid input: expected string, received {}", received(value))
        })),
    }
}
fn unknown_keys(object: &Value, keys: &[&str], path: &[&str], issues: &mut Vec<Value>) {
    let extras: Vec<&str> = object
        .as_object()
        .expect("object checked by caller")
        .keys()
        .filter(|key| !keys.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if extras.is_empty() {
        return;
    }
    let quoted = extras
        .iter()
        .map(|key| serde_json::to_string(key).unwrap())
        .collect::<Vec<_>>()
        .join(", ");
    issues.push(json!({
        "code": "unrecognized_keys", "keys": extras, "path": path,
        "message": format!("Unrecognized key{}: {quoted}", if extras.len() == 1 { "" } else { "s" })
    }));
}
fn object_discriminator<'a>(
    value: Option<&'a Value>,
    options: &[&str],
    path: &[&str],
    issues: &mut Vec<Value>,
) -> Option<&'a str> {
    let Some(object) = value.filter(|value| value.is_object()) else {
        issues.push(json!({
            "code": "invalid_type", "expected": "object", "path": path,
            "message": format!("Invalid input: expected object, received {}", received(value))
        }));
        return None;
    };
    let kind = object.get("kind").and_then(Value::as_str);
    if kind.is_some_and(|kind| options.contains(&kind)) {
        return kind;
    }
    let mut field_path = path.to_vec();
    field_path.push("kind");
    let expected = options
        .iter()
        .map(|kind| format!("'{kind}'"))
        .collect::<Vec<_>>()
        .join(" | ");
    issues.push(json!({
        "code": "invalid_union", "errors": [], "note": "No matching discriminator",
        "discriminator": "kind", "options": options, "path": field_path,
        "message": format!("Invalid discriminator value. Expected {expected}")
    }));
    None
}
fn actor_issues(actor: Option<&Value>) -> Vec<Value> {
    let mut issues = Vec::new();
    let Some(kind) = object_discriminator(
        actor,
        &["kernel", "agent", "human", "dispatcher", "ingester"],
        &[],
        &mut issues,
    ) else {
        return issues;
    };
    let actor = actor.unwrap();
    let keys: &[&str] = match kind {
        "agent" => {
            string_field(actor, "role", &["role"], &mut issues);
            string_field(actor, "session", &["session"], &mut issues);
            &["kind", "role", "session"]
        }
        "human" => {
            string_field(actor, "user", &["user"], &mut issues);
            if let Some(via) = actor.get("via") {
                if let Some(kind) =
                    object_discriminator(Some(via), &["session", "mcp"], &["via"], &mut issues)
                {
                    let field = if kind == "session" { "id" } else { "client" };
                    string_field(via, field, &["via", field], &mut issues);
                    unknown_keys(via, &["kind", field], &["via"], &mut issues);
                }
            }
            &["kind", "user", "via"]
        }
        "ingester" => {
            string_field(actor, "source", &["source"], &mut issues);
            &["kind", "source"]
        }
        _ => &["kind"],
    };
    unknown_keys(actor, keys, &[], &mut issues);
    issues
}
/// Match the core validator's ordering: catalog, via rule, strict actor parsing,
/// then allowed actor kinds. Success says nothing about the payload's validity.
pub fn validate_actor_type(scope: WriteScope, input: &Value) -> Result<(), String> {
    let kind = input["type"]
        .as_str()
        .ok_or("event type must be a string")?;
    let catalog = &rules()[scope.name()];
    let Some(allowed) = catalog.get(kind).and_then(Value::as_array) else {
        let family = match scope {
            WriteScope::Build => "",
            WriteScope::Repository => "repository ",
            WriteScope::Session => "session ",
        };
        let known = catalog
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "unknown {family}event type \"{kind}\" — known types: {known}"
        ));
    };
    let actor = input.get("actor");
    if actor.is_some_and(|actor| {
        actor.is_object() && actor.get("via").is_some() && actor["kind"] != "human"
    }) {
        return Err("only human actors may carry via".to_owned());
    }
    let issues = actor_issues(actor);
    if !issues.is_empty() {
        return Err(format!(
            "invalid actor for \"{kind}\": {}",
            serde_json::to_string_pretty(&issues).unwrap()
        ));
    }
    let actor_kind = actor.unwrap()["kind"].as_str().unwrap();
    if !allowed.iter().any(|value| value == actor_kind) {
        let allowed = allowed
            .iter()
            .map(|kind| kind.as_str().unwrap())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "actor kind \"{actor_kind}\" may not emit \"{kind}\" (allowed: {allowed})"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;

    #[test]
    fn actor_and_type_prefix_matches_typescript_exact_refusals() {
        let mut input = String::new();
        GzDecoder::new(include_bytes!("../../fixtures/protocol-writes.json.gz").as_slice())
            .read_to_string(&mut input)
            .unwrap();
        let corpus: Value = serde_json::from_str(&input).unwrap();
        let mut checked = 0;
        for case in corpus["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            if !id.contains("/actor/")
                && !id.contains("unknown-type-before-via")
                && !id.ends_with("/valid")
            {
                continue;
            }
            let scope = match case["scope"].as_str().unwrap() {
                "build" => WriteScope::Build,
                "repository" => WriteScope::Repository,
                "session" => WriteScope::Session,
                _ => unreachable!(),
            };
            let result = validate_actor_type(scope, &case["input"]);
            let expected = case["oracle"]["rejected"]["message"].as_str();
            match expected {
                Some(message)
                    if message.starts_with("unknown ")
                        || message.starts_with("invalid actor ")
                        || message.starts_with("actor kind ")
                        || message == "only human actors may carry via" =>
                {
                    assert_eq!(result, Err(message.to_owned()), "{id}");
                }
                _ => assert_eq!(result, Ok(()), "{id}"),
            }
            checked += 1;
        }
        assert!(
            checked > 2000,
            "actor catalog coverage unexpectedly shrank: {checked}"
        );
    }
}

/// Interpret an experiment-generated closed schema, retaining exact Zod diagnostics.
pub fn validate_schema(schema: &Value, input: &Value) -> Result<Value, String> {
    let mut issues = Vec::new();
    let (value, _) = session::parse(schema, Some(input), &mut Vec::new(), &mut issues);
    if issues.is_empty() {
        Ok(value.expect("closed schema output"))
    } else {
        Err(serde_json::to_string_pretty(&issues).unwrap())
    }
}

/// Parse one of the closed wire request schemas, preserving Zod's stripping
/// behavior and exact diagnostics. This is body parsing, not event validation.
pub fn validate_request(name: &str, input: &Value) -> Result<Value, String> {
    static SCHEMAS: OnceLock<Value> = OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/protocol-request-schemas.json"))
            .expect("generated request schemas")
    });
    let schema = schemas
        .get(name)
        .ok_or_else(|| format!("unknown request schema \"{name}\""))?;
    let mut issues = Vec::new();
    let (value, _) = session::parse(schema, Some(input), &mut Vec::new(), &mut issues);
    if issues.is_empty() {
        Ok(value.expect("request body schema output"))
    } else {
        Err(serde_json::to_string_pretty(&issues).unwrap())
    }
}

#[cfg(test)]
mod request_tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;
    #[test]
    fn wire_request_schemas_match_zod_normalization_and_diagnostics() {
        let mut data = String::new();
        GzDecoder::new(include_bytes!("../../fixtures/protocol-writes.json.gz").as_slice())
            .read_to_string(&mut data)
            .unwrap();
        let corpus: Value = serde_json::from_str(&data).unwrap();
        let cases = corpus["requests"].as_array().unwrap();
        assert!(cases.len() > 100);
        for case in cases {
            let actual = validate_request(case["name"].as_str().unwrap(), &case["input"]);
            let expected = if let Some(message) = case["oracle"]["rejected"]["message"].as_str() {
                Err(message.to_owned())
            } else {
                Ok(case["oracle"]["accepted"].clone())
            };
            assert_eq!(actual, expected, "{}", case["id"]);
        }
    }
}

/// Payload parsing coverage is explicit. Unsupported schemas never fall through
/// to acceptance; full append handlers must still enforce actor, compatibility
/// and any catalog-level rules before constructing a writable event.
#[derive(Debug, PartialEq)]
pub enum PayloadValidationError {
    Unsupported(String),
    Invalid(String),
}
pub fn validate_catalog_payload(
    scope: WriteScope,
    kind: &str,
    input: &Value,
) -> Result<Value, PayloadValidationError> {
    validate_catalog_payload_optional(scope, kind, Some(input))
}
pub fn validate_catalog_payload_optional(
    scope: WriteScope,
    kind: &str,
    input: Option<&Value>,
) -> Result<Value, PayloadValidationError> {
    static SCHEMAS: OnceLock<Value> = OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/protocol-payload-schemas.json"))
            .expect("generated catalog payload schemas")
    });
    let Some(schema) = schemas["supported"][scope.name()].get(kind) else {
        let reason = schemas["unsupported"][scope.name()][kind]
            .as_str()
            .unwrap_or("unknown payload schema");
        return Err(PayloadValidationError::Unsupported(reason.to_owned()));
    };
    let mut issues = Vec::new();
    let (value, _) = session::parse(schema, input, &mut Vec::new(), &mut issues);
    if issues.is_empty() {
        Ok(value.unwrap())
    } else {
        Err(PayloadValidationError::Invalid(format!(
            "invalid payload for \"{kind}\": {}",
            serde_json::to_string_pretty(&issues).unwrap()
        )))
    }
}
#[cfg(test)]
mod payload_tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;
    #[test]
    fn supported_catalog_payloads_match_oracle_exactly_and_unsupported_fail_closed() {
        let mut data = String::new();
        GzDecoder::new(include_bytes!("../../fixtures/protocol-writes.json.gz").as_slice())
            .read_to_string(&mut data)
            .unwrap();
        let corpus: Value = serde_json::from_str(&data).unwrap();
        let schemas: Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-payload-schemas.json"))
                .unwrap();
        let mut count = 0;
        for case in corpus["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            if case["scope"] == "session"
                || !(id.contains("/payload/")
                    || (id.ends_with("/valid") && !id.contains("/compatibility/")))
            {
                continue;
            }
            let scope = if case["scope"] == "build" {
                WriteScope::Build
            } else {
                WriteScope::Repository
            };
            let kind = case["input"]["type"].as_str().unwrap();
            let actual =
                validate_catalog_payload_optional(scope, kind, case["input"].get("payload"));
            if schemas["unsupported"][scope.name()].get(kind).is_some() {
                assert!(
                    matches!(actual, Err(PayloadValidationError::Unsupported(_))),
                    "{id}"
                );
                continue;
            }
            let expected = if let Some(message) = case["oracle"]["rejected"]["message"].as_str() {
                Err(PayloadValidationError::Invalid(message.to_owned()))
            } else {
                Ok(case["oracle"]["accepted"]["payload"].clone())
            };
            assert_eq!(actual, expected, "{id}");
            count += 1;
        }
        assert!(
            count > 1000,
            "supported payload corpus unexpectedly shrank: {count}"
        );
    }
}
