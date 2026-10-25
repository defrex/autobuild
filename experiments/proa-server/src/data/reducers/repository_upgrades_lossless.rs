//! Port of dispatch-upgrade.ts's durable handoff projection.
use super::repository_lossless::control;
use crate::{
    js_json as json,
    protocol::js_value::{JsJson as Value, JsString},
};
fn remove(v: &mut Value, key: &str) {
    v.remove_js(&JsString::from(key));
}
fn present(v: &Value, key: &str) -> bool {
    v.get(key).is_some_and(|v| !v.is_null())
}
fn same(a: &Value, b: &Value) -> bool {
    [
        "correlation",
        "run",
        "lineage",
        "root",
        "cacheId",
        "from",
        "to",
    ]
    .iter()
    .all(|key| a.get(key) == b.get(key))
        && a["target"]["key"] == b["target"]["key"]
}
pub fn fold(acc: &mut Value, event: &Value) {
    let control_type = control(&event["type"]);
    let kind = control_type.as_str();
    let p = &event["payload"];
    if kind == "dispatcher.run-started" && p["lineage"].as_string().is_some_and(|v| !v.is_empty()) {
        if let Some(run) = p["run"].as_string() {
            acc["lineages"][run] = p["lineage"].clone();
        }
    }
    if kind == "dispatcher.tick-started" {
        acc["authoritativeRun"] = p["run"].clone();
    }
    if kind == "dispatcher.runtime-rolled-back" {
        if acc["rollbackIds"]
            .as_array()
            .unwrap()
            .contains(&p["correlation"])
        {
            return;
        }
        acc["rollbackIds"]
            .as_array_mut()
            .unwrap()
            .push(p["correlation"].clone());
        acc["authoritativeRun"] = p["run"].clone();
        acc["lastRollback"] = event.clone();
        acc["holds"][p["lineage"].as_string().unwrap()] = event.clone();
        return;
    }
    if kind == "dispatcher.rollback-hold-cleared" {
        let lineage = p["lineage"].as_string().unwrap();
        let hold = &acc["holds"][lineage];
        if present(hold, "payload")
            && hold["payload"]["correlation"] == p["correlation"]
            && hold["payload"]["target"]["key"] != p["target"]["key"]
        {
            acc["holds"].remove_js(lineage);
        }
        return;
    }
    if kind != "dispatcher.upgrade-target-resolved" && p.get("correlation").is_none() {
        return;
    }
    let Some(run) = p["run"].as_string() else {
        return;
    };
    if acc["runs"].get_js(run).is_none() {
        acc["runs"][run] = json!({"outstanding":{},"drained":0,"suspended":0});
    }
    let state = &mut acc["runs"][run];
    match kind {
        "dispatcher.upgrade-target-resolved" => state["resolved"] = event.clone(),
        "dispatcher.upgrade-detected" => state["detected"] = event.clone(),
        "dispatcher.upgrade-failed" => {
            if present(state, "handoff")
                && state["handoff"]["payload"]["correlation"] == p["correlation"]
            {
                return;
            }
            state["failure"] = event.clone();
            if present(state, "request")
                && state["request"]["payload"]["correlation"] == p["correlation"]
            {
                remove(state, "request");
            }
        }
        "dispatcher.target-prepared" => {
            if present(state, "handoff") && !present(state, "completed") {
                return;
            }
            if (present(state, "prepared")
                && state["prepared"]["payload"]["correlation"] == p["correlation"])
                || (present(state, "request") && !present(state, "failure"))
            {
                return;
            }
            state["prepared"] = event.clone();
            remove(state, "failure");
            remove(state, "request");
        }
        "dispatcher.yield-requested" => {
            if ["failure", "request", "handoff"]
                .iter()
                .any(|key| present(state, key))
                || !present(state, "prepared")
                || !same(&state["prepared"]["payload"], p)
                || p["successor"] == p["run"]
            {
                return;
            }
            state["request"] = event.clone();
        }
        "dispatcher.handoff-started" => {
            if present(state, "handoff") || (present(p, "mode") && present(state, "failure")) {
                return;
            }
            if present(p, "mode")
                && (!present(state, "request")
                    || !same(&state["request"]["payload"], p)
                    || p["successor"] != state["request"]["payload"]["successor"]
                    || p["mode"] != state["request"]["payload"]["mode"])
            {
                return;
            }
            state["handoff"] = event.clone();
            remove(state, "failure");
            if let Some(deadline) = p.get("deadline") {
                state["deadline"] = deadline.clone();
            } else {
                remove(state, "deadline");
            }
            state["outstanding"] = json!({});
            if let Some(builds) = p["builds"].as_array() {
                for build in builds {
                    state["outstanding"][build["slug"].as_string().unwrap()] =
                        build["instance"].clone();
                }
            }
        }
        "dispatcher.terminal-released" => {
            if present(state, "handoff")
                && same(&state["handoff"]["payload"], p)
                && !present(state, "released")
            {
                state["released"] = event.clone();
            }
        }
        "dispatcher.takeover" => {
            if present(state, "released")
                && same(&state["released"]["payload"], p)
                && state["request"]["payload"].get("successor") == p.get("successor")
            {
                if !present(state, "takeover") {
                    state["takeover"] = event.clone();
                }
                acc["authoritativeRun"] = p["successor"].clone();
            }
        }
        "dispatcher.drain-deadline" => {
            if !present(state, "completed")
                && present(state, "handoff")
                && same(&state["handoff"]["payload"], p)
            {
                state["deadline"] = p["deadline"].clone();
            }
        }
        "dispatcher.drain-settled" => {
            let slug = p["slug"].as_string().unwrap();
            if !present(state, "completed")
                && present(state, "handoff")
                && same(&state["handoff"]["payload"], p)
                && state["outstanding"].get_js(slug) == p.get("instance")
            {
                state["outstanding"].remove_js(slug);
                for (outcome, key) in [("drained", "drained"), ("suspended", "suspended")] {
                    if p["outcome"] == outcome {
                        state[key] = json!(state[key].as_i64().unwrap_or(0) + 1);
                    }
                }
            }
        }
        "dispatcher.handoff-completed"
            if present(state, "handoff")
                && same(&state["handoff"]["payload"], p)
                && state["outstanding"].as_object().unwrap().is_empty()
                && (!present(state, "request")
                    || state["request"]["payload"]["successor"] == p["successor"])
                && !present(state, "completed") =>
        {
            state["completed"] = event.clone();
        }
        _ => {}
    }
}
