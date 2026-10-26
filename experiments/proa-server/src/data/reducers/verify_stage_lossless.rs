use super::super::lossless::{number, push, remove, with_seq};
use crate::js_json as json;
use crate::protocol::js_value::{JsJson as Value, JsString as Key};
fn encode(value: &Value) -> String {
    value.stringify()
}
fn control(value: &Value) -> String {
    value
        .as_string()
        .and_then(|s| s.to_scalar().ok())
        .unwrap_or_default()
}
fn string(value: &Value) -> Option<Key> {
    value.as_string().cloned()
}

fn entries(value: &Value) -> Vec<(Key, Value)> {
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}
pub fn initial() -> Value {
    json!({"cycle":0,"concurrent":false,"executionSeq":0,"members":{},"owners":{},"outcomes":{},"cancellations":{},"failures":[],"implementations":{},"superseded":[]})
}
pub fn key(payload: &Value) -> Key {
    Key::from(encode(&json!([payload["step"], payload["attempt"]])))
}
fn cancellation(stage: &Value, escalation: &Value) -> Option<Value> {
    let session = string(&escalation["session"])?;
    let owner = string(&stage["owners"][&session])?;
    stage["cancellations"].get_js(&owner).cloned()
}
pub fn supersede(state: &mut Value, pending: &mut Value, event: &Value) {
    if control(&event["type"]) != "verify.cancelled" {
        return;
    }
    let stage = state["verifyStage"].clone();
    for field in ["openEscalations", "answeredEscalations"] {
        let mut retained = Vec::new();
        for escalation in state[field].as_array().unwrap().clone() {
            if let Some(cancellation) = cancellation(&stage, &escalation) {
                if escalation["resolution"] == "abort" {
                    pending["abort"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|command| command["seq"] != escalation["answeredSeq"]);
                }
                if !state["verifyStage"]["superseded"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["escalation"]["id"] == escalation["id"])
                {
                    push(
                        &mut state["verifyStage"],
                        "superseded",
                        json!({"escalation":escalation,"cancellation":cancellation}),
                    );
                }
            } else {
                retained.push(escalation);
            }
        }
        state[field] = json!(retained);
    }
}
pub fn raised(state: &mut Value, escalation: &Value) -> bool {
    if let Some(cancellation) = cancellation(&state["verifyStage"], escalation) {
        push(
            &mut state["verifyStage"],
            "superseded",
            json!({"escalation":escalation,"cancellation":cancellation}),
        );
        true
    } else {
        false
    }
}
pub fn advance(stage: &mut Value, event: &Value) {
    let payload = &event["payload"];
    match control(&event["type"]).as_str() {
        "verify.config-captured"
        | "verify.config-superseded"
        | "spec.revised"
        | "reconcile.completed"
        | "integration.prepared" => stage["cycle"] = event["seq"].clone(),
        "code-review.verdict" if payload["verdict"] == "approve" => {
            stage["cycle"] = event["seq"].clone()
        }
        "execution.started" => stage["executionSeq"] = event["seq"].clone(),
        "verify.started" => {
            let key = key(payload);
            if entries(&stage["members"]).iter().any(|(other, member)| {
                other != &key
                    && number(&member["seq"]) > number(&stage["cycle"])
                    && stage["outcomes"].get_js(other).is_none()
                    && stage["cancellations"].get_js(other).is_none()
            }) {
                stage["concurrent"] = json!(true);
            }
            stage["members"][&key] = with_seq(payload, event);
        }
        "session.started" => {
            if let Some(step) = verify_step(&payload["phase"]) {
                if payload.get("round").is_some() {
                    let key = key(&json!({"step":step,"attempt":payload["round"]}));
                    if stage["members"].get_js(&key).is_some() {
                        if let Some(session) = string(&payload["session"]) {
                            stage["owners"][&session] = json!(key);
                        }
                    }
                }
            }
        }
        "verify.completed" => {
            let key = key(payload);
            if stage["cancellations"].get_js(&key).is_none() {
                stage["outcomes"][&key] = event["seq"].clone();
            }
        }
        "verify.cancelled" => {
            let key = key(payload);
            if stage["outcomes"].get_js(&key).is_none()
                && stage["cancellations"].get_js(&key).is_none()
            {
                stage["cancellations"][&key] = with_seq(payload, event);
                stage["cleanupExecutionSeq"] = stage["executionSeq"].clone();
            }
        }
        "verify.stage-failed" => push(stage, "failures", with_seq(payload, event)),
        "implement.started" => {
            if let Some(failure) = payload.get("verifyStageFailure") {
                if stage["failures"].as_array().unwrap().iter().any(|entry| {
                    &entry["seq"] == failure
                        && number(&entry["seq"]) < number(&event["seq"])
                        && entry["cycle"] == stage["cycle"]
                }) {
                    let round = Key::from(number(&payload["round"]).to_string());
                    stage["implementations"][&round] = failure.clone();
                }
            }
        }
        _ => {}
    }
}
pub fn settle(state: &mut Value) {
    let stage = &state["verifyStage"];
    let running: Vec<Value> = entries(&stage["members"])
        .into_iter()
        .filter(|(key, member)| {
            number(&member["seq"]) > number(&state["verify"]["cycleSince"])
                && stage["outcomes"].get_js(key).is_none()
                && stage["cancellations"].get_js(key).is_none()
        })
        .map(|(_, member)| member)
        .collect();
    let concurrent = stage["concurrent"] == true;
    if !entries(&stage["members"]).is_empty() {
        state["verify"]["running"] = json!(running
            .iter()
            .map(|member| member["step"].clone())
            .collect::<Vec<_>>());
    }
    if concurrent {
        if let Some(last) = running.last() {
            state["verify"]["currentStep"] = last["step"].clone();
            if state.get("currentPhase").is_none()
                || verify_step(&state["currentPhase"]["phase"]).is_some()
            {
                state["currentPhase"] = json!({"phase":phase(&last["step"]),"attempt":last["attempt"],"seq":last["seq"]});
            }
        } else {
            remove(&mut state["verify"], "currentStep");
        }
    }
}

fn verify_step(value: &Value) -> Option<Value> {
    let units = &value.as_string()?.0;
    let prefix: Vec<u16> = "verify:".encode_utf16().collect();
    units
        .strip_prefix(prefix.as_slice())
        .map(|step| Value::String(Key::from(step.to_vec())))
}
fn phase(step: &Value) -> Value {
    json!(super::prefix("verify:", step))
}
