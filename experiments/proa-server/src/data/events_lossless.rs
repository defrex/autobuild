//! Persisted-event validation over original JavaScript UTF-16 values.
//! This is deliberately permissive about additive fields, unlike write validation.
use crate::data::{error::DataError, events, reducers::Scope};
use crate::protocol::js_value::{JsJson as J, JsString as S};
use serde_json::Value as Schema;
fn same(v: &J, s: &str) -> bool {
    v.as_string().is_some_and(|v| v.eq_str(s))
}
fn scalar(v: &J) -> Option<String> {
    v.as_string()?.to_scalar().ok()
}
fn object_get<'a>(s: &'a Schema, k: &S) -> Option<&'a Schema> {
    k.to_scalar().ok().and_then(|k| s.get(k))
}
fn pattern(pattern: &str, s: &S) -> bool {
    if pattern == r"^[^/\s]+\/[^/\s]+$" {
        let parts: Vec<_> = s.units().split(|u| *u == b'/' as u16).collect();
        return parts.len() == 2
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.iter()
                        .all(|u| !S::from_units(vec![*u]).trim_js().is_empty())
            });
    }
    if pattern == r"^refs\/autobuild\/archive\/.*" {
        return s
            .units()
            .starts_with(S::from("refs/autobuild/archive/").units());
    }
    // Every other extracted pattern has a closed ASCII accepted language.
    if s.units().iter().any(|u| *u > 127) {
        return false;
    }
    let text: String = s.units().iter().map(|u| char::from(*u as u8)).collect();
    regex::Regex::new(&pattern.replace(r"\d", "[0-9]").replace(r"\/", "/"))
        .expect("closed stored pattern")
        .is_match(&text)
}
fn valid(schema: &Schema, v: &J) -> bool {
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Schema::as_array)
    {
        return branches.iter().any(|s| valid(s, v));
    }
    if let Some(c) = schema.get("const") {
        if *v != J::from_serde(c) {
            return false;
        }
    }
    if let Some(e) = schema.get("enum").and_then(Schema::as_array) {
        if !e.iter().any(|x| *v == J::from_serde(x)) {
            return false;
        }
    }
    match schema["type"].as_str() {
        Some("null") => v.is_null(),
        Some("boolean") => v.is_boolean(),
        Some("number" | "integer") => v.as_f64().is_some_and(|n| {
            n.is_finite()
                && (schema["type"] != "integer" || n.fract() == 0.0)
                && schema["minimum"].as_f64().is_none_or(|x| n >= x)
                && schema["maximum"].as_f64().is_none_or(|x| n <= x)
                && schema["exclusiveMinimum"].as_f64().is_none_or(|x| n > x)
                && schema["exclusiveMaximum"].as_f64().is_none_or(|x| n < x)
        }),
        Some("string") => v.as_string().is_some_and(|s| {
            schema["minLength"]
                .as_u64()
                .is_none_or(|n| s.len() >= n as usize)
                && schema["maxLength"]
                    .as_u64()
                    .is_none_or(|n| s.len() <= n as usize)
                && schema["pattern"].as_str().is_none_or(|p| pattern(p, s))
        }),
        Some("array") => v.as_array().is_some_and(|a| {
            schema["minItems"]
                .as_u64()
                .is_none_or(|n| a.len() >= n as usize)
                && schema["maxItems"]
                    .as_u64()
                    .is_none_or(|n| a.len() <= n as usize)
                && a.iter().enumerate().all(|(i, v)| {
                    schema["prefixItems"]
                        .get(i)
                        .or_else(|| schema.get("items"))
                        .is_none_or(|s| valid(s, v))
                })
        }),
        Some("object") => v.as_object().is_some_and(|o| {
            schema["required"]
                .as_array()
                .is_none_or(|r| r.iter().all(|k| v.get(k.as_str().unwrap()).is_some()))
                && o.iter().all(|(k, v)| {
                    if let Some(s) = object_get(&schema["properties"], k) {
                        valid(s, v)
                    } else if schema["additionalProperties"].is_object() {
                        valid(&schema["additionalProperties"], v)
                    } else {
                        schema["additionalProperties"] != false
                    }
                })
        }),
        None => true,
        _ => false,
    }
}
fn defaults(schema: &Schema, v: &mut J) {
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Schema::as_array)
    {
        for s in branches {
            let mut c = v.clone();
            defaults(s, &mut c);
            if valid(s, &c) {
                *v = c;
                return;
            }
        }
    }
    if let Some(properties) = schema["properties"].as_object() {
        if v.is_object() {
            for (k, s) in properties {
                if v.get(k).is_none() {
                    if let Some(d) = s.get("default") {
                        v[k.as_str()] = J::from_serde(d);
                    }
                }
                if let Some(c) = v.get_mut(k) {
                    defaults(s, c);
                }
            }
        }
    }
    if let Some(items) = v.as_array_mut() {
        for c in items {
            if schema["items"].is_object() {
                defaults(&schema["items"], c);
            }
        }
    }
}
fn project(schema: &Schema, v: &mut J) {
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Schema::as_array)
    {
        if valid(schema, v) {
            return;
        }
        for s in branches {
            let mut c = v.clone();
            project(s, &mut c);
            if valid(s, &c) {
                *v = c;
                return;
            }
        }
    }
    if let Some(o) = v.as_object_mut() {
        if schema["properties"].is_object() {
            if schema["additionalProperties"] == false {
                o.retain(|(k, _)| object_get(&schema["properties"], k).is_some());
            }
            for (k, c) in o {
                if let Some(s) = object_get(&schema["properties"], k) {
                    project(s, c)
                } else if schema["additionalProperties"].is_object() {
                    project(&schema["additionalProperties"], c)
                }
            }
        } else if schema["additionalProperties"].is_object() {
            for (_, c) in o {
                project(&schema["additionalProperties"], c)
            }
        }
    }
    if let Some(a) = v.as_array_mut() {
        for (i, c) in a.iter_mut().enumerate() {
            if let Some(s) = schema["prefixItems"].get(i) {
                project(s, c)
            } else if schema["items"].is_object() {
                project(&schema["items"], c)
            }
        }
    }
}
fn nonempty(v: &J, k: &str) -> bool {
    v[k].as_string().is_some_and(|s| !s.is_empty())
}
fn actor_valid(a: &J) -> bool {
    let valid = match scalar(&a["kind"]).as_deref() {
        Some("kernel" | "dispatcher") => true,
        Some("agent") => nonempty(a, "role") && nonempty(a, "session"),
        Some("human") => nonempty(a, "user"),
        Some("ingester") => nonempty(a, "source"),
        _ => false,
    };
    if !valid {
        return false;
    }
    if let Some(v) = a.get("via") {
        if !same(&a["kind"], "human") {
            return false;
        }
        return match scalar(&v["kind"]).as_deref() {
            Some("session") => nonempty(v, "id"),
            Some("mcp") => nonempty(v, "client"),
            _ => false,
        };
    }
    true
}
fn unique(v: &[J]) -> bool {
    v.iter().enumerate().all(|(i, x)| !v[..i].contains(x))
}
fn absolute(v: &J) -> bool {
    v.as_string()
        .is_some_and(|s| !s.trim_js().is_empty() && s.units().first() == Some(&(b'/' as u16)))
}
fn handles_valid(v: &J) -> bool {
    if let Some(h) = v.get("handle") {
        if !["runner", "nativeId", "host", "workspacePath"]
            .iter()
            .all(|k| h[*k].as_string().is_some_and(|s| !s.trim_js().is_empty()))
            || !absolute(&h["workspacePath"])
        {
            return false;
        }
        if h.get("statePath").is_some_and(|p| !absolute(p)) {
            return false;
        }
    }
    v.get("continuation").is_none_or(handles_valid)
}
fn phase(v: &J, setup: bool) -> bool {
    v.as_string().is_some_and(|s| {
        [
            "plan",
            "plan-review",
            "implement",
            "code-review",
            "finalize",
            "reconcile",
        ]
        .iter()
        .any(|v| s.eq_str(v))
            || (setup && s.eq_str("setup"))
            || (s.units().starts_with(S::from("verify:").units()) && s.len() > 7)
    })
}
fn runtime_trim(v: &mut J) -> bool {
    if let Some(s) = v["version"].as_string() {
        let s = s.trim_js();
        if s.is_empty() {
            return false;
        }
        v["version"] = J::String(s);
    }
    if let Some(s) = v["source"]["location"].as_string() {
        let s = s.trim_js();
        if s.is_empty() {
            return false;
        }
        v["source"]["location"] = J::String(s);
    }
    true
}
fn semantics(scope: Scope, kind: &str, p: &mut J) -> bool {
    if matches!(
        kind,
        "session.started"
            | "session.suspended"
            | "session.native-handle-recorded"
            | "session.build-read-failed"
            | "phase.deferred"
            | "phase.deferral-escalated"
            | "phase.failed"
    ) && !phase(&p["phase"], false)
    {
        return false;
    }
    if kind == "escalation.raised" && !phase(&p["phase"], true) {
        return false;
    }
    if kind == "pr-attachment.hosted"
        && !p["asset"]["url"]
            .as_string()
            .is_some_and(|s| url::Url::parse(&s.to_usv_string()).is_ok())
    {
        return false;
    }
    if matches!(
        kind,
        "runner.runtime-recorded" | "execution.relaunch-requested" | "execution.drain-authorized"
    ) || kind.starts_with("dispatcher.")
    {
        for k in ["runtime", "from", "to", "failed", "restored"] {
            if let Some(v) = p.get_mut(k) {
                if v.get("version").is_some() && !runtime_trim(v) {
                    return false;
                }
            }
        }
    }
    let keys: &[&str] = match kind {
        "integration.verification-failed" => &["id", "head", "parent", "guidance"],
        "verify.completed" if same(&p["outcome"], "skipped") => &["reason"],
        "finalize.step-completed" if p["ok"].as_bool() == Some(true) => &["headSha"],
        "publication.lost" => &["reason"],
        "session.build-read-failed" | "phase.deferred" => &["diagnostic"],
        "dispatcher.run-started" => &["host"],
        _ => &[],
    };
    for k in keys {
        if let Some(s) = p[*k].as_string() {
            let s = s.trim_js();
            if s.is_empty() {
                return false;
            }
            p[*k] = J::String(s);
        }
    }
    if kind == "integration.verification-failed" {
        if let Some(a) = p["steps"].as_array_mut() {
            for v in a.iter_mut() {
                if let Some(s) = v.as_string() {
                    *v = J::String(s.trim_js());
                }
            }
            if a.iter().any(|v| v.as_string().is_none_or(S::is_empty)) || !unique(a) {
                return false;
            }
        }
    }
    if !handles_valid(p) {
        return false;
    }
    if scope == Scope::Session
        && kind == "turn.started"
        && same(&p["trigger"]["kind"], "wake")
        && (p["trigger"].get("build").is_some()
            == (p["trigger"]["journal"].as_bool() == Some(true)))
    {
        return false;
    }
    if let Some(a) = p.get("providerAttempts").and_then(J::as_array) {
        if kind == "harvest.failed" {
            if !unique(&a.iter().map(|v| v["index"].clone()).collect::<Vec<_>>()) {
                return false;
            }
        } else if a
            .iter()
            .enumerate()
            .any(|(i, v)| v["index"].as_i64() != Some(i as i64))
        {
            return false;
        }
    }
    if let Some(s) = p.get("substitution") {
        let f = s["failed"]["index"].as_i64().unwrap_or(-1);
        let n = s["selectedIndex"].as_i64().unwrap_or(-1);
        if (kind == "harvest.session.started" && n == f)
            || (kind != "harvest.session.started" && n != f + 1)
        {
            return false;
        }
    }
    if let Some(a) = p.get("verifySteps").and_then(J::as_array) {
        if !unique(a)
            || a.iter()
                .any(|s| s.as_string().is_none_or(|s| s.trim_js().is_empty()))
        {
            return false;
        }
    }
    if kind == "node.restack-requested"
        && same(&p["reason"], "presence")
        && (p.get("dependent").is_none() || p["identities"].as_array().is_none_or(Vec::is_empty))
    {
        return false;
    }
    if kind == "integration.landing-intended"
        && p.get("commandSeq").is_none()
        && p.get("decisionSeq").is_none()
    {
        return false;
    }
    if kind == "verify.reconcile-policy-captured" {
        let a = p["steps"].as_array().unwrap();
        if !unique(&a.iter().map(|v| v["step"].clone()).collect::<Vec<_>>())
            || a.iter().any(|v| {
                let expected = S::from_units(
                    "verify."
                        .encode_utf16()
                        .chain(
                            v["step"]
                                .as_string()
                                .map(S::units)
                                .unwrap_or(&[])
                                .iter()
                                .copied(),
                        )
                        .chain(".afterReconcile".encode_utf16())
                        .collect(),
                );
                !same(&v["source"], "verify.afterReconcile")
                    && v["source"].as_string() != Some(&expected)
            })
        {
            return false;
        }
    }
    if kind == "dispatcher.config-reloaded"
        && p["restartRequired"].as_array().is_some_and(|a| !unique(a))
    {
        return false;
    }
    if kind == "change-presence.observed"
        && p["identities"]
            .as_array()
            .is_some_and(|a| a.windows(2).any(|a| a[0].as_string() >= a[1].as_string()))
    {
        return false;
    }
    if kind == "tickets.migration-recorded" {
        let m = p["mapping"].as_object().unwrap();
        if (p["from"] == p["to"] && m.iter().any(|(k, v)| v.as_string() != Some(k)))
            || !unique(&m.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>())
        {
            return false;
        }
    }
    true
}
pub fn decode(scope: Scope, event: &J) -> Result<J, DataError> {
    decode_impl(scope, event, true)
}
pub fn decode_payload(scope: Scope, event: &J) -> Result<J, DataError> {
    decode_impl(scope, event, false)
}
fn decode_impl(scope: Scope, event: &J, envelope: bool) -> Result<J, DataError> {
    let kind = scalar(&event["type"]).unwrap_or_default();
    let seq = event["seq"].as_i64().unwrap_or(0);
    let bad = || DataError::Decode {
        scope: scope.name(),
        event_type: kind.clone(),
        seq,
    };
    let schema = events::schemas()[scope.name()].get(&kind).ok_or_else(bad)?;
    if (envelope
        && (seq <= 0
            || !scalar(&event["ts"])
                .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(&s).is_ok())
            || !actor_valid(&event["actor"])))
        || !event["payload"].is_object()
    {
        return Err(bad());
    }
    let mut result = event.clone();
    defaults(schema, &mut result["payload"]);
    if !valid(schema, &result["payload"]) {
        project(schema, &mut result["payload"]);
        defaults(schema, &mut result["payload"]);
    }
    if !valid(schema, &result["payload"]) || !semantics(scope, &kind, &mut result["payload"]) {
        return Err(bad());
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn persisted_unicode_matches_independent_source() {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(
            include_bytes!("../../fixtures/protocol-persisted-unicode.json.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .unwrap();
        let fixture: Schema = serde_json::from_slice(&bytes).unwrap();
        let mut failures = Vec::new();
        for row in fixture["cases"].as_array().unwrap() {
            let scope = match row["scope"].as_str().unwrap() {
                "build" => Scope::Build,
                "repository" => Scope::Repository,
                "session" => Scope::Session,
                _ => panic!(),
            };
            let input = crate::protocol::js_value::parse(row["input"].as_str().unwrap().as_bytes())
                .unwrap();
            let actual = decode_payload(scope, &input);
            if let Some(expected) = row.get("expected") {
                let expected =
                    crate::protocol::js_value::parse(expected.as_str().unwrap().as_bytes())
                        .unwrap();
                match actual {
                    Ok(actual) if actual == expected => {}
                    actual => failures.push(format!(
                        "{} input={} expected={} actual={actual:?}",
                        row["name"],
                        input.stringify(),
                        expected.stringify()
                    )),
                }
            } else if actual.is_ok() {
                failures.push(format!("{} accepted {}", row["name"], input.stringify()));
            }
        }
        assert!(
            failures.is_empty(),
            "{} failures\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
    #[test]
    fn existing_reducer_corpus_has_identical_persisted_projection() {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(
            include_bytes!("../../fixtures/protocol-reducers.json.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .unwrap();
        let fixture: Schema = serde_json::from_slice(&bytes).unwrap();
        let mut seen = std::collections::HashSet::new();
        for row in fixture["replay"].as_array().unwrap() {
            let scope = if row["scope"] == "repo" {
                Scope::Repository
            } else {
                Scope::Build
            };
            for event in row["events"].as_array().unwrap() {
                if !seen.insert(format!("{}:{}", scope.name(), event)) {
                    continue;
                }
                let original = events::decode(scope, event);
                let typed = decode(scope, &J::from_serde(event));
                match (original, typed) {
                    (Ok(a), Ok(b)) => assert_eq!(a, b.to_serde_checked().unwrap(), "{}", row["id"]),
                    (Err(_), Err(_)) => {}
                    (a, b) => panic!("{} {event}: scalar {a:?}; typed {b:?}", row["id"]),
                }
            }
        }
        assert!(seen.len() > 100);
    }
    #[test]
    fn original_units_survive_permissive_projection_and_protocol_ignores_actor() {
        let event=crate::protocol::js_value::parse(br#"{"type":"session.started","seq":1,"ts":"2026-01-01T00:00:00.000Z","actor":{},"payload":{"session":"\ud800","phase":"implement","round":1,"role":"implement","runner":"test","extra":"\udfff"}}"#).unwrap();
        let result = decode_payload(Scope::Build, &event).unwrap();
        assert_eq!(
            result["payload"]["session"].as_string().unwrap().units(),
            &[0xd800]
        );
        assert!(result["payload"].get("extra").is_none());
        assert!(decode(Scope::Build, &event).is_err());
    }
}
