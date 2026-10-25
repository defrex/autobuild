//! Closed interpreter for generated producer and wire-request schemas.
//! This never uses the permissive persisted-event projection. Named custom
//! checks and transforms live in rules.rs; unknown constructs fail generation.
use super::{received, validate_actor_type, WriteScope};
#[path = "rules.rs"]
mod rules;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

fn schemas() -> &'static Value {
    static SCHEMAS: OnceLock<Value> = OnceLock::new();
    SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../fixtures/protocol-session-schemas.json"
        ))
        .expect("generated session producer schemas")
    })
}
fn type_issue(expected: &str, input: Option<&Value>, path: &[Value]) -> Value {
    json!({"expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", received(input))})
}
fn unrecognized_keys(keys: &[String], path: &[Value]) -> Value {
    let labels = keys
        .iter()
        .map(|key| serde_json::to_string(key).unwrap())
        .collect::<Vec<_>>()
        .join(", ");
    json!({"code":"unrecognized_keys", "keys":keys, "path":path,
        "message":format!("Unrecognized key{}: {labels}",if keys.len()==1 {""} else {"s"})})
}
fn invalid_values(values: &[Value], path: &[Value]) -> Value {
    let labels = values
        .iter()
        .map(|value| serde_json::to_string(value).unwrap())
        .collect::<Vec<_>>();
    let message = if values.len() == 1 {
        format!("Invalid input: expected {}", labels[0])
    } else {
        format!("Invalid option: expected one of {}", labels.join("|"))
    };
    json!({"code":"invalid_value", "values":values,"path":path,"message":message})
}
/// Returns normalized value and whether a noncontinuable Zod issue occurred.
pub(super) fn parse(
    schema: &Value,
    input: Option<&Value>,
    path: &mut Vec<Value>,
    issues: &mut Vec<Value>,
) -> (Option<Value>, bool) {
    let kind = schema["type"].as_str().expect("closed schema type");
    let mut abort = false;
    let mut value = match kind {
        "nullable" if input == Some(&Value::Null) => return (Some(Value::Null), false),
        "nullable" => return parse(&schema["inner"], input, path, issues),
        "default" if input.is_none() => return (Some(schema["value"].clone()), false),
        "default" => return parse(&schema["inner"], input, path, issues),
        "optional" if input.is_none() => return (None, false),
        "optional" => return parse(&schema["inner"], input, path, issues),
        "unknown" => {
            if input.is_none() {
                issues.push(json!({"code":"invalid_type","expected":"nonoptional","path":path,"message":"Invalid input: expected nonoptional, received undefined"}));
                return (None, true);
            }
            return (input.cloned(), false);
        }
        "custom" => input.cloned().unwrap_or(Value::Null),
        "object" => {
            let Some(object) = input.and_then(Value::as_object) else {
                issues.push(type_issue("object", input, path));
                return (None, true);
            };
            let shape = schema["shape"].as_object().unwrap();
            let mut output = Map::new();
            for (key, child) in shape {
                path.push(Value::String(key.clone()));
                let (value, child_abort) = parse(child, object.get(key), path, issues);
                abort |= child_abort;
                if let Some(value) = value {
                    output.insert(key.clone(), value);
                }
                path.pop();
            }
            let extra = object
                .keys()
                .filter(|key| !shape.contains_key(*key))
                .cloned()
                .collect::<Vec<_>>();
            if schema["strict"] == true && !extra.is_empty() {
                issues.push(unrecognized_keys(&extra, path));
                abort = true;
            }
            if let Some(catchall) = schema.get("catchall") {
                for key in extra {
                    if key == "__proto__" {
                        continue;
                    }
                    path.push(Value::String(key.clone()));
                    let (value, child_abort) = parse(catchall, object.get(&key), path, issues);
                    abort |= child_abort;
                    if let Some(value) = value {
                        output.insert(key, value);
                    }
                    path.pop();
                }
            }
            Value::Object(output)
        }
        "record" => {
            let Some(object) = input.and_then(Value::as_object) else {
                issues.push(type_issue("record", input, path));
                return (None, true);
            };
            let mut output = Map::new();
            for (key, value) in object {
                if key == "__proto__" {
                    continue;
                }
                if let Some(key_schema) = schema.get("key") {
                    let mut key_issues = Vec::new();
                    parse(
                        key_schema,
                        Some(&Value::String(key.clone())),
                        &mut Vec::new(),
                        &mut key_issues,
                    );
                    if !key_issues.is_empty() {
                        let mut key_path = path.clone();
                        key_path.push(json!(key));
                        issues.push(json!({"code":"invalid_key","origin":"record","issues":key_issues,"path":key_path,"message":"Invalid key in record"}));
                        abort = true;
                        continue;
                    }
                }
                path.push(Value::String(key.clone()));
                let (value, child_abort) = parse(&schema["value"], Some(value), path, issues);
                abort |= child_abort;
                if let Some(value) = value {
                    output.insert(key.clone(), value);
                }
                path.pop();
            }
            Value::Object(output)
        }
        "array" => {
            let Some(array) = input.and_then(Value::as_array) else {
                issues.push(type_issue("array", input, path));
                return (None, true);
            };
            let mut output = Vec::new();
            for (index, value) in array.iter().enumerate() {
                path.push(json!(index));
                let (value, child_abort) = parse(&schema["element"], Some(value), path, issues);
                abort |= child_abort;
                output.push(value.unwrap_or(Value::Null));
                path.pop();
            }
            Value::Array(output)
        }
        "union" => {
            let options = schema["options"].as_array().unwrap();
            if let Some(discriminator) = schema.get("discriminator").and_then(Value::as_str) {
                let Some(object) = input.and_then(Value::as_object) else {
                    issues.push(json!({"code":"invalid_type","expected":"object","path":path,"message":format!("Invalid input: expected object, received {}",received(input))}));
                    return (None, true);
                };
                let values = options
                    .iter()
                    .flat_map(|option| {
                        option["shape"][discriminator]["values"]
                            .as_array()
                            .expect("literal union tag")
                            .iter()
                            .cloned()
                    })
                    .collect::<Vec<_>>();
                if let Some(option) = options.iter().find(|option| {
                    option["shape"][discriminator]["values"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| Some(v) == object.get(discriminator))
                }) {
                    let (value, child_abort) = parse(option, input, path, issues);
                    abort = child_abort;
                    value.unwrap_or(Value::Null)
                } else {
                    let labels = values
                        .iter()
                        .map(|v| {
                            format!(
                                "'{}'",
                                v.as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| v.to_string())
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" | ");
                    path.push(json!(discriminator));
                    issues.push(json!({"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":discriminator,"options":values,"path":path,"message":format!("Invalid discriminator value. Expected {labels}")}));
                    path.pop();
                    return (None, true);
                }
            } else {
                let mut results = Vec::new();
                for option in options {
                    let mut child_issues = Vec::new();
                    let (value, child_abort) =
                        parse(option, input, &mut Vec::new(), &mut child_issues);
                    if child_issues.is_empty() {
                        results.clear();
                        results.push((value, child_issues, false));
                        break;
                    }
                    results.push((value, child_issues, child_abort));
                }
                let successes = results
                    .iter()
                    .filter(|(_, issues, _)| issues.is_empty())
                    .count();
                let nonaborted = results.iter().filter(|(_, _, abort)| !*abort).count();
                if successes > 0 || nonaborted == 1 {
                    let (value, child_issues, child_abort) = results
                        .into_iter()
                        .find(|(_, issues, abort)| issues.is_empty() || !abort)
                        .unwrap();
                    for mut issue in child_issues {
                        let mut prefix = path.clone();
                        prefix.extend(issue["path"].as_array().unwrap().clone());
                        issue["path"] = json!(prefix);
                        issues.push(issue);
                    }
                    abort = child_abort;
                    value.unwrap_or(Value::Null)
                } else {
                    issues.push(json!({"code":"invalid_union","errors":results.into_iter().map(|(_,issues,_)|issues).collect::<Vec<_>>(),"path":path,"message":"Invalid input"}));
                    return (None, true);
                }
            }
        }
        "literal" | "enum" => {
            let values = schema["values"].as_array().unwrap();
            if !values.iter().any(|value| Some(value) == input) {
                issues.push(invalid_values(values, path));
                return (None, true);
            }
            input.unwrap().clone()
        }
        "string" => {
            let Some(value) = input.and_then(Value::as_str) else {
                issues.push(type_issue("string", input, path));
                return (None, true);
            };
            Value::String(value.to_owned())
        }
        "boolean" => {
            let Some(value) = input.filter(|value| value.is_boolean()) else {
                issues.push(type_issue("boolean", input, path));
                return (None, true);
            };
            value.clone()
        }
        "number" => {
            let Some(value) = input.filter(|value| value.is_number()) else {
                issues.push(type_issue("number", input, path));
                return (None, true);
            };
            if value.as_f64().is_none_or(|number| !number.is_finite()) {
                // JSON.parse accepts exponent overflow as either Infinity. Zod
                // rejects it at the primitive number gate before integer/bound
                // checks, while other primitive diagnostics still say number.
                issues.push(json!({"expected":"number","code":"invalid_type","received":"Infinity","path":path,"message":"Invalid input: expected number, received number"}));
                return (None, true);
            }
            value.clone()
        }
        _ => unreachable!("generation rejects unknown session schema: {kind}"),
    };
    if !abort {
        for check in schema["checks"].as_array().into_iter().flatten() {
            let issue_start = issues.len();
            match check["check"].as_str().unwrap() {
                "min_length" | "max_length" => {
                    let (origin, length) = if let Some(string) = value.as_str() {
                        ("string", string.encode_utf16().count())
                    } else {
                        ("array", value.as_array().unwrap().len())
                    };
                    let min = check["check"] == "min_length";
                    let bound = check[if min { "minimum" } else { "maximum" }]
                        .as_u64()
                        .unwrap();
                    if (min && (length as u64) < bound) || (!min && (length as u64) > bound) {
                        let mut issue =
                            json!({"origin":origin,"code":if min{"too_small"}else{"too_big"}});
                        issue.as_object_mut().unwrap().insert(
                            if min { "minimum" } else { "maximum" }.to_owned(),
                            json!(bound),
                        );
                        issue["inclusive"] = json!(true);
                        issue["path"] = json!(path);
                        issue["message"] = json!(format!(
                            "Too {}: expected {origin} to have {}{bound} {}",
                            if min { "small" } else { "big" },
                            if min { ">=" } else { "<=" },
                            if origin == "string" {
                                "characters"
                            } else {
                                "items"
                            }
                        ));
                        issues.push(issue);
                    }
                }
                "number_format" => {
                    let number = value.as_f64().unwrap();
                    if number.fract() != 0.0 {
                        issues.push(json!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"}));
                        abort = true;
                        break;
                    }
                    if number.abs() > 9007199254740991.0 {
                        let big = number > 0.0;
                        let mut issue = json!({"code":if big{"too_big"}else{"too_small"}});
                        issue.as_object_mut().unwrap().insert(
                            if big { "maximum" } else { "minimum" }.to_owned(),
                            json!(if big {
                                9007199254740991_i64
                            } else {
                                -9007199254740991_i64
                            }),
                        );
                        issue["note"] = json!("Integers must be within the safe integer range.");
                        issue["origin"] = json!("int");
                        issue["inclusive"] = json!(true);
                        issue["path"] = json!(path);
                        issue["message"] = json!(format!(
                            "Too {}: expected int to be {}9007199254740991",
                            if big { "big" } else { "small" },
                            if big { "<=" } else { ">=-" }
                        ));
                        issues.push(issue);
                    }
                }
                "greater_than" | "less_than" => {
                    let bound = check["value"].as_f64().unwrap();
                    let inclusive = check["inclusive"] == true;
                    let number = value.as_f64().unwrap();
                    let greater = check["check"] == "greater_than";
                    if (greater && (number < bound || (!inclusive && number == bound)))
                        || (!greater && (number > bound || (!inclusive && number == bound)))
                    {
                        let mut issue = json!({"origin":"number","code":if greater{"too_small"}else{"too_big"}});
                        issue[if greater { "minimum" } else { "maximum" }] = check["value"].clone();
                        issue["inclusive"] = json!(inclusive);
                        issue["path"] = json!(path);
                        issue["message"] = json!(format!(
                            "Too {}: expected number to be {}{}{bound}",
                            if greater { "small" } else { "big" },
                            if greater { ">" } else { "<" },
                            if inclusive { "=" } else { "" }
                        ));
                        issues.push(issue);
                    }
                }
                "wake_exclusive_source" => {
                    if value.get("build").is_some()
                        == (value.get("journal") == Some(&Value::Bool(true)))
                    {
                        issues.push(json!({"code":"custom","message":"a wake trigger names exactly one of build or journal","path":path}));
                    }
                }
                _ => {
                    abort |= rules::apply(check, &mut value, path, issues);
                }
            }
            if let Some(message) = check.get("message") {
                for issue in &mut issues[issue_start..] {
                    issue["message"] = message.clone();
                }
            }
            if abort {
                break;
            }
        }
    }
    (Some(value), abort)
}
/// Fully validated session write. Constructed only after actor and payload
/// checks; unknown envelope keys and compatibility are omitted like TypeScript.
#[derive(Debug, PartialEq)]
pub struct ValidatedSessionWrite {
    pub(crate) actor: Value,
    pub(crate) kind: String,
    pub(crate) payload: Value,
}
impl ValidatedSessionWrite {
    pub fn to_value(&self) -> Value {
        json!({"actor":self.actor,"type":self.kind,"payload":self.payload})
    }
}
pub fn validate_session_write(input: &Value) -> Result<ValidatedSessionWrite, String> {
    validate_actor_type(WriteScope::Session, input)?;
    let kind = input["type"].as_str().unwrap();
    let mut issues = Vec::new();
    let (payload, _) = parse(
        &schemas()[kind],
        input.get("payload"),
        &mut Vec::new(),
        &mut issues,
    );
    if !issues.is_empty() {
        return Err(format!(
            "invalid payload for \"{kind}\": {}",
            serde_json::to_string_pretty(&issues).unwrap()
        ));
    }
    Ok(ValidatedSessionWrite {
        actor: input["actor"].clone(),
        kind: kind.to_owned(),
        payload: payload.unwrap(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;
    #[test]
    fn raw_numeric_text_matches_zod_before_json_serialization() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../fixtures/protocol-numeric-validation.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        for case in cases {
            let input =
                crate::protocol::js_json::parse_js_json(case["raw"].as_str().unwrap().as_bytes())
                    .unwrap();
            let mut issues = Vec::new();
            let (value, _) = parse(&case["schema"], Some(&input), &mut Vec::new(), &mut issues);
            if let Some(expected) = case["oracle"]["rejected"].as_str() {
                assert_eq!(
                    serde_json::to_string_pretty(&issues).unwrap(),
                    expected,
                    "{}",
                    case["id"]
                );
            } else {
                assert!(issues.is_empty(), "{}: {issues:?}", case["id"]);
                let actual = crate::protocol::js_json::serializable(value.unwrap());
                let expected = crate::protocol::js_json::parse_js_json(
                    &serde_json::to_vec(&case["oracle"]["accepted"]).unwrap(),
                )
                .unwrap();
                assert_eq!(actual, expected, "{}", case["id"]);
            }
        }
        assert!(cases.len() > 200);
    }
    #[test]
    fn session_write_validator_matches_all_oracle_outcomes() {
        let mut data = String::new();
        GzDecoder::new(include_bytes!("../../../fixtures/protocol-writes.json.gz").as_slice())
            .read_to_string(&mut data)
            .unwrap();
        let corpus: Value = serde_json::from_str(&data).unwrap();
        let mut count = 0;
        for case in corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["scope"] == "session")
        {
            let outcome = validate_session_write(&case["input"]);
            if let Some(message) = case["oracle"]["rejected"]["message"].as_str() {
                assert_eq!(
                    outcome.map(|value| value.to_value()),
                    Err(message.to_owned()),
                    "{}",
                    case["id"]
                );
            } else {
                assert_eq!(
                    outcome.unwrap().to_value(),
                    case["oracle"]["accepted"],
                    "{}",
                    case["id"]
                );
            }
            count += 1;
        }
        assert!(count > 200, "session corpus unexpectedly shrank: {count}");
    }
}
