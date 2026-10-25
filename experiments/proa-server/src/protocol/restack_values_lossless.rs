//! Node/leaf durable restack projections. These fold facts only; reservations
//! and invalid semantic transitions preserve the core reducer's refusals.
use super::error::ProtocolError;
use crate::js_json as json;
use crate::protocol::js_value::{JsJson as J, JsString as S};
use std::collections::{BTreeSet, HashMap};
fn invalid(message: &str) -> ProtocolError {
    ProtocolError::new(500, "internal", message)
}
fn remove(state: &mut J, keys: &[&str]) {
    for key in keys {
        state.remove_js(&S::from(*key));
    }
}
fn record_put(state: &mut J, field: &str, key: &S, value: J) {
    if state.get(field).is_none() {
        state[field] = json!({});
    }
    if !key.eq_str("__proto__") {
        state[field][key] = value;
    }
}
fn record_delete(state: &mut J, field: &str, key: &S) {
    if let Some(record) = state.get_mut(field) {
        record.remove_js(key);
    }
}
pub fn reduce_leaf(events: &[J]) -> J {
    let mut state = json!({"gates":{}});
    for event in events {
        advance_leaf(&mut state, event);
    }
    state
}
pub fn advance_leaf(state: &mut J, event: &J) {
    let payload = &event["payload"];
    match event["type"]
        .as_string()
        .and_then(|s| s.to_scalar().ok())
        .unwrap_or_default()
        .as_str()
    {
        "workspace.provisioned" => {
            if state.get("initialBase").is_none() {
                if let Some(sha) = payload["base"].get("sha") {
                    state["initialBase"] = sha.clone();
                }
            }
        }
        "finalize.completed" => state["finalizedAt"] = event["seq"].clone(),
        "node.parent-accepted" => remove(state, &["target"]),
        "target.moved" => {
            let mut target = json!({"seq":event["seq"]});
            for (key, value) in payload.as_object().into_iter().flatten() {
                target[key] = value.clone();
            }
            state["target"] = target;
        }
        "finalize.step-completed" => {
            if payload["ok"] == true && payload.get("headSha").is_some() {
                state["postStepAt"] = event["seq"].clone();
            }
        }
        "restack.prepared" => {
            state["active"] = payload.clone();
            remove(state, &["replay", "intent", "reconcileAttempt"]);
        }
        "restack.replayed" => {
            if payload.get("id") == state["active"].get("id") {
                state["replay"] = payload.clone();
            }
        }
        "restack.publish-intended" => {
            if payload.get("id") == state["active"].get("id") {
                state["intent"] = payload.clone();
            }
        }
        "reconcile.started" => {
            if state.get("active").is_some()
                && payload.get("restackId") == state["active"].get("id")
            {
                state["reconcileAttempt"] = payload["attempt"].clone();
                state["initialVerification"] = json!(state["active"]["trigger"] == "verify-entry");
            } else {
                state["initialVerification"] = json!(false);
            }
        }
        "restack.completed" => {
            state["completedAt"] = event["seq"].clone();
            state["completed"] = payload.clone();
            let cycle = payload["cycle"].stringify();
            state["gates"][cycle] = payload.clone();
            if state["active"].get("id") == payload.get("id") {
                remove(state, &["active", "replay", "intent"]);
            }
        }
        _ => {}
    }
}
enum Alias {
    Value(J),
    Function(String),
}
fn alias(state: &J, functions: &HashMap<S, String>, key: &S) -> Alias {
    if let Some(name) = functions.get(key) {
        return Alias::Function(name.clone());
    }
    if let Some(value) = state["foreignAliases"].get_js(key) {
        return Alias::Value(value.clone());
    }
    if key.eq_str("__proto__") {
        return Alias::Value(json!({}));
    }
    if matches!(
        key.to_scalar().unwrap_or_default().as_str(),
        "constructor"
            | "toString"
            | "toLocaleString"
            | "valueOf"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
    ) {
        return Alias::Function(if key.eq_str("constructor") {
            "Object".into()
        } else {
            key.to_scalar().expect("closed native property")
        });
    }
    Alias::Value(json!(key))
}
fn alias_text(value: &Alias) -> S {
    match value {
        Alias::Function(name) => S::from(format!("function {name}() {{ [native code] }}")),
        Alias::Value(v) if v.as_string().is_some() => v.as_string().unwrap().clone(),
        Alias::Value(_) => "[object Object]".into(),
    }
}
pub fn reduce_node(events: &[J]) -> Result<J, ProtocolError> {
    let mut state = json!({"items":[]});
    let mut functions: HashMap<S, String> = HashMap::new();
    for event in events {
        let payload = &event["payload"];
        let active = state.get("active").cloned();
        let prepared = state.get("prepared").cloned();
        let intent = state.get("intent").cloned();
        let items = state["items"].as_array().unwrap().clone();
        match event["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap_or_default()
            .as_str()
        {
            "node.restack-requested" => record_put(
                &mut state,
                "requests",
                payload["id"].as_string().unwrap(),
                payload.clone(),
            ),
            "node.restack-satisfied" => {
                record_delete(&mut state, "requests", payload["id"].as_string().unwrap())
            }
            "node.parent-distance" => state["distance"] = payload.clone(),
            "node.parent-requested" => state["parentRequest"] = payload.clone(),
            "node.parent-accepted" => {
                state["parentChange"] = payload.clone();
                remove(
                    &mut state,
                    &[
                        "parentRequest",
                        "parentReplay",
                        "parentPr",
                        "parentRejection",
                        "distance",
                        "observedParent",
                    ],
                );
            }
            "node.parent-cancelled" => {
                if state["parentRequest"].get("id") == payload.get("id") {
                    remove(&mut state, &["parentRequest"]);
                }
            }
            "node.parent-rejection-cleared" => remove(&mut state, &["parentRejection"]),
            "node.parent-rejected" => state["parentRejection"] = payload.clone(),
            "node.parent-pr-retargeted" => state["parentPr"] = payload["id"].clone(),
            "node.parent-completed" => {
                if state["parentChange"].get("id") == payload.get("id") {
                    remove(&mut state, &["parentChange"]);
                }
            }
            "target.moved" => {
                if state.get("contributionBase").is_some() {
                    state["observedParent"] = payload.clone();
                }
            }
            "node.opened" => {
                if state.get("contributionBase").is_none() {
                    state["contributionBase"] = payload["sha"].clone();
                }
                record_put(
                    &mut state,
                    "contributionBoundaries",
                    payload["sha"].as_string().unwrap(),
                    payload["sha"].clone(),
                );
            }
            "node.writer-reserved" => {
                if active.is_some() {
                    return Err(invalid("node writer already reserved"));
                }
                state["reservedSeq"] = event["seq"].clone();
                state["active"] = payload.clone();
                record_put(
                    &mut state,
                    "contributionBoundaries",
                    payload["expected"].as_string().unwrap(),
                    payload["oldBase"].clone(),
                );
                state["items"] = json!([]);
            }
            "node.item-prepared" => {
                if payload.get("id") != active.as_ref().and_then(|a| a.get("id"))
                    || payload["index"].as_i64() != Some(items.len() as i64)
                {
                    return Err(invalid("node item is not the next reserved change"));
                }
                let a = active.as_ref().unwrap();
                if payload["index"].as_i64().unwrap()
                    >= a["changes"].as_array().unwrap().len() as i64
                {
                    return Err(invalid("node item is outside the reserved contribution"));
                }
                if payload.get("base")
                    != items
                        .last()
                        .and_then(|p| p.get("head"))
                        .or_else(|| a.get("parent"))
                {
                    return Err(invalid("node item has an invalid replay prefix"));
                }
                state["prepared"] = payload.clone();
            }
            "node.item-conflicted" => {
                if payload.get("id") != prepared.as_ref().and_then(|p| p.get("id"))
                    || payload.get("index") != prepared.as_ref().and_then(|p| p.get("index"))
                    || payload.get("base") != prepared.as_ref().and_then(|p| p.get("base"))
                {
                    return Err(invalid("node conflict does not match the prepared change"));
                }
                state["conflict"] = payload.clone();
            }
            "node.item-replayed" => {
                if payload.get("id") != active.as_ref().and_then(|a| a.get("id"))
                    || payload["index"]
                        .as_i64()
                        .is_some_and(|i| i < items.len() as i64)
                {
                    continue;
                }
                if payload.get("id") != prepared.as_ref().and_then(|p| p.get("id"))
                    || payload.get("index") != prepared.as_ref().and_then(|p| p.get("index"))
                    || payload.get("base") != prepared.as_ref().and_then(|p| p.get("base"))
                {
                    return Err(invalid("node receipt does not match the prepared change"));
                }
                if payload["dropped"] == true && payload["head"] != payload["base"] {
                    return Err(invalid("dropped node change moved the replay prefix"));
                }
                state["items"].as_array_mut().unwrap().push(payload.clone());
                remove(&mut state, &["prepared", "conflict"]);
            }
            "node.publish-intended" => {
                if payload.get("id") != active.as_ref().and_then(|a| a.get("id"))
                    || prepared.is_some()
                    || items.len()
                        != active
                            .as_ref()
                            .and_then(|a| a["changes"].as_array())
                            .map_or(0, Vec::len)
                {
                    return Err(invalid("node publication requires the complete replay"));
                }
                if payload.get("head")
                    != items
                        .last()
                        .and_then(|p| p.get("head"))
                        .or_else(|| active.as_ref().and_then(|a| a.get("parent")))
                {
                    return Err(invalid(
                        "node publication does not match the retained prefix",
                    ));
                }
                state["intent"] = payload.clone();
            }
            "node.rewritten" => {
                if payload.get("id") != intent.as_ref().and_then(|a| a.get("id"))
                    || payload.get("head") != intent.as_ref().and_then(|a| a.get("head"))
                    || payload.get("previous") != active.as_ref().and_then(|a| a.get("expected"))
                {
                    return Err(invalid(
                        "node rewrite does not match its publication intent",
                    ));
                }
                let a = active.as_ref().unwrap();
                let base = if a["operation"] == "restack" {
                    a["parent"].clone()
                } else {
                    state
                        .get("contributionBase")
                        .cloned()
                        .unwrap_or_else(|| a["oldBase"].clone())
                };
                record_put(
                    &mut state,
                    "contributionBoundaries",
                    payload["head"].as_string().unwrap(),
                    base,
                );
                if a["operation"] == "restack" {
                    if state.get("foreignAliases").is_none() {
                        state["foreignAliases"] = json!({});
                    }
                    let mut dropped: BTreeSet<S> = state["droppedIdentities"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(J::as_string)
                        .cloned()
                        .collect();
                    for item in &items {
                        if let Some(change) = item["index"]
                            .as_i64()
                            .and_then(|i| a["changes"].as_array().unwrap().get(i as usize))
                        {
                            let sha = change["sha"].as_string().unwrap();
                            let alias = alias(&state, &functions, sha);
                            if item["dropped"] == true {
                                dropped.insert(
                                    if let Some(build) = change.get("build").and_then(J::as_string)
                                    {
                                        concat("build:", build)
                                    } else {
                                        concat("foreign:", &alias_text(&alias))
                                    },
                                );
                            } else if change.get("build").is_none() {
                                let head = item["head"].as_string().unwrap();
                                if !head.eq_str("__proto__") {
                                    match alias {
                                        Alias::Value(value) => {
                                            functions.remove(head);
                                            record_put(&mut state, "foreignAliases", head, value);
                                        }
                                        Alias::Function(name) => {
                                            record_delete(&mut state, "foreignAliases", head);
                                            functions.insert(head.clone(), name);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let mut dropped = dropped.into_iter().collect::<Vec<_>>();
                    dropped.sort();
                    state["droppedIdentities"] =
                        J::Array(dropped.into_iter().map(J::String).collect());
                }
                state["rewritten"] = payload.clone();
            }
            "node.writer-settled" => {
                if payload.get("id") != active.as_ref().and_then(|a| a.get("id")) {
                    return Err(invalid("unknown node writer reservation"));
                }
                if payload["outcome"] == "completed" {
                    if state.get("rewritten").is_none() {
                        return Err(invalid("node completion requires a confirmed rewrite"));
                    }
                    let a = active.as_ref().unwrap();
                    if a["operation"] == "restack" {
                        if let Some(id) = state["parentChange"].get("id").cloned() {
                            state["parentReplay"] = id;
                        }
                        for id in a["requests"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(J::as_string)
                        {
                            record_delete(&mut state, "requests", id);
                        }
                        state["contributionBase"] = a["parent"].clone();
                        remove(&mut state, &["distance"]);
                    }
                }
                remove(
                    &mut state,
                    &["active", "prepared", "conflict", "intent", "rewritten"],
                );
                state["items"] = json!([]);
            }
            "node.contribution-recorded" => state["contribution"] = payload.clone(),
            "node.inventory" => {
                if let Some(base) = state.get("contributionBase").cloned() {
                    let base = payload
                        .get("base")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or_else(|| {
                            if active.as_ref().is_some_and(|a| a["operation"] == "restack")
                                && state["rewritten"].get("head") == payload.get("head")
                            {
                                active.as_ref().unwrap()["parent"].clone()
                            } else {
                                base
                            }
                        });
                    record_put(
                        &mut state,
                        "contributionBoundaries",
                        payload["head"].as_string().unwrap(),
                        base,
                    );
                }
                state["inventory"] = payload.clone();
            }
            _ => {}
        }
    }
    if !functions.is_empty() {
        return Err(invalid("The object can not be cloned."));
    }
    Ok(state)
}
pub fn reduce(name: &str, events: &[J]) -> Result<J, ProtocolError> {
    match name {
        "nodeRestack" => reduce_node(events),
        "leafRestack" => Ok(reduce_leaf(events)),
        _ => Err(invalid("unknown restack reducer")),
    }
}

fn concat(prefix: &str, value: &S) -> S {
    S::from_units(
        prefix
            .encode_utf16()
            .chain(value.units().iter().copied())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn typed_restack_states_and_refusals_match_source_corpus() {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(
            &include_bytes!("../../fixtures/protocol-restack.json.gz")[..],
        )
        .read_to_end(&mut bytes)
        .unwrap();
        let fixture = crate::protocol::js_value::parse(&bytes).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_string().unwrap().to_scalar().unwrap();
            let mut actual = match reduce(&name, case["events"].as_array().unwrap()) {
                Ok(value) => json!({"accepted":value}),
                Err(e) => json!({"error":e.message_js()}),
            };
            let mut expected = case["oracle"].clone();
            actual.sort_all_objects();
            expected.sort_all_objects();
            assert_eq!(actual, expected, "{:?}", case["id"]);
        }
        assert!(fixture["cases"].as_array().unwrap().len() > 200);
    }
    #[test]
    fn original_request_keys_do_not_alias_replacement() {
        let events=crate::protocol::js_value::parse(br#"[{"type":"node.restack-requested","payload":{"id":"\ud800"}},{"type":"node.restack-requested","payload":{"id":"\ufffd"}},{"type":"node.restack-satisfied","payload":{"id":"\ud800"}}]"#).unwrap();
        let value = reduce_node(events.as_array().unwrap()).unwrap();
        assert!(value["requests"]
            .get_js(&S::from_units(vec![0xd800]))
            .is_none());
        assert!(value["requests"].get_js(&S::from("�")).is_some());
    }
}
