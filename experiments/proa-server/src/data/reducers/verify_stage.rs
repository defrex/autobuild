use super::super::{number, push, remove, with_seq};
use serde_json::{json, Value};
type Key = String;
fn encode(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}
fn control(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}
fn string(value: &Value) -> Option<Key> {
    value.as_str().map(str::to_owned)
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
    encode(&json!([payload["step"], payload["attempt"]]))
}
fn cancellation(stage: &Value, escalation: &Value) -> Option<Value> {
    let session = string(&escalation["session"])?;
    let owner = string(&stage["owners"][&session])?;
    stage["cancellations"].get(&owner).cloned()
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
                    && stage["outcomes"].get(other).is_none()
                    && stage["cancellations"].get(other).is_none()
            }) {
                stage["concurrent"] = json!(true);
            }
            stage["members"][&key] = with_seq(payload, event);
        }
        "session.started" => {
            if let Some(step) = verify_step(&payload["phase"]) {
                if payload.get("round").is_some() {
                    let key = key(&json!({"step":step,"attempt":payload["round"]}));
                    if stage["members"].get(&key).is_some() {
                        if let Some(session) = string(&payload["session"]) {
                            stage["owners"][&session] = json!(key);
                        }
                    }
                }
            }
        }
        "verify.completed" => {
            let key = key(payload);
            if stage["cancellations"].get(&key).is_none() {
                stage["outcomes"][&key] = event["seq"].clone();
            }
        }
        "verify.cancelled" => {
            let key = key(payload);
            if stage["outcomes"].get(&key).is_none() && stage["cancellations"].get(&key).is_none() {
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
                    let round = number(&payload["round"]).to_string();
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
                && stage["outcomes"].get(key).is_none()
                && stage["cancellations"].get(key).is_none()
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
    value
        .as_str()?
        .strip_prefix("verify:")
        .map(|step| json!(step))
}
fn phase(step: &Value) -> Value {
    json!(format!("verify:{}", control(step)))
}
