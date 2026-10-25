//! Native operator commands. Decisions come from fresh durable reductions; a
//! transport can never select an event type or bypass the policy checks here.
use super::error::OperatorError;
use crate::data::{reader::DataReader, writer::PostgresWriter};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde_json::{json, Value};

pub struct ControlService<'a> {
    pub reader: &'a DataReader,
    pub writer: &'a PostgresWriter,
    pub blobs: Option<&'a crate::data::blobs::BlobWriter>,
}
pub(super) fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(super) fn error(code: &str, text: impl Into<String>) -> OperatorError {
    OperatorError::refusal(text).with_code(code)
}
pub(super) fn pending(state: &Value, command: &str) -> bool {
    array(&state["pendingCommands"])
        .iter()
        .any(|item| item["command"] == command)
}
pub(super) fn active(slug: &str, state: &Value) -> Result<(), OperatorError> {
    if matches!(
        state["status"].as_str(),
        Some("running" | "collecting" | "paused" | "blocked")
    ) {
        Ok(())
    } else {
        Err(error("inactive", format!("build \"{slug}\" is not active (status: {}); build controls require running, paused, or blocked",state["status"].as_str().unwrap_or_default())))
    }
}
pub(super) fn write(actor: &Value, kind: &str, payload: Value) -> Value {
    json!({"actor":actor,"type":kind,"payload":payload})
}
pub fn bulk_eligible(state: &Value, direction: &str) -> bool {
    if direction == "pause" {
        state["status"] == "running" && !pending(state, "pause") && !pending(state, "abort")
    } else {
        state["status"] == "paused"
            && array(&state["openEscalations"]).is_empty()
            && !pending(state, "resume")
    }
}
pub fn control_prechecks(slug: &str, state: &Value, action: &str) -> Result<(), OperatorError> {
    let display = crate::dashboard::model::effective_status(state);
    if action == "pause" && display == "pausing" {
        return Err(error(
            "inactive",
            format!("build \"{slug}\" cannot pause (status: pausing); pause is already pending"),
        ));
    }
    if action == "cancel-pause" && display != "pausing" {
        return Err(error("inactive",format!("build \"{slug}\" cannot cancel pause (status: {}); cancel pause requires a pending pause",state["status"].as_str().unwrap_or_default())));
    }
    Ok(())
}
/// The same pure guard as kernel/landing-readiness. Live node completeness is
/// checked separately before publishing a land request.
pub fn land_preconditions(state: &Value, restack: &Value) -> bool {
    let decision = &state["landing"]["decision"];
    let node = state["kind"] == "node";
    let head = if node {
        &state["integration"]["cycle"]["head"]
    } else {
        &state["pr"]["headSha"]
    };
    !decision.is_null()
        && (!node || integration_cycle_current(state))
        && state["status"] != "paused"
        && state["currentPhase"].is_null()
        && array(&state["openEscalations"]).is_empty()
        && array(&state["pendingCommands"]).is_empty()
        && state["prState"] == "open"
        && *head == decision["candidate"]["head"]
        && (node
            || restack["target"].is_null()
            || restack["target"]["sha"] == decision["candidate"]["parent"])
        && restack["active"].is_null()
        && state["nodeRestack"]["active"].is_null()
}
fn integration_cycle_current(state: &Value) -> bool {
    let cycle = &state["integration"]["cycle"];
    !cycle.is_null()
        && cycle["seq"].as_i64().unwrap_or(0) > state["restartSince"].as_i64().unwrap_or(0)
}
impl ControlService<'_> {
    pub async fn state(&self, repo: &str, slug: &str) -> Result<Value, OperatorError> {
        self.require_build(repo, slug).await?;
        self.reader
            .build(repo, slug)
            .await
            .map(|v| v["build"].clone())
            .map_err(|_| OperatorError::internal())
    }
    pub async fn require_build(&self, repo: &str, slug: &str) -> Result<Value, OperatorError> {
        self.reader
            .postgres()
            .build_record(repo, slug)
            .await
            .map_err(|_| OperatorError::internal())?
            .ok_or_else(|| OperatorError::not_found(format!("unknown build \"{slug}\"")))
    }
    pub(super) async fn append(
        &self,
        repo: &str,
        slug: &str,
        actor: &Value,
        kind: &str,
        payload: Value,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        self.writer
            .append_build(repo, slug, &write(actor, kind, payload), now)
            .await
            .map_err(|_| OperatorError::internal())
    }
    pub async fn control(
        &self,
        repo: &str,
        slug: &str,
        actor: &Value,
        action: &str,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        let state = self.state(repo, slug).await?;
        control_prechecks(slug, &state, action)?;
        let command = match action {
            "discard" => {
                if state["status"] != "queued" {
                    return Err(error("inactive",format!("build \"{slug}\" cannot be discarded (status: {}); discard requires queued",state["status"].as_str().unwrap_or_default())));
                }
                "discard"
            }
            "abort" => {
                if state["status"] != "queued" {
                    active(slug, &state)?;
                }
                "abort"
            }
            _ => {
                active(slug, &state)?;
                match action {
                    "pause" | "cancel-pause" => {
                        if state["status"] != "running" {
                            return Err(error("inactive",format!("build \"{slug}\" cannot use dashboard pause (status: {}); dashboard pause requires running or a pending pause",state["status"].as_str().unwrap_or_default())));
                        }
                        if pending(&state, "pause") {
                            "resume"
                        } else {
                            "pause"
                        }
                    }
                    "resume" => {
                        let open = array(&state["openEscalations"]);
                        if !open.is_empty() {
                            return Ok(
                                json!({"kind":"answer-required","slug":slug,"escalationIds":open.iter().map(|v|v["id"].clone()).collect::<Vec<_>>()}),
                            );
                        }
                        if state["status"] != "paused" || pending(&state, "resume") {
                            return Err(error("inactive",format!("build \"{slug}\" cannot use dashboard resume (status: {}); dashboard resume requires paused with no pending resume",state["status"].as_str().unwrap_or_default())));
                        }
                        "resume"
                    }
                    "land" | "hold" => return self.landing(repo, slug, actor, action, now).await,
                    _ => {
                        return Err(OperatorError::validation(
                            "unsupported build control action",
                        ))
                    }
                }
            }
        };
        // Abort/discard retries return the original receipt, including actor and
        // timestamp, rather than issuing a second request.
        if matches!(command, "abort" | "discard") {
            let kind = format!("build.{command}-requested");
            let events = self
                .reader
                .postgres()
                .events(repo, crate::data::postgres::Scope::Build(slug), 0)
                .await
                .map_err(|_| OperatorError::internal())?;
            if let Some(event) = events.iter().rev().find(|e| e["type"] == kind) {
                return Ok(json!({"kind":"command","slug":slug,"command":command,"event":event}));
            }
        }
        let event = self
            .append(
                repo,
                slug,
                actor,
                &format!("build.{command}-requested"),
                json!({}),
                now,
            )
            .await?;
        Ok(json!({"kind":"command","slug":slug,"command":command,"event":event}))
    }
    async fn landing(
        &self,
        repo: &str,
        slug: &str,
        actor: &Value,
        action: &str,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        loop {
            let (reduced, facts, seq) = self
                .reader
                .build_display(repo, slug)
                .await
                .map_err(|_| OperatorError::internal())?;
            let state = &reduced["build"];
            active(slug, state)?;
            if action == "land" {
                if !state["discardRequest"].is_null() {
                    return Err(error("discard-pending",format!("build \"{slug}\" has an outstanding discard request; auto-merge consent was not recorded. The discard settles only when the build terminalizes — nothing was appended. If the discard raced with runner attachment and you still want the change, merge the PR manually.")));
                }
                if !land_preconditions(state, &facts["restack"]) {
                    return Err(OperatorError::new(
                        500,
                        "internal",
                        "operator API is unavailable",
                    ));
                }
                if state["kind"] == "node" {
                    let policy = self
                        .ticket_policy(repo)
                        .await?
                        .ok_or_else(OperatorError::internal)?;
                    let observed = self.observe_completeness(repo, slug, &policy, now).await?;
                    if !array(&observed["openChildren"]).is_empty()
                        || !array(&observed["diagnostics"]).is_empty()
                        || array(&observed["contributions"]).is_empty()
                    {
                        return Err(OperatorError::internal());
                    }
                }
            }
            let payload = if action == "land" {
                json!({"decisionSeq":state["landing"]["decision"]["seq"]})
            } else {
                json!({})
            };
            if let Some(event) = self
                .writer
                .append_build_if_current(
                    repo,
                    slug,
                    seq,
                    &write(actor, &format!("build.{action}-requested"), payload),
                    now,
                )
                .await
                .map_err(|_| OperatorError::internal())?
            {
                return Ok(json!({"kind":"command","slug":slug,"command":action,"event":event}));
            }
        }
    }
    pub async fn restack(
        &self,
        repo: &str,
        slug: &str,
        actor: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        self.require_build(repo, slug).await?;
        loop {
            let state = self.state(repo, slug).await?;
            let conflict = |text: String| OperatorError::new(409, "conflict", text);
            if state["kind"] != "node" {
                return Err(conflict(format!(
                    "build \"{slug}\" is not a node; leaves restack automatically"
                )));
            }
            if matches!(state["status"].as_str(), Some("done" | "aborted"))
                || matches!(state["prState"].as_str(), Some("merged" | "closed"))
            {
                return Err(conflict(format!(
                    "node \"{slug}\" is terminal; restack requires an open node"
                )));
            }
            if state["nodeOpened"].is_null()
                || state["baseBranch"].as_str().is_none_or(str::is_empty)
            {
                return Err(conflict(format!("node \"{slug}\" has no open branch yet")));
            }
            let branch = &state["baseBranch"];
            let parent = state["nodeRestack"]["observedParent"]
                .get("sha")
                .or(state["nodeComparison"].get("parentSha"))
                .or(state["nodeRestack"].get("contributionBase"))
                .unwrap_or(&state["nodeOpened"]["sha"]);
            let waiting = matches!(state["status"].as_str(), Some("paused" | "blocked"));
            if let Some(existing) =
                state["nodeRestack"]["requests"]
                    .as_object()
                    .and_then(|requests| {
                        requests.values().find(|v| {
                            v["reason"] == "operator"
                                && v["branch"] == *branch
                                && v["parent"] == *parent
                        })
                    })
            {
                return Ok(
                    json!({"slug":slug,"request":existing,"coalesced":true,"waiting":waiting}),
                );
            }
            let request =
                json!({"id":random_uuid(),"reason":"operator","branch":branch,"parent":parent});
            if self
                .writer
                .append_build_if_current(
                    repo,
                    slug,
                    state["lastSeq"].as_i64().unwrap_or(0),
                    &write(actor, "node.restack-requested", request.clone()),
                    now,
                )
                .await
                .map_err(|_| OperatorError::internal())?
                .is_some()
            {
                return Ok(
                    json!({"slug":slug,"request":request,"coalesced":false,"waiting":waiting}),
                );
            }
        }
    }
    pub async fn setting(
        &self,
        repo: &str,
        actor: &Value,
        enabled: Option<bool>,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        self.writer
            .ensure_repo(repo, now)
            .await
            .map_err(|_| OperatorError::internal())?;
        let enabled = match enabled {
            Some(v) => v,
            None => {
                self.reader
                    .repository(repo)
                    .await
                    .map_err(|_| OperatorError::internal())?["repositoryReadFacts"]["settings"]
                    ["intake"]
                    != true
            }
        };
        let event = self
            .writer
            .append_repo(
                repo,
                &write(actor, "dispatcher.intake-set", json!({"enabled":enabled})),
                now,
            )
            .await
            .map_err(|_| OperatorError::internal())?;
        Ok(json!({"enabled":enabled,"event":event}))
    }
    pub async fn harvest(
        &self,
        repo: &str,
        actor: &Value,
        run: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        self.writer
            .ensure_repo(repo, now)
            .await
            .map_err(|_| OperatorError::internal())?;
        let facts = self
            .reader
            .repository(repo)
            .await
            .map_err(|_| OperatorError::internal())?;
        let facts = &facts["repositoryReadFacts"];
        let state = &facts["harvest"];
        let pending = array(&state["pendingCommands"]);
        let mut action = None;
        let command = if let Some(run) = run {
            let selected = selected_harvest_run(facts);
            if selected
                .is_none_or(|selected| selected["run"] != run || selected["status"] == "completed")
            {
                return Err(error(
                    "stale-harvest-run",
                    "harvest run action ignored: selected run is no longer active",
                ));
            }
            if state["paused"] == true {
                return Err(error("harvest-paused","harvest run action unavailable while harvest is OFF; select Dispatcher and press h"));
            }
            if pending.iter().any(|v| v["command"] == "resume") {
                return Err(error(
                    "harvest-pending",
                    "harvest run: resume acknowledgement pending",
                ));
            }
            let selected = selected.unwrap();
            action = match selected["status"].as_str() {
                Some("failed") => Some(if selected["recoveryExhaustion"].is_null() {
                    "resume"
                } else {
                    "acknowledge"
                }),
                Some("escalated") => Some("acknowledge"),
                _ => None,
            };
            if action.is_none() {
                return Err(error(
                    "harvest-unavailable",
                    "harvest run has no available action",
                ));
            }
            "resume"
        } else {
            let requested_paused = pending
                .last()
                .map_or(state["paused"] == true, |v| v["command"] == "pause");
            if requested_paused {
                "resume"
            } else {
                "pause"
            }
        };
        let event = self
            .writer
            .append_repo(
                repo,
                &write(actor, &format!("harvest.{command}-requested"), json!({})),
                now,
            )
            .await
            .map_err(|_| OperatorError::internal())?;
        Ok(match action {
            Some(action) => json!({"action":action,"event":event}),
            None => json!({"command":command,"event":event}),
        })
    }
    pub async fn bulk(
        &self,
        repo: &str,
        actor: &Value,
        direction: &str,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        if !matches!(direction, "pause" | "resume") {
            return Err(OperatorError::validation("invalid bulk direction"));
        }
        let paused = direction == "pause";
        let intake = !paused;
        let mut progress = json!({"direction":direction,"paused":paused,"pausedWritten":false,"intake":intake,"intakeWritten":false,"slugs":[],"remaining":[]});
        let result: Result<(), OperatorError> = async {
            self.writer
                .ensure_repo(repo, now)
                .await
                .map_err(|error| OperatorError::new(500, "internal", error.to_string()))?;
            self.writer
                .append_repo(
                    repo,
                    &write(actor, "dispatcher.pause-set", json!({"enabled":paused})),
                    now,
                )
                .await
                .map_err(|error| OperatorError::new(500, "internal", error.to_string()))?;
            progress["pausedWritten"] = json!(true);
            self.writer
                .append_repo(
                    repo,
                    &write(actor, "dispatcher.intake-set", json!({"enabled":intake})),
                    now,
                )
                .await
                .map_err(|error| OperatorError::new(500, "internal", error.to_string()))?;
            progress["intakeWritten"] = json!(true);
            let mut records = self
                .reader
                .postgres()
                .builds(repo)
                .await
                .map_err(|error| OperatorError::new(500, "internal", error.to_string()))?;
            records.sort_by(|a, b| a["slug"].as_str().cmp(&b["slug"].as_str()));
            for (index, record) in records.iter().enumerate() {
                let slug = record["slug"].as_str().unwrap_or_default();
                progress["failedSlug"] = json!(slug);
                progress["remaining"] = json!(records[index + 1..]
                    .iter()
                    .map(|r| r["slug"].clone())
                    .collect::<Vec<_>>());
                loop {
                    let state = self.state(repo, slug).await?;
                    if !bulk_eligible(&state, direction) {
                        break;
                    }
                    if self
                        .writer
                        .append_build_if_current(
                            repo,
                            slug,
                            state["lastSeq"].as_i64().unwrap_or(0),
                            &write(actor, &format!("build.{direction}-requested"), json!({})),
                            now,
                        )
                        .await
                        .map_err(|error| OperatorError::new(500, "internal", error.to_string()))?
                        .is_some()
                    {
                        progress["slugs"].as_array_mut().unwrap().push(json!(slug));
                        break;
                    }
                }
                progress.as_object_mut().unwrap().remove("failedSlug");
                progress["remaining"] = json!([]);
            }
            Ok(())
        }
        .await;
        if let Err(mut err) = result {
            err.status = 409;
            err.kind = "refusal";
            err.code = Some("bulk-partial".to_owned());
            err.progress = Some(Box::new(progress));
            return Err(err);
        }
        Ok(json!({"direction":direction,"slugs":progress["slugs"],"paused":paused,"intake":intake}))
    }
}
pub(crate) fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let h = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
fn selected_harvest_run(facts: &Value) -> Option<&Value> {
    let runs = array(&facts["harvest"]["runs"]);
    runs.iter()
        .find(|run| {
            if run["status"] == "failed" {
                return run["recoveryExhaustion"]["attentionAcknowledgedSeq"].is_null();
            }
            run["status"] == "escalated"
                && (run["terminalSeq"].is_null()
                    || facts["dismissedThrough"].as_i64().unwrap_or(0)
                        <= run["terminalSeq"].as_i64().unwrap_or(0))
        })
        .or_else(|| runs.iter().rev().find(|run| run["status"] == "running"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_pause_is_never_cancelled_by_bulk_pause() {
        let state = json!({"status":"running","pendingCommands":[{"command":"pause"}]});
        assert!(!bulk_eligible(&state, "pause"));
        assert_eq!(
            control_prechecks("build", &state, "pause")
                .unwrap_err()
                .error,
            "build \"build\" cannot pause (status: pausing); pause is already pending"
        );
        assert!(control_prechecks("build", &state, "cancel-pause").is_ok());
    }
    #[test]
    fn bulk_resume_preserves_blockers_and_pending_resume() {
        for state in [
            json!({"status":"paused","openEscalations":[{"id":"esc"}]}),
            json!({"status":"paused","pendingCommands":[{"command":"resume"}]}),
        ] {
            assert!(!bulk_eligible(&state, "resume"));
        }
        assert!(bulk_eligible(
            &json!({"status":"paused","openEscalations":[],"pendingCommands":[]}),
            "resume"
        ));
    }
    #[test]
    fn harvest_attention_precedes_live_runs_and_acknowledged_history() {
        let facts = json!({"dismissedThrough":10,"harvest":{"runs":[{"run":"ack","status":"escalated","terminalSeq":5},{"run":"failed","status":"failed"},{"run":"live","status":"running"}]}});
        assert_eq!(selected_harvest_run(&facts).unwrap()["run"], "failed");
    }
    #[test]
    fn land_requires_current_candidate_and_quiet_work() {
        let state = json!({"status":"running","prState":"open","pr":{"headSha":"head"},"openEscalations":[],"pendingCommands":[],"landing":{"decision":{"candidate":{"head":"head","parent":"base"}}}});
        assert!(land_preconditions(&state, &json!({})));
        assert!(!land_preconditions(
            &state,
            &json!({"target":{"sha":"moved"}})
        ));
        let mut paused = state;
        paused["status"] = json!("paused");
        assert!(!land_preconditions(&paused, &json!({})));
    }
}
