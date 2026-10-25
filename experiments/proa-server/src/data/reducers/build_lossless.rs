use super::lossless::{compatibility, copy, max, number, pick, push, remove, with_seq};
use crate::data::error::DataError;
use crate::js_json as json;
use crate::protocol::js_value::{JsJson as Value, JsString as S};

#[derive(Clone, Debug)]
pub struct BuildAcc {
    state: Value,
    attached: bool,
    paused: bool,
    terminal: Option<String>,
    pending: Value,
    ended: Value,
}
impl Default for BuildAcc {
    fn default() -> Self {
        Self {
            state: json!({"compatibility":compatibility(),"compatibilityDeferredBoundary":0,"round":0,"openEscalations":[],"answeredEscalations":[],"reviewRoundCeilings":{},"landing":{},"autoMerge":{"requested":false},"restartSince":0,"pinnedAssets":[],"finalizeCompletedSeq":0,"finalizeSteps":[],"plan":{"round":0,"approved":false},"implement":{"round":0},"codeReviewApproved":false,"reviewFindings":{"planReview":[],"codeReview":[]},"verify":{"maxAttemptSeen":0,"results":[],"cycleSince":0},"reconcileAttempts":0,"observations":[],"setupFailures":[],"dispatchFailures":[],"executions":[],"infrastructureFailures":[],"cleanupAttempts":[],"sessions":{"open":[],"suspended":[],"totals":{},"nativeHandles":{}},"failures":{}}),
            attached: false,
            paused: false,
            terminal: None,
            pending: json!({"pause":[],"resume":[],"abort":[]}),
            ended: json!({}),
        }
    }
}
impl BuildAcc {
    /// The named build-stream seed publishes the canonical carried accumulator,
    /// not the finished BuildState. Preserve the same omission and map shapes.
    pub fn carried(&self) -> Value {
        let mut out = self.state.clone();
        let sessions = out.remove_js(&S::from("sessions")).unwrap();
        out["openSessions"] = sessions["open"].clone();
        out["suspendedSessions"] = sessions["suspended"].clone();
        out["sessionTotals"] = sessions["totals"].clone();
        out["nativeHandles"] = sessions["nativeHandles"].clone();
        let findings = out.remove_js(&S::from("reviewFindings")).unwrap();
        out["planReviewFindings"] = findings["planReview"].clone();
        out["codeReviewFindings"] = findings["codeReview"].clone();
        out["endedExecutionInstances"] = self.ended.clone();
        if !out["drainingExecutions"].is_object() {
            out["drainingExecutions"] = json!({})
        }
        out["attached"] = json!(self.attached);
        out["pausedFlag"] = json!(self.paused);
        out["pending"] = self.pending.clone();
        if let Some(terminal) = &self.terminal {
            out["terminal"] = json!(terminal)
        }
        out
    }
    fn start(&mut self, phase: impl Into<S>, event: &Value, extra: &[&str]) {
        let phase = phase.into();
        let mut ctx = pick(&event["payload"], extra);
        ctx["phase"] = json!(phase);
        ctx["seq"] = event["seq"].clone();
        self.state["currentPhase"] = ctx;
    }
    fn complete(&mut self, phase: impl Into<S>, event: &Value, extra: &[&str]) {
        let phase = phase.into();
        let mut ctx = pick(&event["payload"], extra);
        ctx["phase"] = json!(phase);
        ctx["seq"] = event["seq"].clone();
        self.state["lastCompletedPhase"] = ctx;
        if self.state["currentPhase"]["phase"].as_string() == Some(&phase) {
            remove(&mut self.state, "currentPhase");
        }
    }
    pub fn fold(&mut self, e: &Value) -> Result<(), DataError> {
        let p = &e["payload"];
        let t = e["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap_or_default();
        self.drains(e);
        if self.state.get("pollingActivity").is_none() {
            self.state["pollingActivity"] = json!({});
        }
        if !(t == "node.poll-checked"
            || t == "observation.recorded"
            || ["session.", "runner.", "workspace.", "build.janitor-"]
                .iter()
                .any(|s| t.starts_with(s)))
        {
            self.state["pollingActivity"][t.as_str()] = json!(if [
                "node.compared",
                "node.parent-distance",
                "integration.observed",
                "target.moved",
                "node.inventory",
                "landing.decided",
                "node.parent-rejected"
            ]
            .contains(&t.as_str())
            {
                // Poll activity keys are canonical JSON, independently of the
                // insertion order retained for exact machine-write diagnostics.
                let mut canonical = p.clone();
                canonical.sort_all_objects();
                canonical.stringify()
            } else {
                number(&e["seq"]).to_string()
            });
        }
        self.landing(e);
        if t.starts_with("integration.") {
            self.integration(e);
        }
        if t.starts_with("node.") || (self.state["kind"] == "node" && t == "target.moved") {
            self.node(e)?;
        }
        match t.as_str() {
            "build.created" => {
                for k in ["kind", "target", "baseBranch"] {
                    copy(&mut self.state, p, k);
                }
                self.state["pinnedAssets"] = p.get("assets").cloned().unwrap_or(json!([]));
            }
            "node.parent-accepted" if self.state["kind"] == "node" => {
                if p["next"]["target"].is_null() {
                    remove(&mut self.state, "target");
                } else {
                    copy(&mut self.state, &p["next"], "target");
                }
                self.state["baseBranch"] = p["next"]["branch"].clone();
                remove(&mut self.state, "nodeComparison");
                if self.state.get("integration").is_some() {
                    remove(&mut self.state["integration"], "cycle");
                    remove(&mut self.state["integration"], "observation");
                }
            }
            "node.opening" => self.state["nodeOpening"] = p.clone(),
            "node.opened" => self.state["nodeOpened"] = p.clone(),
            "node.poll-checked" => {
                self.state["nodePolling"] = p.clone();
                self.state["nodePolling"]["checkedAt"] = e["ts"].clone();
            }
            "node.compared" => self.state["nodeComparison"] = p.clone(),
            "node.rewritten" => {
                if self.state.get("nodeComparison").is_some() {
                    self.state["nodeComparison"]["headSha"] = p["head"].clone();
                }
                if self.state.get("pr").is_some() {
                    self.state["pr"]["headSha"] = p["head"].clone();
                }
            }
            "pr.opened" | "finalize.completed" => {
                self.state["pr"] = p["pr"].clone();
                self.state["prState"] = json!("open");
                if t == "finalize.completed" {
                    self.state["finalizeCompletedSeq"] = e["seq"].clone();
                    self.complete("finalize", e, &[]);
                }
            }
            "build.completed" => {
                self.terminal = Some("done".into());
                copy(&mut self.state, p, "outcome");
            }
            "build.aborted" => {
                self.terminal = Some("aborted".into());
                self.pending["abort"] = json!([]);
            }
            "runner.attached" => {
                self.attached = true;
                remove(&mut self.state, "setupFailure");
            }
            "runner.setup-failed" => {
                let f = with_seq(p, e);
                push(&mut self.state, "setupFailures", f.clone());
                self.state["setupFailure"] = f;
            }
            "dispatch.failed" => push(&mut self.state, "dispatchFailures", with_seq(p, e)),
            "execution.started" => {
                push(&mut self.state, "executions", with_seq(p, e));
                remove(&mut self.state, "infrastructureFailure");
            }
            "execution.ended" => remove(&mut self.state, "infrastructureFailure"),
            "infrastructure.failed" => {
                let f = with_seq(p, e);
                push(&mut self.state, "infrastructureFailures", f.clone());
                self.state["infrastructureFailure"] = f;
            }
            "infrastructure.cleanup-attempted" => {
                push(&mut self.state, "cleanupAttempts", with_seq(p, e));
                if p["outcome"] != "unknown"
                    && self.state["infrastructureFailure"]["workspaceRef"] == p["workspaceRef"]
                {
                    remove(&mut self.state, "infrastructureFailure");
                }
            }
            "build.pause-requested" | "build.resume-requested" | "build.abort-requested" => {
                let command = t
                    .trim_start_matches("build.")
                    .trim_end_matches("-requested");
                if command == "pause" {
                    self.pending["resume"] = json!([]);
                }
                if command == "resume" {
                    self.pending["pause"] = json!([]);
                }
                let mut req = pick(p, &["reason"]);
                req["command"] = json!(command);
                req["seq"] = e["seq"].clone();
                req["actor"] = e["actor"].clone();
                push(&mut self.pending, command, req);
            }
            "build.discard-requested" => self.state["discardRequest"] = pick(e, &["seq", "actor"]),
            "build.paused" => {
                self.paused = true;
                self.pending["pause"] = json!([]);
            }
            "build.resumed" => {
                self.paused = false;
                self.pending["resume"] = json!([]);
            }
            "build.auto-merge-requested" | "build.auto-merge-cancelled" => {
                let a = &mut self.state["autoMerge"];
                a["requested"] = json!(t == "build.auto-merge-requested");
                a["commandSeq"] = e["seq"].clone();
                if p["integrationConsent"] == true && t == "build.auto-merge-requested" {
                    a["explicitCommandSeq"] = e["seq"].clone();
                }
                if let Some(v) = p.get("defaultSeq") {
                    a["defaultSeq"] = v.clone();
                }
            }
            "build.auto-merge-default-observed" => {
                max(&mut self.state["autoMerge"], "defaultSeq", &p["defaultSeq"])
            }
            "pr.auto-merge-enabled" | "pr.auto-merge-disabled" => {
                self.state["autoMerge"]["applied"] =
                    json!({"enabled":t=="pr.auto-merge-enabled","commandSeq":p["commandSeq"]})
            }
            "spec.imported" | "spec.authored" => {
                self.state["specRev"] = p["artifact"]["rev"].clone()
            }
            "spec.revised" => {
                self.state["specRev"] = p["artifact"]["rev"].clone();
                if let Some(v) = p.get("assets") {
                    self.state["pinnedAssets"] = v.clone();
                }
                self.state["restartSince"] = e["seq"].clone();
                max(&mut self.state["verify"], "cycleSince", &e["seq"]);
                self.state["reviewRoundCeilings"] = json!({});
            }
            "plan.started"
            | "plan-review.started"
            | "implement.started"
            | "code-review.started" => {
                let phase = t.trim_end_matches(".started");
                self.state["round"] = p["round"].clone();
                if phase == "plan" || phase == "implement" {
                    self.state[phase]["round"] = p["round"].clone();
                }
                self.start(phase, e, &["round"]);
            }
            "plan.completed" | "implement.completed" => {
                let phase = t.trim_end_matches(".completed");
                self.state["round"] = p["round"].clone();
                self.state[phase]["round"] = p["round"].clone();
                self.state[phase]["artifactRev"] = p["artifact"]["rev"].clone();
                if phase == "implement" {
                    copy(&mut self.state[phase], p, "commits");
                }
                self.complete(phase, e, &["round"]);
            }
            "plan-review.verdict" | "code-review.verdict" => {
                let phase = t.trim_end_matches(".verdict");
                self.state["round"] = p["round"].clone();
                let approved = p["verdict"] == "approve";
                let approval = pick(e, &["seq"]);
                let mut approval = approval;
                approval["round"] = p["round"].clone();
                if phase == "plan-review" {
                    self.state["plan"]["approved"] = json!(approved);
                    if approved {
                        self.state["plan"]["approval"] = approval;
                    } else {
                        remove(&mut self.state["plan"], "approval");
                    }
                } else {
                    self.state["codeReviewApproved"] = json!(approved);
                    if approved {
                        self.state["codeReviewApproval"] = approval;
                        max(&mut self.state["verify"], "cycleSince", &e["seq"]);
                    } else {
                        remove(&mut self.state, "codeReviewApproval");
                    }
                }
                let key = if phase == "plan-review" {
                    "planReview"
                } else {
                    "codeReview"
                };
                let findings = self.state["reviewFindings"][key].as_array_mut().unwrap();
                let r = number(&p["round"]) as usize;
                while findings.len() < r {
                    findings.push(json!([]));
                }
                if r > 0 {
                    findings[r - 1] = p["findings"].clone();
                }
                self.complete(phase, e, &["round"]);
            }
            "verify.started" => {
                max(&mut self.state["verify"], "maxAttemptSeen", &p["attempt"]);
                self.state["verify"]["currentStep"] = p["step"].clone();
                self.start(prefix("verify:", &p["step"]), e, &["attempt"]);
            }
            "verify.completed" => {
                let mut result = pick(
                    p,
                    &[
                        "baseSha",
                        "headSha",
                        "restackId",
                        "step",
                        "attempt",
                        "outcome",
                        "report",
                        "reason",
                        "skipCause",
                    ],
                );
                if p.get("outcome").is_none() {
                    result["outcome"] = json!(if p["pass"] == true { "pass" } else { "fail" });
                }
                result["seq"] = e["seq"].clone();
                max(&mut self.state["verify"], "maxAttemptSeen", &p["attempt"]);
                push(&mut self.state["verify"], "results", result);
                if self.state["verify"]["currentStep"] == p["step"] {
                    remove(&mut self.state["verify"], "currentStep");
                }
                self.complete(prefix("verify:", &p["step"]), e, &["attempt"]);
            }
            "finalize.started" => self.start("finalize", e, &[]),
            "finalize.step-completed" => push(
                &mut self.state,
                "finalizeSteps",
                with_seq(&pick(p, &["step", "ok"]), e),
            ),
            "pr.merged" => {
                self.state["mergedSha"] = p["sha"].clone();
                self.state["prState"] = json!("merged");
            }
            "pr.closed" => self.state["prState"] = json!("closed"),
            "pr.conflicted" => self.state["prState"] = json!("conflicted"),
            "reconcile.started" => {
                max(&mut self.state, "reconcileAttempts", &p["attempt"]);
                self.start("reconcile", e, &["attempt"]);
            }
            "restack.rewritten" | "restack.completed" | "reconcile.rewritten" => {
                if self.state["kind"] != "node" && self.state["implement"].get("commits").is_some()
                {
                    self.state["implement"]["commits"] =
                        json!({"base":p["targetBase"],"head":p["headSha"]});
                }
                if t == "restack.completed" && self.state["prState"] == "conflicted" {
                    self.state["prState"] = json!("open");
                }
                if self.state.get("pr").is_some() {
                    self.state["pr"]["headSha"] = if t == "restack.completed" {
                        p["headSha"].clone()
                    } else {
                        p.get("observedHead").unwrap_or(&p["headSha"]).clone()
                    };
                }
            }
            "reconcile.completed" => {
                if self.state["kind"] != "node"
                    && p.get("headSha").is_some()
                    && self.state.get("pr").is_some()
                {
                    self.state["pr"]["headSha"] = p["headSha"].clone();
                }
                let attempt = if self.state["currentPhase"]["phase"] == "reconcile" {
                    self.state["currentPhase"].get("attempt").cloned()
                } else {
                    None
                };
                if self.state["prState"] == "conflicted" {
                    self.state["prState"] = json!("open");
                }
                max(&mut self.state["verify"], "cycleSince", &e["seq"]);
                self.complete("reconcile", e, &[]);
                if let Some(v) = attempt {
                    self.state["lastCompletedPhase"]["attempt"] = v;
                }
            }
            "observation.recorded" => push(&mut self.state, "observations", p.clone()),
            "escalation.raised" | "phase.deferral-escalated" => {
                let mut open = with_seq(
                    &pick(
                        p,
                        &[
                            "id",
                            "phase",
                            "round",
                            "source",
                            "policyCause",
                            "question",
                            "refs",
                        ],
                    ),
                    e,
                );
                if t == "phase.deferral-escalated" {
                    open["source"] = json!("policy");
                    open["deferral"] = json!("own-build-read");
                }
                let a = self.state["openEscalations"].as_array_mut().unwrap();
                if let Some(held) = a.iter_mut().find(|o| o["id"] == p["id"]) {
                    *held = open;
                } else {
                    a.push(open);
                }
            }
            "escalation.answered" => {
                let a = self.state["openEscalations"].as_array_mut().unwrap();
                if let Some(index) = a.iter().position(|o| o["id"] == p["id"]) {
                    let mut open = a.remove(index);
                    if p.get("reviewRoundCeiling").is_some()
                        && open["source"] == "policy"
                        && open["policyCause"] == "review-round-limit"
                    {
                        let key = if open["phase"] == "plan-review" {
                            Some("plan")
                        } else if open["phase"] == "code-review" {
                            Some("code")
                        } else {
                            None
                        };
                        if let Some(k) = key {
                            self.state["reviewRoundCeilings"][k] = p["reviewRoundCeiling"].clone();
                        }
                    }
                    for k in [
                        "answer",
                        "resolution",
                        "artifact",
                        "assets",
                        "reviewRoundCeiling",
                    ] {
                        if let Some(v) = p.get(k) {
                            open[k] = v.clone();
                        }
                    }
                    open["answeredSeq"] = e["seq"].clone();
                    push(&mut self.state, "answeredEscalations", open);
                    if p["resolution"] == "abort" {
                        push(
                            &mut self.pending,
                            "abort",
                            json!({"command":"abort","seq":e["seq"],"reason":p["answer"],"actor":e["actor"]}),
                        );
                    }
                }
            }
            "phase.failed" => {
                let phase = p["phase"]
                    .as_string()
                    .cloned()
                    .unwrap_or_else(|| S::from(""));
                let n = number(&self.state["failures"][&phase]) + 1;
                self.state["failures"][&phase] = json!(n);
            }
            "build.janitor-attempt-failed" => {
                let attention = self.state["janitor"]["attention"] == true;
                self.state["janitor"] = p.clone();
                if attention {
                    self.state["janitor"]["attention"] = json!(true);
                }
            }
            "build.janitor-failing" => {
                if self.state.get("janitor").is_some() {
                    self.state["janitor"]["attention"] = json!(true);
                }
            }
            "build.janitor-recovered" => remove(&mut self.state, "janitor"),
            "build.compatibility-deferred" => {
                self.state["compatibilityDeferredBoundary"] = p["boundary"].clone()
            }
            kind if kind.starts_with("session.") => self.session(e),
            _ => {}
        }
        self.state["lastEvent"] = e.clone();
        Ok(())
    }
    pub fn finish(&self) -> Value {
        let mut s = self.state.clone();
        if !s["drainingExecutions"]
            .as_object()
            .is_some_and(|o| !o.is_empty())
        {
            remove(&mut s, "drainingExecutions");
        }
        let cycle = &s["integration"]["cycle"];
        let failed = number(&cycle["seq"]) > number(&s["restartSince"])
            && s["nodeComparison"]["headSha"] == cycle["head"]
            && s["nodeComparison"]["parentSha"] == cycle["parent"]
            && s["verify"]["results"].as_array().unwrap().iter().any(|r| {
                number(&r["seq"]) > number(&cycle["seq"])
                    && r["restackId"] == cycle["id"]
                    && r["outcome"] == "fail"
            });
        let status = self.terminal.as_deref().unwrap_or(if self.paused {
            "paused"
        } else if !s["openEscalations"].as_array().unwrap().is_empty() || failed {
            "blocked"
        } else if s["kind"] == "node" && s.get("nodeOpened").is_some() {
            "collecting"
        } else if self.attached {
            "running"
        } else {
            "queued"
        });
        s["status"] = json!(status);
        let active = s
            .get("currentPhase")
            .or_else(|| s.get("lastCompletedPhase"))
            .cloned();
        if let Some(a) = active {
            s["phase"] = a["phase"].clone();
        }
        s["lastSeq"] =
            json!(number(&s["lastEvent"]["seq"]).max(number(&s["compatibility"]["lastSeq"])));
        let mut pending = vec![];
        for key in ["pause", "resume", "abort"] {
            pending.extend(self.pending[key].as_array().unwrap().iter().cloned());
        }
        pending.sort_by_key(|r| number(&r["seq"]));
        s["pendingCommands"] = json!(pending);
        if self.terminal.is_some() {
            remove(&mut s, "discardRequest");
        }
        s
    }
    fn session(&mut self, e: &Value) {
        let p = &e["payload"];
        let t = e["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap_or_default();
        let id = p["session"]
            .as_string()
            .cloned()
            .unwrap_or_else(|| S::from(""));
        match t.as_str() {
            "session.started" => {
                let root = p["continuation"]["root"]
                    .as_string()
                    .cloned()
                    .unwrap_or_else(|| id.clone());
                let totals = &mut self.state["sessions"]["totals"];
                if totals.get_js(&root).is_none() {
                    totals[&root] = json!({"activeMs":0,"transcripts":[]});
                }
                totals[&root]["activeMs"] = js_number(
                    totals[&root]["activeMs"]
                        .as_f64()
                        .unwrap_or(0.0)
                        .max(p["continuation"]["activeMs"].as_f64().unwrap_or(0.0)),
                );
                if let Some(c) = p.get("continuation") {
                    self.state["sessions"]["nativeHandles"][&id] = c["handle"].clone();
                    for key in ["open", "suspended"] {
                        self.state["sessions"][key]
                            .as_array_mut()
                            .unwrap()
                            .retain(|s| s["session"] != c["predecessor"]);
                    }
                }
                let mut open = pick(
                    p,
                    &[
                        "continuation",
                        "budgetMs",
                        "args",
                        "session",
                        "role",
                        "runner",
                        "model",
                        "phase",
                        "round",
                        "stream",
                    ],
                );
                open["startedAt"] = e["ts"].clone();
                open["seq"] = e["seq"].clone();
                if let Some(h) = p["continuation"].get("handle") {
                    open["nativeHandle"] = h.clone();
                }
                let entries = self.state["sessions"]["open"].as_array_mut().unwrap();
                if let Some(existing) = entries.iter_mut().find(|s| s["session"] == p["session"]) {
                    *existing = open;
                } else {
                    entries.push(open);
                }
            }
            "session.native-handle-recorded" => {
                if let Some(open) = self.state["sessions"]["open"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|s| {
                        s["session"] == p["session"]
                            && s["phase"] == p["phase"]
                            && s.get("round") == p.get("round")
                            && s.get("nativeHandle").is_none()
                    })
                {
                    open["nativeHandle"] = p["handle"].clone();
                    self.state["sessions"]["nativeHandles"][&id] = p["handle"].clone();
                }
            }
            "session.suspended" => {
                let open = self.state["sessions"]["open"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["session"] == p["session"])
                    .cloned();
                if let Some(mut open) = open {
                    if open["phase"] == p["phase"]
                        && open.get("round") == p.get("round")
                        && !(self.state["lastCompletedPhase"]["phase"] == open["phase"]
                            && number(&self.state["lastCompletedPhase"]["seq"])
                                > number(&open["seq"]))
                    {
                        let root = open["continuation"]["root"]
                            .as_string()
                            .cloned()
                            .unwrap_or_else(|| id.clone());
                        let totals = &mut self.state["sessions"]["totals"][&root];
                        totals["activeMs"] = js_number(
                            totals["activeMs"].as_f64().unwrap_or(0.0)
                                + p["activeMs"].as_f64().unwrap_or(0.0),
                        );
                        push(totals, "transcripts", p["transcript"].clone());
                        if let Some(usage) = p.get("usage") {
                            if totals.get("usage").is_none() {
                                totals["usage"] =
                                    json!({"inputTokens":0,"outputTokens":0,"turns":0});
                            }
                            for k in ["inputTokens", "outputTokens", "turns"] {
                                totals["usage"][k] =
                                    json!(number(&totals["usage"][k]) + number(&usage[k]));
                            }
                        }
                        if let Some(handle) = p.get("handle") {
                            open["nativeHandle"] = handle.clone();
                        }
                        open["suspensionCause"] = p["cause"].clone();
                        open["suspendedActiveMs"] = p["activeMs"].clone();
                        let a = self.state["sessions"]["suspended"].as_array_mut().unwrap();
                        if let Some(held) = a.iter_mut().find(|s| s["session"] == p["session"]) {
                            *held = open;
                        } else {
                            a.push(open);
                        }
                        self.state["sessions"]["open"]
                            .as_array_mut()
                            .unwrap()
                            .retain(|s| s["session"] != p["session"]);
                    }
                }
            }
            "session.resume-fallback" if p["stale"] != true => {
                self.state["sessions"]["suspended"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|s| s["session"] != p["session"]);
                if let Some(open) = self.state["sessions"]["open"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|s| s["session"] == p["session"])
                {
                    remove(open, "nativeHandle");
                    remove(open, "resumed");
                    open["nativeResumeFallback"] = json!(true);
                }
            }
            "session.resumed" if p["stale"] != true => {
                if let Some(open) = self.state["sessions"]["open"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|s| s["session"] == p["session"])
                {
                    if open["nativeResumeFallback"] != true
                        && open.get("continuation").is_some()
                        && open["continuation"]["predecessor"] == p["predecessor"]
                        && open["continuation"]["root"] == p["root"]
                        && open["nativeHandle"] == p["handle"]
                    {
                        open["resumed"] = json!(true);
                    }
                }
            }
            "session.ended" => {
                let open = self.state["sessions"]["open"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["session"] == p["session"])
                    .cloned();
                if let Some(open) = open {
                    if p.get("transcript").is_some() {
                        let root = open["continuation"]["root"]
                            .as_string()
                            .cloned()
                            .unwrap_or_else(|| id.clone());
                        let totals = &mut self.state["sessions"]["totals"][&root];
                        let elapsed = || {
                            let end = chrono::DateTime::parse_from_rfc3339(
                                &e["ts"]
                                    .as_string()
                                    .and_then(|s| s.to_scalar().ok())
                                    .unwrap_or_default(),
                            );
                            let start = chrono::DateTime::parse_from_rfc3339(
                                &open["startedAt"]
                                    .as_string()
                                    .and_then(|s| s.to_scalar().ok())
                                    .unwrap_or_default(),
                            );
                            match (end, start) {
                                (Ok(a), Ok(b)) => (a - b).num_milliseconds().max(0),
                                _ => 0,
                            }
                        };
                        totals["activeMs"] = js_number(
                            totals["activeMs"].as_f64().unwrap_or(0.0)
                                + p.get("activeMs")
                                    .and_then(Value::as_f64)
                                    .unwrap_or_else(|| elapsed() as f64),
                        );
                        push(totals, "transcripts", p["transcript"].clone());
                        if totals.get("usage").is_none() {
                            totals["usage"] = json!({"inputTokens":0,"outputTokens":0,"turns":0});
                        }
                        for k in ["inputTokens", "outputTokens", "turns"] {
                            totals["usage"][k] =
                                json!(number(&totals["usage"][k]) + number(&p["usage"][k]));
                        }
                    }
                }
                for k in ["open", "suspended"] {
                    self.state["sessions"][k]
                        .as_array_mut()
                        .unwrap()
                        .retain(|s| s["session"] != p["session"]);
                }
            }
            _ => {}
        }
    }
    fn drains(&mut self, e: &Value) {
        let p = &e["payload"];
        let t = e["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap_or_default();
        let id = p["instance"]
            .as_string()
            .cloned()
            .unwrap_or_else(|| S::from(""));
        match t.as_str() {
            "execution.drain-authorized" => {
                if self.state.get("drainingExecutions").is_none() {
                    self.state["drainingExecutions"] = json!({});
                }
                let entries = &mut self.state["drainingExecutions"];
                let held = entries.get_js(&id).cloned();
                if held.as_ref().is_some_and(|h| {
                    h["correlation"] == p["correlation"]
                        || h["correlations"]
                            .as_array()
                            .is_some_and(|a| a.contains(&p["correlation"]))
                }) {
                    return;
                }
                let mut next = held.clone().unwrap_or(json!({}));
                let mut correlations = next["correlations"].as_array().cloned().unwrap_or_default();
                if let Some(h) = held {
                    correlations.push(h["correlation"].clone());
                }
                next["correlations"] = json!(correlations);
                next["correlation"] = p["correlation"].clone();
                if self.ended[&id] == true {
                    next["ended"] = json!(true);
                } else {
                    next["authorization"] = p.clone();
                }
                entries[&id] = next;
            }
            "execution.relaunch-requested" => {
                if self.state["drainingExecutions"][&id]["authorization"]["correlation"]
                    == p["correlation"]
                    && self.state["drainingExecutions"][&id]["ended"] != true
                {
                    self.state["drainingExecutions"][&id]["relaunch"] = p.clone();
                }
            }
            "session.suspended" if p["cause"] == "shutdown" => {
                if let Some(entries) = self.state["drainingExecutions"].as_object_mut() {
                    for (_, entry) in entries.iter_mut() {
                        if entry.get("authorization").is_some() && entry["ended"] != true {
                            entry["suspended"] = json!(true);
                        }
                    }
                }
            }
            "execution.ended" => {
                self.ended[&id] = json!(true);
                if self.state["drainingExecutions"].get_js(&id).is_some() {
                    let entry = &mut self.state["drainingExecutions"][&id];
                    entry["ended"] = json!(true);
                    remove(entry, "authorization");
                }
            }
            "execution.drain-settled"
                if self.state["drainingExecutions"][&id]["correlation"] == p["correlation"] =>
            {
                remove(&mut self.state["drainingExecutions"][&id], "authorization");
            }
            _ => {}
        }
    }
    fn landing(&mut self, e: &Value) {
        let p = &e["payload"];
        let t = e["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap_or_default();
        let s = &mut self.state["landing"];
        match t.as_str() {
            "node.parent-accepted" => {
                if s["command"]["kind"] == "land" {
                    remove(s, "command");
                    remove(s, "acknowledgedSeq");
                }
                remove(s, "decision");
                remove(s, "native");
            }
            "landing.decided" => {
                remove(s, "applicationFailure");
                s["decision"] = with_seq(p, e);
            }
            "build.hold-requested" => {
                remove(s, "applicationFailure");
                s["command"] = json!({"kind":"hold","seq":e["seq"]});
            }
            "build.land-requested" => {
                s["command"] = json!({"kind":"land","seq":e["seq"],"decisionSeq":p["decisionSeq"]})
            }
            "landing.command-acknowledged" => {
                if p["commandSeq"] == s["command"]["seq"] {
                    s["acknowledgedSeq"] = p["commandSeq"].clone();
                }
            }
            "pr.auto-merge-enabled" | "pr.auto-merge-disabled" => {
                s["native"] = json!({"enabled":t=="pr.auto-merge-enabled","seq":e["seq"]});
                if t == "pr.auto-merge-disabled" && p["commandSeq"] == s["command"]["seq"] {
                    s["acknowledgedSeq"] = p["commandSeq"].clone();
                }
            }
            "landing.native-enable-started" => s["nativeEnablePending"] = e["seq"].clone(),
            "landing.forge-merged" => s["forgeMerge"] = p.clone(),
            "landing.application-failed" => s["applicationFailure"] = p.clone(),
            "landing.native-applied" => {
                remove(s, "applicationFailure");
                if p.get("enableSeq") == s.get("nativeEnablePending") {
                    remove(s, "nativeEnablePending");
                }
                s["native"] = with_seq(p, e);
            }
            "build.auto-merge-requested" | "build.auto-merge-cancelled" => {
                if p.get("defaultSeq").is_some()
                    || s.get("command").is_some_and(|c| c["legacy"] != true)
                {
                    return;
                }
                s["command"] = json!({"kind":if t=="build.auto-merge-requested"{"land"}else{"hold"},"seq":e["seq"],"legacy":true});
                if t == "build.auto-merge-requested" {
                    s["acknowledgedSeq"] = e["seq"].clone();
                }
            }
            _ => {}
        }
    }
    fn integration(&mut self, e: &Value) {
        if self.state.get("integration").is_none() {
            self.state["integration"] = json!({});
        }
        let s = &mut self.state["integration"];
        let p = &e["payload"];
        match e["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap_or_default()
            .as_str()
        {
            "integration.verification-failed" => push(s, "failures", with_seq(p, e)),
            "integration.prepared" => {
                s["cycle"] = with_seq(p, e);
                push(s, "cycles", with_seq(p, e));
            }
            "integration.observed" => s["observation"] = p.clone(),
            "integration.landing-intended" => s["intent"] = p.clone(),
            "integration.landed" => s["landing"] = p.clone(),
            "integration.audited" => s["audit"] = p.clone(),
            "integration.abandoned" if s["intent"]["id"] == p["id"] => {
                remove(s, "intent");
            }
            _ => {}
        }
    }
    fn node(&mut self, e: &Value) -> Result<(), DataError> {
        if self.state.get("nodeRestack").is_none() {
            self.state["nodeRestack"] = json!({"items":[]});
        }
        let s = &mut self.state["nodeRestack"];
        let p = &e["payload"];
        let t = e["type"]
            .as_string()
            .and_then(|s| s.to_scalar().ok())
            .unwrap_or_default();
        let id = p["id"].as_string().cloned().unwrap_or_else(|| S::from(""));
        let bad = || DataError::Decode {
            scope: "build",
            event_type: t.to_string(),
            seq: number(&e["seq"]),
        };
        match t.as_str() {
            "node.restack-requested" => {
                if s.get("requests").is_none() {
                    s["requests"] = json!({});
                }
                if !id.eq_str("__proto__") {
                    s["requests"][&id] = p.clone();
                }
            }
            "node.restack-satisfied" => {
                if s.get("requests").is_some() {
                    s["requests"].remove_js(&id);
                }
            }
            "node.parent-distance" => s["distance"] = p.clone(),
            "node.parent-requested" => s["parentRequest"] = p.clone(),
            "node.parent-accepted" => {
                s["parentChange"] = p.clone();
                for k in [
                    "parentRequest",
                    "parentReplay",
                    "parentPr",
                    "parentRejection",
                    "distance",
                    "observedParent",
                ] {
                    remove(s, k);
                }
            }
            "node.parent-cancelled" => {
                if s["parentRequest"]["id"] == p["id"] {
                    remove(s, "parentRequest");
                }
            }
            "node.parent-rejection-cleared" => remove(s, "parentRejection"),
            "node.parent-rejected" => s["parentRejection"] = p.clone(),
            "node.parent-pr-retargeted" => s["parentPr"] = p["id"].clone(),
            "node.parent-completed" => {
                if s["parentChange"]["id"] == p["id"] {
                    remove(s, "parentChange");
                }
            }
            "target.moved" => {
                if s.get("contributionBase").is_some() {
                    s["observedParent"] = p.clone();
                }
            }
            "node.opened" => {
                if s.get("contributionBase").is_none() {
                    s["contributionBase"] = p["sha"].clone();
                }
                if s.get("contributionBoundaries").is_none() {
                    s["contributionBoundaries"] = json!({});
                }
                if p["sha"] != "__proto__" {
                    s["contributionBoundaries"]
                        [p["sha"].as_string().cloned().unwrap_or_else(|| S::from(""))] =
                        p["sha"].clone();
                }
            }
            "node.writer-reserved" => {
                if s.get("active").is_some() {
                    return Err(bad());
                }
                s["reservedSeq"] = e["seq"].clone();
                s["active"] = p.clone();
                if s.get("contributionBoundaries").is_none() {
                    s["contributionBoundaries"] = json!({});
                }
                if p["expected"] != "__proto__" {
                    s["contributionBoundaries"][p["expected"]
                        .as_string()
                        .cloned()
                        .unwrap_or_else(|| S::from(""))] = p["oldBase"].clone();
                }
                s["items"] = json!([]);
            }
            "node.item-prepared" => {
                let items = s["items"].as_array().unwrap();
                let base = items
                    .last()
                    .map(|i| &i["head"])
                    .unwrap_or(&s["active"]["parent"]);
                if p["id"] != s["active"]["id"]
                    || number(&p["index"]) as usize != items.len()
                    || number(&p["index"]) as usize
                        >= s["active"]["changes"].as_array().map(Vec::len).unwrap_or(0)
                    || p["base"] != *base
                {
                    return Err(bad());
                }
                s["prepared"] = p.clone();
            }
            "node.item-conflicted" => {
                if p["id"] != s["prepared"]["id"]
                    || p["index"] != s["prepared"]["index"]
                    || p["base"] != s["prepared"]["base"]
                {
                    return Err(bad());
                }
                s["conflict"] = p.clone();
            }
            "node.item-replayed" => {
                if p["id"] != s["active"]["id"]
                    || (number(&p["index"]) as usize) < s["items"].as_array().unwrap().len()
                {
                    return Ok(());
                }
                if p["id"] != s["prepared"]["id"]
                    || p["index"] != s["prepared"]["index"]
                    || p["base"] != s["prepared"]["base"]
                    || (p["dropped"] == true && p["head"] != p["base"])
                {
                    return Err(bad());
                }
                push(s, "items", p.clone());
                remove(s, "prepared");
                remove(s, "conflict");
            }
            "node.publish-intended" => {
                let items = s["items"].as_array().unwrap();
                if p["id"] != s["active"]["id"]
                    || s.get("prepared").is_some()
                    || items.len() != s["active"]["changes"].as_array().map(Vec::len).unwrap_or(0)
                    || p["head"]
                        != *items
                            .last()
                            .map(|i| &i["head"])
                            .unwrap_or(&s["active"]["parent"])
                {
                    return Err(bad());
                }
                s["intent"] = p.clone();
            }
            "node.rewritten" => {
                if p["id"] != s["intent"]["id"]
                    || p["head"] != s["intent"]["head"]
                    || p["previous"] != s["active"]["expected"]
                {
                    return Err(bad());
                }
                if s.get("contributionBoundaries").is_none() {
                    s["contributionBoundaries"] = json!({});
                }
                let base = if s["active"]["operation"] == "restack" {
                    s["active"]["parent"].clone()
                } else {
                    s.get("contributionBase")
                        .unwrap_or(&s["active"]["oldBase"])
                        .clone()
                };
                if p["head"] != "__proto__" {
                    s["contributionBoundaries"][p["head"]
                        .as_string()
                        .cloned()
                        .unwrap_or_else(|| S::from(""))] = base;
                }
                if s["active"]["operation"] == "restack" {
                    if s.get("foreignAliases").is_none() {
                        s["foreignAliases"] = json!({});
                    }
                    let mut dropped = s["droppedIdentities"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let items = s["items"].as_array().unwrap().clone();
                    for item in items {
                        let change =
                            s["active"]["changes"][number(&item["index"]) as usize].clone();
                        if change.is_null() {
                            continue;
                        }
                        let sha = change["sha"]
                            .as_string()
                            .cloned()
                            .unwrap_or_else(|| S::from(""));
                        let alias =
                            s["foreignAliases"]
                                .get_js(&sha)
                                .cloned()
                                .unwrap_or_else(|| {
                                    match sha.to_scalar().as_deref().unwrap_or("") {
                                        "__proto__" => json!({}),
                                        "constructor" => {
                                            json!("function Object() { [native code] }")
                                        }
                                        "toString"
                                        | "toLocaleString"
                                        | "valueOf"
                                        | "hasOwnProperty"
                                        | "isPrototypeOf"
                                        | "propertyIsEnumerable"
                                        | "__defineGetter__"
                                        | "__defineSetter__"
                                        | "__lookupGetter__"
                                        | "__lookupSetter__" => {
                                            json!(format!(
                                                "function {}() {{ [native code] }}",
                                                sha.to_scalar().unwrap()
                                            ))
                                        }
                                        _ => change["sha"].clone(),
                                    }
                                });
                        if item["dropped"] == true {
                            let identity = if let Some(b) = change.get("build") {
                                prefix("build:", b)
                            } else {
                                prefix(
                                    "foreign:",
                                    &if alias.is_string() {
                                        alias.clone()
                                    } else {
                                        json!("[object Object]")
                                    },
                                )
                            };
                            let identity = json!(identity);
                            if !dropped.contains(&identity) {
                                dropped.push(identity);
                            }
                        } else if change.get("build").is_none() && item["head"] != "__proto__" {
                            s["foreignAliases"][item["head"]
                                .as_string()
                                .cloned()
                                .unwrap_or_else(|| S::from(""))] = alias;
                        }
                    }
                    dropped.sort_by_cached_key(|value| {
                        value
                            .as_string()
                            .map(|s| s.units().to_vec())
                            .unwrap_or_default()
                    });
                    s["droppedIdentities"] = json!(dropped);
                }
                s["rewritten"] = p.clone();
            }
            "node.writer-settled" => {
                if p["id"] != s["active"]["id"] {
                    return Err(bad());
                }
                if p["outcome"] == "completed" {
                    if s.get("rewritten").is_none() {
                        return Err(bad());
                    }
                    if s["active"]["operation"] == "restack" {
                        if let Some(parent) = s.get("parentChange") {
                            s["parentReplay"] = parent["id"].clone();
                        }
                        for id in s["active"]["requests"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                        {
                            if s.get("requests").is_some() {
                                s["requests"].remove_js(
                                    &id.as_string().cloned().unwrap_or_else(|| S::from("")),
                                );
                            }
                        }
                        s["contributionBase"] = s["active"]["parent"].clone();
                        remove(s, "distance");
                    }
                }
                for k in ["active", "prepared", "conflict", "intent", "rewritten"] {
                    remove(s, k);
                }
                s["items"] = json!([]);
            }
            "node.contribution-recorded" => s["contribution"] = p.clone(),
            "node.inventory" => {
                if s.get("contributionBase").is_some() {
                    let base = p.get("base").cloned().unwrap_or_else(|| {
                        if s["active"]["operation"] == "restack"
                            && s["rewritten"]["head"] == p["head"]
                        {
                            s["active"]["parent"].clone()
                        } else {
                            s["contributionBase"].clone()
                        }
                    });
                    if s.get("contributionBoundaries").is_none() {
                        s["contributionBoundaries"] = json!({});
                    }
                    if p["head"] != "__proto__" {
                        s["contributionBoundaries"][p["head"]
                            .as_string()
                            .cloned()
                            .unwrap_or_else(|| S::from(""))] = base;
                    }
                }
                s["inventory"] = p.clone();
            }
            _ => {}
        }
        Ok(())
    }
}

fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= i64::MAX as f64 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn prefix(prefix: &str, v: &Value) -> S {
    S::from_units(
        prefix
            .encode_utf16()
            .chain(v.as_string().map(S::units).unwrap_or(&[]).iter().copied())
            .collect(),
    )
}
