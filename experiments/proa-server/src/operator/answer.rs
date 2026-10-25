//! Answer policy shared by the bearer API and progressive browser forms.
use super::{
    control::{active, array, error, pending, write, ControlService},
    error::OperatorError,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
pub const BARE_RETRY_ANSWER: &str = "Operator requested a bare retry with no feedback";
pub const DISMISSAL_ANSWER: &str = "Operator dismissed the cited findings with no feedback";
pub fn terminal_signal(state: &Value) -> Option<Value> {
    if matches!(state["status"].as_str(), Some("done" | "aborted")) {
        let mut signal = json!({"kind":"terminal-status","status":state["status"]});
        if let Some(outcome) = state.get("outcome") {
            signal["outcome"] = outcome.clone();
        }
        Some(signal)
    } else if pending(state, "abort") {
        Some(json!({"kind":"abort-requested"}))
    } else if matches!(state["prState"].as_str(), Some("merged" | "closed")) {
        Some(json!({"kind":"pr-ended","state":state["prState"]}))
    } else {
        None
    }
}
fn abort_pending(slug: &str) -> OperatorError {
    error("abort-pending",format!("build \"{slug}\" is aborting; nothing was recorded. Abort is not revocable — after cleanup returns the ticket to Triage, dispatch it as a fresh build"))
}
fn reject_cancelled(state: &Value, captured: Option<&[Value]>) -> Result<(), OperatorError> {
    if array(&state["verifyStage"]["superseded"])
        .iter()
        .any(|item| {
            captured.map_or_else(
                || array(&state["openEscalations"]).is_empty(),
                |ids| ids.contains(&item["escalation"]["id"]),
            )
        })
    {
        return Err(error(
            "no-open-escalations",
            "Cannot answer a stale escalation: its verifier occurrence was cancelled by fail-fast",
        ));
    }
    Ok(())
}
fn selected(state: &Value, request: &Value) -> Vec<Value> {
    let captured = request.get("escalationIds").and_then(Value::as_array);
    array(&state["openEscalations"])
        .iter()
        .filter(|item| captured.is_none_or(|ids| ids.contains(&item["id"])))
        .cloned()
        .collect()
}
fn no_open(slug: &str, captured: bool) -> OperatorError {
    error(
        "no-open-escalations",
        if captured {
            format!("build \"{slug}\" is no longer blocked by the captured escalation(s)")
        } else {
            format!("build \"{slug}\" has no open escalations to answer")
        },
    )
}
fn partition(state: &Value, open: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let known: HashSet<&str> = ["planReview", "codeReview"]
        .into_iter()
        .flat_map(|key| array(&state["reviewFindings"][key]))
        .flat_map(array)
        .filter_map(|finding| finding["id"].as_str())
        .collect();
    open.iter().cloned().partition(|item| {
        array(&item["refs"])
            .iter()
            .any(|reference| reference.as_str().is_some_and(|r| known.contains(r)))
    })
}
fn no_findings(slug: &str, open: &[Value]) -> OperatorError {
    // proa-perf-ok(scope): This formats API refusal text, not HTML; browser rendering escapes it.
    let mut refs = Vec::new();
    for value in open.iter().flat_map(|v| array(&v["refs"])) {
        if let Some(value) = value.as_str() {
            if !refs.contains(&value) {
                refs.push(value);
            }
        }
    }
    let detail = if refs.is_empty() {
        "the selected escalation(s) cite no references".to_owned()
    } else {
        format!(
            "their references are not review finding ids: {}",
            refs.join(", ")
        )
    };
    error("no-cited-findings",format!("cannot dismiss findings for build \"{slug}\": {detail}. Use ab answer {slug} {} for guidance, or ab answer {slug} for a bare retry.", "<text>"))
}
pub fn validate_answer_options(
    slug: &str,
    state: &Value,
    request: &Value,
) -> Result<Option<Value>, OperatorError> {
    let ceiling = request.get("ceiling");
    if let Some(ceiling) = ceiling {
        if ceiling.as_u64().is_none_or(|n| n == 0) {
            return Err(error(
                "review-round-ceiling-unavailable",
                "review round ceiling must be a positive integer; nothing was recorded",
            ));
        }
        if request["resolution"] == "revise-spec" {
            return Err(error("incompatible-answer-options","cannot combine a review round ceiling with a spec revision: revision resets the loop round budget on its own; nothing was recorded"));
        }
        if request["resolution"] == "dismiss" {
            return Err(error("incompatible-answer-options","cannot combine a review round ceiling with --dismiss; use guidance or a bare retry to answer the review-round-limit escalation; nothing was recorded"));
        }
        let eligible: Vec<Value> = selected(state, request)
            .into_iter()
            .filter(|item| {
                item["source"] == "policy"
                    && item["policyCause"] == "review-round-limit"
                    && matches!(item["phase"].as_str(), Some("plan-review" | "code-review"))
            })
            .collect();
        if eligible.len() != 1 {
            return Err(error("review-round-ceiling-unavailable",format!("cannot set a review round ceiling for build \"{slug}\": exactly one open review-round-limit escalation is required; nothing was recorded")));
        }
        return Ok(Some(eligible[0].clone()));
    }
    Ok(None)
}
impl ControlService<'_> {
    pub async fn answer(
        &self,
        repo: &str,
        slug: &str,
        actor: &Value,
        request: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        let state = self.state(repo, slug).await?;
        active(slug, &state)?;
        let captured = request.get("escalationIds").and_then(Value::as_array);
        if captured.is_some() || state["kind"] != "node" || request["resolution"] != "revise-spec" {
            reject_cancelled(&state, captured.map(Vec::as_slice))?;
        }
        let ceiling_escalation = validate_answer_options(slug, &state, request)?;
        if request["resolution"] == "revise-spec" {
            return self
                .revise_spec(repo, slug, actor, request, &state, now)
                .await;
        }
        let guidance = request["text"]
            .as_str()
            .unwrap_or_default()
            .trim_matches(super::auth::js_space);
        let mut open = selected(&state, request);
        if request["resolution"] == "dismiss" && pending(&state, "abort") {
            return Err(abort_pending(slug));
        }
        if open.is_empty() {
            return Err(no_open(slug, request.get("escalationIds").is_some()));
        }
        let mut remaining = None;
        let mut also_paused = state["status"] == "paused";
        let dismiss = request["resolution"] == "dismiss";
        if dismiss {
            if partition(&state, &open).0.is_empty() {
                return Err(no_findings(slug, &open));
            }
            let fresh = self.state(repo, slug).await?;
            if !matches!(
                fresh["status"].as_str(),
                Some("running" | "collecting" | "paused" | "blocked")
            ) {
                let outcome = fresh["outcome"]
                    .as_str()
                    .map(|v| format!(" ({v})"))
                    .unwrap_or_default();
                return Err(error("no-longer-active",format!("build \"{slug}\" became {}{outcome} while the answer was being prepared; nothing was appended. Any deposited replacement revision is inert because no spec event cites it.",fresh["status"].as_str().unwrap_or_default())));
            }
            if pending(&fresh, "abort") {
                return Err(abort_pending(slug));
            }
            open = selected(&fresh, request);
            if open.is_empty() {
                return Err(no_open(slug, false));
            }
            let (eligible, ineligible) = partition(&fresh, &open);
            if eligible.is_empty() {
                return Err(no_findings(slug, &open));
            }
            open = eligible;
            also_paused = fresh["status"] == "paused" && ineligible.is_empty();
            remaining = Some(ineligible.len());
        }
        let resolution = if dismiss {
            "dismiss-finding"
        } else if guidance.is_empty() {
            "retry"
        } else {
            "guidance"
        };
        let answer = if guidance.is_empty() {
            if dismiss {
                DISMISSAL_ANSWER
            } else {
                BARE_RETRY_ANSWER
            }
        } else {
            guidance
        };
        let mut answered_count = 0;
        for escalation in &open {
            let mut payload =
                json!({"id":escalation["id"],"answer":answer,"resolution":resolution});
            if ceiling_escalation
                .as_ref()
                .is_some_and(|e| e["id"] == escalation["id"])
            {
                payload["reviewRoundCeiling"] = request["ceiling"].clone();
            }
            if dismiss {
                self.append(repo, slug, actor, "escalation.answered", payload, now)
                    .await?;
                answered_count += 1;
            } else {
                loop {
                    let fresh = self.state(repo, slug).await?;
                    reject_cancelled(&fresh, Some(std::slice::from_ref(&escalation["id"])))?;
                    if !array(&fresh["openEscalations"])
                        .iter()
                        .any(|item| item["id"] == escalation["id"])
                    {
                        break;
                    }
                    if self
                        .writer
                        .append_build_if_current(
                            repo,
                            slug,
                            fresh["lastSeq"].as_i64().unwrap_or(0),
                            &write(actor, "escalation.answered", payload.clone()),
                            now,
                        )
                        .await
                        .map_err(|_| OperatorError::internal())?
                        .is_some()
                    {
                        answered_count += 1;
                        break;
                    }
                }
            }
        }
        if also_paused {
            self.append(repo, slug, actor, "build.resume-requested", json!({}), now)
                .await?;
        }
        let mut result = json!({"kind":"answered","slug":slug,"count":answered_count,"resolution":resolution,"resumed":also_paused});
        if let Some(remaining) = remaining {
            result["remainingOpen"] = json!(remaining);
            if let Some(signal) = terminal_signal(&self.state(repo, slug).await?) {
                result["terminalSignal"] = signal;
            }
        }
        if let Some(escalation) = ceiling_escalation {
            result["reviewRoundCeiling"] = json!({"loop":if escalation["phase"]=="plan-review"{"plan"}else{"code"},"value":request["ceiling"]});
        }
        Ok(result)
    }
}

#[derive(Debug)]
enum RevisionDecision {
    Fresh {
        open: Vec<Value>,
        escalation_seq: i64,
    },
    Complete {
        artifact: Value,
        assets: Option<Value>,
        open: Vec<Value>,
        escalation_seq: i64,
    },
}
fn decide_revision(
    slug: &str,
    state: &Value,
    request: &Value,
) -> Result<RevisionDecision, OperatorError> {
    let open = selected(state, request);
    let pending_answers: Vec<&Value> = array(&state["answeredEscalations"])
        .iter()
        .filter(|item| {
            item["resolution"] == "revise-spec"
                && item["answeredSeq"].as_i64().unwrap_or(0)
                    > state["restartSince"].as_i64().unwrap_or(0)
        })
        .collect();
    if pending(state, "abort") {
        return Err(abort_pending(slug));
    }
    if let Some(authorized) = pending_answers.first() {
        let artifact=authorized.get("artifact").ok_or_else(||error("missing-authorization",format!("build \"{slug}\" has a pending spec revision from escalation \"{}\", but its recorded answer names no replacement body. Autobuild will not infer authorization from the newest deposited spec: the spec is the contract for every downstream approval. The build remains parked; use ab abort {slug} and dispatch the ticket fresh to exit this state.",authorized["id"].as_str().unwrap_or_default())))?;
        let escalation_seq = open
            .iter()
            .chain(pending_answers.iter().copied())
            .map(|item| item["seq"].as_i64().unwrap_or(0))
            .max()
            .unwrap_or(0);
        return Ok(RevisionDecision::Complete {
            artifact: artifact.clone(),
            assets: authorized.get("assets").cloned(),
            open,
            escalation_seq,
        });
    }
    if open.is_empty() {
        let paused = if state["status"] == "paused" {
            format!(
                " If a revision already landed, the build remains paused; run ab resume {slug}."
            )
        } else {
            String::new()
        };
        return Err(error("no-open-escalations",format!("build \"{slug}\" has no open escalation for a spec revision (status: {}). The spec is the build contract and changes only through an escalation raised by a phase; the phase must use ab escalate first.{paused}",state["status"].as_str().unwrap_or_default())));
    }
    let escalation_seq = open
        .iter()
        .map(|item| item["seq"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    Ok(RevisionDecision::Fresh {
        open,
        escalation_seq,
    })
}
/// Mechanical core of core/spec-standard.ts, including heading nesting and
/// preserving the body exactly as supplied after checking its shape.
pub fn spec_missing(body: &str) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if body.trim_matches(super::auth::js_space).is_empty() {
        missing.push("a nonempty spec body");
    }
    let lines: Vec<&str> = body.split('\n').collect();
    fn heading(line: &str) -> Option<(usize, String)> {
        let n = line.bytes().take_while(|b| *b == b'#').count();
        if !(1..=6).contains(&n) {
            return None;
        }
        Some((
            n,
            line[n..].trim_matches(super::auth::js_space).to_lowercase(),
        ))
    }
    fn section<'a>(lines: &'a [&str], name: &str) -> Option<&'a [&'a str]> {
        let (start, level) = lines.iter().enumerate().find_map(|(i, line)| {
            heading(line)
                .filter(|(_, text)| text.starts_with(name))
                .map(|(level, _)| (i + 1, level))
        })?;
        let end = lines[start..]
            .iter()
            .position(|line| heading(line).is_some_and(|(n, _)| n <= level))
            .map_or(lines.len(), |offset| start + offset);
        Some(&lines[start..end])
    }
    let criteria = section(&lines, "acceptance criteria");
    if let Some(criteria) = criteria {
        let list = criteria.iter().any(|line| {
            let line = line.trim_start_matches(super::auth::js_space);
            let prefix = if line.starts_with(['-', '*', '+']) {
                1
            } else {
                let n = line.bytes().take_while(u8::is_ascii_digit).count();
                if n > 0
                    && line
                        .as_bytes()
                        .get(n)
                        .is_some_and(|b| matches!(b, b'.' | b')'))
                {
                    n + 1
                } else {
                    0
                }
            };
            prefix > 0
                && line[prefix..]
                    .chars()
                    .next()
                    .is_some_and(super::auth::js_space)
                && !line[prefix..]
                    .trim_matches(super::auth::js_space)
                    .is_empty()
        });
        if !list {
            missing.push("at least one list item under '## Acceptance criteria'");
        }
    } else {
        missing.push("an '## Acceptance criteria' heading");
    }
    if section(&lines, "out of scope").is_none() {
        missing.push("an '## Out of scope' heading");
    }
    missing
}
fn node_revision_eligible(slug: &str, state: &Value) -> Result<(), OperatorError> {
    let cycle = &state["integration"]["cycle"];
    let failed = !cycle.is_null()
        && cycle["seq"].as_i64().unwrap_or(0) > state["restartSince"].as_i64().unwrap_or(0)
        && state["nodeComparison"]["headSha"] == cycle["head"]
        && state["nodeComparison"]["parentSha"] == cycle["parent"]
        && array(&state["verify"]["results"]).iter().any(|result| {
            result["seq"].as_i64().unwrap_or(0) > cycle["seq"].as_i64().unwrap_or(0)
                && result["restackId"] == cycle["id"]
                && result["outcome"] == "fail"
        });
    let restack = &state["nodeRestack"];
    if state["kind"] != "node"
        || state["nodeOpened"].is_null()
        || !(state["status"] == "collecting" || (state["status"] == "blocked" && failed))
        || terminal_signal(state).is_some()
        || !array(&state["pendingCommands"]).is_empty()
        || !array(&state["openEscalations"]).is_empty()
        || !state["currentPhase"].is_null()
        || !array(&state["sessions"]["open"]).is_empty()
        || !array(&state["sessions"]["suspended"]).is_empty()
        || !restack["active"].is_null()
        || !restack["parentRequest"].is_null()
        || !restack["parentChange"].is_null()
        || restack["requests"]
            .as_object()
            .is_some_and(|requests| !requests.is_empty())
        || !state["integration"]["intent"].is_null()
        || !state["landing"]["nativeEnablePending"].is_null()
        || state["landing"]["native"]["enabled"] == true
        || !state["landing"]["forgeMerge"].is_null()
        || state["landing"]["command"]["kind"] == "land"
    {
        return Err(error("inactive",format!("build \"{slug}\" cannot revise its node spec while work or controls are active; wait for idle collection or failed verification and retry")));
    }
    Ok(())
}
fn still_active(slug: &str, state: &Value) -> Result<(), OperatorError> {
    if matches!(
        state["status"].as_str(),
        Some("running" | "collecting" | "paused" | "blocked")
    ) {
        return Ok(());
    }
    let outcome = state["outcome"]
        .as_str()
        .map(|value| format!(" ({value})"))
        .unwrap_or_default();
    Err(error("no-longer-active",format!("build \"{slug}\" became {}{outcome} while the answer was being prepared; nothing was appended. Any deposited replacement revision is inert because no spec event cites it.",state["status"].as_str().unwrap_or_default())))
}
impl ControlService<'_> {
    async fn revise_spec(
        &self,
        repo: &str,
        slug: &str,
        actor: &Value,
        request: &Value,
        state: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        let pending_revision = array(&state["answeredEscalations"]).iter().any(|item| {
            item["resolution"] == "revise-spec"
                && item["answeredSeq"].as_i64().unwrap_or(0)
                    > state["restartSince"].as_i64().unwrap_or(0)
        });
        let node = state["kind"] == "node"
            && request.get("escalationIds").is_none()
            && array(&state["openEscalations"]).is_empty()
            && !pending_revision;
        if node {
            node_revision_eligible(slug, state)?;
        }
        let decision = if node {
            None
        } else {
            Some(decide_revision(slug, state, request)?)
        };
        let mut authorized_earlier = matches!(&decision, Some(RevisionDecision::Complete { .. }));
        let (mut artifact, mut assets) = if let Some(RevisionDecision::Complete {
            artifact,
            assets,
            ..
        }) = decision
        {
            (artifact, assets)
        } else {
            let record = self.require_build(repo, slug).await?;
            let body = request["body"].as_str().unwrap_or_default();
            let ticket = request["origin"] == "ticket";
            if ticket && record["ticket"].is_null() {
                return Err(error(
                    "ticket-unavailable",
                    format!("build \"{slug}\" has no recorded ticket to re-import"),
                ));
            }
            let missing = spec_missing(body);
            if !missing.is_empty() {
                return Err(error("spec-nonconforming",format!("replacement spec from {} does not conform: missing {}; nothing was recorded and the build remains blocked",if ticket{"the build ticket"}else{"operator API body"},missing.join("; "))));
            }
            let prepared_assets = if ticket {
                let id = record["ticket"]["id"].as_str().unwrap_or_default();
                if self.ticket_policy(repo).await?.is_some() {
                    let repository = self
                        .reader
                        .repository(repo)
                        .await
                        .map_err(|_| OperatorError::internal())?;
                    let reference = super::completeness::current_ref(
                        &record["ticket"],
                        &repository["repositoryReadFacts"]["ticketMigrations"]["migrations"],
                        "database",
                        slug,
                    )
                    .map_err(|_| OperatorError::internal())?;
                    Some(
                        crate::data::ticket_assets::snapshot(
                            self.reader,
                            self.writer,
                            self.blobs.ok_or_else(OperatorError::internal)?,
                            repo,
                            reference["id"].as_str().unwrap_or_default(),
                            now,
                        )
                        .await?,
                    )
                } else {
                    if record["ticket"]["source"] == "hosted" {
                        return Err(OperatorError::internal());
                    }
                    Some(crate::data::ticket_assets::sample_pins(self.writer, repo, id).await?)
                }
            } else {
                None
            };
            let metadata = if record["ticket"].is_null() {
                json!({})
            } else {
                json!({"ticket":record["ticket"]["id"],"source":record["ticket"]["source"]})
            };
            let blobs = self.blobs.ok_or_else(OperatorError::internal)?;
            let deposited = self
                .writer
                .put_artifact(blobs, repo, slug, "spec", body.as_bytes(), &metadata, now)
                .await
                .map_err(|_| OperatorError::internal())?;
            (
                json!({"kind":"spec","rev":deposited["revision"]}),
                prepared_assets,
            )
        };
        if node {
            let holder = format!("spec-revision-{}", super::control::random_uuid());
            if !self
                .writer
                .claim_revision_fence(repo, slug, &holder, true, now)
                .await
                .map_err(|_| OperatorError::internal())?
            {
                return Err(error(
                    "inactive",
                    "Node writer is busy; retry the spec revision",
                ));
            }
            let mut runner = false;
            let published:Result<Value,OperatorError>=async{
                runner=self.writer.claim_revision_fence(repo,slug,&holder,false,now).await.map_err(|_|OperatorError::internal())?;
                if !runner{return Err(error("inactive","Node runner is busy; retry the spec revision"));}
                let fresh=self.state(repo,slug).await?;
                node_revision_eligible(slug,&fresh)?;
                if fresh["lastSeq"]!=state["lastSeq"]{return Err(error("inactive","Build changed while preparing the spec; retry. Deposited artifacts remain inert."));}
                let mut payload=json!({"artifact":artifact,"operator":{"user":actor["user"]}});
                if let Some(via)=actor.get("via"){payload["operator"]["via"]=via.clone();}
                if let Some(assets)=&assets{payload["assets"]=assets.clone();}
                let write=json!({"actor":{"kind":"kernel"},"type":"spec.revised","payload":payload});
                if self.writer.append_build_if_current(repo,slug,fresh["lastSeq"].as_i64().unwrap_or(0),&write,now).await.map_err(|_|OperatorError::internal())?.is_none(){return Err(error("inactive","Build changed while publishing the spec; retry. Deposited artifacts remain inert."));}
                Ok(json!({"kind":"answered","slug":slug,"count":0,"resolution":"revise-spec","resumed":false,"nodeRevision":true,"specRev":artifact["rev"]}))
            }.await;
            let release_runner = if runner {
                self.writer
                    .release_revision_fence(repo, slug, &holder, false, now)
                    .await
            } else {
                Ok(())
            };
            let release_writer = self
                .writer
                .release_revision_fence(repo, slug, &holder, true, now)
                .await;
            release_runner.map_err(|_| OperatorError::internal())?;
            release_writer.map_err(|_| OperatorError::internal())?;
            return published;
        }
        let fresh = self.state(repo, slug).await?;
        still_active(slug, &fresh)?;
        let (open, escalation_seq) = match decide_revision(slug, &fresh, request)? {
            RevisionDecision::Fresh {
                open,
                escalation_seq,
            } => (open, escalation_seq),
            RevisionDecision::Complete {
                artifact: authorized,
                assets: pinned,
                open,
                escalation_seq,
            } => {
                artifact = authorized;
                assets = pinned;
                authorized_earlier = true;
                (open, escalation_seq)
            }
        };
        let guidance = request["text"]
            .as_str()
            .unwrap_or_default()
            .trim_matches(super::auth::js_space);
        let answer = if guidance.is_empty() {
            if state["kind"] == "node" {
                "Operator replaced the node spec; recollect and verify"
            } else {
                "Operator replaced the spec; the build restarts from plan"
            }
        } else {
            guidance
        };
        for escalation in &open {
            let mut payload = json!({"id":escalation["id"],"answer":answer,"resolution":"revise-spec","artifact":artifact});
            if let Some(assets) = &assets {
                payload["assets"] = assets.clone();
            }
            self.append(repo, slug, actor, "escalation.answered", payload, now)
                .await?;
        }
        let mut payload = json!({"artifact":artifact,"escalation":escalation_seq});
        if let Some(assets) = assets {
            payload["assets"] = assets;
        }
        if fresh["verifyStage"]["concurrent"] == true {
            loop {
                let current = self.state(repo, slug).await?;
                let authorization = decide_revision(slug, &current, request)?;
                let RevisionDecision::Complete {
                    artifact,
                    assets,
                    escalation_seq,
                    ..
                } = authorization
                else {
                    return Err(error(
                        "missing-authorization",
                        "Spec revision authorization is no longer effective",
                    ));
                };
                let mut current_payload = json!({"artifact":artifact,"escalation":escalation_seq});
                if let Some(assets) = assets {
                    current_payload["assets"] = assets;
                }
                if self
                    .writer
                    .append_build_if_current(
                        repo,
                        slug,
                        current["lastSeq"].as_i64().unwrap_or(0),
                        &write(&json!({"kind":"kernel"}), "spec.revised", current_payload),
                        now,
                    )
                    .await
                    .map_err(|_| OperatorError::internal())?
                    .is_some()
                {
                    break;
                }
            }
        } else {
            self.append(
                repo,
                slug,
                &json!({"kind":"kernel"}),
                "spec.revised",
                payload,
                now,
            )
            .await?;
        }
        let paused = fresh["status"] == "paused";
        if paused {
            self.append(repo, slug, actor, "build.resume-requested", json!({}), now)
                .await?;
        }
        let after = self.state(repo, slug).await?;
        let mut result = json!({"kind":"answered","slug":slug,"count":open.len(),"resolution":"revise-spec","resumed":paused});
        if state["kind"] == "node" {
            result["nodeRevision"] = json!(true);
        }
        if let Some(rev) = after.get("specRev") {
            result["specRev"] = rev.clone();
        }
        if authorized_earlier {
            result["authorizedEarlier"] = json!(true);
        }
        if let Some(signal) = terminal_signal(&after) {
            result["terminalSignal"] = signal;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conformance_respects_nested_sections_and_nonempty_list_items() {
        assert!(
            spec_missing("## Acceptance criteria\n- Works\n## Out of scope\nNothing").is_empty()
        );
        assert!(
            spec_missing("## Acceptance criteria\n### Detail\n1) Works\n## Out of scope")
                .is_empty()
        );
        assert!(
            spec_missing("## Acceptance criteria\n- \n## Out of scope\n- Wrong section")
                .contains(&"at least one list item under '## Acceptance criteria'")
        );
    }
    #[test]
    fn pending_authorization_is_lazy_and_abort_wins() {
        let state = json!({"restartSince":0,"openEscalations":[],"answeredEscalations":[{"id":"e","seq":2,"answeredSeq":3,"resolution":"revise-spec","artifact":{"kind":"spec","rev":1}}]});
        assert!(matches!(
            decide_revision("b", &state, &json!({})).unwrap(),
            RevisionDecision::Complete {
                escalation_seq: 2,
                ..
            }
        ));
        let mut abort = state;
        abort["pendingCommands"] = json!([{"command":"abort"}]);
        assert_eq!(
            decide_revision("b", &abort, &json!({}))
                .unwrap_err()
                .code
                .as_deref(),
            Some("abort-pending")
        );
    }
    #[test]
    fn ceiling_is_only_a_single_open_review_limit_override() {
        let state = json!({"openEscalations":[{"id":"e","source":"policy","policyCause":"review-round-limit","phase":"code-review"}]});
        assert_eq!(
            validate_answer_options("b", &state, &json!({"ceiling":5}))
                .unwrap()
                .unwrap()["id"],
            "e"
        );
        assert!(validate_answer_options("b", &state, &json!({"ceiling":0})).is_err());
        assert_eq!(
            validate_answer_options(
                "b",
                &state,
                &json!({"ceiling":5,"resolution":"revise-spec"})
            )
            .unwrap_err()
            .code
            .as_deref(),
            Some("incompatible-answer-options")
        );
    }
    #[test]
    fn captured_blockers_and_known_finding_partition_are_separate() {
        let state = json!({"openEscalations":[{"id":"a","refs":["f"]},{"id":"b","refs":["file.ts"]}],"reviewFindings":{"planReview":[[{"id":"f"}]],"codeReview":[]}});
        let open = selected(&state, &json!({}));
        let (eligible, ineligible) = partition(&state, &open);
        assert_eq!(eligible[0]["id"], "a");
        assert_eq!(ineligible[0]["id"], "b");
        assert_eq!(selected(&state, &json!({"escalationIds":["b"]})).len(), 1);
    }
}
