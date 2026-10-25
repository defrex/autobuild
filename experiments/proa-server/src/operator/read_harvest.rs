//! Exact harvest status and dashboard projections over the native durable reducer.
use serde_json::{json, Value};
pub fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn number(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}
pub fn copy(out: &mut Value, input: &Value, key: &str) {
    if let Some(v) = input.get(key) {
        out[key] = v.clone();
    }
}
pub fn epoch(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.timestamp_millis())
}
fn suspended(run: &Value) -> Option<&Value> {
    if run["status"] == "running" {
        array(&run["sessions"])
            .last()
            .filter(|s| s["status"] == "suspended")
    } else {
        None
    }
}
pub fn recovery(run: &Value) -> Value {
    let exhaustion = &run["recoveryExhaustion"];
    let requests = array(&run["recoveryRequests"]);
    let limit = exhaustion
        .get("limit")
        .or_else(|| requests.last().and_then(|r| r.get("limit")))
        .cloned()
        .unwrap_or(json!(2));
    let mut out = json!({"recoverable":run["status"]=="failed"&&exhaustion.is_null(),"finished":matches!(run["status"].as_str(),Some("completed"|"escalated"))||!exhaustion.is_null(),"automatic":{"attempts":requests.len(),"limit":limit,"exhausted":!exhaustion.is_null()},"attention":{"required":!exhaustion.is_null()&&exhaustion.get("attentionAcknowledgedSeq").is_none(),"acknowledged":exhaustion.get("attentionAcknowledgedSeq").is_some()},"pending":{"observations":if let Some(obs)=exhaustion.get("releasedObservations"){obs.clone()}else if run["status"]=="failed"{run["observations"].clone()}else{json!([])},"proposalKeys":array(&exhaustion["pendingProposals"]).iter().map(|p|p["proposalKey"].clone()).collect::<Vec<_>>()}});
    if let Some(failure) = run.get("failure") {
        out["stopped"] = json!({"step":failure["step"]});
        copy(&mut out["stopped"], failure, "round");
    }
    out
}
fn unresolved(run: &Value) -> bool {
    run["status"] == "failed"
        && run["recoveryExhaustion"]
            .get("attentionAcknowledgedSeq")
            .is_none()
}
fn run_status(run: &Value, facts: &Value) -> Value {
    let rounds = array(&run["reviews"])
        .iter()
        .map(|r| number(&r["round"]))
        .max()
        .unwrap_or(0);
    let filed=array(&run["filed"]).iter().map(|f|{let mut v=json!({"proposalKey":f["proposalKey"],"ticket":{"source":f["ticket"]["source"],"id":f["ticket"]["id"]}});copy(&mut v,f,"blockers");v}).collect::<Vec<_>>();
    let sessions = array(&facts["harvestSessions"])
        .iter()
        .filter(|s| s["run"] == run["run"])
        .map(|s| {
            let mut v = s.clone();
            v.as_object_mut().unwrap().shift_remove("run");
            v
        })
        .collect::<Vec<_>>();
    let mut out = json!({"run":run["run"],"status":if suspended(run).is_some(){json!("suspended")}else{run["status"].clone()},"startedSeq":run["startedSeq"],"startedAt":run["startedAt"],"observations":array(&run["observations"]).len(),"steps":run["steps"],"rounds":rounds,"filed":filed,"recovery":recovery(run),"sessions":sessions});
    for key in ["trigger", "escalation", "failure"] {
        copy(&mut out, run, key);
    }
    out
}
pub fn status(repo: &str, facts: &Value) -> Value {
    let state = &facts["harvest"];
    let all = array(&state["runs"]);
    let latest = all.last();
    let runs = all
        .iter()
        .filter(|r| {
            unresolved(r)
                || r["status"] == "running"
                || latest.is_some_and(|last| last["run"] == r["run"])
        })
        .map(|r| run_status(r, facts))
        .collect::<Vec<_>>();
    let primary = runs
        .iter()
        .find(|r| all.iter().any(|a| a["run"] == r["run"] && unresolved(a)))
        .or_else(|| {
            runs.iter()
                .find(|r| matches!(r["status"].as_str(), Some("running" | "suspended")))
        })
        .or_else(|| runs.last());
    let paused = state["paused"] == true;
    let mut out = json!({"repo":repo,"status":if paused{"paused"}else{"idle"},"paused":paused,"pendingCommands":state["pendingCommands"],"runs":runs,"observations":0,"steps":[],"rounds":0,"filed":[],"recovery":recovery(&Value::Null)});
    for key in ["pausedSeq", "pausedAt"] {
        copy(&mut out, state, key);
    }
    if let Some(primary) = primary {
        out["runStatus"] = primary["status"].clone();
        if !paused {
            out["status"] = primary["status"].clone();
        }
        for (key, v) in primary.as_object().unwrap() {
            if !["status", "startedSeq", "startedAt"].contains(&key.as_str()) {
                out[key] = v.clone();
            }
        }
    }
    out
}
fn timing(steps: &[Value], name: &str, frozen: Option<i64>) -> Option<Value> {
    let matching = steps
        .iter()
        .filter(|s| s["step"] == name)
        .collect::<Vec<_>>();
    if matching.is_empty() {
        return None;
    }
    let mut accumulated = 0;
    let mut running = None;
    for occurrence in matching {
        let start = epoch(&occurrence["startedAt"]).unwrap_or(0);
        if let Some(end) = epoch(&occurrence["completedAt"]).or(frozen) {
            accumulated += (end - start).max(0);
        } else {
            running = Some(start);
        }
    }
    let mut value = json!({"accumulatedMs":accumulated});
    if let Some(start) = running {
        value["runningSince"] = json!(start);
    }
    Some(value)
}
pub fn dashboard(facts: &Value) -> Option<Value> {
    let state = &facts["harvest"];
    let runs = array(&state["runs"]);
    let run = runs
        .iter()
        .find(|r| {
            unresolved(r)
                || (r["status"] == "escalated"
                    && (r.get("terminalSeq").is_none()
                        || number(&facts["dismissedThrough"]) <= number(&r["terminalSeq"])))
        })
        .or_else(|| runs.iter().find(|r| r["status"] == "running"))?;
    if run["status"] == "completed" {
        return None;
    }
    let exhaustion = &run["recoveryExhaustion"];
    let occurrences = array(&run["steps"]);
    let suspend = suspended(run);
    let stopped = run["status"] != "running" || suspend.is_some();
    let mut rounds = 0;
    for key in ["proposals", "reviews", "steps"] {
        rounds = rounds.max(
            array(&run[key])
                .iter()
                .map(|r| number(&r["round"]))
                .max()
                .unwrap_or(0),
        );
    }
    let frozen = [
        epoch(&state["pausedAt"]),
        if run["status"] == "failed" {
            epoch(&facts["failedAt"][run["run"].to_string()])
        } else {
            None
        },
        suspend.and_then(|s| epoch(&s["suspendedAt"])),
    ]
    .into_iter()
    .flatten()
    .min();
    let approved = array(&run["reviews"])
        .iter()
        .any(|r| r["verdict"] == "approve");
    let synth = !array(&run["proposals"]).is_empty();
    let reviewed = !array(&run["reviews"]).is_empty();
    let steps=["scan","synthesize","review","file"].iter().map(|name|{
  let matching=occurrences.iter().filter(|s|s["step"]==*name).collect::<Vec<_>>();let failed=run["status"]=="failed"&&run["failure"]["step"]==*name;
  let complete=matching.iter().any(|s|s.get("completedSeq").is_some());let output=match *name{"synthesize"=>synth||complete,"review"=>reviewed||complete,_=>complete};
  let done=match *name{"scan"=>matching.iter().any(|s|s["outcome"]=="completed"),"synthesize"=>synth&&(approved||stopped)&&!failed,"review"=>reviewed&&(approved||stopped)&&!failed,_=>false};
  let active=!stopped&&state["paused"]!=true&&matching.last().is_some_and(|s|s.get("completedSeq").is_none());let mut v=json!({"label":name,"state":if done{"done"}else if active{"current"}else{"pending"}});
  if output{v["producedOutput"]=json!(true);}
 if failed{v["qualifier"]=json!("failed");}
 if rounds>1&&["synthesize","review"].contains(name){v["count"]=json!(rounds);}
 if let Some(t)=timing(occurrences,name,frozen){v["timing"]=t;}v
 }).collect::<Vec<_>>();
    let requests = array(&run["recoveryRequests"]);
    let limit = number(
        &exhaustion
            .get("limit")
            .or_else(|| requests.last().and_then(|r| r.get("limit")))
            .cloned()
            .unwrap_or(json!(2)),
    );
    let stopped_at = if run["failure"]["round"].is_null() {
        run["failure"]["step"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    } else {
        format!(
            "{} r{}",
            run["failure"]["step"].as_str().unwrap_or_default(),
            run["failure"]["round"]
        )
    };
    let detail = if let Some(reason) = run["escalation"].get("reason") {
        Some(reason.clone())
    } else if !exhaustion.is_null() {
        Some(json!(format!(
            "recovery exhausted - human attention required; stopped at {}{}; pending {}",
            exhaustion["step"].as_str().unwrap_or_default(),
            if let Some(r) = exhaustion.get("round") {
                format!(" r{r}")
            } else {
                String::new()
            },
            array(&exhaustion["releasedObservations"]).len()
        )))
    } else if let Some(failure) = run.get("failure") {
        Some(json!(format!(
            "stopped at {stopped_at} - automatic recovery {}/{limit}; {}",
            requests.len(),
            failure["error"].as_str().unwrap_or_default()
        )))
    } else if !requests.is_empty() {
        Some(json!(format!(
            "automatic recovery {}/{limit} resumed",
            requests.len()
        )))
    } else {
        None
    };
    let mut out = json!({"kind":"harvest","run":run["run"],"status":if state["paused"]==true&&run["status"]=="running"{json!("paused")}else if suspend.is_some(){json!("suspended")}else{run["status"].clone()},"steps":steps,"observations":array(&run["observations"]).len(),"rounds":rounds});
    if let Some(detail) = detail {
        out["detail"] = detail;
    }
    if state["paused"] != true
        && !array(&state["pendingCommands"])
            .iter()
            .any(|p| p["command"] == "resume")
    {
        if run["status"] == "failed" {
            out["action"] = json!(if exhaustion.is_null() {
                "resume"
            } else {
                "acknowledge"
            });
        } else if run["status"] == "escalated" {
            out["action"] = json!("acknowledge");
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn harvest_matches_actual_typescript_query_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/api-read-corpus.json")).unwrap();
        let mut count = 0;
        for f in array(&corpus["fixtures"]) {
            if f["scenario"]["path"] != "harvest/status" {
                continue;
            }
            let mut acc =
                crate::data::reducers::Accumulator::new(crate::data::reducers::Scope::Repository);
            acc.advance(array(&f["seed"]["repository"]["events"]))
                .unwrap();
            assert_eq!(
                status("api-read/repository", &acc.finish()["repositoryReadFacts"]),
                f["body"],
                "{}",
                f["scenario"]["id"]
            );
            count += 1;
        }
        assert!(count >= 7);
    }
}
