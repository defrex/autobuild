//! Strict producer boundary: payload validation, catalog authority, then writer
//! compatibility stamping. Never use persisted-event projection for new facts.
use super::{
    validate_actor_type, validate_catalog_payload_optional, PayloadValidationError, WriteScope,
};
use serde_json::{json, Value};
use std::sync::OnceLock;

fn fixture() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../fixtures/protocol-write-preparation.json"
        ))
        .expect("generated producer policy")
    })
}
fn stamp_compatibility(
    scope: WriteScope,
    kind: &str,
    supplied: Option<&Value>,
) -> Result<Value, String> {
    let scope = match scope {
        WriteScope::Build => "build",
        WriteScope::Repository => "repository",
        WriteScope::Session => return Err("session writes have no compatibility metadata".into()),
    };
    let classification = fixture()["policies"][scope][kind]
        .as_str()
        .expect("complete catalog policy");
    let Some(supplied) = supplied else {
        return Ok(
            json!({"writerVersion":fixture()["writerVersion"],"classification":classification}),
        );
    };
    let mut issues = Vec::new();
    let (metadata, _) = super::session::parse(
        &fixture()["compatibilitySchema"],
        Some(supplied),
        &mut Vec::new(),
        &mut issues,
    );
    if !issues.is_empty() {
        return Err(format!(
            "invalid compatibility metadata: {}",
            serde_json::to_string_pretty(&issues).unwrap()
        ));
    }
    let metadata = metadata.unwrap();
    if metadata["classification"] != classification {
        return Err("invalid compatibility metadata: event compatibility classification disagrees with catalog".into());
    }
    Ok(metadata)
}
fn escalation_rules(actor: &Value, payload: &Value) -> Result<(), String> {
    if actor["kind"] == "dispatcher"
        && (payload["source"] != "policy"
            || !matches!(
                payload["policyCause"].as_str(),
                Some(
                    "infrastructure-failure-limit"
                        | "dispatch-failure-limit"
                        | "execution-no-progress"
                )
            ))
    {
        return Err("invalid dispatcher escalation: only policy/infrastructure-failure-limit or policy/dispatch-failure-limit or policy/execution-no-progress may be raised outside the kernel".into());
    }
    if payload["source"] == "policy" && payload.get("policyCause").is_none() {
        return Err("invalid payload for \"escalation.raised\": source \"policy\" requires a recognized policyCause".into());
    }
    if payload["source"] != "policy" && payload.get("policyCause").is_some() {
        let source = payload
            .get("source")
            .map(|source| serde_json::to_string(source).unwrap())
            .unwrap_or_else(|| "undefined".into());
        return Err(format!("invalid payload for \"escalation.raised\": policyCause is only allowed when source is \"policy\", not {source}"));
    }
    Ok(())
}
fn prepare(scope: WriteScope, input: &Value) -> Result<Value, String> {
    validate_actor_type(scope, input)?;
    let kind = input["type"].as_str().unwrap();
    let payload =
        validate_catalog_payload_optional(scope, kind, input.get("payload")).map_err(|error| {
            match error {
                PayloadValidationError::Invalid(message) => message,
                PayloadValidationError::Unsupported(reason) => {
                    format!("unsupported producer payload schema for \"{kind}\": {reason}")
                }
            }
        })?;
    if matches!(scope, WriteScope::Build) && kind == "escalation.raised" {
        escalation_rules(&input["actor"], &payload)?;
    }
    let compatibility = stamp_compatibility(scope, kind, input.get("compatibility"))?;
    Ok(json!({"actor":input["actor"],"type":kind,"payload":payload,"compatibility":compatibility}))
}
pub fn prepare_build_write(input: &Value) -> Result<Value, String> {
    prepare(WriteScope::Build, input)
}
pub fn prepare_repository_write(input: &Value) -> Result<Value, String> {
    prepare(WriteScope::Repository, input)
}
/// Full append validation includes identifying the actual producer when old
/// writers supply no envelope metadata, exactly as the TypeScript adapter does.
pub fn validate_build_write(input: &Value) -> Result<Value, String> {
    prepare_build_write(input)
}
pub fn validate_repository_write(input: &Value) -> Result<Value, String> {
    prepare_repository_write(input)
}

pub fn validate_created_event(input: &Value) -> Result<Option<Value>, String> {
    let Some(created) = input.get("created") else {
        return Ok(None);
    };
    let validated = prepare_build_write(created)?;
    if validated["type"] != "build.created" {
        return Err(format!(
            "createBuild's initial event must be \"build.created\", got \"{}\"",
            validated["type"].as_str().unwrap()
        ));
    }
    Ok(Some(validated))
}
fn js_number(number: &serde_json::Number) -> String {
    let Some(n) = number.as_f64().filter(|number| number.is_finite()) else {
        return if number.as_str().starts_with('-') {
            "-Infinity".into()
        } else {
            "Infinity".into()
        };
    };
    if n == 0.0 {
        return "0".into();
    }
    let decimal = n.abs().to_string();
    let sign = if n < 0.0 { "-" } else { "" };
    if (1e-6..1e21).contains(&n.abs()) {
        return format!("{sign}{decimal}");
    }
    let point = decimal.find('.').unwrap_or(decimal.len());
    let digits = decimal.replace('.', "");
    let first = digits.find(|c| c != '0').unwrap();
    let exponent = point as i32 - first as i32 - 1;
    let significant = digits[first..].trim_end_matches('0');
    let mantissa = if significant.len() == 1 {
        significant.to_owned()
    } else {
        format!("{}.{}", &significant[..1], &significant[1..])
    };
    format!(
        "{sign}{mantissa}e{}{exponent}",
        if exponent >= 0 { "+" } else { "" }
    )
}
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => js_number(value),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
/// Wire parsing already rejects invalid/unsafe values. The store helper retains
/// the core's Number.isInteger contract; values above a possible log tail remain
/// valid stale comparisons rather than spuriously rejecting old clients.
pub fn validate_expected_seq(value: &Value) -> Result<i64, String> {
    if let Some(number) = value
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0 && *number >= 0.0)
    {
        return Ok(number as i64);
    }
    Err(format!(
        "expectedSeq must be a nonnegative integer, got {}",
        js_string(value)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;
    #[test]
    fn invalid_nonfinite_expected_sequence_formats_without_panicking() {
        for (raw, expected) in [
            ("1e400", "Infinity"),
            ("-1e400", "-Infinity"),
            ("[1e400,-1e400]", "Infinity,-Infinity"),
        ] {
            let value = crate::protocol::js_json::parse_js_json(raw.as_bytes()).unwrap();
            assert_eq!(
                validate_expected_seq(&value).unwrap_err(),
                format!("expectedSeq must be a nonnegative integer, got {expected}")
            );
        }
    }
    #[test]
    fn prepared_writes_and_created_and_sequence_validation_match_typescript() {
        let mut checked = 0;
        for case in fixture()["cases"].as_array().unwrap() {
            let result = match case["scope"].as_str().unwrap() {
                "build" => prepare_build_write(&case["input"]),
                "repository" => prepare_repository_write(&case["input"]),
                "created" => {
                    validate_created_event(&case["input"]).map(|value| value.unwrap_or(Value::Null))
                }
                "expected-seq" => validate_expected_seq(&case["input"]).map(|_| Value::Bool(true)),
                _ => unreachable!(),
            };
            let expected = if let Some(message) = case["oracle"]["rejected"]["message"].as_str() {
                Err(message.to_owned())
            } else {
                Ok(case["oracle"]["accepted"].clone())
            };
            assert_eq!(result, expected, "{}", case["id"]);
            checked += 1;
        }
        assert!(checked >= 90);
    }
    #[test]
    fn wire_parsing_and_prepared_writes_match_the_http_append_oracle() {
        let mut bytes = String::new();
        GzDecoder::new(include_bytes!("../../../fixtures/protocol-writes.json.gz").as_slice())
            .read_to_string(&mut bytes)
            .unwrap();
        let corpus: Value = serde_json::from_str(&bytes).unwrap();
        let mut checked = 0;
        for case in corpus["cases"].as_array().unwrap() {
            let scope = case["scope"].as_str().unwrap();
            if scope == "session" {
                continue;
            }
            let actual = match super::super::validate_request("eventWrite", &case["input"]) {
                Err(message) => {
                    json!({"status":400,"body":{"kind":"validation","error":format!("invalid request body: {message}")}})
                }
                Ok(input) => match if scope == "build" {
                    prepare_build_write(&input)
                } else {
                    prepare_repository_write(&input)
                } {
                    Ok(value) => json!({"status":201,"body":value}),
                    Err(message) => {
                        json!({"status":422,"body":{"kind":"validation","error":message}})
                    }
                },
            };
            assert_eq!(actual, case["http"], "{}", case["id"]);
            checked += 1;
        }
        assert!(
            checked > 9000,
            "full build/repository append corpus unexpectedly shrank: {checked}"
        );
    }
}
