//! Source-generated configuration grammar with native normalization and the
//! cross-field policies used by core/config/schema.ts. No runtime subprocess.
use super::{auth::js_space, error::OperatorError};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};
fn contract() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/config-schema.json"))
            .expect("configuration grammar")
    })
}
#[derive(Default)]
struct Parsed {
    value: Option<Value>,
    issues: Vec<Value>,
    aborted: bool,
}
fn at(path: &[Value], key: impl Into<Value>) -> Vec<Value> {
    let mut p = path.to_vec();
    p.push(key.into());
    p
}
fn custom(issues: &mut Vec<Value>, path: &[Value], message: impl Into<String>) {
    issues.push(json!({"code":"custom","path":path,"message":message.into()}));
}
fn custom_transform(issues: &mut Vec<Value>, path: &[Value], message: impl Into<String>) {
    issues.push(json!({"code":"custom","message":message.into(),"path":path}));
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn keys(v: &Value) -> Vec<String> {
    let Some(o) = v.as_object() else {
        return vec![];
    };
    let mut numeric = Vec::new();
    let mut rest = Vec::new();
    for key in o.keys() {
        if let Ok(n) = key.parse::<u32>() {
            if n < u32::MAX && n.to_string() == *key {
                numeric.push((n, key.clone()));
                continue;
            }
        }
        rest.push(key.clone());
    }
    numeric.sort_by_key(|(n, _)| *n);
    numeric.into_iter().map(|(_, k)| k).chain(rest).collect()
}
fn invalid_type(schema: &Value, input: Option<&Value>, expected: &str, path: &[Value]) -> Value {
    let received = match input {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    json!({"expected":expected,"code":"invalid_type","path":path,"message":schema["error"].as_str().map(str::to_owned).unwrap_or_else(||format!("Invalid input: expected {expected}, received {received}"))})
}
fn invalid_value(values: &[Value], path: &[Value]) -> Value {
    let values_text = values
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("|");
    json!({"code":"invalid_value","values":values,"path":path,"message":if values.len()==1{format!("Invalid input: expected {values_text}")}else{format!("Invalid option: expected one of {values_text}")}})
}
fn parse(schema: &Value, input: Option<&Value>, path: &[Value]) -> Parsed {
    let kind = text(&schema["type"]);
    if kind == "optional" && input.is_none() {
        return Parsed::default();
    }
    if (kind == "default" || kind == "prefault") && input.is_none() {
        if kind == "default" {
            return Parsed {
                value: Some(schema["default"].clone()),
                ..Default::default()
            };
        }
        return parse(&schema["inner"], schema.get("default"), path);
    }
    if ["optional", "default", "prefault"].contains(&kind) {
        return parse(&schema["inner"], input, path);
    }
    if kind == "nullable" {
        if input == Some(&Value::Null) {
            return Parsed {
                value: Some(Value::Null),
                ..Default::default()
            };
        }
        return parse(&schema["inner"], input, path);
    }
    if kind == "pipe" {
        let mut result = parse(&schema["input"], input, path);
        if !result.issues.is_empty() {
            return result;
        }
        if let Some(v) = result.value.as_mut() {
            match text(&schema["transform"]) {
                "service-url" => match service_url(text(v), "store.url") {
                    Ok(s) => *v = json!(s),
                    Err(e) => {
                        custom_transform(&mut result.issues, path, e);
                        result.aborted = true;
                    }
                },
                "tickets" => {
                    if v.get("readyState").is_none() {
                        v["readyState"] = json!("ready");
                    }
                    if v["source"] == "hosted" {
                        if let Some(url) = v["url"].as_str() {
                            match service_url(url, "tickets.url") {
                                Ok(url) => v["url"] = json!(url),
                                Err(e) => custom(&mut result.issues, &at(path, "url"), e),
                            }
                        }
                    }
                }
                _ => panic!("unported generated configuration transform"),
            }
        }
        return result;
    }
    if kind == "map" || kind == "steps" {
        let empty = json!({});
        let value = input.unwrap_or(&empty);
        let mut result = Parsed {
            value: Some(json!({})),
            ..Default::default()
        };
        if !value.is_object() {
            custom_transform(
                &mut result.issues,
                path,
                format!(
                    "{} must be a table of named entries",
                    text(&schema["label"])
                ),
            );
            result.aborted = true;
            return result;
        }
        if kind == "map" {
            for key in keys(value) {
                let valid = match text(&schema["keys"]) {
                    "nonempty" => !key.is_empty(),
                    "nonblank" => !key.trim_matches(js_space).is_empty(),
                    _ => true,
                };
                if !valid {
                    custom_transform(
                        &mut result.issues,
                        path,
                        format!(
                            "{} entry names must be {}",
                            text(&schema["label"]),
                            text(&schema["keys"])
                        ),
                    );
                    continue;
                }
                let parsed = parse(&schema["value"], value.get(&key), &at(path, key.clone()));
                if parsed.issues.is_empty() {
                    if let Some(v) = parsed.value {
                        result.value.as_mut().unwrap()[&key] = v;
                    }
                } else {
                    result.issues.extend(parsed.issues);
                }
            }
        } else {
            let mut steps = json!([]);
            let mut tables = json!({});
            let mut after = true;
            for key in keys(value) {
                if key == "steps" {
                    let parsed = parse(&schema["steps"], value.get(&key), &at(path, "steps"));
                    if parsed.issues.is_empty() {
                        steps = parsed.value.unwrap();
                    } else {
                        result.issues.extend(parsed.issues);
                    }
                    continue;
                }
                if key == "afterReconcile" && schema["afterReconcile"] == true {
                    if let Some(v) = value[&key].as_bool() {
                        after = v;
                    } else {
                        result.issues.push(invalid_type(
                            &json!({}),
                            value.get(&key),
                            "boolean",
                            &at(path, key),
                        ));
                    }
                    continue;
                }
                let parsed = parse(&schema["table"], value.get(&key), &at(path, key.clone()));
                if parsed.issues.is_empty() {
                    if let Some(v) = parsed.value {
                        tables[&key] = v;
                    }
                } else {
                    result.issues.extend(parsed.issues);
                }
            }
            let grouped =
                schema["afterReconcile"] == true && array(&steps).iter().any(Value::is_array);
            let stages: Vec<Value> = array(&steps)
                .iter()
                .map(|step| {
                    if step.is_array() {
                        step.clone()
                    } else {
                        json!([step])
                    }
                })
                .collect();
            let flat: Vec<Value> = stages
                .iter()
                .flat_map(|stage| array(stage).iter().cloned())
                .collect();
            let mut v = json!({"steps":flat,"stepConfigs":tables});
            if schema["afterReconcile"] == true {
                v["afterReconcile"] = json!(after);
                if grouped {
                    v["stages"] = json!(stages);
                }
            }
            result.value = Some(v);
        }
        result.aborted = !result.issues.is_empty();
        return result;
    }
    if kind == "union" {
        let options = array(&schema["options"]);
        if let Some(discriminator) = schema["discriminator"].as_str() {
            if !input.is_some_and(Value::is_object) {
                return Parsed {
                    issues: vec![
                        json!({"code":"invalid_type","expected":"object","path":path,"message":invalid_type(schema,input,"object",path)["message"]}),
                    ],
                    aborted: true,
                    ..Default::default()
                };
            }
            if let Some(option) = options.iter().find(|s| {
                array(&s["properties"][discriminator]["values"])
                    .contains(&input.unwrap()[discriminator])
            }) {
                return parse(option, input, path);
            }
            let values = options
                .iter()
                .flat_map(|option| array(&option["properties"][discriminator]["values"]))
                .cloned()
                .collect::<Vec<_>>();
            let expected = values
                .iter()
                .map(|value| format!("'{}'", text(value)))
                .collect::<Vec<_>>()
                .join(" | ");
            return Parsed {
                issues: vec![
                    json!({"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":discriminator,"options":values,"path":at(path,discriminator),"message":format!("Invalid discriminator value. Expected {expected}")}),
                ],
                aborted: true,
                ..Default::default()
            };
        }
        let mut errors = Vec::new();
        let mut continuable = None;
        for option in options {
            let parsed = parse(option, input, path);
            if parsed.issues.is_empty() {
                return parsed;
            }
            if !parsed.aborted && continuable.is_none() {
                continuable = Some(Parsed {
                    value: parsed.value.clone(),
                    issues: parsed.issues.clone(),
                    aborted: false,
                });
            }
            errors.push(json!(parsed.issues));
        }
        if let Some(result) = continuable {
            return result;
        }
        return Parsed {
            issues: vec![
                json!({"code":"invalid_union","errors":errors,"path":path,"message":"Invalid input"}),
            ],
            aborted: true,
            ..Default::default()
        };
    }
    if kind == "literal" || kind == "enum" {
        if !input.is_some_and(|v| array(&schema["values"]).contains(v)) {
            return Parsed {
                issues: vec![invalid_value(array(&schema["values"]), path)],
                aborted: true,
                ..Default::default()
            };
        }
        return Parsed {
            value: input.cloned(),
            ..Default::default()
        };
    }
    let valid = match kind {
        "string" => input.is_some_and(Value::is_string),
        "number" => input.is_some_and(Value::is_number),
        "boolean" => input.is_some_and(Value::is_boolean),
        "object" => input.is_some_and(Value::is_object),
        "array" => input.is_some_and(Value::is_array),
        "unknown" => true,
        "never" => false,
        _ => panic!("unported generated configuration type {kind}"),
    };
    if !valid {
        let mut result = Parsed {
            value: input.cloned(),
            issues: vec![invalid_type(schema, input, kind, path)],
            aborted: true,
        };
        if input.is_some_and(|v| v.is_string() || v.is_array() || v.get("length").is_some()) {
            for check in array(&schema["checks"]) {
                if ["min_length", "max_length"].contains(&text(&check["op"])) {
                    checks(
                        check,
                        if input.unwrap().is_string() {
                            "string"
                        } else if input.unwrap().is_array() {
                            "array"
                        } else {
                            "unknown"
                        },
                        path,
                        &mut result,
                    );
                }
            }
        }
        return result;
    }
    let mut result = Parsed {
        value: input.cloned(),
        ..Default::default()
    };
    if kind == "object" {
        let props = schema["properties"].as_object().unwrap();
        let v = input.unwrap();
        let mut output = Map::new();
        for (key, child) in props {
            let parsed = parse(child, v.get(key), &at(path, key.clone()));
            result.aborted |= parsed.aborted;
            result.issues.extend(parsed.issues);
            if let Some(v) = parsed.value {
                output.insert(key.clone(), v);
            }
        }
        let extra: Vec<String> = keys(v)
            .into_iter()
            .filter(|k| !props.contains_key(k))
            .collect();
        if schema["strict"] == true && !extra.is_empty() {
            let labels = extra
                .iter()
                .map(|v| serde_json::to_string(v).unwrap())
                .collect::<Vec<_>>()
                .join(", ");
            result.issues.push(json!({"code":"unrecognized_keys","keys":extra,"path":path,"message":format!("Unrecognized key{}: {labels}",if extra.len()==1{""}else{"s"})}));
            result.aborted = true;
        }
        result.value = Some(Value::Object(output));
    } else if kind == "array" {
        let mut output = Vec::new();
        for (i, v) in input.unwrap().as_array().unwrap().iter().enumerate() {
            let parsed = parse(&schema["element"], Some(v), &at(path, i));
            result.aborted |= parsed.aborted;
            result.issues.extend(parsed.issues);
            output.push(parsed.value.unwrap_or(Value::Null));
        }
        result.value = Some(json!(output));
    }
    if !result.aborted {
        for check in array(&schema["checks"]) {
            checks(check, kind, path, &mut result);
            if result.aborted {
                break;
            }
        }
    }
    result
}
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) => {
            let s = s.trim_matches(js_space);
            if s.is_empty() {
                0.0
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        Value::Array(a) => {
            if a.is_empty() {
                0.0
            } else if a.len() == 1 {
                if a[0].is_null() {
                    0.0
                } else {
                    js_number(&json!(if a[0].is_string() {
                        text(&a[0]).to_owned()
                    } else {
                        a[0].to_string()
                    }))
                }
            } else {
                f64::NAN
            }
        }
        _ => f64::NAN,
    }
}
fn checks(check: &Value, kind: &str, path: &[Value], result: &mut Parsed) {
    let v = result.value.as_ref().unwrap_or(&Value::Null);
    let op = text(&check["op"]);
    match op {
        "min_length" | "max_length" => {
            let n = if kind == "string" {
                text(v).encode_utf16().count() as f64
            } else if kind == "array" {
                array(v).len() as f64
            } else {
                js_number(&v["length"])
            };
            let small = op == "min_length";
            let limit = check[if small { "minimum" } else { "maximum" }]
                .as_u64()
                .unwrap();
            if !(if small {
                n >= limit as f64
            } else {
                n <= limit as f64
            }) {
                let relation = if small { ">=" } else { "<=" };
                let unit = if kind == "string" {
                    "characters"
                } else {
                    "items"
                };
                let fallback = if kind == "unknown" {
                    format!(
                        "Too {}: expected unknown to be {relation}{limit}",
                        if small { "small" } else { "big" }
                    )
                } else {
                    format!(
                        "Too {}: expected {kind} to have {relation}{limit} {unit}",
                        if small { "small" } else { "big" }
                    )
                };
                let mut issue = json!({"origin":kind,"code":if small{"too_small"}else{"too_big"}});
                issue[if small { "minimum" } else { "maximum" }] = json!(limit);
                issue["inclusive"] = json!(true);
                issue["path"] = json!(path);
                issue["message"] = check.get("error").cloned().unwrap_or(json!(fallback));
                result.issues.push(issue);
            }
        }
        "number_format" => {
            let n = v.as_f64().unwrap();
            if n.fract() != 0.0 {
                result.issues.push(json!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"}));
                result.aborted = true;
            } else if n.abs() > 9007199254740991.0 {
                let small = n < 0.0;
                let mut issue = json!({"code":if small{"too_small"}else{"too_big"}});
                issue[if small { "minimum" } else { "maximum" }] = json!(if small {
                    -9007199254740991i64
                } else {
                    9007199254740991i64
                });
                issue["note"] = json!("Integers must be within the safe integer range.");
                issue["origin"] = json!("int");
                issue["inclusive"] = json!(true);
                issue["path"] = json!(path);
                issue["message"] = json!(format!(
                    "Too {}: expected int to be {}9007199254740991",
                    if small { "small" } else { "big" },
                    if small { ">=-" } else { "<=" }
                ));
                result.issues.push(issue);
            }
        }
        "greater_than" | "less_than" => {
            let n = v.as_f64().unwrap();
            let bound = check["value"].as_f64().unwrap();
            let inclusive = check["inclusive"] == true;
            let small = op == "greater_than";
            let good = if small {
                if inclusive {
                    n >= bound
                } else {
                    n > bound
                }
            } else if inclusive {
                n <= bound
            } else {
                n < bound
            };
            if !good {
                let mut issue =
                    json!({"origin":"number","code":if small{"too_small"}else{"too_big"}});
                issue[if small { "minimum" } else { "maximum" }] = check["value"].clone();
                issue["inclusive"] = json!(inclusive);
                issue["path"] = json!(path);
                issue["message"] = check.get("error").cloned().unwrap_or(json!(format!(
                    "Too {}: expected number to be {}{}",
                    if small { "small" } else { "big" },
                    if small {
                        if inclusive {
                            ">="
                        } else {
                            ">"
                        }
                    } else if inclusive {
                        "<="
                    } else {
                        "<"
                    },
                    check["value"]
                )));
                result.issues.push(issue);
            }
        }
        "nonblank" => {
            if text(v).trim_matches(js_space).is_empty() {
                custom(&mut result.issues, path, text(&check["error"]));
            }
        }
        "assignee" => {
            let s = text(v);
            let good = s == "me"
                || (s == s.trim_matches(js_space)
                    && !s.chars().any(js_space)
                    && s.split_once('@').is_some_and(|(a, b)| {
                        !a.is_empty()
                            && !b.contains('@')
                            && b.rsplit_once('.')
                                .is_some_and(|(c, d)| !c.is_empty() && !d.is_empty())
                    }));
            if !good {
                custom(&mut result.issues, path, text(&check["error"]));
            }
        }
        "vercel-image" => {
            if !vercel_image(text(v)) {
                custom(&mut result.issues, path, text(&check["error"]));
            }
        }
        "string_format" => {
            if !regex_check(text(&check["pattern"]), text(v)) {
                result.issues.push(json!({"origin":"string","code":"invalid_format","format":"regex","pattern":check["patternDisplay"],"path":path,"message":check.get("error").cloned().unwrap_or(json!("Invalid string: must match pattern"))}));
            }
        }
        "path-glob" => {
            if let Some(error) = path_glob(text(v)) {
                custom_transform(&mut result.issues, path, error);
            }
        }
        "tickets-cross" => tickets_cross(v, path, &mut result.issues),
        "vercel-cross" => vercel_cross(v, path, &mut result.issues),
        "root-cross" => root_cross(v, path, &mut result.issues),
        _ => panic!("unported configuration check {op}"),
    }
}
fn service_url(raw: &str, setting: &str) -> Result<String, String> {
    let url = url::Url::parse(raw)
        .map_err(|_| format!("{setting} must be an absolute HTTPS service URL"))?;
    if raw.trim_matches(js_space).is_empty()
        || raw != raw.trim_matches(js_space)
        || !url.username().is_empty()
        || url.password().is_some_and(|s| !s.is_empty())
        || url.query().is_some_and(|s| !s.is_empty())
        || url.fragment().is_some_and(|s| !s.is_empty())
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && ["localhost", "127.0.0.1", "[::1]", "::1"]
                    .contains(&url.host_str().unwrap_or_default())))
    {
        return Err(format!("{setting} must be HTTPS (HTTP is allowed on loopback), without credentials, query or fragment"));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
fn vercel_image(s: &str) -> bool {
    let Some(s) = s.strip_prefix("vercel/sandbox/universal") else {
        return false;
    };
    if s.is_empty() {
        return true;
    }
    if let Some(hash) = s.strip_prefix("@sha256:") {
        return hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    }
    s.strip_prefix(':').is_some_and(|tag| {
        !tag.is_empty()
            && tag.len() <= 128
            && tag.bytes().enumerate().all(|(i, c)| {
                c.is_ascii_alphanumeric() || c == b'_' || (i > 0 && b".-".contains(&c))
            })
    })
}
fn regex_check(pattern: &str, s: &str) -> bool {
    match pattern {
        "^[^/\\s]+\\/[^/\\s]+$" => s.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty() && !b.is_empty() && !b.contains('/') && !s.chars().any(js_space)
        }),
        "^[A-Za-z_][A-Za-z0-9_]*$" => {
            !s.is_empty()
                && s.bytes().enumerate().all(|(i, c)| {
                    c.is_ascii_alphabetic() || c == b'_' || (i > 0 && c.is_ascii_digit())
                })
        }
        "^[a-z][a-z0-9_.]*(:[a-z0-9_-]+)?$" => {
            let mut p = s.split(':');
            let a = p.next().unwrap();
            let b = p.next();
            p.next().is_none()
                && !a.is_empty()
                && a.bytes().enumerate().all(|(i, c)| {
                    c.is_ascii_lowercase() || (i > 0 && (c.is_ascii_digit() || b"_.".contains(&c)))
                })
                && b.is_none_or(|b| {
                    !b.is_empty()
                        && b.bytes().all(|c| {
                            c.is_ascii_lowercase() || c.is_ascii_digit() || b"_-".contains(&c)
                        })
                })
        }
        _ => panic!("unported configuration regex {pattern}"),
    }
}
fn path_glob(s: &str) -> Option<&'static str> {
    if s.is_empty() {
        return Some("path selectors must be nonempty");
    }
    if s.contains('\0') {
        return Some("path selectors must not contain NUL bytes");
    }
    if s.starts_with('/')
        || (s.len() >= 3 && s.as_bytes()[0].is_ascii_alphabetic() && &s.as_bytes()[1..3] == b":/")
    {
        return Some("path selectors must be repository-relative, not absolute");
    }
    if s.contains('\\') {
        return Some("path selectors use Git-style \"/\" separators; backslashes and escapes are unsupported");
    }
    if s.starts_with('!') {
        return Some("path selectors are positive globs; negation is unsupported");
    }
    if s.contains(['[', ']', '{', '}']) {
        return Some("path selectors support only literal characters, *, ?, and whole-segment **; character classes and brace expansion are unsupported");
    }
    if ["?(", "*(", "+(", "@(", "!("].iter().any(|p| s.contains(p)) {
        return Some("path selectors support only literal characters, *, ?, and whole-segment **; extglobs are unsupported");
    }
    let segments: Vec<&str> = s.split('/').collect();
    if segments.contains(&"") {
        return Some("path selectors must not contain empty path segments");
    }
    if segments.iter().any(|p| [".", ".."].contains(p)) {
        return Some("path selectors must not contain \".\" or \"..\" traversal segments");
    }
    if segments.iter().any(|s| s.contains("**") && *s != "**") {
        return Some("the ** wildcard must occupy a complete path segment");
    }
    None
}
fn tickets_cross(v: &Value, path: &[Value], issues: &mut Vec<Value>) {
    let source = text(&v["source"]);
    if source == "hosted" {
        if let Some(url) = v["url"].as_str() {
            if let Err(e) = service_url(url, "tickets.url") {
                custom(issues, &at(path, "url"), e);
            }
        }
    }
    if source != "hosted" && v.get("readyState").is_none() {
        custom(issues,&at(path,"readyState"),"[tickets].readyState is required — name the one workflow state a ticket must sit in to be dispatched (e.g. \"ready\").");
    }
    if ["file", "linear"].contains(&source) && v.get("url").is_some() {
        custom(
            issues,
            &at(path, "url"),
            "[tickets].url applies only to source = \"hosted\"",
        );
    }
}
fn vercel_cross(v: &Value, path: &[Value], issues: &mut Vec<Value>) {
    for key in ["environmentVariables", "failoverRegions"] {
        let mut seen = BTreeSet::new();
        for (i, s) in array(&v[key]).iter().enumerate() {
            if !seen.insert(text(s)) {
                custom(
                    issues,
                    &at(&at(path, key), i),
                    format!("duplicate environment variable {s}"),
                );
            }
        }
    }
    let mut names = BTreeMap::new();
    for (i, step) in array(&v["provisioning"]).iter().enumerate() {
        let name = text(&step["name"]);
        if let Some(first) = names.get(name) {
            custom(issues,&at(&at(&at(path,"provisioning"),i),"name"),format!("duplicate provisioning step name {} — first declared at provisioning[{first}].name",step["name"]));
        } else {
            names.insert(name, i);
        }
    }
    if v.get("region").is_some() && array(&v["failoverRegions"]).contains(&v["region"]) {
        custom(
            issues,
            &at(path, "failoverRegions"),
            "failover regions must not include the primary region",
        );
    }
    if v.get("gitUsernameEnv").is_some() != v.get("gitPasswordEnv").is_some() {
        custom(
            issues,
            &at(path, "gitPasswordEnv"),
            "gitUsernameEnv and gitPasswordEnv must be configured together",
        );
    }
    for key in ["gitUsernameEnv", "gitPasswordEnv"] {
        if let Some(name) = v[key].as_str() {
            if array(&v["environmentVariables"]).contains(&json!(name)) {
                custom(issues,&at(path,key),"private repository clone credentials must not be exposed as runtime environment variables");
            }
            if [
                "GITHUB_TOKEN",
                "GH_TOKEN",
                "VERCEL_TOKEN",
                "VERCEL_OIDC_TOKEN",
                "VERCEL_TEAM_ID",
                "VERCEL_PROJECT_ID",
            ]
            .contains(&name)
            {
                custom(issues,&at(path,key),"private repository read credentials must be separate from Forge and Vercel credentials");
            }
        }
    }
}
fn display_name(name: &str) -> String {
    let mut s = String::from("\"");
    for c in name.chars() {
        match c {
            '"' | '\\' => {
                s.push('\\');
                s.push(c);
            }
            c if (' '..='~').contains(&c) => s.push(c),
            c if (c as u32) > 0xffff => s.push_str(&format!("\\U{:08X}", c as u32)),
            c => s.push_str(&format!("\\u{:04X}", c as u32)),
        }
    }
    s.push('"');
    s
}
fn toml_key(name: &str) -> String {
    if !name.is_empty()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        name.into()
    } else {
        display_name(name)
    }
}
fn runtime_references(v: &Value) -> BTreeMap<String, BTreeSet<String>> {
    let default = &v["roles"]["default"];
    let roles = &v["roles"];
    let mut routes: Vec<(String, Option<String>, String)> = array(&contract()["coreRoles"])
        .iter()
        .map(|r| {
            (
                text(r).to_owned(),
                None,
                format!("role {}", display_name(text(r))),
            )
        })
        .collect();
    for (section, label) in [
        ("verify", "agent verify role"),
        ("finalize", "agent finalize role"),
    ] {
        let mut seen = BTreeSet::new();
        for step in array(&v[section]["steps"]) {
            let name = text(step);
            if !seen.insert(name) {
                continue;
            }
            let table = &v[section]["stepConfigs"][name];
            if table["kind"] == "agent" {
                routes.push((
                    name.to_owned(),
                    if section == "verify" {
                        Some(text(&table["skill"]).into())
                    } else {
                        None
                    },
                    format!("{label} {}", display_name(name)),
                ));
            }
        }
    }
    let mut groups: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (role, alias, label) in routes {
        let spec = roles
            .get(&role)
            .or_else(|| alias.as_ref().and_then(|a| roles.get(a)))
            .unwrap_or(default);
        let runtime = spec["runtime"]
            .as_str()
            .or_else(|| default["runtime"].as_str());
        let mut add = |runtime: Option<&str>, reference: String| {
            if let Some(runtime) = runtime.filter(|s| !s.trim_matches(js_space).is_empty()) {
                groups
                    .entry(runtime.to_owned())
                    .or_default()
                    .insert(reference);
            }
        };
        add(runtime, format!("{label} primary"));
        let alternates = spec.get("alternates").or_else(|| default.get("alternates"));
        if let Some(alternates) = alternates {
            for (i, alternate) in array(alternates).iter().enumerate() {
                add(
                    alternate["runtime"].as_str().or(runtime),
                    format!("{label} alternate[{i}]"),
                );
            }
        }
    }
    groups
}
fn root_cross(v: &Value, path: &[Value], issues: &mut Vec<Value>) {
    // proa-perf-ok(scope): These are exact configuration diagnostics, not HTML. Browser rendering escapes them.
    for section in ["verify", "finalize"] {
        let mut names = array(&v[section]["steps"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        names.extend(keys(&v[section]["stepConfigs"]));
        let mut seen = BTreeSet::new();
        for name in names {
            if !seen.insert(name.clone()) {
                continue;
            }
            if name.is_empty()
                || [".", ".."].contains(&name.as_str())
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            {
                custom(issues,&at(&at(path,section),name.clone()),format!("{section} step \"{name}\" must contain only ASCII letters, digits, ., _ or - and cannot be . or .."));
            }
        }
    }
    let mut plugins = BTreeMap::new();
    for (i, plugin) in array(&v["plugins"]).iter().enumerate() {
        if let Some(first) = plugins.get(text(plugin)) {
            custom(issues,&at(&at(path,"plugins"),i),format!("duplicate plugin module specifier {plugin} — first declared at plugins[{first}]; remove or deduplicate this entry"));
        } else {
            plugins.insert(text(plugin), i);
        }
    }
    let provider = text(&v["workspace"]["provider"]);
    if provider == "git-worktree" && !keys(&v["workspace"]["config"]).is_empty() {
        custom(issues,&at(&at(path,"workspace"),"config"),"[workspace.config] is not supported by the builtin \"git-worktree\" provider — remove it or select a plugin workspace provider");
    }
    if provider == "vercel-sandbox" {
        let parsed = parse(
            &contract()["vercel"],
            v["workspace"].get("config"),
            &at(&at(path, "workspace"), "config"),
        );
        if !parsed.issues.is_empty() {
            issues.extend(parsed.issues);
        } else {
            let parsed = parsed.value.unwrap();
            for (runtime, references) in runtime_references(v) {
                if parsed["runtimeProvisioning"].get(&runtime).is_none() {
                    custom(issues,&at(&at(&at(&at(path,"workspace"),"config"),"runtimeProvisioning"),runtime.clone()),format!("runtime {} is selected by {} but has no sandbox provisioning; add [workspace.config.runtimeProvisioning.{}] with nonblank install and preflight commands",display_name(&runtime),references.into_iter().collect::<Vec<_>>().join(", "),toml_key(&runtime)));
                }
            }
        }
    }
    let commands = keys(&v["commands"]);
    let known = if commands.is_empty() {
        "[commands] has no entries".to_owned()
    } else {
        format!("known commands: {}", commands.join(", "))
    };
    for section in ["verify", "finalize"] {
        let tables = &v[section]["stepConfigs"];
        if !tables.is_object() {
            continue;
        }
        let steps = array(&v[section]["steps"]);
        let mut seen_steps = BTreeSet::new();
        for (i, step) in steps.iter().enumerate() {
            let name = text(step);
            if section == "verify" && !seen_steps.insert(name) {
                custom(
                    issues,
                    &at(&at(&at(path, section), "steps"), i),
                    format!(
                        "duplicate verify step {} across or within stages",
                        serde_json::to_string(name).unwrap()
                    ),
                );
            }
            if tables.get(name).is_none() {
                custom(issues,&at(&at(&at(path,section),"steps"),i),format!("{section} step \"{name}\" is listed in {section}.steps but has no [{section}.{name}] table — add one with kind = \"check\" (command = <name in [commands]>) or kind = \"agent\" (skill = <skill name>)"));
            }
        }
        for name in keys(tables) {
            let table = &tables[&name];
            if !steps.contains(&json!(name)) {
                custom(issues,&at(&at(path,section),name.clone()),format!("[{section}.{name}] is defined but \"{name}\" is not listed in {section}.steps — add \"{name}\" to {section}.steps or remove the table"));
            }
            if table["kind"] == "check" && v["commands"].get(text(&table["command"])).is_none() {
                custom(issues,&at(&at(&at(path,section),name.clone()),"command"),format!("[{section}.{name}].command = \"{}\" does not name a key in [commands] — {known}",text(&table["command"])));
            }
        }
    }
    let tickets = &v["tickets"];
    let source = text(&tickets["source"]);
    if ["linear", "hosted"].contains(&source) {
        if tickets.get("teamKey").is_none() {
            custom(
                issues,
                &at(&at(path, "tickets"), "teamKey"),
                format!(
                    "[tickets].source = \"{source}\" requires teamKey{}",
                    if source == "linear" {
                        " — the Linear team key (e.g. \"ENG\")"
                    } else {
                        ""
                    }
                ),
            );
        }
        if tickets.get("dir").is_some() {
            custom(issues,&at(&at(path,"tickets"),"dir"),"[tickets].dir applies only to source = \"file\" — remove it or set source = \"file\"");
        }
    } else if source == "file" {
        for key in ["teamKey", "claimedState"] {
            if tickets.get(key).is_some() {
                custom(issues,&at(&at(path,"tickets"),key),format!("[tickets].{key} applies only to source = \"linear\" or \"hosted\" — remove it or select one of those sources"));
            }
        }
    }
    if source != "linear" && tickets.get("readyAssignee").is_some() {
        custom(issues,&at(&at(path,"tickets"),"readyAssignee"),format!("[tickets].readyAssignee applies only to source = \"linear\" — remove it or select that source (selected source: \"{source}\")"));
    }
}
fn failure(label: &str, message: String) -> OperatorError {
    OperatorError::new(
        409,
        "conflict",
        format!("effective config {label} {message}"),
    )
    .with_code("effective-config-unavailable")
}
pub fn decode(bytes: &[u8], label: &str) -> Result<Value, OperatorError> {
    let s = String::from_utf8_lossy(bytes);
    let s = s.strip_prefix('\u{feff}').unwrap_or(&s);
    let value: Value =
        serde_json::from_str(s).map_err(|_| failure(label, "is not valid JSON".into()))?;
    let result = parse(&contract()["grammar"], Some(&value), &[]);
    if result.issues.is_empty() {
        Ok(result.value.unwrap())
    } else {
        Err(failure(
            label,
            format!(
                "is invalid: {}",
                serde_json::to_string_pretty(&result.issues).unwrap()
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    fn corpus() -> &'static Value {
        static V: OnceLock<Value> = OnceLock::new();
        V.get_or_init(|| {
            serde_json::from_str(include_str!("../../fixtures/config-corpus.json"))
                .expect("configuration oracle")
        })
    }
    #[test]
    fn generated_configuration_cases_match_normalization_and_every_issue_byte() {
        let mut mismatches = Vec::new();
        for case in array(&corpus()["cases"]) {
            let actual = parse(&contract()["grammar"], case.get("input"), &[]);
            let matches = if let Some(output) = case.get("output") {
                actual.issues.is_empty() && actual.value.as_ref() == Some(output)
            } else {
                actual.issues == *case["issues"].as_array().unwrap()
                    && serde_json::to_string_pretty(&actual.issues).unwrap() == text(&case["error"])
            };
            if !matches {
                mismatches.push(json!({"id":case["id"],"actualIssues":actual.issues,"expectedIssues":case["issues"],"actual":if case.get("output").is_some(){actual.value}else{None},"expected":case["output"]}));
            }
        }
        assert!(
            mismatches.is_empty(),
            "{} mismatches: {}",
            mismatches.len(),
            serde_json::to_string_pretty(&mismatches.iter().take(10).collect::<Vec<_>>()).unwrap()
        );
    }
    #[test]
    fn every_generated_schema_node_matches_its_typescript_parser() {
        let mut mismatches = Vec::new();
        for probe in array(&corpus()["probes"]) {
            for case in array(&probe["cases"]) {
                let actual = parse(&probe["grammar"], case.get("input"), &[]);
                let matches = if case["success"] == true {
                    actual.issues.is_empty() && actual.value.as_ref() == case.get("output")
                } else {
                    actual.issues == *case["issues"].as_array().unwrap()
                        && serde_json::to_string_pretty(&actual.issues).unwrap()
                            == text(&case["error"])
                };
                if !matches {
                    mismatches.push(json!({"path":probe["path"],"input":case["input"],"actualIssues":actual.issues,"expectedIssues":case["issues"],"actual":if case["success"]==true {actual.value}else{None},"expected":case["output"]}));
                }
            }
        }
        assert!(
            mismatches.is_empty(),
            "{} schema-node mismatches: {}",
            mismatches.len(),
            serde_json::to_string_pretty(&mismatches.iter().take(10).collect::<Vec<_>>()).unwrap()
        );
    }
    #[test]
    fn byte_decoder_matches_text_decoder_json_and_typed_conflict() {
        for case in array(&corpus()["byteCases"]) {
            let bytes = STANDARD.decode(text(&case["base64"])).unwrap();
            let result = decode(&bytes, "test@0");
            if let Some(output) = case.get("output") {
                assert_eq!(&result.unwrap(), output);
            } else {
                let error = result.unwrap_err();
                assert_eq!(error.error, text(&case["error"]));
                assert_eq!(error.status, 409);
                assert_eq!(error.kind, "conflict");
                assert_eq!(error.code.as_deref(), Some("effective-config-unavailable"));
            }
        }
    }
}
