//! Port of repository-attention.ts's episode snapshot (not wall-clock pending observations).
use super::repository_lossless::control;
use crate::{
    js_json as json,
    protocol::js_value::{JsJson as Value, JsString},
};
fn millis(v: &Value) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&control(v))
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}
fn remove(v: &mut Value, key: &str) {
    v.remove_js(&JsString::from(key));
}
fn find(v: &Value, key: &Value) -> Option<usize> {
    v.as_array()
        .unwrap()
        .iter()
        .position(|entry| &entry[0] == key)
}
fn defers(state: &Value, now: i64) -> bool {
    state["sources"].as_array().unwrap().iter().any(|entry| {
        let source = &entry[1];
        now < source["deadline"].as_i64().unwrap_or(0)
            || (source["requiresRetry"] == true && source["retryObserved"] != true)
    })
}
fn observe_retry(state: &mut Value, run: &Value) {
    let Some(index) = find(&state["tickStarts"], run) else {
        return;
    };
    let started = state["tickStarts"].as_array_mut().unwrap().remove(index)[1]
        .as_i64()
        .unwrap_or(0);
    if state.get("forge").is_some() && started >= state["forge"]["deadline"].as_i64().unwrap_or(0) {
        state["forge"]["retryObserved"] = json!(true);
    }
    for entry in state["sources"].as_array_mut().unwrap() {
        if started >= entry[1]["deadline"].as_i64().unwrap_or(0) {
            entry[1]["retryObserved"] = json!(true);
        }
    }
}
pub fn fold(state: &mut Value, event: &Value) {
    let p = &event["payload"];
    match control(&event["type"]).as_str() {
        "dispatcher.forge-degraded" => {
            let deadline = millis(&p["resetAt"]);
            if state.get("forge").is_none() {
                state["forge"] = json!({"event":event,"deadline":deadline,"retryObserved":false});
            } else {
                state["forge"]["deadline"] = json!(state["forge"]["deadline"]
                    .as_i64()
                    .unwrap_or(0)
                    .min(deadline));
            }
        }
        "dispatcher.forge-recovered" => remove(state, "forge"),
        "dispatcher.ticket-source-degraded" => {
            let requires = p.get("resetAt").is_some();
            let deadline = if requires {
                millis(&p["resetAt"])
            } else {
                millis(&event["ts"]) + 15 * 60_000
            };
            if let Some(index) = find(&state["sources"], &p["source"]) {
                let source = &mut state["sources"][index][1];
                source["deadline"] = json!(source["deadline"].as_i64().unwrap_or(0).min(deadline));
                source["requiresRetry"] = json!(source["requiresRetry"] == true || requires);
            } else {
                state["sources"].as_array_mut().unwrap().push(json!([p["source"],{"event":event,"deadline":deadline,"dependencyLimited":false,"requiresRetry":requires,"retryObserved":false}]));
            }
            if defers(state, millis(&event["ts"])) {
                remove(state, "failure");
            }
        }
        "dispatcher.ticket-source-dependency-limited" => {
            if let Some(index) = find(&state["sources"], &p["source"]) {
                state["sources"][index][1]["dependencyLimited"] = json!(true);
            }
        }
        "dispatcher.ticket-source-recovered" => {
            if let Some(index) = find(&state["sources"], &p["source"]) {
                state["sources"].as_array_mut().unwrap().remove(index);
            }
        }
        "dispatcher.run-started" => {
            remove(state, "failure");
            state["tickStarts"] = json!([]);
        }
        "dispatcher.run-stopped" => {
            if let Some(index) = find(&state["tickStarts"], &p["run"]) {
                state["tickStarts"].as_array_mut().unwrap().remove(index);
            }
            if state["failure"]["payload"].get("run") == p.get("run") {
                remove(state, "failure");
            }
        }
        "dispatcher.tick-started" => {
            let time = millis(p.get("startedAt").unwrap_or(&event["ts"]));
            if let Some(index) = find(&state["tickStarts"], &p["run"]) {
                state["tickStarts"][index][1] = json!(time);
            } else {
                state["tickStarts"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!([p["run"], time]));
            }
        }
        "dispatcher.tick-completed" => {
            observe_retry(state, &p["run"]);
            if state["failure"]["payload"].get("run") == p.get("run") {
                remove(state, "failure");
            }
        }
        "dispatcher.tick-failed" => {
            observe_retry(state, &p["run"]);
            if defers(state, millis(&event["ts"])) {
                remove(state, "failure");
            } else if state["failure"]["payload"].get("run") != p.get("run") {
                state["failure"] = event.clone();
            }
        }
        _ => {}
    }
}
