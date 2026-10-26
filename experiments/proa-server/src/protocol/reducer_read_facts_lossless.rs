//! JSON-safe compound build readers and terminal authority guards.
#[path = "reducer_log_index_lossless.rs"]
mod log_index;
use super::{
    kernels_lossless::{compatibility, extras},
    lossless_values::{validate_node_lossless, ResolvedReducerLossless as ResolvedReducer},
};
use crate::data::reducers::lossless::{number, remove};
fn seq(v: &Value) -> i64 {
    number(&v["seq"])
}
use crate::js_json as json;
use crate::{
    data::reducers::build_lossless::BuildAcc,
    protocol::{
        error::ProtocolError,
        js_value::{parse_js_string, JsJson as Value, JsString},
        store::records::Scope,
    },
};
pub(super) fn value(
    name: &str,
    scope: Scope<'_>,
    resolved: &ResolvedReducer,
    raw: &[Value],
    events: &[Value],
    unknown: &[Value],
) -> Result<Value, ProtocolError> {
    match name {
        "terminalGuard" => super::lossless_values::terminal_guard_lossless(&resolved.args, events),
        "buildStreamSeed" => build_seed(events, unknown),
        "buildReadFacts" => build_facts(scope, raw, events),
        _ => unreachable!(),
    }
}
fn named(name: &str, scope: Scope<'_>, raw: &[Value]) -> Result<Value, ProtocolError> {
    super::reduce_events_lossless(
        scope,
        &ResolvedReducer {
            name: name.into(),
            args: json!({}),
            version: 0,
        },
        raw,
    )
}
fn nonempty(value: &Value) -> bool {
    value.as_array().is_some_and(|a| !a.is_empty())
}
fn absent(value: &Value) -> bool {
    value.is_null()
}
fn awaits_consent(state: &Value, restack: &Value) -> Result<bool, ProtocolError> {
    let decision = &state["landing"]["decision"];
    let candidate = &decision["candidate"];
    let node = state["kind"] == "node";
    let cycle = &state["integration"]["cycle"];
    let cycle_current = !cycle.is_null() && number(&cycle["seq"]) > number(&state["restartSince"]);
    if decision.is_null()
        || (node && !cycle_current)
        || state["status"] == "paused"
        || !absent(&state["currentPhase"])
        || nonempty(&state["openEscalations"])
        || nonempty(&state["pendingCommands"])
        || state["prState"] != "open"
        || (if node {
            &cycle["head"]
        } else {
            &state["pr"]["headSha"]
        }) != &candidate["head"]
        || (!node
            && !restack["target"].is_null()
            && restack["target"]["sha"] != candidate["parent"])
        || !restack["active"].is_null()
        || !state["nodeRestack"]["active"].is_null()
    {
        return Ok(false);
    }
    if matches!(
        Some(control(&state["status"])).as_deref(),
        Some("queued" | "done" | "aborted")
    ) || state.get("discardRequest").is_some()
        || !state["nodeRestack"]["parentRequest"].is_null()
        || !state["nodeRestack"]["parentChange"].is_null()
        || nonempty(&state["sessions"]["open"])
    {
        return Ok(false);
    }
    let expected_cycle = number(&state["finalizeCompletedSeq"]).to_string();
    let ready = if node {
        let observation = &state["integration"]["observation"];
        let current = cycle_current
            && !observation.is_null()
            && !nonempty(&observation["openChildren"])
            && !nonempty(&observation["diagnostics"])
            && nonempty(&observation["contributions"])
            && state["nodeComparison"]["headSha"] == cycle["head"]
            && state["nodeComparison"]["parentSha"] == cycle["parent"]
            && (state["nodeRestack"]["observedParent"].is_null()
                || state["nodeRestack"]["observedParent"]["sha"] == cycle["parent"])
            && state["nodeRestack"]["contributionBase"] == cycle["parent"];
        if !current {
            return Ok(false);
        }
        let config =
            parse_js_string(string(&cycle["config"])).map_err(|_| ProtocolError::internal())?;
        let steps = config["verify"]["steps"]
            .as_array()
            .ok_or_else(ProtocolError::internal)?;
        let receipts: Vec<_> = state["verify"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| {
                number(&r["seq"]) > number(&cycle["seq"])
                    && r["restackId"] == cycle["id"]
                    && r["headSha"] == cycle["head"]
                    && r["baseSha"] == cycle["parent"]
            })
            .collect();
        !receipts.iter().any(|r| r["outcome"] == "fail")
            && steps.iter().all(|step| {
                receipts.iter().any(|r| {
                    &r["step"] == step
                        && matches!(
                            Some(control(&r["outcome"])).as_deref(),
                            Some("pass" | "skipped")
                        )
                })
            })
            && candidate["parent"] == cycle["parent"]
            && candidate["cycle"] == cycle["id"]
    } else {
        number(&state["finalizeCompletedSeq"]) > number(&state["restartSince"])
            && number(&decision["seq"]) >= number(&state["verify"]["cycleSince"])
            && !state["verify"]["results"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| {
                    number(&r["seq"]) > number(&state["verify"]["cycleSince"])
                        && r["outcome"] == "fail"
                })
            && candidate["cycle"] == expected_cycle.as_str()
            && string(&candidate["parent"])
                == restack["completed"]
                    .get("targetBase")
                    .or_else(|| restack.get("initialBase"))
                    .and_then(Value::as_string)
                    .unwrap_or(&EMPTY)
    };
    Ok(ready
        && (state["landing"]["command"]["kind"] == "hold"
            || (decision["mode"] == "consent" && state["landing"]["command"]["kind"] != "land")))
}
fn merge_attention(state: &Value, ledger: &Value) -> Option<Value> {
    if !state["pr"].is_null()
        && state["landing"]["forgeMerge"]["classification"] == "possible-stale-enable"
    {
        return Some(state["pr"]["number"].clone());
    }
    if number(&state["finalizeCompletedSeq"]) == 0
        || state["pr"].is_null()
        || state["prState"] != "open"
        || matches!(
            Some(control(&state["status"])).as_deref(),
            Some("done" | "aborted")
        )
    {
        return None;
    }
    let auto = &state["autoMerge"];
    let command = auto.get("commandSeq")?;
    if auto["requested"] != true
        || (auto["applied"]["commandSeq"] == *command
            && auto["applied"]["enabled"] == auto["requested"])
    {
        return None;
    }
    let marker = format!(
        "auto-merge-gate:pr:{}:command:{}",
        state["pr"]["number"].stringify(),
        command.stringify()
    );
    let entries = ledger["entries"].as_array().unwrap();
    let observation = entries.iter().rev().find(|entry| {
        entry["t"] == "observation"
            && entry["event"]["payload"]["refs"]
                .as_array()
                .is_some_and(|refs| refs.contains(&json!(marker)))
    })?;
    let observed_seq = seq(&observation["event"]);
    let mut head = None;
    for entry in entries {
        let n = if entry["t"] == "observation" {
            seq(&entry["event"])
        } else {
            number(&entry["seq"])
        };
        if n >= observed_seq {
            break;
        }
        if entry["t"] == "finalized" {
            head = Some(entry["headSha"].clone())
        }
    }
    for entry in entries {
        if matches!(
            Some(control(&entry["t"])).as_deref(),
            Some("observation" | "barrier")
        ) || number(&entry["seq"]) <= observed_seq
        {
            continue;
        }
        if matches!(
            Some(control(&entry["t"])).as_deref(),
            Some("terminal" | "reconciled")
        ) {
            return None;
        }
        if let Some(head) = &head {
            if head != &entry["headSha"] {
                return None;
            }
        } else {
            head = Some(entry["headSha"].clone())
        }
    }
    Some(state["pr"]["number"].clone())
}
fn build_seed(events: &[Value], unknown: &[Value]) -> Result<Value, ProtocolError> {
    let mut build = BuildAcc::default();
    let mut value = json!({"build":build.carried(),"deferral":{"entries":[]},"mergeAttentionPrs":[],"restack":{"gates":{}}});
    let mut prefix = Vec::new();
    for event in events {
        build.fold(event)?;
        prefix.push(event.clone());
        validate_node_lossless("buildStreamSeed", &prefix)?;
        let event_type = control(&event["type"]);
        let t = event_type.as_str();
        let p = &event["payload"];
        if matches!(t, "workspace.provisioned" | "node.opening") {
            value["branch"] = p["branch"].clone()
        }
        if matches!(t, "build.completed" | "build.aborted") {
            value["terminalEvent"] = event.clone()
        }
        crate::protocol::restack_values_lossless::advance_leaf(&mut value["restack"], event);
        value["deferral"] = extras("currentDeferralObservation", &prefix, &json!({}));
        let mut state = build.finish();
        state["compatibility"] = compatibility(
            &unknown
                .iter()
                .filter(|u| seq(u) <= seq(event))
                .cloned()
                .collect::<Vec<_>>(),
        )?;
        if awaits_consent(&state, &value["restack"])? {
            let candidate = &state["landing"]["decision"]["candidate"];
            let id = stringify(&json!([
                candidate["head"],
                candidate["parent"],
                candidate["cycle"]
            ]))
            .unwrap();
            if value["consentEpisode"]["candidate"] != id.as_str() {
                value["consentEpisode"] = json!({"seq":event["seq"],"candidate":id})
            }
        } else {
            remove(&mut value, "consentEpisode")
        }
        if let Some(pr) = merge_attention(&state, &value["deferral"]) {
            let prs = value["mergeAttentionPrs"].as_array_mut().unwrap();
            if !prs.contains(&pr) {
                prs.push(pr)
            }
        }
    }
    value["build"] = build.carried();
    value["build"]["compatibility"] = compatibility(unknown)?;
    Ok(value)
}
fn optional(value: &mut Value, key: &str, next: Option<&Value>) {
    if let Some(next) = next {
        value[key] = next.clone()
    }
}
fn head(payload: &Value) -> Value {
    payload
        .get("headSha")
        .or_else(|| payload.get("mergeCommit"))
        .cloned()
        .unwrap_or(Value::Null)
}
fn publication(events: &[Value]) -> Value {
    let mut ledger: Vec<Value> = Vec::new();
    let mut retries: Vec<Value> = Vec::new();
    for e in events {
        let p = &e["payload"];
        let event_type = control(&e["type"]);
        let t = event_type.as_str();
        if matches!(
            t,
            "publication.retry-scheduled" | "publication.retry-exhausted" | "escalation.answered"
        ) {
            retries.push(e.clone());
        }
        if matches!(
            t,
            "restack.completed" | "restack.contended" | "reconcile.contended"
        ) || (t == "reconcile.completed" && p.get("rewriteId").is_some())
        {
            let id = p.get("id").or_else(|| p.get("rewriteId"));
            let operation = if t.starts_with("restack.") {
                "restack"
            } else {
                "reconcile"
            };
            retries.retain(|event| {
                event["type"] == "escalation.answered"
                    || event["payload"]["operation"] != operation
                    || event["payload"].get("rewriteId") != id
            });
        }
        if t == "workspace.released" {
            retries.clear();
        }
        let mut item = match t {
            "publication.requested" => Some(json!({"t":"request","seq":e["seq"],"event":e})),
            "restack.completed" => {
                Some(json!({"t":"restack","seq":e["seq"],"id":p["id"],"head":p["headSha"]}))
            }
            "restack.contended" | "reconcile.contended" => {
                Some(json!({"t":"cancelled","seq":e["seq"],"request":p["request"]}))
            }
            "publication.lost" => Some(json!({"t":"lost","seq":e["seq"],"request":p["request"]})),
            "workspace.provisioned" => {
                Some(json!({"t":"provisioned","seq":e["seq"],"ref":p["ref"]}))
            }
            "workspace.released" => {
                let mut item = json!({"t":"released","seq":e["seq"]});
                optional(&mut item, "ref", p.get("ref"));
                Some(item)
            }
            "implement.completed" => Some(
                json!({"t":"implement","seq":e["seq"],"round":p["round"],"base":p["commits"]["base"],"head":p["commits"]["head"]}),
            ),
            "reconcile.completed" => {
                let mut item = json!({"t":"reconcile","seq":e["seq"],"mergeCommit":head(p)});
                optional(&mut item, "rewriteId", p.get("rewriteId"));
                Some(item)
            }
            "finalize.completed" => {
                Some(json!({"t":"finalize","seq":e["seq"],"headSha":p["pr"]["headSha"]}))
            }
            "finalize.step-completed" => {
                let mut item = json!({"t":"step","seq":e["seq"],"step":p["step"],"ok":p["ok"]});
                optional(&mut item, "headSha", p.get("headSha"));
                Some(item)
            }
            _ => None,
        };
        if let Some(item) = item.take() {
            ledger.push(item)
        } else if let Some(last) = ledger.last_mut().filter(|last| last["t"] == "barrier") {
            last["seq"] = json!(number(&last["seq"]).max(seq(e)))
        } else {
            ledger.push(json!({"t":"barrier","seq":e["seq"]}))
        }
    }
    json!({"ledger":ledger,"retries":retries})
}
fn summary_boundary(events: &[Value]) -> Option<Value> {
    let mut occurrence = None;
    let mut boundary = None;
    let mut sessions = Vec::new();
    for e in events {
        let event_type = control(&e["type"]);
        let t = event_type.as_str();
        let p = &e["payload"];
        if [
            "plan.started",
            "plan-review.started",
            "implement.started",
            "code-review.started",
            "verify.started",
            "reconcile.started",
            "finalize.started",
            "finalize.step-started",
        ]
        .contains(&t)
        {
            occurrence = Some(seq(e));
            boundary = None
        }
        if t == "session.started" && !sessions.contains(&p["session"]) {
            sessions.push(p["session"].clone())
        }
        if t == "session.ended" {
            sessions.retain(|s| s != &p["session"])
        }
        if occurrence.is_some()
            && (t == "session.ended"
                || [
                    "plan.completed",
                    "plan-review.verdict",
                    "implement.completed",
                    "code-review.verdict",
                    "verify.completed",
                    "reconcile.completed",
                    "finalize.completed",
                    "finalize.step-completed",
                    "phase.failed",
                    "escalation.raised",
                    "publication.requested",
                ]
                .contains(&t))
        {
            boundary = Some(seq(e))
        }
    }
    match (occurrence, boundary, sessions.is_empty()) {
        (Some(occurrence), Some(boundary), true) => {
            Some(json!({"occurrence":occurrence,"boundary":boundary}))
        }
        _ => None,
    }
}
fn git_tips(value: &Value, key: &str, tips: &mut std::collections::BTreeSet<JsString>) {
    match value {
        Value::String(text)
            if [
                "sha",
                "base",
                "head",
                "baseSha",
                "headSha",
                "mergeCommit",
                "oldHead",
                "oldBase",
                "targetBase",
                "changeSha",
                "workspaceHead",
                "localBranchHead",
                "observedHead",
            ]
            .contains(&key)
                && (text.len() == 40 || text.len() == 64)
                && text
                    .units()
                    .iter()
                    .all(|b| (*b >= 48 && *b <= 57) || (97..=102).contains(b)) =>
        {
            tips.insert(text.clone());
        }
        Value::Array(a) => {
            for value in a {
                git_tips(value, "", tips)
            }
        }
        Value::Object(o) => {
            for (key, value) in o {
                git_tips(value, &key.to_scalar().unwrap_or_default(), tips)
            }
        }
        _ => {}
    }
}
fn build_facts(scope: Scope<'_>, raw: &[Value], events: &[Value]) -> Result<Value, ProtocolError> {
    let mut value = json!({"runnerAttaches":[],"summaryHistory":[],"summaryAttempts":[],"summaryRequested":{},"finalizePublicationRequested":false,"findings":{},"feedback":{},"planFeedback":{},"reconcileBases":{},"reconcileHistory":[],"restackHistory":[],"gitTips":[],"maxPlanRevision":-1,"seenTypes":[],"localWorkspace":false,"cleanupCounts":{},"reclaimCounts":{},"infrastructureCount":0,"infrastructureRaisedSeq":0,"remoteWorkspace":false,"latestWorkspaceFailureSeq":0,"workspaceGenerations":0,"dispatchFailureCount":0,"commentPosted":false,"specRecorded":false,"autoMergeEverRequested":false,"observations":[],"observationFacts":[],"mergeTimes":[]});
    for (out, name) in [
        ("summaryRequests", "summaryRequests"),
        ("designations", "currentPrAttachments"),
        ("pendingAttachments", "pendingPrAttachmentReclaims"),
        ("state", "build"),
        ("executionNoProgress", "executionNoProgress"),
        ("open", "openExecution"),
        ("workspace", "openBuildWorkspace"),
        ("lastExecution", "lastExecutionOutcome"),
        ("dashboard", "dashboardFacts"),
        ("deferral", "currentDeferralObservation"),
        ("infrastructureReset", "infrastructureFailureReset"),
    ] {
        value[out] = named(name, scope, raw)?
    }
    value["log"] = log_index::log_index(events);
    value["publication"] = publication(events);
    optional(
        &mut value,
        "summaryBoundary",
        summary_boundary(events).as_ref(),
    );
    let base = named("baseBranchValue", scope, raw)?;
    optional(&mut value, "baseBranch", base.get("value"));
    let mut first_base = None;
    let mut settled = None;
    let mut provision = None;
    let mut image_created: Option<&Value> = None;
    let mut hosted = std::collections::BTreeMap::<String, Value>::new();
    let mut infra_raises = Vec::new();
    let mut infra_reset = 0;
    for e in events {
        let event_type = control(&e["type"]);
        let t = event_type.as_str();
        let p = &e["payload"];
        if t == "build.created" && image_created.is_none_or(|old| seq(e) < seq(old)) {
            image_created = Some(e)
        }
        if t == "pr-attachment.hosted" {
            let key = p["designationSeq"].stringify();
            if hosted.get(&key).is_none_or(|old| seq(e) > seq(old)) {
                hosted.insert(key, e.clone());
            }
        }
        match t {
            "runner.attached" => {
                let mut attach = p.clone();
                attach["seq"] = e["seq"].clone();
                attach["ts"] = e["ts"].clone();
                attach["runtime"] = Value::Null;
                value["runnerAttaches"].as_array_mut().unwrap().push(attach)
            }
            "runner.runtime-recorded" => {
                if let Some(attach) = value["runnerAttaches"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|a| a["seq"] == p["attachedSeq"] && a["instance"] == p["instance"])
                {
                    attach["runtime"] = p["runtime"].clone()
                }
            }
            "plan-review.verdict" | "code-review.verdict" => {
                value["summaryHistory"].as_array_mut().unwrap().push(json!({"kind":"review","phase":if t=="plan-review.verdict"{"plan-review"}else{"code-review"},"round":p["round"],"verdict":p["verdict"],"count":p["findings"].as_array().unwrap().len()}));
                for finding in p["findings"].as_array().unwrap() {
                    value["findings"][stringify(&finding["id"]).unwrap()] = finding.clone()
                }
                if t == "plan-review.verdict" {
                    value["planFeedback"][(number(&p["round"]) + 1).to_string()] = if p["verdict"]
                        == "revise"
                    {
                        json!({"findings":p["findings"].as_array().unwrap().iter().map(|f|f["id"].clone()).collect::<Vec<_>>()})
                    } else {
                        Value::Null
                    }
                }
            }
            "verify.completed" => value["summaryHistory"]
                .as_array_mut()
                .unwrap()
                .push(json!({"kind":"verify","result":p})),
            "pr-summary.attempted" => {
                let a = value["summaryAttempts"].as_array_mut().unwrap();
                if !a.contains(&p["occurrence"]) {
                    a.push(p["occurrence"].clone())
                }
            }
            "pr-summary.requested" => {
                let key = p["occurrence"].stringify();
                if value["summaryRequested"].get(&key).is_none() {
                    value["summaryRequested"][key] = e.clone()
                }
            }
            "pr-summary.result" => {
                if let Some(next) = p.get("eligibleAfter") {
                    let time = |v: &Value| {
                        chrono::DateTime::parse_from_rfc3339(&control(v))
                            .map(|d| d.timestamp_millis())
                            .unwrap_or(0)
                    };
                    if value
                        .get("summaryEligibleAfter")
                        .is_none_or(|old| time(next) > time(old))
                    {
                        value["summaryEligibleAfter"] = next.clone()
                    }
                }
            }
            "publication.requested" if p["operation"] == "finalize" => {
                value["finalizePublicationRequested"] = json!(true)
            }
            "plan.started" | "implement.started" => {
                let phase = if t == "plan.started" {
                    "plan"
                } else {
                    "implement"
                };
                value["feedback"][stringify(&json!([phase, p["round"]])).unwrap()] =
                    p.get("feedback").cloned().unwrap_or(Value::Null)
            }
            "verify.started" => {
                value["feedback"][stringify(&json!([
                    prefix("verify:", string(&p["step"])),
                    p["attempt"]
                ]))
                .unwrap()] = p.get("feedback").cloned().unwrap_or(Value::Null)
            }
            "reconcile.prepared" => {
                value["reconcileTransaction"] = p.clone();
                remove(&mut value, "reconcileReplay")
            }
            "reconcile.replayed" => value["reconcileReplay"] = p.clone(),
            "reconcile.started" => {
                value["reconcileBases"][p["attempt"].stringify()] = p["baseSha"].clone()
            }
            "workspace.provisioned" => {
                value["latestWorkspace"] = e.clone();
                if value.get("firstWorkspace").is_none() {
                    value["firstWorkspace"] = e.clone()
                }
                value["workspaceGenerations"] = json!(number(&value["workspaceGenerations"]) + 1);
                if p.get("remote")
                    .and_then(Value::as_bool)
                    .unwrap_or(p["provider"] == "vercel-sandbox")
                {
                    value["remoteWorkspace"] = json!(true)
                } else {
                    value["localWorkspace"] = json!(true)
                }
                if first_base.is_none() {
                    first_base = Some(p["base"]["sha"].clone())
                }
                provision = None
            }
            "workspace.provision-started" => {
                let mut marker = p.clone();
                marker["ts"] = e["ts"].clone();
                marker["seq"] = e["seq"].clone();
                provision = Some(marker)
            }
            "workspace.released" => {
                value["latestRelease"] = e.clone();
                provision = None
            }
            "implement.completed" => settled = Some(p["commits"]["head"].clone()),
            "restack.rewritten" | "restack.completed" => {
                settled = Some(
                    p.get("observedHead")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&p["headSha"])
                        .clone(),
                )
            }
            "reconcile.rewritten" => {
                settled = Some(
                    p.get("observedHead")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&p["headSha"])
                        .clone(),
                )
            }
            "reconcile.completed" => settled = Some(head(p)),
            "finalize.step-completed" if p["ok"] == true && p.get("headSha").is_some() => {
                settled = Some(p["headSha"].clone())
            }
            "build.abort-requested" => value["latestAbort"] = e.clone(),
            "build.discard-requested" => value["latestDiscard"] = e.clone(),
            "plan.completed" => {
                value["maxPlanRevision"] =
                    json!(number(&value["maxPlanRevision"]).max(number(&p["artifact"]["rev"])))
            }
            "infrastructure.cleanup-attempted" => {
                let key = stringify(&p["workspaceRef"]).unwrap();
                let n = number(&value["cleanupCounts"][key.as_str()]) + 1;
                value["cleanupCounts"][key] = json!(n)
            }
            "pr-attachment.reclaim-failed" => {
                let key = p["hostedSeq"].stringify();
                let n = number(&value["reclaimCounts"][key.as_str()]) + 1;
                value["reclaimCounts"][key] = json!(n)
            }
            "escalation.raised" if p["policyCause"] == "infrastructure-failure-limit" => {
                value["infrastructureRaisedSeq"] = e["seq"].clone();
                infra_raises.push(p["id"].clone())
            }
            "build.created" => {
                if value.get("created").is_none() {
                    value["created"] = e.clone()
                }
                value["lastCreated"] = e.clone()
            }
            "dispatch.failed" => {
                value["dispatchFailureCount"] = json!(number(&value["dispatchFailureCount"]) + 1);
                if p["stage"] == "workspace" {
                    value["latestWorkspaceFailureSeq"] = e["seq"].clone()
                }
            }
            "dispatch.comment-posted" => value["commentPosted"] = json!(true),
            "spec.imported" | "spec.authored" => value["specRecorded"] = json!(true),
            "build.auto-merge-requested" => value["autoMergeEverRequested"] = json!(true),
            "build.completed" | "build.aborted" => value["terminalEvent"] = e.clone(),
            "observation.recorded" => {
                value["observations"]
                    .as_array_mut()
                    .unwrap()
                    .push(p.clone());
                value["observationFacts"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"payload":p,"seq":e["seq"],"ts":e["ts"]}))
            }
            "pr.merged" => value["mergeTimes"]
                .as_array_mut()
                .unwrap()
                .push(e["ts"].clone()),
            _ => {}
        }
        let reset = if t == "execution.ended"
            || (t == "escalation.answered"
                && p["resolution"] == "retry"
                && infra_raises.contains(&p["id"]))
        {
            seq(e)
        } else {
            infra_reset
        };
        if reset != infra_reset {
            value["infrastructureCount"] = json!(0);
            infra_reset = reset
        }
        if t == "infrastructure.failed" {
            value["infrastructureCount"] = json!(number(&value["infrastructureCount"]) + 1)
        }
        if t.starts_with("restack.") {
            value["restackHistory"]
                .as_array_mut()
                .unwrap()
                .push(e.clone())
        }
        if [
            "reconcile.started",
            "reconcile.completed",
            "reconcile.prepared",
            "reconcile.replayed",
            "reconcile.contended",
            "reconcile.publish-intended",
            "reconcile.rewritten",
            "workspace.provisioned",
            "phase.failed",
        ]
        .contains(&t)
        {
            value["reconcileHistory"]
                .as_array_mut()
                .unwrap()
                .push(e.clone())
        }
        let seen = value["seenTypes"].as_array_mut().unwrap();
        if !seen.contains(&e["type"]) {
            seen.push(e["type"].clone())
        }
        if t == "workspace.provisioned"
            || t == "implement.completed"
            || ["code-review.", "restack.", "reconcile.", "finalize.", "pr."]
                .iter()
                .any(|prefix| t.starts_with(prefix))
        {
            let mut tips = std::collections::BTreeSet::new();
            git_tips(p, "", &mut tips);
            let all = value["gitTips"].as_array_mut().unwrap();
            for tip in tips {
                let tip = json!(tip);
                if !all.contains(&tip) {
                    all.push(tip)
                }
            }
        }
    }
    optional(
        &mut value,
        "recoveryCheckpoint",
        settled.as_ref().or(first_base.as_ref()),
    );
    optional(&mut value, "provisionMarker", provision.as_ref());
    optional(
        &mut value,
        "imageHost",
        image_created.and_then(|e| e["payload"]["pr"].get("imageHost")),
    );
    let images: Vec<_> = value["designations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|designation| {
            hosted
                .get(&designation["seq"].stringify())
                .filter(|hosted| seq(hosted) > seq(designation))
                .map(|hosted| json!([designation["seq"], hosted]))
        })
        .collect();
    value["hostedImages"] = Value::Array(images);
    Ok(value)
}

static EMPTY: JsString = JsString(Vec::new());
fn string(v: &Value) -> &JsString {
    v.as_string().unwrap_or(&EMPTY)
}
fn control(v: &Value) -> String {
    v.as_string()
        .and_then(|s| s.to_scalar().ok())
        .unwrap_or_default()
}
fn stringify(v: &Value) -> Result<String, std::convert::Infallible> {
    Ok(v.stringify())
}
fn prefix(p: &str, s: &JsString) -> JsString {
    JsString::from_units(p.encode_utf16().chain(s.units().iter().copied()).collect())
}
