//! Lossless pure named kernels over validated persisted events.
use super::*;
use crate::js_json as json;
use crate::protocol::js_value::{JsJson as J, JsString as S};
fn seq(e: &J) -> i64 {
    e["seq"].as_i64().unwrap_or(0)
}
fn remove(v: &mut J, k: &str) {
    v.remove_js(&S::from(k));
}
fn copy(v: &mut J, from: &J, k: &str) {
    if let Some(x) = from.get(k) {
        v[k] = x.clone()
    } else {
        remove(v, k)
    }
}
fn pick(v: &J, keys: &[&str]) -> J {
    let mut out = json!({});
    for k in keys {
        copy(&mut out, v, k)
    }
    out
}
pub(super) fn simple(name: &str, events: &[J], unknown: &[J]) -> Result<J, ProtocolError> {
    let mut state = json!({});
    let mut open = J::Null;
    let mut outcome = json!("none");
    let mut boundary = 0;
    let mut failures = Vec::new();
    let mut raised = Vec::new();
    let mut pins = Vec::new();
    for event in events {
        let p = &event["payload"];
        let kind = event["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap();
        match name {
            "baseBranchValue" => {
                if kind == "build.created" && state.get("value").is_none() {
                    copy(&mut state, p, "baseBranch");
                    if let Some(v) = state.remove_js(&S::from("baseBranch")) {
                        state["value"] = v
                    }
                }
                if kind == "node.parent-accepted" {
                    state["value"] = p["next"]["branch"].clone()
                }
            }
            "recordedBaseShaValue" => {
                if kind == "workspace.provisioned" {
                    state["value"] = p["base"]["sha"].clone()
                }
            }
            "publishedBranchHeadValue" => {
                let next = match kind.as_str() {
                    "implement.completed" => p["commits"].get("head"),
                    "restack.rewritten" => p
                        .get("observedHead")
                        .filter(|v| !v.is_null())
                        .or_else(|| p.get("headSha")),
                    "restack.completed" => p.get("headSha"),
                    "reconcile.rewritten" => p
                        .get("observedHead")
                        .filter(|v| !v.is_null())
                        .or_else(|| p.get("headSha")),
                    "reconcile.completed" => p.get("headSha").or_else(|| p.get("mergeCommit")),
                    "finalize.step-completed" if p["ok"] == true => p.get("headSha"),
                    _ => None,
                };
                if let Some(v) = next {
                    state["value"] = v.clone()
                }
            }
            "verifyDiffBaseValue" => match kind.as_str() {
                "workspace.provisioned" if state.get("provisioned").is_none() => {
                    state["provisioned"] = p["base"]["sha"].clone()
                }
                "restack.completed" => state["promoted"] = p["targetBase"].clone(),
                "reconcile.started" => state["pending"] = p["baseSha"].clone(),
                "reconcile.completed" => {
                    if let Some(v) = state.remove_js(&S::from("pending")) {
                        state["promoted"] = v
                    }
                }
                _ => {}
            },
            "openBuildWorkspace" | "openWorkspace" => match kind.as_str() {
                "workspace.provisioned" => {
                    open = if name == "openBuildWorkspace" {
                        p.clone()
                    } else {
                        json!({"ref":p["ref"],"path":p.get("path").unwrap_or(&p["ref"]),"branch":p["branch"]})
                    }
                }
                "workspace.released" => open = J::Null,
                _ => {}
            },
            "openExecution" | "lastExecutionOutcome" => match kind.as_str() {
                "execution.started" => {
                    open = pick(
                        p,
                        &[
                            "instance",
                            "workspaceRef",
                            "provider",
                            "environmentId",
                            "sessionId",
                            "commandId",
                        ],
                    );
                    outcome = json!("open")
                }
                "execution.ended" if !open.is_null() && open["instance"] == p["instance"] => {
                    if outcome == "open" {
                        outcome = p["outcome"].clone()
                    }
                    if name == "openExecution" {
                        open = J::Null
                    }
                }
                _ => {}
            },
            "setupStreak" => match kind.as_str() {
                "runner.attached" => boundary = seq(event),
                "escalation.raised" if p["phase"] == "setup" && p["source"] == "policy" => {
                    raised.push(p["id"].clone())
                }
                "escalation.answered" if raised.contains(&p["id"]) => boundary = seq(event),
                "runner.setup-failed" => failures.push(seq(event)),
                _ => {}
            },
            "infrastructureFailureReset" => match kind.as_str() {
                "escalation.raised" if p["policyCause"] == "infrastructure-failure-limit" => {
                    raised.push(p["id"].clone())
                }
                "execution.ended" => boundary = seq(event),
                "escalation.answered"
                    if p["resolution"] == "retry" && raised.contains(&p["id"]) =>
                {
                    boundary = seq(event)
                }
                _ => {}
            },
            "pinnedAssets" => {
                if matches!(kind.as_str(), "build.created" | "spec.revised") {
                    if let Some(assets) = p.get("assets") {
                        pins.push(assets.clone())
                    }
                }
            }
            _ => {}
        }
    }
    match name {
        "baseBranchValue" | "recordedBaseShaValue" | "publishedBranchHeadValue" => Ok(state),
        "verifyDiffBaseValue" => Ok(state
            .get("provisioned")
            .map(|v| json!({"value":state.get("promoted").unwrap_or(v)}))
            .unwrap_or_else(|| json!({}))),
        "openBuildWorkspace" | "openWorkspace" | "openExecution" => Ok(open),
        "lastExecutionOutcome" => Ok(outcome),
        "setupStreak" => Ok(json!(failures
            .iter()
            .filter(|seq| **seq > boundary)
            .count())),
        "infrastructureFailureReset" => Ok(json!(boundary)),
        "pinnedAssets" => Ok(json!({"pins":pins})),
        "buildDelegation" => Ok(crate::protocol::delegation_facts::reduce(events, false)),
        "harvestDelegation" => Ok(crate::protocol::delegation_facts::reduce(events, true)),
        "buildDigest" => digest(events, unknown),
        _ => Err(ProtocolError::new(
            500,
            "internal",
            format!("native reducer \"{name}\" not implemented"),
        )),
    }
}
pub(super) fn extras(name: &str, events: &[J], args: &J) -> J {
    if name == "phaseFailures" {
        let mut raised = std::collections::BTreeMap::<S, J>::new();
        let mut value = json!({"count":0});
        for event in events {
            let p = &event["payload"];
            match event["type"]
                .as_string()
                .and_then(|s| s.to_scalar().ok())
                .unwrap()
                .as_str()
            {
                "phase.deferral-escalated" => {
                    let mut raise = pick(p, &["phase", "round"]);
                    raise["source"] = json!("policy");
                    raise["deferral"] = json!("own-build-read");
                    raised.insert(p["id"].as_string().unwrap().clone(), raise);
                }
                "escalation.raised" => {
                    raised.insert(
                        p["id"].as_string().unwrap().clone(),
                        pick(p, &["phase", "source", "round", "policyCause"]),
                    );
                }
                "escalation.answered" => {
                    if let Some(raise) = raised.get(p["id"].as_string().unwrap()) {
                        let resets = raise["deferral"] != "own-build-read"
                            && raise["phase"] == args["phase"]
                            && if raise["source"] != "policy" || raise.get("policyCause").is_none()
                            {
                                raise
                                    .get("round")
                                    .is_none_or(|round| round == &args["round"])
                            } else {
                                match catalog()["phaseFailureResets"][raise["policyCause"]
                                    .as_string()
                                    .unwrap()
                                    .to_scalar()
                                    .unwrap()]
                                .as_str()
                                {
                                    Some("matching-round") => raise["round"] == args["round"],
                                    Some("all-phase-rounds") => true,
                                    _ => false,
                                }
                            };
                        if resets {
                            value = json!({"count":0})
                        }
                    }
                }
                "phase.failed" if p["phase"] == args["phase"] && p["round"] == args["round"] => {
                    value["count"] = json!(value["count"].as_i64().unwrap() + 1);
                    for (from, to) in [
                        ("error", "lastError"),
                        ("willRetry", "lastWillRetry"),
                        ("providerAttempts", "lastProviderAttempts"),
                    ] {
                        if let Some(v) = p.get(from) {
                            value[to] = v.clone()
                        } else {
                            remove(&mut value, to)
                        }
                    }
                }
                _ => {}
            }
        }
        return value;
    }
    if name == "dashboardFacts" {
        return dashboard_facts(events);
    }
    let mut selected = std::collections::BTreeMap::<S, J>::new();
    let mut restart = 0;
    let mut hosted = Vec::new();
    let mut reclaimed = std::collections::BTreeMap::<S, J>::new();
    let mut requests = Vec::new();
    let mut settled = Vec::new();
    let mut ledger: Vec<J> = Vec::new();
    let mut active = J::Null;
    let mut count = 0;
    let mut open: Vec<J> = Vec::new();
    let mut latest = J::Null;
    let mut failures = Vec::new();
    let mut aborted = false;
    for event in events {
        let t = event["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap();
        let p = &event["payload"];
        match name {
            "currentPrAttachments" => {
                if t == "spec.revised" {
                    restart = restart.max(seq(event))
                } else if t == "pr-attachment.designated" {
                    let key = p["artifact"]["kind"].as_string().unwrap();
                    if selected
                        .get(key)
                        .is_none_or(|previous| seq(event) > seq(previous))
                    {
                        selected.insert(key.clone(), event.clone());
                    }
                }
            }
            "pendingPrAttachmentReclaims" => {
                if t == "pr-attachment.hosted" {
                    hosted.push(event.clone())
                } else if t == "pr-attachment.reclaimed" {
                    let key = S::from(p["hostedSeq"].stringify());
                    if reclaimed
                        .get(&key)
                        .is_none_or(|previous| seq(event) > previous.as_i64().unwrap())
                    {
                        reclaimed.insert(key, event["seq"].clone());
                    }
                }
            }
            "summaryRequests" => {
                if t == "pr-summary.requested" {
                    requests.push(event.clone())
                } else if t == "pr-summary.settled" {
                    settled.push(p["request"].clone())
                }
            }
            "currentDeferralObservation" => {
                let entry = if t == "observation.recorded"
                    && p["refs"].as_array().is_some_and(|refs| {
                        refs.iter().any(|r| {
                            r.as_string().is_some_and(|r| {
                                r.units()
                                    .starts_with(S::from("auto-merge-gate:pr:").units())
                            })
                        })
                    }) {
                    Some(json!({"t":"observation","event":event}))
                } else if t == "finalize.completed" {
                    Some(json!({"t":"finalized","seq":event["seq"],"headSha":p["pr"]["headSha"]}))
                } else if matches!(t.as_str(), "pr.merged" | "pr.closed") {
                    Some(json!({"t":"terminal","seq":event["seq"]}))
                } else if t == "reconcile.completed" {
                    Some(json!({"t":"reconciled","seq":event["seq"]}))
                } else {
                    None
                };
                if let Some(entry) = entry {
                    ledger.push(entry)
                } else if let Some(last) = ledger.last_mut().filter(|last| last["t"] == "barrier") {
                    last["seq"] = json!(last["seq"].as_i64().unwrap().max(seq(event)))
                } else {
                    ledger.push(json!({"t":"barrier","seq":event["seq"]}))
                }
            }
            "executionNoProgress" => {
                if t == "execution.started" {
                    if !active.is_null() {
                        count = 0
                    }
                    active = json!({"instance":p["instance"],"seq":event["seq"],"eligible":true})
                } else if t == "execution.ended" {
                    if active.is_null() || active["instance"] != p["instance"] {
                        continue;
                    }
                    count = if p["outcome"] == "completed"
                        && p["exitCode"].as_i64() == Some(0)
                        && active["eligible"] == true
                    {
                        count + 1
                    } else {
                        0
                    };
                    latest = json!({"instance":p["instance"],"seq":event["seq"]});
                    active = J::Null;
                } else if t == "escalation.raised"
                    && p["source"] == "policy"
                    && p["policyCause"] == "execution-no-progress"
                {
                    if !open.contains(&p["id"]) {
                        open.push(p["id"].clone())
                    }
                } else if t == "escalation.answered" {
                    if !open.contains(&p["id"]) {
                        continue;
                    }
                    open.retain(|id| id != &p["id"]);
                    count = 0;
                    active = J::Null;
                } else if catalog()["executionProgress"][t.as_str()] != "bookkeeping" {
                    count = 0;
                    if !active.is_null() {
                        active["eligible"] = json!(false)
                    }
                }
            }
            "dispatchFailureBudget" => {
                if t == "runner.attached" {
                    failures.clear()
                } else if t == "escalation.raised"
                    && p["source"] == "policy"
                    && p["policyCause"] == "dispatch-failure-limit"
                {
                    if !open.contains(&p["id"]) {
                        open.push(p["id"].clone())
                    }
                } else if t == "escalation.answered" && open.contains(&p["id"]) {
                    open.retain(|id| id != &p["id"]);
                    if p["resolution"] != "abort" {
                        failures.clear()
                    } else {
                        aborted = true
                    }
                } else if t == "dispatch.failed"
                    && !(args["infrastructureOwnsWorkspace"] == true && p["stage"] == "workspace")
                {
                    failures.push(event.clone())
                }
            }
            _ => {}
        }
    }
    match name {
        "currentPrAttachments" => {
            let mut items: Vec<_> = selected
                .into_values()
                .filter(|event| seq(event) > restart)
                .collect();
            items.sort_by_key(seq);
            J::Array(items)
        }
        "pendingPrAttachmentReclaims" => {
            hosted.sort_by_key(seq);
            hosted.retain(|event| {
                !reclaimed
                    .get(&S::from(event["seq"].stringify()))
                    .is_some_and(|at| at.as_i64().unwrap() > seq(event))
            });
            J::Array(hosted)
        }
        "summaryRequests" => J::Array(
            requests
                .into_iter()
                .filter(|event| !settled.contains(&event["seq"]))
                .collect::<Vec<_>>(),
        ),
        "currentDeferralObservation" => json!({"entries":ledger}),
        "executionNoProgress" => json!({"active":active,"count":count,"open":open,"latest":latest}),
        "dispatchFailureBudget" => {
            let mut value = json!({"count":failures.len(),"parked":aborted||!open.is_empty()});
            if let Some(last) = failures.last() {
                value["latest"] = last.clone()
            }
            value
        }
        _ => unreachable!(),
    }
}

fn dashboard_facts(events: &[J]) -> J {
    let mut value = json!({"sessionEvents":[],"intervals":{},"produced":{"planCompleted":{},"planReviewVerdict":{},"implementCompleted":{},"codeReviewVerdict":{}}});
    for event in events {
        let t = event["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap();
        let p = &event["payload"];
        let phase = match t.as_str() {
            "plan.started" | "plan.completed" => Some(S::from("plan")),
            "plan-review.started" | "plan-review.verdict" => Some(S::from("plan-review")),
            "implement.started" | "implement.completed" => Some(S::from("implement")),
            "code-review.started" | "code-review.verdict" => Some(S::from("code-review")),
            "verify.started" | "verify.completed" | "verify.cancelled" => Some(S::from_units(
                "verify:"
                    .encode_utf16()
                    .chain(p["step"].as_string().unwrap().units().iter().copied())
                    .collect(),
            )),
            "finalize.started" | "finalize.completed" => Some(S::from("finalize")),
            "reconcile.started" | "reconcile.completed" => Some(S::from("reconcile")),
            _ => None,
        };
        if let Some(phase) = phase {
            if value["intervals"].get_js(&phase).is_none() {
                value["intervals"][&phase] = json!({"closed":[]})
            }
            let timing = &mut value["intervals"][&phase];
            let ms = chrono::DateTime::parse_from_rfc3339(
                &event["ts"].as_string().unwrap().to_scalar().unwrap(),
            )
            .unwrap()
            .timestamp_millis();
            if t.ends_with(".started") {
                timing["open"] = json!({"start":ms,"startSeq":event["seq"]})
            } else if let Some(open) = timing.remove_js(&S::from("open")) {
                timing["closed"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"start":open["start"],"end":ms,"startSeq":open["startSeq"]}))
            }
        }
        match t.as_str() {
            "build.created" => value["created"] = event["seq"].clone(),
            "workspace.provisioned" => value["workspaceProvisioned"] = event["seq"].clone(),
            "workspace.released" => value["workspaceReleased"] = event["seq"].clone(),
            "spec.imported" | "spec.authored" => value["specLanded"] = event["seq"].clone(),
            "dispatch.comment-posted" => value["commentPosted"] = event["seq"].clone(),
            "dispatch.failed" => {
                let mut failed = pick(p, &["stage", "attempt", "error"]);
                failed["seq"] = event["seq"].clone();
                value["latestFailure"] = failed;
            }
            "session.suspended" | "session.resumed" | "session.started" | "session.ended" => value
                ["sessionEvents"]
                .as_array_mut()
                .unwrap()
                .push(event.clone()),
            "build.paused" => value["pausedAt"] = event["ts"].clone(),
            "plan.completed"
            | "plan-review.verdict"
            | "implement.completed"
            | "code-review.verdict" => {
                let field = match t.as_str() {
                    "plan.completed" => "planCompleted",
                    "plan-review.verdict" => "planReviewVerdict",
                    "implement.completed" => "implementCompleted",
                    _ => "codeReviewVerdict",
                };
                let key = S::from(p["round"].stringify());
                let prior = value["produced"][field][&key].as_i64().unwrap_or(0);
                value["produced"][field][&key] = json!(prior.max(seq(event)));
            }
            _ => {}
        }
    }
    value
}

fn digest(events: &[J], unknown: &[J]) -> Result<J, ProtocolError> {
    let mut state = json!({"observations":[]});
    let mut hosted = Vec::new();
    let mut reclaimed = Vec::new();
    let mut open = J::Null;
    for e in events {
        let p = &e["payload"];
        let t = e["type"].as_string().unwrap().to_scalar().unwrap();
        if [
            "node.writer-settled",
            "node.opened",
            "node.contribution-recorded",
            "pr.closed",
            "pr.merged",
            "build.completed",
            "build.aborted",
        ]
        .contains(&t.as_str())
        {
            state["readinessChangeSeq"] = e["seq"].clone()
        }
        match t.as_str() {
            "integration.landed" => {
                if p.get("operation").is_some() {
                    state["integrationAuditPending"] = json!(true)
                } else {
                    remove(&mut state, "integrationAuditPending")
                }
            }
            "integration.audited" => remove(&mut state, "integrationAuditPending"),
            "build.created" => copy(&mut state, p, "kind"),
            "node.contribution-recorded" => state["nodeContribution"] = p.clone(),
            "node.opened" => state["nodeOpened"] = json!(true),
            "pr.closed" => state["prClosed"] = json!(true),
            "build.completed" => state["terminal"] = json!("done"),
            "build.aborted" => state["terminal"] = json!("aborted"),
            "pr.merged" => {
                state["merged"] = e["ts"].clone();
                if let Some(sha) = p.get("sha") {
                    state["mergedSha"] = sha.clone()
                } else {
                    remove(&mut state, "mergedSha")
                }
            }
            "observation.recorded" => state["observations"]
                .as_array_mut()
                .unwrap()
                .push(json!({"seq":e["seq"],"ts":e["ts"]})),
            "pr-attachment.hosted" => hosted.push(seq(e)),
            "pr-attachment.reclaimed" => {
                if p["hostedSeq"].as_i64().is_some_and(|s| seq(e) > s) {
                    reclaimed.push(p["hostedSeq"].as_i64().unwrap())
                }
            }
            "execution.started" => open = p.get("instance").cloned().unwrap_or(J::Null),
            "execution.ended" if !open.is_null() && p["instance"] == open => open = J::Null,
            _ => {}
        }
    }
    if hosted.iter().any(|seq| !reclaimed.contains(seq)) {
        state["reclaimPending"] = json!(true)
    }
    if !open.is_null() {
        state["executionOpen"] = json!(true)
    }
    if !unknown.is_empty() {
        state["compatibility"] = compatibility(unknown)?
    }
    Ok(state)
}
fn initial_compatibility() -> J {
    json!({"unknownFacts":0,"decisiveFacts":0,"lastSeq":0,"decisiveBoundary":0,"types":[],"writerVersions":[],"legacyVersionUnavailable":false,"decisiveTypes":[],"decisiveWriterVersions":[],"decisiveLegacyVersionUnavailable":false})
}
fn unique(state: &mut J, key: &str, value: &J) {
    let a = state[key].as_array_mut().unwrap();
    if !a.contains(value) {
        a.push(value.clone())
    }
}
pub(super) fn compatibility(unknown: &[J]) -> Result<J, ProtocolError> {
    let mut state = initial_compatibility();
    for event in unknown {
        state["unknownFacts"] = json!(state["unknownFacts"].as_i64().unwrap() + 1);
        state["lastSeq"] = json!(state["lastSeq"].as_i64().unwrap().max(seq(event)));
        unique(&mut state, "types", &event["type"]);
        if let Some(metadata) = event.get("compatibility") {
            crate::protocol::validation::lossless::validate_schema(
                &catalog()["compatibilitySchema"],
                metadata,
            )
            .map_err(|message| ProtocolError::new_js(500, "internal", message))?;
            unique(&mut state, "writerVersions", &metadata["writerVersion"])
        } else {
            state["legacyVersionUnavailable"] = json!(true)
        }
        if event["compatibility"]["classification"] != "advisory" {
            state["decisiveFacts"] = json!(state["decisiveFacts"].as_i64().unwrap() + 1);
            state["decisiveBoundary"] = event["seq"].clone();
            unique(&mut state, "decisiveTypes", &event["type"]);
            if let Some(metadata) = event.get("compatibility") {
                unique(
                    &mut state,
                    "decisiveWriterVersions",
                    &metadata["writerVersion"],
                )
            } else {
                state["decisiveLegacyVersionUnavailable"] = json!(true)
            }
        }
    }
    Ok(state)
}
