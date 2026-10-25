//! Narrow source-generated operator schema interpreter. This is transport
//! validation, never lifecycle policy. Unsupported schema forms fail closed.
use super::{auth::js_space, error::OperatorError};
use serde_json::{json, Value};
use std::sync::OnceLock;
fn contract() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/operator-requests.json"))
            .expect("request contract")
    })
}
fn tool_contract() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/registry-corpus.json"))
            .expect("registry contract")
    })
}
#[derive(Default)]
struct Parsed {
    value: Option<Value>,
    issues: Vec<Value>,
    aborted: bool,
}
fn path_at(path: &[Value], key: Value) -> Vec<Value> {
    let mut p = path.to_vec();
    p.push(key);
    p
}
fn type_error(value: Option<&Value>, expected: &str, path: &[Value]) -> Value {
    let received = match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    json!({"expected":expected,"code":"invalid_type","path":path,"message":format!("Invalid input: expected {expected}, received {received}")})
}
fn invalid_enum(values: &[Value], path: &[Value]) -> Value {
    let text = values
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("|");
    json!({"code":"invalid_value","values":values,"path":path,"message":if values.len()==1 {format!("Invalid input: expected {text}")}else{format!("Invalid option: expected one of {text}")}})
}
fn validate(schema: &Value, input: Option<&Value>, path: &[Value]) -> Parsed {
    let mut result = Parsed {
        value: input.cloned(),
        ..Default::default()
    };
    if input.is_none() {
        if let Some(value) = schema.get("default") {
            result.value = Some(value.clone());
            return result;
        }
    }

    if let Some(branches) = schema.get("oneOf").and_then(Value::as_array) {
        if !input.is_some_and(Value::is_object) {
            let issue = type_error(input, "object", path);
            result.issues.push(json!({"code":"invalid_type","expected":"object","path":path,"message":issue["message"]}));
            result.aborted = true;
            return result;
        }
        if let Some(branch) = branches
            .iter()
            .find(|s| input.and_then(|v| v.get("action")) == s["properties"]["action"].get("const"))
        {
            return validate(branch, input, path);
        }
        let options: Vec<Value> = branches
            .iter()
            .map(|s| s["properties"]["action"]["const"].clone())
            .collect();
        let message = format!(
            "Invalid discriminator value. Expected {}",
            options
                .iter()
                .map(|s| format!("'{}'", s.as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
                .join(" | ")
        );
        result.issues.push(json!({"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":"action","options":options,"path":path_at(path,json!("action")),"message":message}));
        result.aborted = true;
        return result;
    }
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        if branches.len() == 2 && branches[1]["type"] == "null" {
            if input == Some(&Value::Null) {
                return result;
            }
            return validate(&branches[0], input, path);
        }

        let parsed: Vec<Parsed> = branches.iter().map(|s| validate(s, input, path)).collect();
        if let Some(i) = parsed.iter().position(|r| r.issues.is_empty()) {
            return parsed.into_iter().nth(i).unwrap();
        }
        let dirty: Vec<usize> = parsed
            .iter()
            .enumerate()
            .filter(|(_, r)| !r.aborted)
            .map(|(i, _)| i)
            .collect();
        if dirty.len() == 1 {
            return parsed.into_iter().nth(dirty[0]).unwrap();
        }
        result.issues.push(json!({"code":"invalid_union","errors":parsed.into_iter().map(|r|r.issues).collect::<Vec<_>>(),"path":path,"message":"Invalid input"}));
        result.aborted = true;
        return result;
    }
    if let Some(value) = schema.get("const") {
        if input != Some(value) {
            result
                .issues
                .push(invalid_enum(std::slice::from_ref(value), path));
            result.aborted = true;
        }
        return result;
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !input.is_some_and(|v| values.contains(v)) {
            result.issues.push(invalid_enum(values, path));
            result.aborted = true;
        }
        return result;
    }
    let kind = schema["type"].as_str().unwrap_or("");
    let valid = match kind {
        "object" => input.is_some_and(Value::is_object),
        "array" => input.is_some_and(Value::is_array),
        "string" => input.is_some_and(Value::is_string),
        "boolean" => input.is_some_and(Value::is_boolean),
        "number" | "integer" => input.is_some_and(Value::is_number),
        "null" => input == Some(&Value::Null),
        _ => false,
    };
    if !valid {
        result.issues.push(type_error(
            input,
            if kind == "integer" { "number" } else { kind },
            path,
        ));
        result.aborted = true;
        return result;
    }
    let input = input.unwrap();
    match kind {
        "object" => {
            let props = schema["properties"].as_object().expect("schema properties");
            let required = schema["required"].as_array();
            for (key, child) in props {
                if input.get(key).is_none() && required.is_none_or(|r| !r.contains(&json!(key))) {
                    continue;
                }
                let parsed = validate(child, input.get(key), &path_at(path, json!(key)));
                result.aborted |= parsed.aborted;
                result.issues.extend(parsed.issues);
                if key == "expectedRevision"
                    && input
                        .get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.trim_matches(js_space).is_empty())
                {
                    result.issues.push(json!({"code":"custom","path":path_at(path,json!(key)),"message":"expectedRevision must be nonblank"}));
                }
                if let Some(value) = parsed.value {
                    result.value.as_mut().unwrap()[key] = value;
                }
            }
            let keys: Vec<&String> = input
                .as_object()
                .unwrap()
                .keys()
                .filter(|k| !props.contains_key(*k))
                .collect();
            if schema["additionalProperties"] == false && !keys.is_empty() {
                let text = keys
                    .iter()
                    .map(|k| serde_json::to_string(k).unwrap())
                    .collect::<Vec<_>>()
                    .join(", ");
                result.issues.push(json!({"code":"unrecognized_keys","keys":keys,"path":path,"message":format!("Unrecognized key{}: {text}",if keys.len()==1{""}else{"s"})}));
                result.aborted = true;
            }
        }
        "array" => {
            for (i, value) in input.as_array().unwrap().iter().enumerate() {
                let parsed = validate(&schema["items"], Some(value), &path_at(path, json!(i)));
                result.aborted |= parsed.aborted;
                result.issues.extend(parsed.issues);
                if let Some(value) = parsed.value {
                    result.value.as_mut().unwrap()[i] = value;
                }
            }
            length_checks(
                schema,
                input.as_array().unwrap().len(),
                "array",
                path,
                &mut result.issues,
            );
        }
        "string" => {
            length_checks(
                schema,
                input.as_str().unwrap().encode_utf16().count(),
                "string",
                path,
                &mut result.issues,
            );
        }
        "number" | "integer" => {
            let n = input.as_f64().unwrap();
            if kind == "integer" && n.fract() != 0.0 {
                result.issues.push(json!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"}));
                result.aborted = true;
            } else {
                if kind == "integer" && n > 9_007_199_254_740_991.0 {
                    result.issues.push(json!({"code":"too_big","maximum":9007199254740991i64,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":path,"message":"Too big: expected int to be <=9007199254740991"}));
                }
                if kind == "integer" && n < -9_007_199_254_740_991.0 {
                    result.issues.push(json!({"code":"too_small","minimum":-9007199254740991i64,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":path,"message":"Too small: expected int to be >=-9007199254740991"}));
                }
                for (key, inclusive) in [("minimum", true), ("exclusiveMinimum", false)] {
                    if let Some(min) = schema[key].as_f64() {
                        if n < min || (!inclusive && n == min) {
                            result.issues.push(json!({"origin":"number","code":"too_small","minimum":min as i64,"inclusive":inclusive,"path":path,"message":format!("Too small: expected number to be {}{min}",if inclusive{">="}else{">"})}));
                        }
                    }
                }
                if let Some(max) = schema["maximum"].as_f64() {
                    if n > max && !(kind == "integer" && max == 9_007_199_254_740_991.0) {
                        result.issues.push(json!({"origin":"number","code":"too_big","maximum":max as i64,"inclusive":true,"path":path,"message":format!("Too big: expected number to be <={max}")}));
                    }
                }
            }
        }
        _ => {}
    }
    result
}
fn length_checks(schema: &Value, n: usize, origin: &str, path: &[Value], issues: &mut Vec<Value>) {
    let (min, max) = if origin == "string" {
        ("minLength", "maxLength")
    } else {
        ("minItems", "maxItems")
    };
    let unit = if origin == "string" {
        "characters"
    } else {
        "items"
    };
    if let Some(min) = schema[min].as_u64() {
        if (n as u64) < min {
            issues.push(json!({"origin":origin,"code":"too_small","minimum":min,"inclusive":true,"path":path,"message":format!("Too small: expected {origin} to have >={min} {unit}")}));
        }
    }
    if let Some(max) = schema[max].as_u64() {
        if n as u64 > max {
            issues.push(json!({"origin":origin,"code":"too_big","maximum":max,"inclusive":true,"path":path,"message":format!("Too big: expected {origin} to have <={max} {unit}")}));
        }
    }
}
fn parse_value(name: &str, input: Option<&Value>) -> Result<Value, OperatorError> {
    let schema = contract()["schemas"]
        .get(name)
        .or_else(|| tool_contract()["schemas"].get(name))
        .ok_or_else(OperatorError::internal)?;
    let mut input = input.cloned();
    // JSON Schema cannot encode string transforms or the two custom refinements.
    if let Some(value) = input.as_mut() {
        for field in [
            if matches!(name, "answerRequestSchema" | "builds.answer")
                && value["resolution"] == "guidance"
            {
                "text"
            } else {
                ""
            },
            if name == "sessionMessageRequestSchema" {
                "text"
            } else {
                ""
            },
            if matches!(
                name,
                "ticketCreateRequestSchema"
                    | "ticketUpdateRequestSchema"
                    | "tickets.create"
                    | "tickets.update"
            ) {
                "target"
            } else {
                ""
            },
        ] {
            if let Some(raw) = value[field].as_str() {
                value[field] = json!(raw.trim_matches(js_space));
            }
        }
    }
    let mut parsed = validate(schema, input.as_ref(), &[]);
    if !parsed.aborted && input.as_ref().is_some_and(Value::is_object) {
        let value = input.as_ref().unwrap();
        if matches!(name, "ticketUpdateRequestSchema" | "tickets.update")
            && !["title", "body", "labels", "kind", "target"]
                .iter()
                .any(|k| value.get(k).is_some())
        {
            // The registry's safe extension retains the source refinement and
            // applies its routing wrapper's identical refinement a second time.
            for _ in 0..if name == "tickets.update" { 2 } else { 1 } {
                parsed.issues.push(json!({"code":"custom","path":[],"message":"update must name at least one field"}));
            }
        }
    }
    if parsed.issues.is_empty() {
        Ok(parsed.value.unwrap_or(Value::Null))
    } else {
        Err(OperatorError::validation(format!(
            "invalid request body: {}",
            serde_json::to_string_pretty(&parsed.issues).unwrap()
        )))
    }
}
/// Match Bun Request.json: decode UTF-8 lossily, then parse without consuming a BOM.
pub fn decode_json(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    let text = String::from_utf8_lossy(bytes);
    let mut value: Value = serde_json::from_str(&text)?;
    fn numbers(value: &mut Value) {
        match value {
            Value::Number(n) => {
                if let Some(n) = n.as_f64() {
                    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
                        *value = json!(n as i64);
                    }
                }
            }
            Value::Array(values) => values.iter_mut().for_each(numbers),
            Value::Object(values) => values.values_mut().for_each(numbers),
            _ => {}
        }
    }
    numbers(&mut value);
    Ok(value)
}
pub fn parse(name: &str, bytes: &[u8]) -> Result<Value, OperatorError> {
    let value = decode_json(bytes)
        .map_err(|_| OperatorError::validation("request body is not valid JSON"))?;
    parse_value(name, Some(&value))
}
pub fn tool_known(name: &str) -> bool {
    tool_contract()["schemas"].get(name).is_some()
}
pub fn parse_tool(name: &str, input: &Value) -> Result<Value, OperatorError> {
    parse_value(name, Some(input)).map_err(|mut error| {
        if let Some(issues) = error.error.strip_prefix("invalid request body: ") {
            error.error = format!("invalid input for tool \"{name}\": {issues}");
        }
        error
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_schemas_match_typescript_defaults_and_error_bytes() {
        for case in tool_contract()["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let result = parse_value(name, case.get("input"));
            if let Some(error) = case["error"].as_str() {
                let expected = error.replacen(
                    &format!("invalid input for tool \"{name}\": "),
                    "invalid request body: ",
                    1,
                );
                assert_eq!(
                    result.unwrap_err().error,
                    expected,
                    "{name} {:?}",
                    case.get("input")
                );
            } else {
                assert_eq!(result.unwrap(), case["output"], "{name}");
            }
        }
    }
    #[test]
    fn every_generated_request_sample_matches_typescript_output_and_error_bytes() {
        for case in contract()["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let result = parse_value(name, case.get("input"));
            if let Some(error) = case["error"].as_str() {
                assert_eq!(
                    result.unwrap_err().error,
                    error,
                    "{name} input {:?}",
                    case.get("input")
                );
            } else {
                assert_eq!(result.unwrap(), case["output"], "{name}");
            }
        }
    }
}
