//! JSON encoding of log-index and its phase-read deferral fold.
use super::{number, terminal};
use crate::protocol::reducer_values::{pick, remove, seq};
use serde_json::{json, Value};
fn empty_loop() -> Value {
    json!({"maxRoundEver":0,"maxRound":0,"rounds":[],"latestApproveSeq":0,"findingsByRound":[]})
}
fn round_record(value: &mut Value, round: i64) -> &mut Value {
    value["maxRound"] = json!(number(&value["maxRound"]).max(round));
    let a = value["rounds"].as_array_mut().unwrap();
    let index = if let Some(i) = a.iter().position(|entry| number(&entry[0]) == round) {
        i
    } else {
        a.push(json!([round, {}]));
        a.len() - 1
    };
    &mut a[index][1]
}
pub(super) fn log_index(events: &[Value]) -> Value {
    let mut value = json!({"readDeferrals":deferrals(events),"restack":crate::protocol::restack_values::reduce_leaf(events),"restartSeq":0,"plan":empty_loop(),"code":empty_loop(),"verifyCompleted":[],"verifyStarted":[],"maxVerifyAttemptEver":0,"verifyConfigBoundary":0,"lastReconcileCompletedSeq":0,"lastImplementCompletedSeq":0,"finalizeCompleted":false,"finalizeStepsDone":[],"reconcileNoProgressCount":0,"guidanceDeliveries":[]});
    let mut pending = serde_json::Map::new();
    let mut active_start: Option<Value> = None;
    let mut starts = Vec::new();
    let mut completions = Vec::new();
    let mut checks = Vec::new();
    let mut conflicts = Vec::new();
    for event in events {
        let t = event["type"].as_str().unwrap();
        let p = &event["payload"];
        let group = if matches!(
            t,
            "plan.started" | "plan.completed" | "plan-review.started" | "plan-review.verdict"
        ) {
            Some("plan")
        } else if matches!(
            t,
            "implement.started"
                | "implement.completed"
                | "code-review.started"
                | "code-review.verdict"
        ) {
            Some("code")
        } else {
            None
        };
        if let Some(group) = group {
            value[group]["maxRoundEver"] =
                json!(number(&value[group]["maxRoundEver"]).max(number(&p["round"])))
        }
        if matches!(t, "verify.started" | "verify.completed") {
            value["maxVerifyAttemptEver"] =
                json!(number(&value["maxVerifyAttemptEver"]).max(number(&p["attempt"])))
        }
        match t {
            "spec.revised" => value["restartSeq"] = event["seq"].clone(),
            "plan.started" | "implement.started" | "verify.started" => {
                let phase = if t == "verify.started" {
                    format!("verify:{}", p["step"].as_str().unwrap())
                } else {
                    t.strip_suffix(".started").unwrap().to_string()
                };
                let round = if t == "verify.started" {
                    &p["attempt"]
                } else {
                    &p["round"]
                };
                let key = format!("{phase}@{round}");
                if let Some(guidance) = p["feedback"].get("guidance") {
                    pending.insert(
                        key,
                        json!({"escalation":guidance["escalation"],"seq":event["seq"]}),
                    );
                } else {
                    pending.remove(&key);
                }
            }
            "session.started" => {
                if let Some(round) = p.get("round") {
                    let key = format!("{}@{round}", p["phase"].as_str().unwrap());
                    if let Some(carrier) = pending
                        .get(&key)
                        .filter(|carrier| number(&carrier["seq"]) < seq(event))
                        .cloned()
                    {
                        value["guidanceDeliveries"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"escalation":carrier["escalation"],"seq":event["seq"]}));
                        pending.remove(&key);
                    }
                }
            }
            "pr.conflicted" => {
                value["lastConflict"] = json!({"seq":event["seq"]});
                conflicts.push(seq(event));
                remove(&mut value, "conflictReconcileStarted");
            }
            "reconcile.progress-checked" => {
                let mut check = p.clone();
                check["seq"] = event["seq"].clone();
                checks.push(check)
            }
            "reconcile.started" => {
                let mut start = p.clone();
                start["seq"] = event["seq"].clone();
                starts.push(start.clone());
                active_start = Some(start);
                if value.get("lastConflict").is_some()
                    && seq(event) > number(&value["lastConflict"]["seq"])
                {
                    value["conflictReconcileStarted"] = json!({"attempt":p["attempt"]})
                }
            }
            "reconcile.completed" => {
                if let Some(mut start) = active_start.take() {
                    start["completedSeq"] = event["seq"].clone();
                    completions.push(start)
                }
                remove(&mut value, "conflictReconcileStarted")
            }
            _ => {}
        }
    }
    let restart = number(&value["restartSeq"]);
    for event in events {
        if seq(event) <= restart {
            continue;
        }
        let t = event["type"].as_str().unwrap();
        let p = &event["payload"];
        match t {
            "plan.started" | "implement.started" => {
                let group = if t == "plan.started" { "plan" } else { "code" };
                round_record(&mut value[group], number(&p["round"]))["startedSeq"] =
                    event["seq"].clone()
            }
            "plan-review.started" | "code-review.started" => {
                let group = if t == "plan-review.started" {
                    "plan"
                } else {
                    "code"
                };
                round_record(&mut value[group], number(&p["round"]));
            }
            "plan.completed" => {
                let record = round_record(&mut value["plan"], number(&p["round"]));
                record["completedSeq"] = event["seq"].clone();
                let mut completion = pick(p, &["artifact", "verifySteps"]);
                completion["seq"] = event["seq"].clone();
                record["planCompletion"] = completion;
            }
            "implement.completed" => {
                round_record(&mut value["code"], number(&p["round"]))["completedSeq"] =
                    event["seq"].clone();
                value["lastImplementCompletedSeq"] = event["seq"].clone()
            }
            "plan-review.verdict" | "code-review.verdict" => {
                let group = if t == "plan-review.verdict" {
                    "plan"
                } else {
                    "code"
                };
                let mut verdict = pick(p, &["round", "verdict", "findings", "reason"]);
                verdict["seq"] = event["seq"].clone();
                let record = round_record(&mut value[group], number(&p["round"]));
                record["verdict"] = verdict.clone();
                let completion = record.get("planCompletion").cloned();
                if p["verdict"] == "revise" {
                    value[group]["latestRevise"] = verdict.clone()
                }
                if p["verdict"] == "approve" {
                    value[group]["latestApproveSeq"] = event["seq"].clone();
                    if group == "plan" {
                        if let Some(completion) = completion {
                            value[group]["approvedPlan"] = completion
                        } else {
                            remove(&mut value[group], "approvedPlan")
                        }
                    }
                }
                let findings = value[group]["findingsByRound"].as_array_mut().unwrap();
                while findings.len() < number(&p["round"]) as usize {
                    findings.push(json!([]))
                }
                if number(&p["round"]) > 0 {
                    findings[number(&p["round"]) as usize - 1] = p["findings"].clone()
                }
            }
            "verify.started" => {
                let mut record = pick(p, &["attempt", "baseSha", "headSha", "restackId"]);
                record["seq"] = event["seq"].clone();
                value["verifyStarted"].as_array_mut().unwrap().push(record)
            }
            "verify.completed" => {
                let mut record = pick(
                    p,
                    &[
                        "baseSha",
                        "headSha",
                        "restackId",
                        "step",
                        "attempt",
                        "outcome",
                        "report",
                        "skipCause",
                        "reason",
                    ],
                );
                record["seq"] = event["seq"].clone();
                if let Some(pass) = p.get("pass") {
                    record["outcome"] = json!(if *pass == true { "pass" } else { "fail" });
                    remove(&mut record, "reason");
                    remove(&mut record, "skipCause")
                }
                value["verifyCompleted"]
                    .as_array_mut()
                    .unwrap()
                    .push(record)
            }
            "verify.config-captured" | "verify.config-superseded" => {
                value["verifyConfigBoundary"] =
                    json!(number(&value["verifyConfigBoundary"]).max(seq(event)));
            }
            "verify.reconcile-policy-captured" => value["reconcilePolicy"] = p.clone(),
            "finalize.completed" => value["finalizeCompleted"] = json!(true),
            "finalize.step-completed" => {
                let done = value["finalizeStepsDone"].as_array_mut().unwrap();
                if !done.contains(&p["step"]) {
                    done.push(p["step"].clone())
                }
            }
            "reconcile.completed" => value["lastReconcileCompletedSeq"] = event["seq"].clone(),
            _ => {}
        }
    }
    let mut by_attempt: Vec<Value> = Vec::new();
    for completion in completions {
        if let Some(prior) = by_attempt
            .iter_mut()
            .find(|prior| prior["attempt"] == completion["attempt"])
        {
            *prior = completion
        } else {
            by_attempt.push(completion)
        }
    }
    by_attempt.sort_by_key(|completion| number(&completion["completedSeq"]));
    let mut count = 0;
    for completion in &by_attempt {
        let next = starts.iter().find(|start| {
            number(&start["seq"]) > number(&completion["completedSeq"])
                && number(&start["attempt"]) > number(&completion["attempt"])
        });
        let limit = next.map(|start| number(&start["seq"])).unwrap_or(i64::MAX);
        let explicit = checks.iter().rfind(|check| {
            check["attempt"] == completion["attempt"]
                && number(&check["seq"]) > number(&completion["completedSeq"])
                && number(&check["seq"]) < limit
                && number(&check["conflictSeq"]) > number(&completion["completedSeq"])
                && number(&check["seq"]) > number(&check["conflictSeq"])
                && conflicts.contains(&number(&check["conflictSeq"]))
        });
        let base = explicit.or(next).map(|v| &v["baseSha"]);
        if base == Some(&completion["baseSha"]) {
            count += 1
        }
    }
    value["reconcileNoProgressCount"] = json!(count);
    if let Some(last) = by_attempt.last() {
        value["lastReconcileCompleted"] = last.clone();
        if let Some(conflict) = value.get("lastConflict") {
            if let Some(check) = checks.iter().rfind(|check| {
                check["conflictSeq"] == conflict["seq"]
                    && check["attempt"] == last["attempt"]
                    && number(&check["seq"]) > number(&conflict["seq"])
            }) {
                value["lastConflictProgressCheck"] = check.clone()
            }
        }
    }
    value
}
fn deferrals(events: &[Value]) -> Value {
    let mut sessions = serde_json::Map::new();
    let mut pending: Vec<Value> = Vec::new();
    let mut raises = serde_json::Map::new();
    for event in events {
        let t = event["type"].as_str().unwrap();
        let p = &event["payload"];
        if t == "session.started" {
            sessions.insert(p["session"].as_str().unwrap().into(),json!({"phase":p["phase"],"round":p.get("round").unwrap_or(&json!(1)),"ended":false,"terminal":false}));
        }
        for (id, session) in &mut sessions {
            if session["ended"] == true {
                continue;
            }
            let actor_matches = event["actor"]["kind"] == "kernel"
                || (event["actor"]["kind"] == "agent" && event["actor"]["session"] == *id);
            let phase = session["phase"].as_str().unwrap();
            let completion = t == terminal(phase)
                && (t != "verify.completed"
                    || phase == format!("verify:{}", p["step"].as_str().unwrap()))
                && (p.get("round").is_none() || p["round"] == session["round"])
                && (p.get("attempt").is_none() || p["attempt"] == session["round"]);
            let boundary = event["actor"]["kind"] == "agent"
                && event["actor"]["session"] == *id
                && matches!(t, "escalation.raised" | "publication.requested");
            if actor_matches && (completion || boundary) {
                session["terminal"] = json!(true);
                pending.retain(|item| item["session"] != *id)
            }
        }
        match t {
            "session.build-read-failed" => {
                let id = p["session"].as_str().unwrap();
                if let Some(session) = sessions.get(id) {
                    if session["terminal"] != true
                        && session["ended"] != true
                        && session["phase"] == p["phase"]
                        && session["round"] == p["round"]
                        && !pending.iter().any(|item| item["session"] == id)
                    {
                        let mut item = pick(p, &["session", "phase", "round", "diagnostic"]);
                        item["evidenceSeq"] = event["seq"].clone();
                        item["ended"] = json!(false);
                        item["settled"] = json!(false);
                        pending.push(item)
                    }
                }
            }
            "session.ended" => {
                let id = p["session"].as_str().unwrap();
                if let Some(session) = sessions.get_mut(id) {
                    session["ended"] = json!(true)
                }
                if !pending.iter().any(|item| item["session"] == id) {
                    sessions.remove(id);
                }
                for item in &mut pending {
                    if item["session"] == id {
                        item["ended"] = json!(true)
                    }
                }
            }
            "phase.deferred" => {
                for item in &mut pending {
                    if item["session"] == p["session"]
                        && item["phase"] == p["phase"]
                        && item["round"] == p["round"]
                    {
                        item["settled"] = json!(true)
                    }
                }
            }
            "phase.deferral-escalated" => {
                if pending.iter().any(|item| {
                    item["evidenceSeq"] == p["evidenceSeq"]
                        && item["session"] == p["session"]
                        && item["phase"] == p["phase"]
                        && item["round"] == p["round"]
                }) {
                    raises.insert(p["id"].as_str().unwrap().into(), p["evidenceSeq"].clone());
                }
            }
            "escalation.answered" => {
                if let Some(n) = raises.remove(p["id"].as_str().unwrap()) {
                    for item in &pending {
                        if item["evidenceSeq"] == n {
                            sessions.remove(item["session"].as_str().unwrap());
                        }
                    }
                    pending.retain(|item| item["evidenceSeq"] != n)
                }
            }
            _ => {}
        }
    }
    pending.into()
}
