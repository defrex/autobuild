//! Read-only display predicates, scoped to the same restart/cycle facts as TypeScript.
use super::{detail::project_sessions, landing};
use serde_json::{json, Value};
pub fn number(value: &Value) -> i64 {
    value.as_i64().unwrap_or(0)
}
pub fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
pub fn copy(out: &mut Value, input: &Value, key: &str) {
    if let Some(value) = input.get(key) {
        out[key] = value.clone();
    }
}
fn epoch(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
}
fn timing(intervals: &Value, phase: &str, since: i64, frozen: Option<i64>) -> Option<Value> {
    let t = &intervals[phase];
    let closed: Vec<_> = array(&t["closed"])
        .iter()
        .filter(|i| number(&i["startSeq"]) > since)
        .collect();
    let open = &t["open"];
    let live = !open.is_null() && number(&open["startSeq"]) > since;
    if closed.is_empty() && !live {
        return None;
    }
    let mut accumulated: i64 = closed
        .iter()
        .map(|i| (number(&i["end"]) - number(&i["start"])).max(0))
        .sum();
    let mut out = json!({});
    if live {
        if let Some(end) = frozen {
            accumulated += (end - number(&open["start"])).max(0);
        } else {
            out["runningSince"] = open["start"].clone();
        }
    }
    out["accumulatedMs"] = json!(accumulated);
    Some(out)
}
fn step(label: &str, done: bool, current: bool, produced: bool) -> Value {
    json!({"label":label,"state":if current {"current"} else if done {"done"} else if produced {"provisional"} else {"pending"}})
}
pub fn effective_status(state: &Value) -> String {
    let status = state["status"].as_str().unwrap_or("queued");
    let pending = array(&state["pendingCommands"]);
    let has = |command| pending.iter().any(|p| p["command"] == command);
    if status == "done" {
        return status.into();
    }
    if status == "aborted" {
        return "cleaning".into();
    }
    if has("abort") {
        return "aborting".into();
    }
    if state["kind"] == "node" && super::tree::integration_failed(state) {
        return "blocked".into();
    }
    if ["paused", "blocked"].contains(&status) && !array(&state["openEscalations"]).is_empty() {
        return "blocked".into();
    }
    if status == "running" && has("pause") {
        return "pausing".into();
    }
    if status == "paused" && has("resume") {
        return "resuming".into();
    }
    status.into()
}
pub struct ProjectionFacts<'a> {
    pub dashboard: &'a Value,
    pub restack: &'a Value,
    pub deferral: &'a Value,
}
pub fn project(
    record: &Value,
    state: &Value,
    projections: ProjectionFacts<'_>,
    config: &Value,
    streams: Option<&[Value]>,
    pinned: Option<&Value>,
) -> Option<Value> {
    let facts = projections.dashboard;
    let restack = projections.restack;
    let status = effective_status(state);
    if ![
        "queued",
        "running",
        "collecting",
        "pausing",
        "paused",
        "resuming",
        "blocked",
        "aborting",
        "cleaning",
    ]
    .contains(&status.as_str())
    {
        return None;
    }
    let pipeline = pinned.unwrap_or(config);
    let vocabulary = super::tree::vocabulary(state);
    let mut identity = json!({"repo":record["repo"],"status":state["status"]});
    for (to, value) in [
        ("source", &record["ticket"]["source"]),
        ("id", &record["ticket"]["id"]),
        ("targetBuild", &state["target"]["build"]),
        ("targetSource", &state["target"]["ticket"]["source"]),
        ("targetId", &state["target"]["ticket"]["id"]),
        ("title", &record["ticket"]["title"]),
        ("createdAt", &record["createdAt"]),
    ] {
        if !value.is_null() {
            identity[to] = value.clone();
        }
    }
    identity["phase"] = [
        &state["currentPhase"]["phase"],
        &vocabulary["integration"],
        &state["phase"],
        &state["status"],
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .unwrap()
    .clone();
    let mut out = vocabulary;
    out["slug"] = record["slug"].clone();
    out["status"] = json!(status);
    out["alsoPaused"] = json!(state["status"] == "paused" && status == "blocked");
    out["collectionIdentity"] = identity;
    if state["kind"] == "node" {
        let (row, detail) = super::integration::project(record, state, restack, config, pipeline);
        out["integrationRow"] = row;
        out["integrationDetail"] = detail;
    }

    out["tree"] = super::tree::project(record, state, restack, &pipeline["verify"]["steps"]);
    out["blockers"] = json!(array(&state["openEscalations"])
        .iter()
        .map(|e| e["question"].clone())
        .collect::<Vec<_>>());
    out["landing"] = state["landing"].clone();
    out["autoMerge"] = json!(landing::auto_merge(state));
    out["sessions"] = json!(project_sessions(array(&facts["sessionEvents"]), streams));
    if !record["ticket"]["id"].is_null() {
        out["ticketId"] = record["ticket"]["id"].clone();
    }
    if state["pr"].is_object() && state["prState"].is_string() {
        out["pr"] = json!({"url":state["pr"]["url"],"state":state["prState"]});
    }
    if state["reviewRoundCeilings"]
        .as_object()
        .is_some_and(|m| !m.is_empty())
    {
        out["reviewRoundCeilings"] = state["reviewRoundCeilings"].clone();
    }
    if state["janitor"]["attention"] == true {
        out["setupError"] = json!(format!(
            "Janitor failing: {}",
            state["janitor"]["message"].as_str().unwrap_or_default()
        ));
    }
    if status == "queued" && state["kind"] != "node" {
        out["alsoPaused"] = json!(false);
        out["blockers"] = json!([]);
        out.as_object_mut().unwrap().remove("pr");
        out.as_object_mut().unwrap().remove("reviewRoundCeilings");
        out["steps"] = json!([]);
        let created = number(&facts["created"]);
        let workspace = number(&facts["workspaceProvisioned"]);
        let spec = number(&facts["specLanded"]);
        let failure = &facts["latestFailure"];
        let superseded = match failure["stage"].as_str() {
            Some("create") => created,
            Some("workspace") => workspace,
            Some("spec") => spec,
            Some("comment") => number(&facts["commentPosted"]),
            _ => 0,
        } > number(&failure["seq"]);
        out["dispatch"] = json!(if !state["discardRequest"].is_null() {
            "discard requested; cleanup and Ready handback pending".into()
        } else if !failure.is_null() && !superseded {
            format!(
                "dispatch {} failed (attempt {}): {}",
                failure["stage"].as_str().unwrap_or_default(),
                failure["attempt"],
                failure["error"].as_str().unwrap_or_default()
            )
        } else if created == 0 {
            "dispatch initialization pending".into()
        } else if workspace == 0 || workspace <= number(&facts["workspaceReleased"]) {
            "workspace provisioning pending".into()
        } else if spec == 0 {
            "spec import pending".into()
        } else {
            "runner attachment pending".into()
        });
        return Some(out);
    }
    if status == "aborting" || status == "cleaning" {
        out["alsoPaused"] = json!(false);
        out["steps"] = json!([]);
        out["abortProgress"] = json!(if status == "cleaning" {
            "running work stopped; abort cleanup pending or in progress"
        } else if state["status"] == "queued" {
            "abort requested; waiting for dispatcher acknowledgement"
        } else {
            "abort requested; waiting for running work to stop"
        });
        return Some(out);
    }
    if state["janitor"]["attention"] != true {
        let failure = &state["infrastructureFailure"];
        if !failure.is_null() {
            out["setupError"] = json!(format!(
                "{} {} failed (attempt {}, {}{}): {}",
                failure["provider"].as_str().unwrap_or_default(),
                failure["operation"].as_str().unwrap_or_default(),
                failure["attempt"],
                failure["cause"].as_str().unwrap_or_default(),
                if failure["cleanupPending"] == true {
                    ", cleanup pending"
                } else {
                    ""
                },
                failure["error"].as_str().unwrap_or_default()
            ));
        } else if !state["setupFailure"].is_null() {
            let failure = &state["setupFailure"];
            out["setupError"] = json!(format!(
                "[commands].setup {} failed (attempt {}, {}): {}",
                failure["command"],
                failure["attempt"],
                if failure["exitStatus"].is_null() {
                    "exit status unavailable".into()
                } else {
                    format!("exit status {}", failure["exitStatus"])
                },
                failure["output"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .unwrap_or("(no output)")
            ));
        }
    }
    let pending_restart = array(&state["answeredEscalations"]).iter().any(|e| {
        e["resolution"] == "revise-spec"
            && number(&e["answeredSeq"]) > number(&state["restartSince"])
    });
    let restart = number(
        &state[if pending_restart {
            "lastSeq"
        } else {
            "restartSince"
        }],
    );
    let cycle_since = restart.max(number(&state["verify"]["cycleSince"]));
    let active = &state["currentPhase"];
    let at = |phase: &str| number(&active["seq"]) > restart && active["phase"] == phase;
    let frozen = if state["status"] == "running" {
        None
    } else if state["status"] == "paused" && facts["pausedAt"].is_string() {
        epoch(&facts["pausedAt"])
    } else {
        epoch(&state["lastEvent"]["ts"])
    };
    let cycle: Vec<_> = array(&state["verify"]["results"])
        .iter()
        .filter(|r| number(&r["seq"]) > cycle_since)
        .collect();
    let failed = cycle.iter().any(|r| r["outcome"] == "fail");
    let satisfied = |name: &Value| {
        cycle
            .iter()
            .any(|r| &r["step"] == name && (r["outcome"] == "pass" || r["outcome"] == "skipped"))
    };
    let loop_done = |approval: &Value, round: &Value| {
        !approval.is_null() && number(&approval["seq"]) > restart && &approval["round"] == round
    };
    let plan_done = loop_done(&state["plan"]["approval"], &state["plan"]["round"]);
    let code_done =
        loop_done(&state["codeReviewApproval"], &state["implement"]["round"]) && !failed;
    let mut steps = Vec::new();
    for (label, done, output, round) in [
        ("plan", plan_done, "planCompleted", &state["plan"]["round"]),
        (
            "plan-review",
            plan_done,
            "planReviewVerdict",
            &state["plan"]["round"],
        ),
        (
            "implement",
            code_done,
            "implementCompleted",
            &state["implement"]["round"],
        ),
        (
            "code-review",
            code_done,
            "codeReviewVerdict",
            &state["implement"]["round"],
        ),
    ] {
        let mut s = step(
            label,
            done,
            at(label),
            number(&facts["produced"][output][round.to_string()]) > restart,
        );
        if number(round) > 0 {
            s["count"] = round.clone();
        }
        if let Some(t) = timing(&facts["intervals"], label, restart, frozen) {
            s["timing"] = t;
        }
        steps.push(s);
    }
    for name in array(&pipeline["verify"]["steps"]) {
        let label = format!("verify:{}", name.as_str().unwrap_or_default());
        let results: Vec<_> = cycle.iter().filter(|r| &r["step"] == name).collect();
        let mut s = step(
            &label,
            !failed && satisfied(name),
            at(&label),
            !results.is_empty(),
        );
        if results.iter().any(|r| r["outcome"] == "fail") {
            s["qualifier"] = json!("failed");
        } else if results.iter().any(|r| r["outcome"] == "skipped") {
            s["qualifier"] = json!("skipped");
        }
        if let Some(r) = results
            .iter()
            .find(|r| r["skipCause"] == "post-reconcile-policy")
        {
            copy(&mut s, r, "reason");
        }
        let count = if at(&label) && !active["attempt"].is_null() {
            Some(number(&active["attempt"]))
        } else {
            results.iter().map(|r| number(&r["attempt"])).max()
        };
        if let Some(count) = count {
            s["count"] = json!(count);
        }
        if let Some(t) = timing(&facts["intervals"], &label, cycle_since, frozen) {
            s["timing"] = t;
        }
        steps.push(s);
    }
    let finalize_done = number(&state["finalizeCompletedSeq"]) > restart;
    let mut finalize = step("finalize", finalize_done, at("finalize"), false);
    if let Some(t) = timing(&facts["intervals"], "finalize", restart, frozen) {
        finalize["timing"] = t;
    }
    steps.push(finalize);
    let posts: Vec<_> = array(&state["finalizeSteps"])
        .iter()
        .filter(|f| number(&f["seq"]) > restart)
        .collect();
    for name in array(&pipeline["finalize"]["steps"]) {
        let done = posts.iter().find(|f| &f["step"] == name);
        let mut s = step(
            name.as_str().unwrap_or_default(),
            done.is_some(),
            false,
            false,
        );
        if done.is_some_and(|f| f["ok"] == false) {
            s["qualifier"] = json!("failed");
        }
        steps.push(s);
    }
    if state["prState"] == "conflicted" || number(&state["reconcileAttempts"]) > 0 {
        let mut s = step(
            "reconcile",
            number(&state["reconcileAttempts"]) > 0 && state["prState"] != "conflicted",
            at("reconcile"),
            false,
        );
        if number(&state["reconcileAttempts"]) > 0 {
            s["count"] = state["reconcileAttempts"].clone();
        }
        if let Some(t) = timing(&facts["intervals"], "reconcile", 0, frozen) {
            s["timing"] = t;
        }
        steps.push(s);
    }
    let merge_current = finalize_done
        && state["prState"] == "open"
        && !failed
        && array(&pipeline["verify"]["steps"]).iter().all(satisfied)
        && array(&pipeline["finalize"]["steps"])
            .iter()
            .all(|name| posts.iter().any(|f| &f["step"] == name))
        && !(number(&active["seq"]) > restart);
    let mut merge = step("merge", false, merge_current, false);
    merge["qualifier"] = json!("waiting");
    if merge_current {
        let last = epoch(&state["lastEvent"]["ts"]).unwrap_or(0);
        merge["timing"] = if let Some(now) = frozen {
            json!({"accumulatedMs":(now-last).max(0)})
        } else {
            json!({"accumulatedMs":0,"runningSince":last})
        };
        if !landing::authorized(&state["landing"]) {
            let slug = record["slug"].as_str().unwrap_or_default();
            merge["reason"] = json!(if state["landing"]["command"]["kind"] == "hold" {
                format!("Landing held — use ab land {slug} when ready to release the hold")
            } else if state["landing"]["decision"]["mode"] == "consent" {
                format!("Landing awaits consent — use ab land {slug}; use ab hold {slug} to withdraw consent")
            } else {
                "Landing policy decision pending".into()
            });
        }
    }
    steps.push(merge);

    if state["kind"] == "node" {
        let complete = super::tree::integration_complete(state);
        let failed = super::tree::integration_failed(state);
        let mut merge = step("merge", false, !state["pr"].is_null(), false);
        merge["qualifier"] = json!("waiting");
        let open = array(&state["integration"]["observation"]["openChildren"]);
        merge["reason"] = json!(if !complete {
            format!(
                "integration incomplete{}",
                if open.is_empty() {
                    String::new()
                } else {
                    format!(
                        ": {}",
                        open.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }
            )
        } else if failed {
            "verification failed; file a repair child targeting this node".into()
        } else if state["integration"]["cycle"].is_null() || !super::tree::cycle_verified(state) {
            "integration awaits verification".into()
        } else if !landing::authorized(&state["landing"]) {
            "integration awaits explicit per-build consent".into()
        } else {
            "integration awaits guarded landing".into()
        });
        steps = vec![
            step("spec", !state["specRev"].is_null(), false, false),
            step(
                "open",
                !state["nodeOpened"].is_null(),
                state["nodeOpened"].is_null(),
                false,
            ),
            step(
                out["integration"].as_str().unwrap_or_default(),
                false,
                !state["nodeOpened"].is_null(),
                false,
            ),
            merge,
        ];
        if failed {
            out["blockers"].as_array_mut().unwrap().push(json!(
                "verification failed: file a repair child targeting this node"
            ));
        }
    }
    // Terminal pipeline boundaries match the engine's final awaiting-PR route.
    // Operator/policy gates above that route must never carry an old diagnostic.
    let no_commands = !array(&state["pendingCommands"])
        .iter()
        .any(|command| command["command"] == "pause" || command["command"] == "abort");
    let settled = state["kind"] != "node"
        && plan_done
        && code_done
        && finalize_done
        && !failed
        && !pending_restart
        && !state["specRev"].is_null()
        && array(&pipeline["verify"]["steps"]).iter().all(satisfied)
        && array(&pipeline["finalize"]["steps"])
            .iter()
            .all(|name| posts.iter().any(|f| &f["step"] == name))
        && state["prState"] != "conflicted";
    let node_wait = state["kind"] == "node"
        && state["nodeRestack"]["conflict"].is_null()
        && (!super::tree::integration_current(state)
            || (!super::tree::integration_failed(state) && super::tree::cycle_verified(state)));
    if (settled || node_wait)
        && number(&state["compatibility"]["decisiveFacts"]) == 0
        && no_commands
        && state["status"] != "paused"
        && array(&state["openEscalations"]).is_empty()
    {
        if let Some(reason) = super::routing::current_deferral(projections.deferral, state) {
            out["blockers"].as_array_mut().unwrap().push(json!(reason));
        }
    }
    out["steps"] = json!(steps);
    Some(out)
}
