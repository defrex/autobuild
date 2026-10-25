//! Repository tick observations share the repository row lock with leases and
//! event writers. Completion does not renew a lease or heartbeat.
use super::{
    events::{insert_prepared, tail},
    records::{lock, Scope},
    timestamp, Store,
};
use crate::protocol::{
    error::ProtocolError,
    validation::{validate_request, writes::prepare_repository_write},
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::Row;

fn held(row: &Row, holder: &str, now: DateTime<Utc>) -> bool {
    row.get::<_, Option<String>>("lease_holder").as_deref() == Some(holder)
        && row
            .get::<_, Option<DateTime<Utc>>>("lease_expires_at")
            .is_some_and(|expires| expires > now)
}
fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(422, "validation", message)
}
/// Core tick validation intentionally uses catalog validation, not the ordinary
/// producer append boundary: absent compatibility remains absent on these facts.
fn validate_finish(
    holder: &str,
    completion: &Value,
    events: &[Value],
) -> Result<Vec<Value>, ProtocolError> {
    let parsed = validate_request("tickCompletion", completion)
        .map_err(|message| ProtocolError::new(500, "internal", message))?;
    let validated = events
        .iter()
        .map(|input| {
            let mut event = prepare_repository_write(input).map_err(|message| {
                if let Some(message) = message.strip_prefix("invalid compatibility metadata: ") {
                    ProtocolError::new(500, "internal", message)
                } else {
                    invalid(message)
                }
            })?;
            if input.get("compatibility").is_none() {
                event.as_object_mut().unwrap().remove("compatibility");
            }
            Ok(event)
        })
        .collect::<Result<Vec<_>, ProtocolError>>()?;
    if validated.is_empty() && completion["outcome"] == "completed" {
        return Ok(validated);
    }
    if validated.len() != 2 {
        return Err(invalid(
            "tick finish requires start and terminal boundaries",
        ));
    }
    let start = &validated[0];
    let end = &validated[1];
    let terminal = if completion["outcome"] == "completed" {
        "dispatcher.tick-completed"
    } else {
        "dispatcher.tick-failed"
    };
    if start["type"] != "dispatcher.tick-started"
        || end["type"] != terminal
        || validated.iter().any(|event| {
            event["actor"]["kind"] != "dispatcher" || event["payload"]["run"] != holder
        })
    {
        return Err(invalid("invalid tick finish boundaries"));
    }
    if end["type"] == "dispatcher.tick-failed"
        && completion["outcome"] == "failed"
        && end["payload"]["error"] != completion["error"]
    {
        return Err(invalid("tick error mismatch"));
    }
    // Both objects have been parsed through the same closed counter schema, so
    // their insertion order matches Zod's schema order used by JSON.stringify.
    if end["type"] == "dispatcher.tick-completed"
        && completion["outcome"] == "completed"
        && serde_json::to_string(&end["payload"]["counters"]).unwrap()
            != serde_json::to_string(&parsed["counters"]).unwrap()
    {
        return Err(invalid("tick counters mismatch"));
    }
    Ok(validated)
}
impl Store {
    pub async fn begin_repo_tick(&self, repo: &str, holder: &str) -> Result<Value, ProtocolError> {
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = lock(&tx, Scope::Repo(repo)).await?;
        if !held(&row, holder, self.now()) {
            return Ok(Value::Null);
        }
        let started_at = self.now();
        let mut tick = json!({"run":holder,"open":{"startedAt":timestamp(started_at)}});
        if let Some(previous) = row
            .get::<_, Option<crate::protocol::js_json::JsValue>>("tick")
            .map(|value| value.0)
        {
            if let Some(finished) = previous.get("finished").filter(|value| !value.is_null()) {
                tick["finished"] = finished.clone();
            }
        }
        tx.execute(
            "UPDATE repo_streams SET tick=$1,updated_at=$2 WHERE repo=$3",
            &[&tick, &started_at, &repo],
        )
        .await
        .map_err(ProtocolError::query)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(timestamp(started_at).into())
    }
    pub async fn finish_repo_tick(
        &self,
        repo: &str,
        holder: &str,
        completion: &Value,
        events: &[Value],
    ) -> Result<Value, ProtocolError> {
        // Invalid batches are rejected before even a stale holder is considered.
        let validated = validate_finish(holder, completion, events)?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let scope = Scope::Repo(repo);
        let row = lock(&tx, scope).await?;
        if !held(&row, holder, self.now()) {
            return Ok(Value::Null);
        }
        let previous = row
            .get::<_, Option<crate::protocol::js_json::JsValue>>("tick")
            .map(|value| value.0)
            .unwrap_or(Value::Null);
        if previous["run"] != holder || previous.get("open").is_none_or(Value::is_null) {
            return Err(ProtocolError::new(
                500,
                "internal",
                "no open repository tick",
            ));
        }
        let completed_at = self.now();
        let mut seq = tail(&tx, scope).await?;
        let mut envelopes = Vec::new();
        for event in &validated {
            seq = seq
                .checked_add(1)
                .filter(|seq| *seq <= 9_007_199_254_740_991)
                .ok_or_else(ProtocolError::internal)?;
            envelopes.push(insert_prepared(&tx, scope, event, seq, completed_at).await?);
        }
        let mut finished = completion.clone();
        finished["run"] = holder.into();
        finished["startedAt"] = previous["open"]["startedAt"].clone();
        finished["completedAt"] = timestamp(completed_at).into();
        let observation = json!({"run":holder,"finished":finished});
        tx.execute(
            "UPDATE repo_streams SET tick=$1,updated_at=$2 WHERE repo=$3",
            &[&observation, &completed_at, &repo],
        )
        .await
        .map_err(ProtocolError::query)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(json!({"observation":observation,"events":envelopes}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tick_finish_matches_core_boundary_validation() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol-ticks.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let result = validate_finish(
                case["holder"].as_str().unwrap(),
                &case["completion"],
                case["events"].as_array().unwrap(),
            );
            let actual = match result {
                Ok(events) => json!({"accepted":events}),
                Err(error) => {
                    json!({"rejected":{"status":error.status.as_u16(),"message":error.error}})
                }
            };
            assert_eq!(actual, case["oracle"], "{}", case["id"]);
        }
        assert!(cases["cases"].as_array().unwrap().len() >= 20);
    }
}

#[path = "ticks_lossless.rs"]
mod lossless;
