//! Stored-event decoding uses a generated, closed catalog. Producer schemas are
//! recorded by the corpus tool; adding a TS event requires regenerating them.
use super::{error::DataError, reducers::Scope};
use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock};

fn schemas() -> &'static Value {
    static SCHEMAS: OnceLock<Value> = OnceLock::new();
    SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/event-schemas.json"))
            .expect("generated event schemas")
    })
}
/// Remove additive object fields recursively only where the producer has a
/// closed object. The source envelope stays intact, including compatibility.
fn project(schema: &Value, value: &mut Value) {
    if jsonschema::is_valid(schema, value) {
        return;
    }
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
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
fn validators() -> &'static HashMap<String, jsonschema::Validator> {
    static VALIDATORS: OnceLock<HashMap<String, jsonschema::Validator>> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        let mut out = HashMap::new();
        for (scope, catalog) in schemas().as_object().unwrap() {
            for (kind, schema) in catalog.as_object().unwrap() {
                out.insert(
                    format!("{scope}:{kind}"),
                    jsonschema::validator_for(schema).expect("generated schema validates"),
                );
            }
        }
        out
    })
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
        || !event["ts"].is_string()
        || !event["actor"].is_object()
        || !event["payload"].is_object()
    {
        return Err(bad());
    }
    let mut result = event.clone();
    let validator = &validators()[&format!("{}:{kind}", scope.name())];
    if !validator.is_valid(&result["payload"]) {
        project(schema, &mut result["payload"]);
    }
    if !validator.is_valid(&result["payload"]) {
        return Err(bad());
    }
    Ok(result)
}
