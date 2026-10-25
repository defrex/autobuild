use super::{max, number, pick, push, remove, with_seq};
use crate::data::error::DataError;
use serde_json::{json, Value};
#[derive(Clone, Debug)]
pub struct HarvestAcc {
    state: Value,
    pending: Value,
    claims: Vec<Value>,
}
impl Default for HarvestAcc {
    fn default() -> Self {
        Self {
            state: json!({"lastSeq":0,"runs":[],"paused":false,"ledger":[]}),
            pending: json!({"pause":[],"resume":[]}),
            claims: vec![],
        }
    }
}
fn occurrence_key(value: &Value) -> String {
    serde_json::to_string(&json!([value["build"], value["seq"]])).unwrap()
}
impl HarvestAcc {
    pub fn fold(&mut self, e: &Value) -> Result<(), DataError> {
        let t = e["type"].as_str().unwrap_or("");
        let p = &e["payload"];
        max(&mut self.state, "lastSeq", &e["seq"]);
        let bad = || DataError::Decode {
            scope: "repository",
            event_type: t.to_string(),
            seq: number(&e["seq"]),
        };
        match t {
            "harvest.pause-requested" | "harvest.resume-requested" => {
                let command = if t == "harvest.pause-requested" {
                    "pause"
                } else {
                    "resume"
                };
                self.pending[if command == "pause" {
                    "resume"
                } else {
                    "pause"
                }] = json!([]);
                push(
                    &mut self.pending,
                    command,
                    json!({"command":command,"seq":e["seq"],"actor":e["actor"]}),
                );
                return Ok(());
            }
            "harvest.paused" => {
                self.state["paused"] = json!(true);
                self.state["pausedSeq"] = e["seq"].clone();
                self.state["pausedAt"] = e["ts"].clone();
                self.pending["pause"] = json!([]);
                return Ok(());
            }
            "harvest.resumed" => {
                let human = !self.pending["resume"].as_array().unwrap().is_empty();
                self.state["paused"] = json!(false);
                remove(&mut self.state, "pausedSeq");
                remove(&mut self.state, "pausedAt");
                self.pending["resume"] = json!([]);
                for run in self.state["runs"].as_array_mut().unwrap() {
                    if run.get("recoveryExhaustion").is_some() {
                        if human
                            && run["recoveryExhaustion"]
                                .get("attentionAcknowledgedSeq")
                                .is_none()
                        {
                            run["recoveryExhaustion"]["attentionAcknowledgedSeq"] =
                                e["seq"].clone();
                            run["recoveryExhaustion"]["attentionAcknowledgedAt"] = e["ts"].clone();
                        }
                        continue;
                    }
                    if run["status"] != "failed" {
                        continue;
                    }
                    let automatic = run["recoveryRequests"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .rev()
                        .find(|r| r.get("acknowledgedSeq").is_none());
                    let has = automatic.is_some();
                    if let Some(r) = automatic {
                        r["acknowledgedSeq"] = e["seq"].clone();
                        r["acknowledgedAt"] = e["ts"].clone();
                    }
                    if human || has {
                        run["status"] = json!("running");
                        for k in ["failure", "failureSeq", "terminalSeq", "terminalAt"] {
                            remove(run, k);
                        }
                    }
                }
                return Ok(());
            }
            "harvest.started" => {
                if self.state["runs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["run"] == p["run"])
                {
                    return Err(bad());
                }
                let mut run = pick(p, &["run", "observations", "scan", "trigger"]);
                run["scan"] = pick(&p["scan"], &["kind", "rev"]);
                run["status"] = json!("running");
                run["startedSeq"] = e["seq"].clone();
                run["startedAt"] = e["ts"].clone();
                for k in [
                    "sessions",
                    "steps",
                    "proposals",
                    "reviews",
                    "reservations",
                    "filed",
                    "dispositions",
                    "recoveryRequests",
                ] {
                    run[k] = json!([]);
                }
                for occurrence in p["observations"].as_array().unwrap() {
                    let key = occurrence_key(occurrence);
                    if self.claims.iter().any(|c| c["key"] == key) {
                        return Err(bad());
                    }
                    self.claims
                        .push(json!({"key":key,"occurrence":occurrence,"run":p["run"]}));
                }
                push(&mut self.state, "runs", run);
                return Ok(());
            }
            _ => {}
        }
        if ![
            "harvest.recovery-requested",
            "harvest.recovery-exhausted",
            "harvest.step.started",
            "harvest.step.completed",
            "harvest.proposals.submitted",
            "harvest.review.verdict",
            "harvest.proposal.id-reserved",
            "harvest.proposal.filed",
            "harvest.completed",
            "harvest.escalated",
            "harvest.failed",
            "harvest.session.started",
            "harvest.session.native-handle-recorded",
            "harvest.session.suspended",
            "harvest.session.resumed",
            "harvest.session.resume-fallback",
            "harvest.session.ended",
        ]
        .contains(&t)
        {
            return Ok(());
        }
        let index = self.state["runs"]
            .as_array()
            .unwrap()
            .iter()
            .position(|r| r["run"] == p["run"]);
        let Some(index) = index else {
            if t.starts_with("harvest.session.") {
                return Ok(());
            }
            return Err(bad());
        };
        let run = &mut self.state["runs"][index];
        match t {
            "harvest.recovery-requested" => {
                let requests = run["recoveryRequests"].as_array().unwrap();
                if run["status"] != "failed"
                    || run.get("recoveryExhaustion").is_some()
                    || requests.iter().any(|r| r.get("acknowledgedSeq").is_none())
                    || number(&p["attempt"]) as usize != requests.len() + 1
                    || requests.first().is_some_and(|r| r["limit"] != p["limit"])
                    || number(&p["attempt"]) > number(&p["limit"])
                {
                    return Err(bad());
                }
                let mut req = with_seq(&pick(p, &["attempt", "limit"]), e);
                req["requestedAt"] = e["ts"].clone();
                push(run, "recoveryRequests", req);
            }
            "harvest.recovery-exhausted" => {
                if run.get("recoveryExhaustion").is_some()
                    || run["status"] != "failed"
                    || run.get("failure").is_none()
                    || run["failure"]["step"] != p["step"]
                    || run["failure"].get("round") != p.get("round")
                    || run["failure"]["error"] != p["error"]
                {
                    return Err(bad());
                }
                let requests = run["recoveryRequests"].as_array().unwrap();
                if number(&p["attempts"]) as usize != requests.len()
                    || p["attempts"] != p["limit"]
                    || requests
                        .iter()
                        .any(|r| r["limit"] != p["limit"] || r.get("acknowledgedSeq").is_none())
                {
                    return Err(bad());
                }
                let expected = run["observations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(occurrence_key)
                    .collect::<Vec<_>>();
                let mut partition = vec![];
                let mut released = vec![];
                for disposition in p["committedDispositions"].as_array().unwrap() {
                    let key = occurrence_key(&disposition["occurrence"]);
                    if !expected.contains(&key) || partition.contains(&key) {
                        return Err(bad());
                    }
                    partition.push(key);
                }
                for occurrence in p["releasedObservations"].as_array().unwrap() {
                    let key = occurrence_key(occurrence);
                    if !expected.contains(&key) || partition.contains(&key) {
                        return Err(bad());
                    }
                    partition.push(key.clone());
                    released.push(key);
                }
                if partition.len() != expected.len() {
                    return Err(bad());
                }
                let mut keys = vec![];
                let mut pending_occurrences = vec![];
                for proposal in p["pendingProposals"].as_array().unwrap() {
                    if keys.contains(&proposal["proposalKey"]) {
                        return Err(bad());
                    }
                    keys.push(proposal["proposalKey"].clone());
                    for occurrence in proposal["observations"].as_array().unwrap() {
                        let key = occurrence_key(occurrence);
                        if !released.contains(&key) || pending_occurrences.contains(&key) {
                            return Err(bad());
                        }
                        pending_occurrences.push(key);
                    }
                }
                for key in &released {
                    if !self
                        .claims
                        .iter()
                        .any(|c| c["key"] == *key && c["run"] == run["run"])
                    {
                        return Err(bad());
                    }
                }
                self.claims
                    .retain(|c| !released.contains(&c["key"].as_str().unwrap_or("").to_string()));
                run["dispositions"] = p["committedDispositions"].clone();
                run["recoveryExhaustion"] = with_seq(
                    &pick(
                        p,
                        &[
                            "step",
                            "round",
                            "error",
                            "attempts",
                            "limit",
                            "releasedObservations",
                            "committedDispositions",
                            "pendingProposals",
                        ],
                    ),
                    e,
                );
                run["recoveryExhaustion"]["at"] = e["ts"].clone();
                run["terminalSeq"] = e["seq"].clone();
                run["terminalAt"] = e["ts"].clone();
                let run_id = run["run"].clone();
                for disposition in p["committedDispositions"].as_array().unwrap() {
                    let mut entry = with_seq(disposition, e);
                    entry["run"] = run_id.clone();
                    push(&mut self.state, "ledger", entry);
                }
            }
            "harvest.step.started" => {
                let mut step = pick(p, &["step", "round"]);
                step["startedSeq"] = e["seq"].clone();
                step["startedAt"] = e["ts"].clone();
                push(run, "steps", step);
            }
            "harvest.step.completed" => {
                let steps = run["steps"].as_array_mut().unwrap();
                let index = if let Some(i) = steps.iter().rposition(|s| {
                    s["step"] == p["step"]
                        && s.get("round") == p.get("round")
                        && s.get("completedSeq").is_none()
                }) {
                    i
                } else {
                    let mut step = pick(p, &["step", "round"]);
                    step["startedSeq"] = e["seq"].clone();
                    step["startedAt"] = e["ts"].clone();
                    steps.push(step);
                    steps.len() - 1
                };
                let step = &mut steps[index];
                step["completedSeq"] = e["seq"].clone();
                step["completedAt"] = e["ts"].clone();
                step["outcome"] = p["outcome"].clone();
                for k in ["artifact", "detail"] {
                    if let Some(v) = p.get(k) {
                        step[k] = if k == "artifact" {
                            pick(v, &["kind", "rev"])
                        } else {
                            v.clone()
                        };
                    }
                }
            }
            "harvest.proposals.submitted" => push(
                run,
                "proposals",
                with_seq(
                    &json!({"round":p["round"],"artifact":pick(&p["artifact"],&["kind","rev"])}),
                    e,
                ),
            ),
            "harvest.review.verdict" => {
                let mut review = pick(p, &["round", "verdict", "findings", "artifact", "reason"]);
                review["artifact"] = pick(&p["artifact"], &["kind", "rev"]);
                push(run, "reviews", with_seq(&review, e));
            }
            "harvest.proposal.id-reserved" => {
                let a = run["reservations"].as_array_mut().unwrap();
                let id = p["id"].as_str().unwrap_or("").to_lowercase();
                if let Some(old) = a.iter().find(|r| r["proposalKey"] == p["proposalKey"]) {
                    if old["id"].as_str().unwrap_or("").to_lowercase() != id {
                        return Err(bad());
                    }
                } else {
                    if a.iter()
                        .any(|r| r["id"].as_str().unwrap_or("").to_lowercase() == id)
                    {
                        return Err(bad());
                    }
                    a.push(with_seq(&pick(p, &["proposalKey", "id"]), e));
                }
            }
            "harvest.proposal.filed" => {
                if !run["filed"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["proposalKey"] == p["proposalKey"])
                {
                    push(
                        run,
                        "filed",
                        with_seq(&pick(p, &["proposalKey", "ticket", "blockers"]), e),
                    );
                }
            }
            "harvest.completed" => {
                if run["status"] == "running" {
                    run["status"] = json!("completed");
                    run["dispositions"] = p["dispositions"].clone();
                    run["report"] = pick(&p["report"], &["kind", "rev"]);
                    run["terminalSeq"] = e["seq"].clone();
                    run["terminalAt"] = e["ts"].clone();
                    let run_id = run["run"].clone();
                    for disposition in p["dispositions"].as_array().unwrap() {
                        let mut entry = with_seq(disposition, e);
                        entry["run"] = run_id.clone();
                        push(&mut self.state, "ledger", entry);
                    }
                }
            }
            "harvest.escalated" => {
                if run["status"] == "running" {
                    run["status"] = json!("escalated");
                    run["escalation"] = pick(p, &["source", "reason", "round"]);
                    run["terminalSeq"] = e["seq"].clone();
                    run["terminalAt"] = e["ts"].clone();
                }
            }
            "harvest.failed" => {
                if run["status"] == "running" {
                    run["failure"] = pick(p, &["step", "round", "attempt", "error", "willRetry"]);
                    run["failureSeq"] = e["seq"].clone();
                    if p["willRetry"] != true {
                        run["status"] = json!("failed");
                    }
                }
            }
            "harvest.session.started" => {
                let sessions = run["sessions"].as_array_mut().unwrap();
                if sessions.iter().any(|s| s["session"] == p["session"]) {
                    return Ok(());
                }
                if let Some(c) = p.get("continuation") {
                    let Some(prior) = sessions
                        .iter_mut()
                        .find(|s| s["session"] == c["predecessor"])
                    else {
                        return Ok(());
                    };
                    if prior["step"] != p["step"]
                        || prior.get("round") != p.get("round")
                        || prior["status"] == "ended"
                        || prior["continuation"]
                            .get("root")
                            .unwrap_or(&prior["session"])
                            != &c["root"]
                    {
                        return Ok(());
                    }
                    prior["status"] = json!("ended");
                }
                let mut session = p.clone();
                session["status"] = json!("open");
                session["startedSeq"] = e["seq"].clone();
                session["startedAt"] = e["ts"].clone();
                if let Some(h) = p["continuation"].get("handle") {
                    session["nativeHandle"] = h.clone();
                }
                sessions.push(session);
            }
            _ if t.starts_with("harvest.session.") => {
                let Some(s) = run["sessions"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|s| s["session"] == p["session"])
                else {
                    return Ok(());
                };
                if s["status"] != "open" {
                    return Ok(());
                }
                if [
                    "harvest.session.native-handle-recorded",
                    "harvest.session.resumed",
                ]
                .contains(&t)
                    && s.get("nativeHandle").is_some_and(|h| *h != p["handle"])
                {
                    return Ok(());
                }
                match t {
                    "harvest.session.resumed" => {
                        if s["resumed"] == true
                            || s["fallback"] == true
                            || s["continuation"]["predecessor"] != p["predecessor"]
                            || s["continuation"]["root"] != p["root"]
                        {
                            return Ok(());
                        }
                        s["resumed"] = json!(true);
                        s["nativeHandle"] = p["handle"].clone();
                    }
                    "harvest.session.resume-fallback" => {
                        if s.get("continuation").is_none()
                            || s["resumed"] == true
                            || s["fallback"] == true
                        {
                            return Ok(());
                        }
                        s["fallback"] = json!(true);
                        remove(s, "nativeHandle");
                    }
                    "harvest.session.native-handle-recorded" => {
                        s["nativeHandle"] = p["handle"].clone()
                    }
                    "harvest.session.suspended" => {
                        s["status"] = json!("suspended");
                        s["suspendedAt"] = e["ts"].clone();
                        s["cause"] = p["cause"].clone();
                        s["transcript"] = pick(&p["transcript"], &["kind", "rev"]);
                    }
                    "harvest.session.ended" => {
                        s["status"] = json!("ended");
                        s["transcript"] = pick(&p["transcript"], &["kind", "rev"]);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn finish(&self) -> Value {
        let mut s = self.state.clone();
        let mut pending = self.pending["pause"].as_array().unwrap().clone();
        pending.extend(self.pending["resume"].as_array().unwrap().iter().cloned());
        pending.sort_by_key(|p| number(&p["seq"]));
        s["pendingCommands"] = json!(pending);
        s["claimed"] = json!(self
            .claims
            .iter()
            .map(|c| c["occurrence"].clone())
            .collect::<Vec<_>>());
        if let Some(last) = s["runs"].as_array().unwrap().last().cloned() {
            s["latest"] = last;
        }
        s
    }
}
