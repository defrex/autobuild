//! Native operator-session policy. Transport validation happens before these operations.
//! Session events always name the signed user, without transport provenance.
use super::error::OperatorError;
use serde_json::{json, Value};

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("string is JSON serializable")
}

pub fn require_session<'a>(
    record: Option<&'a Value>,
    repo: &str,
    id: &str,
) -> Result<&'a Value, OperatorError> {
    record
        .filter(|record| record["repo"] == repo)
        .ok_or_else(|| {
            OperatorError::new(404, "not-found", format!("unknown session {}", quoted(id)))
        })
}

fn require_owner(record: &Value, user: &str, operation: &str) -> Result<(), OperatorError> {
    if record["operator"] != user {
        return Err(OperatorError::new(
            403,
            "auth",
            format!(
                "session {} belongs to operator {}; {} may not {operation}",
                quoted(record["id"].as_str().unwrap_or_default()),
                quoted(record["operator"].as_str().unwrap_or_default()),
                quoted(user),
            ),
        ));
    }
    Ok(())
}

fn event(user: &str, kind: &str, payload: Value) -> Value {
    json!({"actor":{"kind":"human","user":user},"type":kind,"payload":payload})
}

fn append_as(
    record: &Value,
    state: &Value,
    user: &str,
    kind: &str,
    payload: Value,
) -> Result<Value, OperatorError> {
    require_owner(record, user, &format!("write {kind}"))?;
    if state["status"] == "archived" {
        return Err(OperatorError::new(
            409,
            "refusal",
            format!(
                "session {} is archived and read-only",
                quoted(record["id"].as_str().unwrap_or_default())
            ),
        ));
    }
    Ok(event(user, kind, payload))
}

pub fn message(
    record: &Value,
    state: &Value,
    user: &str,
    text: &str,
) -> Result<Value, OperatorError> {
    append_as(record, state, user, "message.posted", json!({"text":text}))
}

pub fn wake(
    record: &Value,
    state: &Value,
    user: &str,
    globs: &[String],
) -> Result<Value, OperatorError> {
    append_as(
        record,
        state,
        user,
        "session.wake-set",
        json!({"globs":globs}),
    )
}

pub fn approval(
    record: &Value,
    state: &Value,
    user: &str,
    turn: &str,
    tool_call_id: &str,
    decision: &str,
) -> Result<Value, OperatorError> {
    require_owner(record, user, "answer an approval")?;
    let pending = &state["pendingApproval"];
    if state["status"] == "archived"
        || pending["turn"] != turn
        || pending["toolCallId"] != tool_call_id
    {
        return Err(OperatorError::new(
            409,
            "refusal",
            format!(
                "session {} has no pending approval for turn {} tool call {}",
                quoted(record["id"].as_str().unwrap_or_default()),
                quoted(turn),
                quoted(tool_call_id),
            ),
        ));
    }
    append_as(
        record,
        state,
        user,
        "approval.answered",
        json!({"turn":turn,"toolCallId":tool_call_id,"decision":decision}),
    )
}

pub fn archive(record: &Value, state: &Value, user: &str) -> Result<Value, OperatorError> {
    require_owner(record, user, "archive")?;
    if state["status"] == "archived" {
        return Err(OperatorError::new(
            409,
            "refusal",
            format!(
                "session {} is already archived",
                quoted(record["id"].as_str().unwrap_or_default())
            ),
        ));
    }
    Ok(event(user, "session.archived", json!({})))
}

pub fn view(record: Value, state: Value) -> Value {
    json!({"session":record,"turns":state["turns"],"state":state})
}

pub fn turn_stream<'a>(state: &'a Value, id: &str, turn: &str) -> Result<&'a str, OperatorError> {
    state["turns"]
        .as_array()
        .and_then(|turns| turns.iter().find(|candidate| candidate["turn"] == turn))
        .and_then(|target| target["stream"].as_str())
        .ok_or_else(|| {
            OperatorError::new(
                404,
                "not-found",
                format!("unknown turn {} in session {}", quoted(turn), quoted(id)),
            )
        })
}

/// Shared domain operations for the future bearer and browser transports.
/// No runner is provisioned or resumed here: sessions are the durable resource.
pub struct SessionService<'a> {
    pub reader: &'a crate::data::reader::DataReader,
    pub writer: &'a crate::data::writer::PostgresWriter,
}

pub enum Mutation<'a> {
    Message(&'a str),
    Wake(&'a [String]),
    Approval {
        turn: &'a str,
        tool_call_id: &'a str,
        decision: &'a str,
    },
    Archive,
}

fn storage_error(_: impl std::fmt::Display) -> OperatorError {
    OperatorError::internal()
}

impl SessionService<'_> {
    /// HTTP sessions are inert facts and never inherit hosted-runner settings.
    pub async fn create_http(
        &self,
        repo: &str,
        user: &str,
        title: Option<&str>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<Value, OperatorError> {
        self.create(repo, user, title, None, now).await
    }

    pub async fn list(&self, repo: &str) -> Result<Vec<Value>, OperatorError> {
        let mut records = self
            .reader
            .postgres()
            .sessions(repo)
            .await
            .map_err(storage_error)?;
        // Stable sort preserves the store's creation-sequence tiebreak for equal updates.
        records.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
        Ok(records)
    }

    async fn record(&self, repo: &str, id: &str) -> Result<Value, OperatorError> {
        let records = self
            .reader
            .postgres()
            .sessions(repo)
            .await
            .map_err(storage_error)?;
        let record = require_session(records.iter().find(|record| record["id"] == id), repo, id)?;
        Ok(record.clone())
    }

    pub async fn get(&self, repo: &str, id: &str) -> Result<Value, OperatorError> {
        let record = self.record(repo, id).await?;
        let reduced = self.reader.session(repo, id).await.map_err(storage_error)?;
        Ok(view(record, reduced["session"].clone()))
    }

    pub async fn stream(
        &self,
        repo: &str,
        id: &str,
        turn: &str,
        since: i64,
        wait_seconds: u64,
    ) -> Result<Value, OperatorError> {
        let view = self.get(repo, id).await?;
        let stream = turn_stream(&view["state"], id, turn)?.to_owned();
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(wait_seconds.min(30));
        loop {
            let read = self
                .reader
                .postgres()
                .session_stream(repo, id, &stream, since)
                .await
                .map_err(storage_error)?;
            if read["status"] != "open"
                || read["chunks"].as_array().is_some_and(|c| !c.is_empty())
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(read);
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    pub async fn create(
        &self,
        repo: &str,
        user: &str,
        title: Option<&str>,
        inherited_wake_globs: Option<&[String]>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<Value, OperatorError> {
        let record = self
            .writer
            .create_session(repo, user, title, now)
            .await
            .map_err(storage_error)?;
        if let Some(globs) = inherited_wake_globs {
            let write = event(user, "session.wake-set", json!({"globs":globs}));
            self.writer
                .append_session(
                    repo,
                    record["id"].as_str().expect("session id"),
                    &write,
                    now,
                )
                .await
                .map_err(storage_error)?;
        }
        Ok(record)
    }

    /// Matches the TS service's sequential read/check/append boundaries. The store's
    /// parent lock serializes sequence allocation; this method does not claim a
    /// stronger atomic policy gate than the TypeScript service provides.
    pub async fn mutate(
        &self,
        repo: &str,
        id: &str,
        user: &str,
        mutation: Mutation<'_>,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<Value, OperatorError> {
        let record = self.record(repo, id).await?;
        let operation = match &mutation {
            Mutation::Message(_) => "write message.posted",
            Mutation::Wake(_) => "write session.wake-set",
            Mutation::Approval { .. } => "answer an approval",
            Mutation::Archive => "archive",
        };
        // Ownership precedes history reads, including unreadable event logs.
        require_owner(&record, user, operation)?;
        let reduced = self.reader.session(repo, id).await.map_err(storage_error)?;
        let state = &reduced["session"];
        let record = &record;
        let write = match mutation {
            Mutation::Message(text) => message(record, state, user, text),
            Mutation::Wake(globs) => wake(record, state, user, globs),
            Mutation::Approval {
                turn,
                tool_call_id,
                decision,
            } => {
                let prepared = approval(record, state, user, turn, tool_call_id, decision)?;
                // TS answerOperatorApproval validates pending approval first, then
                // appendAs rereads history for its owner/archive gate. It does not
                // revalidate pendingApproval during that second check.
                let latest = self.reader.session(repo, id).await.map_err(storage_error)?;
                append_as(
                    record,
                    &latest["session"],
                    user,
                    "approval.answered",
                    prepared["payload"].clone(),
                )
            }
            Mutation::Archive => archive(record, state, user),
        }?;
        self.writer
            .append_session(repo, id, &write, now)
            .await
            .map_err(storage_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::reducers::session::SessionAcc;

    fn record() -> Value {
        json!({"id":"s1","repo":"https://github.com/acme/app","operator":"owner@example.com"})
    }

    #[test]
    fn foreign_sessions_are_hidden_before_owner_checks() {
        assert!(require_session(Some(&record()), "https://github.com/other/app", "s1").is_err());
        let error = require_session(None, "repo", "s1").unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.error, "unknown session \"s1\"");
    }

    #[test]
    fn owner_and_archive_refusals_preserve_types_and_exact_operation() {
        let state = json!({"status":"archived"});
        let error = message(&record(), &state, "other", "text").unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.error, "session \"s1\" belongs to operator \"owner@example.com\"; \"other\" may not write message.posted");
        assert_eq!(
            message(&record(), &state, "owner@example.com", "text")
                .unwrap_err()
                .error,
            "session \"s1\" is archived and read-only"
        );
        assert_eq!(
            archive(&record(), &state, "owner@example.com")
                .unwrap_err()
                .error,
            "session \"s1\" is already archived"
        );
        assert_eq!(
            approval(&record(), &state, "owner@example.com", "t", "c", "approve")
                .unwrap_err()
                .error,
            "session \"s1\" has no pending approval for turn \"t\" tool call \"c\""
        );
    }

    #[test]
    fn approval_targets_current_pending_call_and_archive_is_terminal() {
        let mut state = SessionAcc::default();
        state.fold(&json!({"seq":1,"type":"turn.started","payload":{"turn":"t","stream":"stream","trigger":{"kind":"message","messageSeq":1}}}));
        state.fold(&json!({"seq":2,"type":"approval.requested","payload":{"turn":"t","toolCallId":"c","toolName":"builds.pause","input":{}}}));
        assert!(approval(
            &record(),
            &state.finish(),
            "owner@example.com",
            "stale",
            "c",
            "approve"
        )
        .is_err());
        let answer = approval(
            &record(),
            &state.finish(),
            "owner@example.com",
            "t",
            "c",
            "approve",
        )
        .unwrap();
        assert_eq!(
            answer["actor"],
            json!({"kind":"human","user":"owner@example.com"})
        );
        state.fold(&answer);
        assert!(state.finish().get("pendingApproval").is_none());
        assert!(approval(
            &record(),
            &state.finish(),
            "owner@example.com",
            "t",
            "c",
            "deny"
        )
        .is_err());
        state.fold(&archive(&record(), &state.finish(), "owner@example.com").unwrap());
        assert_eq!(state.finish()["status"], "archived");
        assert!(wake(&record(), &state.finish(), "owner@example.com", &[]).is_err());
    }

    #[test]
    fn prepared_approval_checks_fresh_archive_state_without_rechecking_pending() {
        let pending =
            json!({"status":"awaiting-approval","pendingApproval":{"turn":"t","toolCallId":"c"}});
        let prepared = approval(
            &record(),
            &pending,
            "owner@example.com",
            "t",
            "c",
            "approve",
        )
        .unwrap();
        let archived = append_as(
            &record(),
            &json!({"status":"archived"}),
            "owner@example.com",
            "approval.answered",
            prepared["payload"].clone(),
        )
        .unwrap_err();
        assert_eq!(archived.error, "session \"s1\" is archived and read-only");
        let no_pending = append_as(
            &record(),
            &json!({"status":"running"}),
            "owner@example.com",
            "approval.answered",
            prepared["payload"].clone(),
        )
        .unwrap();
        assert_eq!(no_pending, prepared);
    }

    #[test]
    fn text_bytes_and_empty_wake_sets_are_preserved() {
        let state = json!({"status":"idle"});
        assert_eq!(
            message(&record(), &state, "owner@example.com", "line\n  ").unwrap()["payload"]["text"],
            "line\n  "
        );
        assert_eq!(
            wake(&record(), &state, "owner@example.com", &[]).unwrap()["payload"],
            json!({"globs":[]})
        );
        assert!(turn_stream(&json!({"turns":[]}), "s1", "t").is_err());
    }
}

#[cfg(test)]
mod oracle_tests {
    use super::*;
    use crate::data::reducers::session::SessionAcc;

    #[test]
    fn session_policies_match_typescript_http_results_and_ordered_deltas() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/operator-corpus.json")).unwrap();
        let mut checked = 0;
        for fixture in corpus["fixtures"].as_array().unwrap() {
            let id = fixture["scenario"]["id"].as_str().unwrap();
            // Body/protocol/auth decoding is a separate seam; this checkpoint tests
            // the policy invoked after valid requests and verified principals.
            if !matches!(
                id,
                "session-detail"
                    | "session-foreign-hidden"
                    | "session-missing"
                    | "session-message"
                    | "session-other-reader"
                    | "session-other-writer"
                    | "session-wake"
                    | "session-wake-empty"
                    | "session-approval-approve"
                    | "session-approval-deny"
                    | "session-approval-mismatch"
                    | "session-approval-none"
                    | "session-archive"
                    | "session-archive-again"
                    | "session-archived-message"
                    | "session-stream-unknown-turn"
            ) {
                continue;
            }
            let seed = fixture["seed"].as_array().unwrap().first();
            let record = seed.map(|seed| &seed["record"]);
            let mut acc = SessionAcc::default();
            if let Some(seed) = seed {
                for event in seed["events"].as_array().unwrap() {
                    acc.fold(event);
                }
            }
            let observation = &fixture["observations"][0];
            let request = &observation["request"];
            let user = request["user"].as_str().unwrap_or("operator@example.com");
            let sid = record
                .and_then(|record| record["id"].as_str())
                .unwrap_or("missing");
            let state = acc.finish();
            let result = require_session(record, "acme/widgets", sid).and_then(|record| {
                let body = &request["body"];
                match fixture["scenario"]["route"].as_str().unwrap() {
                    "POST sessions/:sid/messages" => {
                        message(record, &state, user, body["text"].as_str().unwrap().trim())
                            .map(Some)
                    }
                    "PUT sessions/:sid/wake" => {
                        let globs = body["globs"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap().to_owned())
                            .collect::<Vec<_>>();
                        wake(record, &state, user, &globs).map(Some)
                    }
                    "POST sessions/:sid/approvals" => approval(
                        record,
                        &state,
                        user,
                        body["turn"].as_str().unwrap(),
                        body["toolCallId"].as_str().unwrap(),
                        body["decision"].as_str().unwrap(),
                    )
                    .map(Some),
                    "POST sessions/:sid/archive" => archive(record, &state, user).map(Some),
                    "GET sessions/:sid/turns/:turn/stream" => {
                        turn_stream(&state, sid, "missing").map(|_| None)
                    }
                    "GET sessions/:sid" => {
                        assert_eq!(
                            view(record.clone(), state.clone()),
                            observation["body"],
                            "{id}"
                        );
                        Ok(None)
                    }
                    route => panic!("unhandled policy oracle route {route}"),
                }
            });
            match result {
                Err(error) => {
                    assert_eq!(json!(error.status), observation["status"], "{id}");
                    assert_eq!(
                        error.kind,
                        observation["body"]["kind"].as_str().unwrap(),
                        "{id}"
                    );
                    assert_eq!(
                        error.error,
                        observation["body"]["error"].as_str().unwrap(),
                        "{id}"
                    );
                    assert_eq!(
                        fixture["seed"], observation["sessions"],
                        "{id}: refusal changed durable state"
                    );
                }
                Ok(write) => {
                    assert_eq!(observation["status"], 200, "{id}");
                    if let Some(write) = write {
                        let before = seed.unwrap()["events"].as_array().unwrap().len();
                        let events = observation["sessions"][0]["events"].as_array().unwrap();
                        assert_eq!(events.len(), before + 1, "{id}: write count");
                        let actual = &events[before];
                        assert_eq!(
                            write,
                            json!({"actor":actual["actor"],"type":actual["type"],"payload":actual["payload"]}),
                            "{id}: policy write"
                        );
                        acc.fold(&write);
                        assert_eq!(
                            acc.finish(),
                            observation["sessions"][0]["state"],
                            "{id}: reduced poststate"
                        );
                    }
                }
            }
            checked += 1;
        }
        assert_eq!(checked, 16, "session policy oracle coverage changed");
    }
}
