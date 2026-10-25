//! Named refinements operate on code units. Only URL syntax explicitly crosses
//! the WHATWG USV-string boundary; its accepted output keeps original units.
use super::{concat, j, same, Schema, ToJs, J, S};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
fn custom(issues: &mut Vec<J>, path: &[J], message: impl Into<S>, first: bool) {
    let message = message.into();
    issues.push(if first {
        j!({"code":"custom","message":message,"path":path})
    } else {
        j!({"code":"custom","path":path,"message":message})
    })
}
fn phase(value: &J) -> bool {
    value.as_string().is_some_and(|s| {
        [
            "plan",
            "plan-review",
            "implement",
            "code-review",
            "finalize",
            "reconcile",
        ]
        .iter()
        .any(|p| s.eq_ascii(p))
            || (s.units().starts_with(S::from("verify:").units()) && s.len() > 7)
    })
}
fn regex_matches(check: &Schema, value: &S) -> bool {
    let source = check["source"].as_str().unwrap();
    // This closed producer pattern permits arbitrary nonwhitespace UTF-16 units.
    if source == r"^[^/\s]+\/[^/\s]+$" {
        let slash = u16::from(b'/');
        let parts = value.units().split(|u| *u == slash).collect::<Vec<_>>();
        return parts.len() == 2
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.iter()
                        .all(|u| !S::from_units(vec![*u]).trim_js().is_empty())
            });
    }
    // All other extracted expressions have ASCII-only accepted languages. Test
    // that language boundary explicitly, without replacing/projecting surrogates.
    if value.units().iter().any(|u| *u > 0x7f) {
        return false;
    }
    let ascii = value.units().iter().map(|u| *u as u8).collect::<Vec<_>>();
    let ascii = std::str::from_utf8(&ascii).expect("proven ASCII");
    static CACHE: OnceLock<Mutex<HashMap<String, regex::Regex>>> = OnceLock::new();
    let key = format!("{}:{}", check["flags"], check["source"]);
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("lossless regex cache");
    let re = cache.entry(key).or_insert_with(|| {
        let pattern = source.replace("\\d", "[0-9]").replace("\\/", "/");
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(check["flags"].as_str().unwrap_or("").contains('i'))
            .build()
            .expect("closed ASCII regex")
    });
    re.is_match(ascii)
}
fn format_issue(check: &Schema, path: &[J]) -> J {
    let format = check["format"].as_str().unwrap();
    if format == "url" {
        return j!({"code":"invalid_format","format":"url","path":path,"message":"Invalid URL"});
    }
    let mut issue = j!({"origin":"string","code":"invalid_format","format":format});
    let message = if format == "starts_with" {
        issue["prefix"] = j!(check["prefix"]);
        format!(
            "Invalid string: must start with \"{}\"",
            check["prefix"].as_str().unwrap()
        )
    } else {
        issue["pattern"] = j!(check["pattern"]);
        match format {
            "regex" => format!(
                "Invalid string: must match pattern {}",
                check["pattern"].as_str().unwrap()
            ),
            "datetime" => "Invalid ISO datetime".into(),
            "uuid" => "Invalid UUID".into(),
            _ => unreachable!("closed format"),
        }
    };
    issue["path"] = j!(path);
    issue["message"] = j!(message);
    issue
}
pub(super) fn apply(check: &Schema, value: &mut J, path: &[J], issues: &mut Vec<J>) -> bool {
    let name = check["check"].as_str().unwrap();
    let before = issues.len();
    let message = || check["message"].as_str().expect("named refine message");
    match name {
        "trim" => *value = j!(value.as_string().unwrap().trim_js()),
        "string_format" => {
            let text = value.as_string().unwrap();
            if check["format"] == "url" {
                let trimmed = text.trim_js();
                if url::Url::parse(&trimmed.to_usv_string()).is_ok() {
                    *value = j!(trimmed)
                } else {
                    issues.push(format_issue(check, path))
                }
            } else {
                let valid = if check["format"] == "starts_with" {
                    text.units()
                        .starts_with(S::from(check["prefix"].as_str().unwrap()).units())
                } else {
                    regex_matches(check, text)
                };
                if !valid {
                    issues.push(format_issue(check, path))
                }
            }
        }
        "phase" | "escalation_target" => {
            if !phase(value) && !(name == "escalation_target" && same(value, "setup")) {
                custom(issues, path, message(), false)
            }
        }
        "nonblank" => {
            if value.as_string().unwrap().trim_js().is_empty() {
                custom(issues, path, message(), false)
            }
        }
        "absolute_path" => {
            if !value
                .as_string()
                .unwrap()
                .units()
                .starts_with(&[u16::from(b'/')])
            {
                custom(issues, path, message(), false)
            }
        }
        "filename_component" => {
            if same(value, ".") || same(value, "..") {
                custom(issues, path, message(), false)
            }
        }
        "filename_basename" => {
            if value.as_string().unwrap().units().iter().any(|u| {
                *u == u16::from(b'/') || *u == u16::from(b'\\') || *u <= 0x1f || *u == 0x7f
            }) {
                custom(issues, path, message(), false)
            }
        }
        "https_url" => {
            if !value
                .as_string()
                .unwrap()
                .units()
                .starts_with(S::from("https://").units())
            {
                custom(issues, path, message(), false)
            }
        }
        "presence_demand" => {
            if same(&value["reason"], "presence")
                && (value.get("dependent").is_none()
                    || value["identities"].as_array().is_none_or(Vec::is_empty))
            {
                custom(issues, path, message(), false)
            }
        }
        "landing_intent" => {
            if value.get("commandSeq").is_none() && value.get("decisionSeq").is_none() {
                custom(issues, path, message(), false)
            }
        }
        "unique_values" => {
            let values = value.as_array().unwrap();
            if values
                .iter()
                .enumerate()
                .any(|(i, v)| values[..i].contains(v))
            {
                custom(issues, path, message(), false)
            }
        }
        "sorted_identities" => {
            if value
                .as_array()
                .unwrap()
                .windows(2)
                .any(|p| p[0].as_string().unwrap() >= p[1].as_string().unwrap())
            {
                custom(issues, path, message(), false)
            }
        }
        "different_target" => {
            if value["selectedIndex"] == value["failed"]["index"] {
                custom(issues, path, message(), false)
            }
        }
        "unique_attempts" => {
            let values = value.as_array().unwrap();
            if values
                .iter()
                .enumerate()
                .any(|(i, v)| values[..i].iter().any(|p| p["index"] == v["index"]))
            {
                custom(issues, path, message(), false)
            }
        }
        "provider_substitution" => {
            if value["selectedIndex"].as_f64().unwrap()
                != value["failed"]["index"].as_f64().unwrap() + 1.0
            {
                let mut p = path.to_vec();
                p.push(j!("selectedIndex"));
                custom(
                    issues,
                    &p,
                    "selectedIndex must name the configured entry immediately after failed.index",
                    false,
                )
            }
        }
        "ordered_attempts" => {
            for (index, attempt) in value.as_array().unwrap().iter().enumerate() {
                if attempt["index"].as_f64().unwrap() != index as f64 {
                    let mut p = path.to_vec();
                    p.extend([j!(index), j!("index")]);
                    custom(
                        issues,
                        &p,
                        format!("provider attempt index must be {index} at this ordered position"),
                        false,
                    )
                }
            }
        }
        "verify_steps" | "restart_paths" => {
            let values = value.as_array().unwrap();
            for (index, v) in values.iter().enumerate() {
                if values[..index].contains(v) {
                    let mut p = path.to_vec();
                    p.push(j!(index));
                    let text = if name == "verify_steps" {
                        S::from(format!("duplicate verify step {}", v.stringify()))
                    } else {
                        concat(&[&S::from("duplicate config path "), v.as_string().unwrap()])
                    };
                    custom(issues, &p, text, false)
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
                custom(issues, path, "duplicate policy step", true)
            }
            for v in values {
                let expected = concat(&[
                    &S::from("verify."),
                    v["step"].as_string().unwrap(),
                    &S::from(".afterReconcile"),
                ]);
                if !same(&v["source"], "verify.afterReconcile") && v["source"] != j!(expected) {
                    custom(issues, path, "invalid policy source", true)
                }
            }
        }
        "ticket_migration" => {
            let mapping = value["mapping"].as_object().unwrap();
            if value["from"] == value["to"] && mapping.iter().any(|(id, next)| next != &j!(id)) {
                custom(issues, path, "migration sources must differ", true)
            }
            let values = mapping.iter().map(|(_, v)| v).collect::<Vec<_>>();
            if values
                .iter()
                .enumerate()
                .any(|(i, v)| values[..i].contains(v))
            {
                custom(issues, path, "duplicate destination ticket id", true)
            }
        }
        _ => unreachable!("generation rejects unknown named check {name}"),
    }
    issues.len() != before && check["abort"] == true
}
