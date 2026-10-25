//! Stored-event decoding uses a generated, closed catalog. Producer schemas are
//! recorded by the corpus tool; adding a TS event requires regenerating them.
#[path = "events_lossless.rs"]
mod lossless;
use super::{error::DataError, reducers::Scope};
pub use lossless::{decode as decode_lossless, decode_payload as decode_payload_lossless};
use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock};

pub(super) fn schemas() -> &'static Value {
    static SCHEMAS: OnceLock<Value> = OnceLock::new();
    SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/event-schemas.json"))
            .expect("generated event schemas")
    })
}
/// Vocabulary filtering for display selectors over compact/adapted rows.
/// Persisted lifecycle reads still pass the strict decoder below.
pub(crate) fn known_event(scope: Scope, event_type: &str) -> bool {
    schemas()[scope.name()].get(event_type).is_some()
}
/// Remove additive object fields recursively only where the producer has a
/// closed object. The source envelope stays intact, including compatibility.
fn project(schema: &Value, value: &mut Value) {
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        // A valid later union member must win before considering projection
        // through an earlier member (notably the historical empty variant).
        if jsonschema::is_valid(schema, value) {
            return;
        }
        for branch in branches {
            let mut candidate = value.clone();
            project(branch, &mut candidate);
            if jsonschema::is_valid(branch, &candidate) {
                *value = candidate;
                return;
            }
        }
    }
    if let Some(object) = value.as_object_mut() {
        if let Some(properties) = schema["properties"].as_object() {
            if schema["additionalProperties"] == false {
                object.retain(|key, _| properties.contains_key(key));
            }
            for (key, child) in object.iter_mut() {
                if let Some(s) = properties.get(key) {
                    project(s, child);
                } else if schema["additionalProperties"].is_object() {
                    project(&schema["additionalProperties"], child);
                }
            }
        } else if schema["additionalProperties"].is_object() {
            for child in object.values_mut() {
                project(&schema["additionalProperties"], child);
            }
        }
    }
    if let Some(array) = value.as_array_mut() {
        for (index, item) in array.iter_mut().enumerate() {
            if let Some(s) = schema["prefixItems"].get(index) {
                project(s, item);
            } else if schema["items"].is_object() {
                project(&schema["items"], item);
            }
        }
    }
}
fn has_defaults(schema: &Value) -> bool {
    match schema {
        Value::Object(object) => {
            object.contains_key("default") || object.values().any(has_defaults)
        }
        Value::Array(items) => items.iter().any(has_defaults),
        _ => false,
    }
}
fn validators() -> &'static HashMap<String, (jsonschema::Validator, bool)> {
    static VALIDATORS: OnceLock<HashMap<String, (jsonschema::Validator, bool)>> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        let mut out = HashMap::new();
        for (scope, catalog) in schemas().as_object().unwrap() {
            for (kind, schema) in catalog.as_object().unwrap() {
                out.insert(
                    format!("{scope}:{kind}"),
                    (
                        jsonschema::validator_for(schema).expect("generated schema validates"),
                        has_defaults(schema),
                    ),
                );
            }
        }
        out
    })
}
// JSON Schema cannot express Zod's defaults, string transforms, or custom refinements.
fn defaults(schema: &Value, value: &mut Value) {
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        for branch in branches {
            let mut candidate = value.clone();
            defaults(branch, &mut candidate);
            if jsonschema::is_valid(branch, &candidate) {
                *value = candidate;
                return;
            }
        }
    }
    if let Some(object) = value.as_object_mut() {
        if let Some(properties) = schema["properties"].as_object() {
            for (key, child_schema) in properties {
                if !object.contains_key(key) {
                    if let Some(default) = child_schema.get("default") {
                        object.insert(key.clone(), default.clone());
                    }
                }
                if let Some(child) = object.get_mut(key) {
                    defaults(child_schema, child);
                }
            }
        }
    }
    if let Some(items) = value.as_array_mut() {
        for item in items {
            if schema["items"].is_object() {
                defaults(&schema["items"], item);
            }
        }
    }
}
fn nonempty(v: &Value, key: &str) -> bool {
    v[key].as_str().is_some_and(|s| !s.is_empty())
}
fn actor_valid(actor: &Value) -> bool {
    let valid = match actor["kind"].as_str() {
        Some("kernel" | "dispatcher") => true,
        Some("agent") => nonempty(actor, "role") && nonempty(actor, "session"),
        Some("human") => nonempty(actor, "user"),
        Some("ingester") => nonempty(actor, "source"),
        _ => false,
    };
    if !valid {
        return false;
    }
    if let Some(via) = actor.get("via") {
        if actor["kind"] != "human" {
            return false;
        }
        return match via["kind"].as_str() {
            Some("session") => nonempty(via, "id"),
            Some("mcp") => nonempty(via, "client"),
            _ => false,
        };
    }
    true
}
fn unique(values: &[Value]) -> bool {
    values
        .iter()
        .enumerate()
        .all(|(i, value)| !values[..i].contains(value))
}
fn handles_valid(value: &Value) -> bool {
    if let Some(object) = value.as_object() {
        if let Some(handle) = object.get("handle") {
            if !["runner", "nativeId", "host", "workspacePath"]
                .iter()
                .all(|key| handle[key].as_str().is_some_and(|v| !v.trim().is_empty()))
                || !handle["workspacePath"]
                    .as_str()
                    .is_some_and(|v| std::path::Path::new(v).is_absolute())
            {
                return false;
            }
            if let Some(path) = handle.get("statePath") {
                if !path
                    .as_str()
                    .is_some_and(|v| !v.trim().is_empty() && std::path::Path::new(v).is_absolute())
                {
                    return false;
                }
            }
        }
        if let Some(continuation) = object.get("continuation") {
            return handles_valid(continuation);
        }
    }
    true
}
fn semantics(scope: Scope, kind: &str, p: &mut Value) -> bool {
    let trim_keys: &[&str] = match kind {
        "integration.verification-failed" => &["id", "head", "parent", "guidance"],
        "verify.completed" if p["outcome"] == "skipped" => &["reason"],
        "finalize.step-completed" if p["ok"] == true => &["headSha"],
        "publication.lost" => &["reason"],
        "session.build-read-failed" | "phase.deferred" => &["diagnostic"],
        "dispatcher.run-started" => &["host"],
        _ => &[],
    };
    for key in trim_keys {
        if let Some(value) = p
            .get(*key)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_owned())
        {
            if value.is_empty() {
                return false;
            }
            p[*key] = Value::String(value);
        }
    }
    if kind == "integration.verification-failed" {
        if let Some(steps) = p["steps"].as_array_mut() {
            for step in steps.iter_mut() {
                if let Some(s) = step.as_str() {
                    *step = Value::String(s.trim().to_owned());
                }
            }
            if steps.iter().any(|s| s.as_str().is_none_or(str::is_empty)) || !unique(steps) {
                return false;
            }
        }
    }
    if !handles_valid(p) {
        return false;
    }
    if scope == Scope::Session
        && kind == "turn.started"
        && p["trigger"]["kind"] == "wake"
        && (p["trigger"].get("build").is_some() == (p["trigger"]["journal"] == true))
    {
        return false;
    }
    if let Some(attempts) = p.get("providerAttempts").and_then(Value::as_array) {
        if kind == "harvest.failed" {
            if !unique(
                &attempts
                    .iter()
                    .map(|a| a["index"].clone())
                    .collect::<Vec<_>>(),
            ) {
                return false;
            }
        } else if attempts
            .iter()
            .enumerate()
            .any(|(i, a)| a["index"].as_u64() != Some(i as u64))
        {
            return false;
        }
    }
    if let Some(sub) = p.get("substitution") {
        let failed = sub["failed"]["index"].as_i64().unwrap_or(-1);
        let selected = sub["selectedIndex"].as_i64().unwrap_or(-1);
        if (kind == "harvest.session.started" && selected == failed)
            || (kind != "harvest.session.started" && selected != failed + 1)
        {
            return false;
        }
    }
    if let Some(steps) = p.get("verifySteps").and_then(Value::as_array) {
        if !unique(steps)
            || steps
                .iter()
                .any(|s| s.as_str().is_none_or(|s| s.trim().is_empty()))
        {
            return false;
        }
    }
    if kind == "node.restack-requested"
        && p["reason"] == "presence"
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
        let steps = p["steps"].as_array().unwrap();
        if !unique(&steps.iter().map(|s| s["step"].clone()).collect::<Vec<_>>())
            || steps.iter().any(|s| {
                s["source"] != "verify.afterReconcile"
                    && s["source"].as_str()
                        != Some(
                            format!("verify.{}.afterReconcile", s["step"].as_str().unwrap_or(""))
                                .as_str(),
                        )
            })
        {
            return false;
        }
    }
    if kind == "dispatcher.config-reloaded" {
        if let Some(paths) = p["restartRequired"].as_array() {
            if !unique(paths) {
                return false;
            }
        }
    }
    if kind == "change-presence.observed" {
        if let Some(ids) = p["identities"].as_array() {
            if ids
                .windows(2)
                .any(|pair| pair[0].as_str() >= pair[1].as_str())
            {
                return false;
            }
        }
    }
    if kind == "tickets.migration-recorded" {
        let mapping = p["mapping"].as_object().unwrap();
        if (p["from"] == p["to"] && mapping.iter().any(|(key, v)| v.as_str() != Some(key)))
            || !unique(&mapping.values().cloned().collect::<Vec<_>>())
        {
            return false;
        }
    }
    true
}
pub fn decode(scope: Scope, event: &Value) -> Result<Value, DataError> {
    let kind = event["type"].as_str().unwrap_or("");
    let seq = event["seq"].as_i64().unwrap_or(0);
    let bad = || DataError::Decode {
        scope: scope.name(),
        event_type: kind.to_string(),
        seq,
    };
    let schema = schemas()[scope.name()].get(kind).ok_or_else(bad)?;
    if seq <= 0
        || !event["ts"]
            .as_str()
            .is_some_and(|ts| chrono::DateTime::parse_from_rfc3339(ts).is_ok())
        || !actor_valid(&event["actor"])
        || !event["payload"].is_object()
    {
        return Err(bad());
    }
    let mut result = event.clone();
    let (validator, needs_defaults) = &validators()[&format!("{}:{kind}", scope.name())];
    if *needs_defaults {
        defaults(schema, &mut result["payload"]);
    }
    if !validator.is_valid(&result["payload"]) {
        project(schema, &mut result["payload"]);
        if *needs_defaults {
            defaults(schema, &mut result["payload"]);
        }
    }
    if !validator.is_valid(&result["payload"]) {
        return Err(bad());
    }
    if !semantics(scope, kind, &mut result["payload"]) {
        return Err(bad());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn event(kind: &str, payload: Value) -> Value {
        json!({"type":kind,"seq":1,"ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"kernel"},"payload":payload})
    }
    #[test]
    fn envelopes_reject_invalid_actor_and_timestamp() {
        let valid = event(
            "observation.recorded",
            json!({"id":"o1","kind":"followup","summary":"test"}),
        );
        assert!(decode(Scope::Build, &valid).is_ok());
        for actor in [
            json!({}),
            json!({"kind":"future"}),
            json!({"kind":"agent","role":"implement"}),
            json!({"kind":"kernel","via":{"kind":"mcp","client":"test"}}),
        ] {
            let mut malformed = valid.clone();
            malformed["actor"] = actor;
            assert!(decode(Scope::Build, &malformed).is_err());
        }
        let mut malformed = valid;
        malformed["ts"] = json!("not-a-date");
        assert!(decode(Scope::Build, &malformed).is_err());
    }
    #[test]
    fn wake_names_exactly_one_source() {
        for (build, journal, valid) in [
            (true, false, true),
            (false, true, true),
            (true, true, false),
            (false, false, false),
        ] {
            let mut trigger = json!({"kind":"wake","seq":1,"type":"escalated"});
            if build {
                trigger["build"] = json!("build");
            }
            if journal {
                trigger["journal"] = json!(true);
            }
            let e = event(
                "turn.started",
                json!({"turn":"turn","stream":"stream","trigger":trigger}),
            );
            assert_eq!(decode(Scope::Session, &e).is_ok(), valid);
        }
    }
    #[test]
    fn recursive_defaults_and_zod_refinements_are_preserved() {
        let schema = json!({"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"persists":{"type":"array","default":[]}}}}}});
        let mut value = json!({"findings":[{}]});
        defaults(&schema, &mut value);
        assert_eq!(value, json!({"findings":[{"persists":[]}]}));
        let invalid = event(
            "plan.completed",
            json!({"round":1,"artifact":{"kind":"plan","rev":0},"verifySteps":["types","types"]}),
        );
        assert!(decode(Scope::Build, &invalid).is_err());
        let invalid = event(
            "plan.completed",
            json!({"round":1,"artifact":{"kind":"plan","rev":0},"verifySteps":["   "]}),
        );
        assert!(decode(Scope::Build, &invalid).is_err());
    }
    #[test]
    fn string_transforms_match_stored_read_parser() {
        let e = event(
            "verify.completed",
            json!({"step":"docs","attempt":1,"outcome":"skipped","reason":"  policy disabled  "}),
        );
        assert_eq!(
            decode(Scope::Build, &e).unwrap()["payload"]["reason"],
            "policy disabled"
        );
    }
}
