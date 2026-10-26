//! Named producer refinements and string checks. These implement the checked
//! TypeScript sources; unsupported checks never turn into unchecked acceptance.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

pub(super) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(
            c,
            '\t' | '\n'
                | '\u{000b}'
                | '\u{000c}'
                | '\r'
                | ' '
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}
fn custom(
    issues: &mut Vec<Value>,
    path: &[Value],
    message: impl Into<String>,
    message_first: bool,
) {
    let message = message.into();
    issues.push(if message_first {
        json!({"code":"custom","message":message,"path":path})
    } else {
        json!({"code":"custom","path":path,"message":message})
    });
}
fn phase(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        [
            "plan",
            "plan-review",
            "implement",
            "code-review",
            "finalize",
            "reconcile",
        ]
        .contains(&s)
            || (s.starts_with("verify:") && s.len() > 7)
    })
}
fn regex_matches(check: &Value, value: &str) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<String, regex::Regex>>> = OnceLock::new();
    let key = format!("{}:{}", check["flags"], check["source"]);
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("producer regex cache");
    let regex = cache.entry(key).or_insert_with(|| {
        // JavaScript digit classes are ASCII. The closed extractor only allows
        // the one producer whitespace pattern inside character classes.
        let whitespace = r"\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
        let pattern = check["source"].as_str().unwrap()
            .replace("\\d", "[0-9]")
            .replace("\\/", "/")
            .replace("\\s", whitespace);
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(check["flags"].as_str().unwrap_or("").contains('i'))
            .build()
            .expect("checked producer regex")
    });
    regex.is_match(value)
}
fn format_issue(check: &Value, path: &[Value]) -> Value {
    let format = check["format"].as_str().unwrap();
    if format == "url" {
        return json!({"code":"invalid_format","format":"url","path":path,"message":"Invalid URL"});
    }
    let mut issue = json!({"origin":"string","code":"invalid_format","format":format});
    let message = if format == "starts_with" {
        issue["prefix"] = check["prefix"].clone();
        format!(
            "Invalid string: must start with \"{}\"",
            check["prefix"].as_str().unwrap()
        )
    } else {
        issue["pattern"] = check["pattern"].clone();
        match format {
            "regex" => format!(
                "Invalid string: must match pattern {}",
                check["pattern"].as_str().unwrap()
            ),
            "datetime" => "Invalid ISO datetime".to_owned(),
            "uuid" => "Invalid UUID".to_owned(),
            _ => unreachable!("closed format"),
        }
    };
    issue["path"] = json!(path);
    issue["message"] = message.into();
    issue
}
/// Returns whether this check aborts further checks. The caller applies any
/// explicit producer error override after normal diagnostic construction.
pub(super) fn apply(
    check: &Value,
    value: &mut Value,
    path: &[Value],
    issues: &mut Vec<Value>,
) -> bool {
    let name = check["check"].as_str().unwrap();
    let before = issues.len();
    let message = || {
        check["message"]
            .as_str()
            .expect("named refine error")
            .to_owned()
    };
    match name {
        "trim" => {
            *value = js_trim(value.as_str().unwrap()).into();
        }
        "string_format" => {
            let text = value.as_str().unwrap();
            if check["format"] == "url" {
                let trimmed = js_trim(text);
                if url::Url::parse(trimmed).is_ok() {
                    *value = trimmed.into();
                } else {
                    issues.push(format_issue(check, path));
                }
            } else {
                let valid = if check["format"] == "starts_with" {
                    text.starts_with(check["prefix"].as_str().unwrap())
                } else {
                    regex_matches(check, text)
                };
                if !valid {
                    issues.push(format_issue(check, path));
                }
            }
        }
        "phase" | "escalation_target" => {
            if !phase(value) && !(name == "escalation_target" && value.as_str() == Some("setup")) {
                custom(issues, path, message(), false);
            }
        }
        "nonblank" => {
            if js_trim(value.as_str().unwrap()).is_empty() {
                custom(issues, path, message(), false);
            }
        }
        "absolute_path" => {
            if !value.as_str().unwrap().starts_with('/') {
                custom(issues, path, message(), false);
            }
        }
        "filename_component" => {
            if value.as_str() == Some(".") || value.as_str() == Some("..") {
                custom(issues, path, message(), false);
            }
        }
        "filename_basename" => {
            if value
                .as_str()
                .unwrap()
                .chars()
                .any(|c| c == '/' || c == '\\' || c <= '\u{001f}' || c == '\u{007f}')
            {
                custom(issues, path, message(), false);
            }
        }
        "https_url" => {
            if !value.as_str().unwrap().starts_with("https://") {
                custom(issues, path, message(), false);
            }
        }
        "presence_demand" => {
            if value["reason"] == "presence"
                && (value.get("dependent").is_none()
                    || value["identities"].as_array().is_none_or(Vec::is_empty))
            {
                custom(issues, path, message(), false);
            }
        }
        "target_distance" => {
            if !value["count"].is_null() && value["head"].is_null() {
                issues.push(json!({"code":"custom","path":path,"message":"Invalid input"}));
            }
        }
        "landing_intent" => {
            if value.get("commandSeq").is_none() && value.get("decisionSeq").is_none() {
                custom(issues, path, message(), false);
            }
        }
        "unique_values" => {
            let values = value.as_array().unwrap();
            if values
                .iter()
                .enumerate()
                .any(|(i, v)| values[..i].contains(v))
            {
                custom(issues, path, message(), false);
            }
        }
        "sorted_identities" => {
            if value.as_array().unwrap().windows(2).any(|pair| {
                pair[0]
                    .as_str()
                    .unwrap()
                    .encode_utf16()
                    .cmp(pair[1].as_str().unwrap().encode_utf16())
                    .is_ge()
            }) {
                custom(issues, path, message(), false);
            }
        }
        "different_target" => {
            if value["selectedIndex"] == value["failed"]["index"] {
                custom(issues, path, message(), false);
            }
        }
        "unique_attempts" => {
            let values = value.as_array().unwrap();
            if values
                .iter()
                .enumerate()
                .any(|(i, v)| values[..i].iter().any(|p| p["index"] == v["index"]))
            {
                custom(issues, path, message(), false);
            }
        }
        "provider_substitution" => {
            if value["selectedIndex"].as_f64().unwrap()
                != value["failed"]["index"].as_f64().unwrap() + 1.0
            {
                let mut p = path.to_vec();
                p.push(json!("selectedIndex"));
                custom(
                    issues,
                    &p,
                    "selectedIndex must name the configured entry immediately after failed.index",
                    false,
                );
            }
        }
        "ordered_attempts" => {
            for (index, attempt) in value.as_array().unwrap().iter().enumerate() {
                if attempt["index"].as_f64().unwrap() != index as f64 {
                    let mut p = path.to_vec();
                    p.extend([json!(index), json!("index")]);
                    custom(
                        issues,
                        &p,
                        format!("provider attempt index must be {index} at this ordered position"),
                        false,
                    );
                }
            }
        }
        "verify_steps" | "restart_paths" => {
            let values = value.as_array().unwrap();
            for (index, v) in values.iter().enumerate() {
                if values[..index].contains(v) {
                    let mut p = path.to_vec();
                    p.push(json!(index));
                    custom(
                        issues,
                        &p,
                        if name == "verify_steps" {
                            format!(
                                "duplicate verify step {}",
                                serde_json::to_string(v).unwrap()
                            )
                        } else {
                            format!("duplicate config path {}", v.as_str().unwrap())
                        },
                        false,
                    );
                }
            }
        }
        "verify_policy_steps" => {
            let values = value.as_array().unwrap();
            if values
                .iter()
                .enumerate()
                .any(|(i, v)| values[..i].iter().any(|p| p["step"] == v["step"]))
            {
                custom(issues, path, "duplicate policy step", true);
            }
            for v in values {
                if v["source"] != "verify.afterReconcile"
                    && v["source"]
                        != format!("verify.{}.afterReconcile", v["step"].as_str().unwrap())
                {
                    custom(issues, path, "invalid policy source", true);
                }
            }
        }
        "ticket_migration" => {
            let mapping = value["mapping"].as_object().unwrap();
            if value["from"] == value["to"] && mapping.iter().any(|(id, next)| next != id.as_str())
            {
                custom(issues, path, "migration sources must differ", true);
            }
            let values = mapping.values().collect::<Vec<_>>();
            if values
                .iter()
                .enumerate()
                .any(|(i, v)| values[..i].contains(v))
            {
                custom(issues, path, "duplicate destination ticket id", true);
            }
        }
        _ => unreachable!("generation rejects unknown named check: {name}"),
    }
    issues.len() != before && check["abort"] == true
}
