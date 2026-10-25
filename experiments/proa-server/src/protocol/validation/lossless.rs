//! Closed schema interpreter over JavaScript UTF-16 values. Projection to Rust
//! scalar strings belongs after schema stripping, never before validation.
use crate::protocol::js_value::{JsJson as J, JsString as S};
use serde_json::Value as Schema;
use std::sync::OnceLock;
#[path = "lossless_rules.rs"]
mod rules;

pub(super) trait ToJs {
    fn js(&self) -> J;
}
impl ToJs for J {
    fn js(&self) -> J {
        self.clone()
    }
}
impl ToJs for S {
    fn js(&self) -> J {
        J::String(self.clone())
    }
}
impl ToJs for Schema {
    fn js(&self) -> J {
        J::from_serde(self)
    }
}
impl ToJs for str {
    fn js(&self) -> J {
        J::String(S::from(self))
    }
}
impl ToJs for String {
    fn js(&self) -> J {
        self.as_str().js()
    }
}
impl ToJs for bool {
    fn js(&self) -> J {
        J::Bool(*self)
    }
}
impl<T: ToJs + ?Sized> ToJs for &T {
    fn js(&self) -> J {
        (**self).js()
    }
}
impl<T: ToJs + ?Sized> ToJs for &mut T {
    fn js(&self) -> J {
        (**self).js()
    }
}
impl<T: ToJs> ToJs for Vec<T> {
    fn js(&self) -> J {
        J::Array(self.iter().map(ToJs::js).collect())
    }
}
impl<T: ToJs> ToJs for [T] {
    fn js(&self) -> J {
        J::Array(self.iter().map(ToJs::js).collect())
    }
}
macro_rules! number {($($ty:ty),*)=>{$(impl ToJs for $ty {fn js(&self)->J{J::Number(*self as f64)}})*}}
number!(usize, u64, i64, i32, f64);
macro_rules! j {({$($key:literal:$value:expr),*$(,)?})=>{J::Object(vec![$((S::from($key),ToJs::js(&$value))),*])};($value:expr)=>{ToJs::js(&$value)}}
pub(super) use j;
pub(super) fn same(value: &J, text: &str) -> bool {
    value.as_string().is_some_and(|v| v.eq_str(text))
}
fn yes(value: &J) -> bool {
    matches!(value, J::Bool(true))
}
pub(super) fn concat(parts: &[&S]) -> S {
    S::from_units(
        parts
            .iter()
            .flat_map(|s| s.units().iter().copied())
            .collect(),
    )
}
pub(super) fn received(value: Option<&J>) -> &'static str {
    match value {
        None => "undefined",
        Some(J::Null) => "null",
        Some(J::Bool(_)) => "boolean",
        Some(J::Number(_)) => "number",
        Some(J::String(_)) => "string",
        Some(J::Array(_)) => "array",
        Some(J::Object(_)) => "object",
    }
}
pub(super) fn type_issue(expected: &str, input: Option<&J>, path: &[J]) -> J {
    j!({"expected":expected,"code":"invalid_type","path":path,"message":format!("Invalid input: expected {expected}, received {}",received(input))})
}
pub(super) fn unrecognized(keys: &[S], path: &[J]) -> J {
    let mut message = S::from(format!(
        "Unrecognized key{}: ",
        if keys.len() == 1 { "" } else { "s" }
    ));
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            message = concat(&[&message, &S::from(", ")]);
        }
        message = concat(&[&message, &S::from("\""), key, &S::from("\"")]);
    }
    j!({"code":"unrecognized_keys","keys":keys,"path":path,"message":message})
}
fn invalid_values(values: &[Schema], path: &[J]) -> J {
    let labels = values
        .iter()
        .map(|v| J::from_serde(v).stringify())
        .collect::<Vec<_>>();
    let message = if values.len() == 1 {
        format!("Invalid input: expected {}", labels[0])
    } else {
        format!("Invalid option: expected one of {}", labels.join("|"))
    };
    j!({"code":"invalid_value","values":values,"path":path,"message":message})
}
fn insert(object: &mut J, key: S, value: J) {
    let J::Object(entries) = object else {
        panic!("closed object")
    };
    if let Some((_, existing)) = entries.iter_mut().find(|(k, _)| *k == key) {
        *existing = value
    } else {
        entries.push((key, value))
    }
}
fn object_get<'a>(object: &'a [(S, J)], key: &S) -> Option<&'a J> {
    object.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}
/// Returns normalized value and whether a noncontinuable issue occurred.
pub fn parse(
    schema: &Schema,
    input: Option<&J>,
    path: &mut Vec<J>,
    issues: &mut Vec<J>,
) -> (Option<J>, bool) {
    let kind = schema["type"].as_str().expect("closed schema type");
    let mut abort = false;
    let mut value = match kind {
        "nullable" if input == Some(&J::Null) => return (Some(J::Null), false),
        "nullable" => return parse(&schema["inner"], input, path, issues),
        "default" if input.is_none() => return (Some(J::from_serde(&schema["value"])), false),
        "default" => return parse(&schema["inner"], input, path, issues),
        "optional" if input.is_none() => return (None, false),
        "optional" => return parse(&schema["inner"], input, path, issues),
        "unknown" => {
            if input.is_none() {
                issues.push(j!({"code":"invalid_type","expected":"nonoptional","path":path,"message":"Invalid input: expected nonoptional, received undefined"}));
                return (None, true);
            }
            return (input.cloned(), false);
        }
        "custom" => input.cloned().unwrap_or(J::Null),
        "object" => {
            let Some(object) = input.and_then(J::as_object) else {
                issues.push(type_issue("object", input, path));
                return (None, true);
            };
            let shape = schema["shape"].as_object().unwrap();
            let mut output = J::Object(vec![]);
            for (key, child) in shape {
                let key = S::from(key.as_str());
                path.push(j!(key));
                let (next, child_abort) = parse(child, object_get(object, &key), path, issues);
                abort |= child_abort;
                if let Some(next) = next {
                    insert(&mut output, key, next)
                }
                path.pop();
            }
            let extra = object
                .iter()
                .map(|(k, _)| k)
                .filter(|key| !shape.keys().any(|s| key.eq_str(s)))
                .cloned()
                .collect::<Vec<_>>();
            if schema["strict"] == true && !extra.is_empty() {
                issues.push(unrecognized(&extra, path));
                abort = true
            }
            if let Some(catchall) = schema.get("catchall") {
                for key in extra {
                    if key.eq_ascii("__proto__") {
                        continue;
                    }
                    path.push(j!(key));
                    let (next, child_abort) =
                        parse(catchall, object_get(object, &key), path, issues);
                    abort |= child_abort;
                    if let Some(next) = next {
                        insert(&mut output, key, next)
                    }
                    path.pop();
                }
            }
            output
        }
        "record" => {
            let Some(object) = input.and_then(J::as_object) else {
                issues.push(type_issue("record", input, path));
                return (None, true);
            };
            let mut output = J::Object(vec![]);
            for (key, item) in object {
                if key.eq_ascii("__proto__") {
                    continue;
                }
                if let Some(key_schema) = schema.get("key") {
                    let mut key_issues = vec![];
                    parse(key_schema, Some(&j!(key)), &mut vec![], &mut key_issues);
                    if !key_issues.is_empty() {
                        let mut key_path = path.clone();
                        key_path.push(j!(key));
                        issues.push(j!({"code":"invalid_key","origin":"record","issues":key_issues,"path":key_path,"message":"Invalid key in record"}));
                        abort = true;
                        continue;
                    }
                }
                path.push(j!(key));
                let (next, child_abort) = parse(&schema["value"], Some(item), path, issues);
                abort |= child_abort;
                if let Some(next) = next {
                    insert(&mut output, key.clone(), next)
                }
                path.pop();
            }
            output
        }
        "array" => {
            let Some(array) = input.and_then(J::as_array) else {
                issues.push(type_issue("array", input, path));
                return (None, true);
            };
            let mut output = vec![];
            for (index, item) in array.iter().enumerate() {
                path.push(j!(index));
                let (next, child_abort) = parse(&schema["element"], Some(item), path, issues);
                abort |= child_abort;
                output.push(next.unwrap_or(J::Null));
                path.pop();
            }
            J::Array(output)
        }
        "union" => {
            let options = schema["options"].as_array().unwrap();
            if let Some(discriminator) = schema.get("discriminator").and_then(Schema::as_str) {
                if input.and_then(J::as_object).is_none() {
                    issues.push(j!({"code":"invalid_type","expected":"object","path":path,"message":format!("Invalid input: expected object, received {}",received(input))}));
                    return (None, true);
                }
                let values = options
                    .iter()
                    .flat_map(|o| {
                        o["shape"][discriminator]["values"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .cloned()
                    })
                    .collect::<Vec<_>>();
                if let Some(option) = options.iter().find(|o| {
                    o["shape"][discriminator]["values"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| Some(&J::from_serde(v)) == input.unwrap().get(discriminator))
                }) {
                    let (next, child_abort) = parse(option, input, path, issues);
                    abort = child_abort;
                    next.unwrap_or(J::Null)
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
                    path.push(j!(discriminator));
                    issues.push(j!({"code":"invalid_union","errors":Vec::<J>::new(),"note":"No matching discriminator","discriminator":discriminator,"options":values,"path":path,"message":format!("Invalid discriminator value. Expected {labels}")}));
                    path.pop();
                    return (None, true);
                }
            } else {
                let mut results = vec![];
                for option in options {
                    let mut child_issues = vec![];
                    let (next, child_abort) = parse(option, input, &mut vec![], &mut child_issues);
                    if child_issues.is_empty() {
                        results.clear();
                        results.push((next, child_issues, false));
                        break;
                    }
                    results.push((next, child_issues, child_abort));
                }
                let successes = results
                    .iter()
                    .filter(|(_, issues, _)| issues.is_empty())
                    .count();
                let nonaborted = results.iter().filter(|(_, _, abort)| !*abort).count();
                if successes > 0 || nonaborted == 1 {
                    let (next, child_issues, child_abort) = results
                        .into_iter()
                        .find(|(_, issues, abort)| issues.is_empty() || !*abort)
                        .unwrap();
                    for mut issue in child_issues {
                        let mut prefix = path.clone();
                        prefix.extend(issue["path"].as_array().unwrap().clone());
                        issue["path"] = j!(prefix);
                        issues.push(issue)
                    }
                    abort = child_abort;
                    next.unwrap_or(J::Null)
                } else {
                    issues.push(j!({"code":"invalid_union","errors":results.into_iter().map(|(_,issues,_)|issues).collect::<Vec<_>>(),"path":path,"message":"Invalid input"}));
                    return (None, true);
                }
            }
        }
        "literal" | "enum" => {
            let values = schema["values"].as_array().unwrap();
            if !values.iter().any(|v| Some(&J::from_serde(v)) == input) {
                issues.push(invalid_values(values, path));
                return (None, true);
            }
            input.unwrap().clone()
        }
        "string" => {
            let Some(value) = input.and_then(J::as_string) else {
                issues.push(type_issue("string", input, path));
                return (None, true);
            };
            j!(value)
        }
        "boolean" => {
            let Some(value) = input.filter(|v| v.is_boolean()) else {
                issues.push(type_issue("boolean", input, path));
                return (None, true);
            };
            value.clone()
        }
        "number" => {
            let Some(value) = input.filter(|v| v.is_number()) else {
                issues.push(type_issue("number", input, path));
                return (None, true);
            };
            if value.as_f64().is_none_or(|n| !n.is_finite()) {
                issues.push(j!({"expected":"number","code":"invalid_type","received":"Infinity","path":path,"message":"Invalid input: expected number, received number"}));
                return (None, true);
            }
            value.clone()
        }
        _ => unreachable!("generation rejects unknown schema {kind}"),
    };
    if !abort {
        for check in schema["checks"].as_array().into_iter().flatten() {
            let start = issues.len();
            match check["check"].as_str().unwrap() {
                "min_length" | "max_length" => {
                    let (origin, length) = if let Some(text) = value.as_string() {
                        ("string", text.len())
                    } else {
                        ("array", value.as_array().unwrap().len())
                    };
                    let min = check["check"] == "min_length";
                    let bound = check[if min { "minimum" } else { "maximum" }]
                        .as_u64()
                        .unwrap();
                    if (min && (length as u64) < bound) || (!min && (length as u64) > bound) {
                        let mut issue =
                            j!({"origin":origin,"code":if min{"too_small"}else{"too_big"}});
                        issue[if min { "minimum" } else { "maximum" }] = j!(bound);
                        issue["inclusive"] = j!(true);
                        issue["path"] = j!(path);
                        issue["message"] = j!(format!(
                            "Too {}: expected {origin} to have {}{bound} {}",
                            if min { "small" } else { "big" },
                            if min { ">=" } else { "<=" },
                            if origin == "string" {
                                "characters"
                            } else {
                                "items"
                            }
                        ));
                        issues.push(issue)
                    }
                }
                "number_format" => {
                    let number = value.as_f64().unwrap();
                    if number.fract() != 0.0 {
                        issues.push(j!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"}));
                        abort = true;
                        break;
                    }
                    if number.abs() > 9007199254740991.0 {
                        let big = number > 0.0;
                        let mut issue = j!({"code":if big{"too_big"}else{"too_small"}});
                        issue[if big { "maximum" } else { "minimum" }] = j!(if big {
                            9007199254740991_i64
                        } else {
                            -9007199254740991_i64
                        });
                        issue["note"] = j!("Integers must be within the safe integer range.");
                        issue["origin"] = j!("int");
                        issue["inclusive"] = j!(true);
                        issue["path"] = j!(path);
                        issue["message"] = j!(format!(
                            "Too {}: expected int to be {}9007199254740991",
                            if big { "big" } else { "small" },
                            if big { "<=" } else { ">=-" }
                        ));
                        issues.push(issue)
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
                        let mut issue =
                            j!({"origin":"number","code":if greater{"too_small"}else{"too_big"}});
                        issue[if greater { "minimum" } else { "maximum" }] = j!(check["value"]);
                        issue["inclusive"] = j!(inclusive);
                        issue["path"] = j!(path);
                        issue["message"] = j!(format!(
                            "Too {}: expected number to be {}{}{bound}",
                            if greater { "small" } else { "big" },
                            if greater { ">" } else { "<" },
                            if inclusive { "=" } else { "" }
                        ));
                        issues.push(issue)
                    }
                }
                "wake_exclusive_source" => {
                    if value.get("build").is_some() == yes(&value["journal"]) {
                        issues.push(j!({"code":"custom","message":"a wake trigger names exactly one of build or journal","path":path}))
                    }
                }
                _ => abort |= rules::apply(check, &mut value, path, issues),
            };
            if let Some(message) = check.get("message") {
                for issue in &mut issues[start..] {
                    issue["message"] = j!(message)
                }
            }
            if abort {
                break;
            }
        }
    }
    (Some(value), abort)
}
/// JSON.stringify(issues,null,2), including typed UTF-16 paths and messages.
pub(super) fn pretty(value: &J, depth: usize) -> String {
    let indent = "  ".repeat(depth);
    let child = "  ".repeat(depth + 1);
    match value {
        J::Array(items) if !items.is_empty() => format!(
            "[\n{}\n{indent}]",
            items
                .iter()
                .map(|v| format!("{child}{}", pretty(v, depth + 1)))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        J::Object(items) if !items.is_empty() => format!(
            "{{\n{}\n{indent}}}",
            items
                .iter()
                .map(|(k, v)| format!("{child}{}: {}", k.quote(), pretty(v, depth + 1)))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        _ => value.stringify(),
    }
}
pub fn validate_schema(schema: &Schema, input: &J) -> Result<J, S> {
    let mut issues = vec![];
    let (value, _) = parse(schema, Some(input), &mut vec![], &mut issues);
    if issues.is_empty() {
        Ok(value.expect("closed schema output"))
    } else {
        Err(S::from(pretty(&J::Array(issues), 0)))
    }
}
pub fn validate_request(name: &str, input: &J) -> Result<J, S> {
    static SCHEMAS: OnceLock<Schema> = OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../fixtures/protocol-request-schemas.json"
        ))
        .expect("generated request schemas")
    });
    let schema = schemas
        .get(name)
        .ok_or_else(|| S::from(format!("unknown request schema \"{name}\"")))?;
    validate_schema(schema, input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;
    fn corpus() -> Schema {
        let mut text = String::new();
        GzDecoder::new(include_bytes!("../../../fixtures/protocol-writes.json.gz").as_slice())
            .read_to_string(&mut text)
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }
    #[test]
    fn scalar_request_and_payload_corpora_preserve_normalization_and_errors() {
        let corpus = corpus();
        let mut checked = 0;
        for case in corpus["requests"].as_array().unwrap() {
            let input = J::from_serde(&case["input"]);
            let actual = validate_request(case["name"].as_str().unwrap(), &input);
            let expected =
                super::super::validate_request(case["name"].as_str().unwrap(), &case["input"])
                    .map(|v| J::from_serde(&v))
                    .map_err(S::from);
            assert_eq!(actual, expected, "request {}", case["id"]);
            checked += 1;
        }
        let schemas: Schema = serde_json::from_str(include_str!(
            "../../../fixtures/protocol-payload-schemas.json"
        ))
        .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let scope = if case["scope"] == "build" {
                "build"
            } else if case["scope"] == "repository" {
                "repository"
            } else {
                continue;
            };
            let Some(kind) = case["input"]["type"].as_str() else {
                continue;
            };
            let Some(schema) = schemas["supported"][scope].get(kind) else {
                continue;
            };
            let Some(input) = case["input"].get("payload") else {
                continue;
            };
            let input_js = J::from_serde(input);
            let actual = validate_schema(schema, &input_js);
            let expected = super::super::validate_schema(schema, input)
                .map(|v| J::from_serde(&v))
                .map_err(S::from);
            assert_eq!(actual, expected, "payload {}", case["id"]);
            checked += 1;
        }
        assert!(
            checked > 2000,
            "scalar corpus unexpectedly shrank: {checked}"
        );
    }
    #[test]
    fn unicode_normalization_and_diagnostics_match_executable_zod() {
        let mut text = String::new();
        GzDecoder::new(
            include_bytes!("../../../fixtures/protocol-unicode-validation.json.gz").as_slice(),
        )
        .read_to_string(&mut text)
        .unwrap();
        let corpus: Schema = serde_json::from_str(&text).unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert!(cases.len() > 5000);
        for case in cases {
            let schema = &corpus["schemas"][case["schema"].as_str().unwrap()];
            let input = J::parse(case["raw"].as_str().unwrap().as_bytes()).unwrap();
            let actual = validate_schema(schema, &input)
                .map(|v| v.stringify())
                .map_err(|e| e.quote());
            let expected = if let Some(accepted) = case["accepted"].as_str() {
                Ok(J::parse(accepted.as_bytes()).unwrap().stringify())
            } else {
                Err(J::parse(case["rejected"].as_str().unwrap().as_bytes())
                    .unwrap()
                    .as_string()
                    .unwrap()
                    .quote())
            };
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }
    #[test]
    fn stripping_precedes_checked_scalar_conversion_and_preserves_record_units() {
        let schema = serde_json::json!({"type":"object","shape":{"kept":{"type":"string"}}});
        let input = J::parse(br#"{"kept":"ok","discarded":"\ud800"}"#).unwrap();
        let output = validate_schema(&schema, &input).unwrap();
        assert_eq!(
            output.to_serde_checked().unwrap(),
            serde_json::json!({"kept":"ok"})
        );
        let schema = serde_json::json!({"type":"record","value":{"type":"string"}});
        let input = J::parse(br#"{"\ud800":"\udfff","__proto__":"ignored"}"#).unwrap();
        let output = validate_schema(&schema, &input).unwrap();
        assert_eq!(output.stringify(), r#"{"\ud800":"\udfff"}"#);
        assert!(output.to_serde_checked().is_err());
    }
}
