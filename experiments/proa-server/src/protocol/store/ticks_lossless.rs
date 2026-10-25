//! Tick validation retains UTF-16 before holder fencing and JSONB publication.
use super::super::{
    events::{insert_prepared_lossless, tail},
    records::{lock, Scope},
    timestamp, Store,
};
use crate::protocol::{
    error::ProtocolError,
    js_postgres::PgJson,
    js_value::{JsJson as J, JsString as S},
    validation::{lossless, lossless_writes},
};
use chrono::{DateTime, Utc};
use tokio_postgres::Row;
fn same(v: &J, s: &str) -> bool {
    v.as_js_string().is_some_and(|v| v.eq_str(s))
}
fn invalid(s: &str) -> ProtocolError {
    ProtocolError::new(422, "validation", s)
}
fn held(row: &Row, holder: &S, now: DateTime<Utc>) -> bool {
    row.get::<_, Option<String>>("lease_holder")
        .is_some_and(|v| holder.eq_str(&v))
        && row
            .get::<_, Option<DateTime<Utc>>>("lease_expires_at")
            .is_some_and(|v| v > now)
}
fn validate(holder: &S, completion: &J, events: &[J]) -> Result<Vec<J>, ProtocolError> {
    let parsed = lossless::validate_request("tickCompletion", completion)
        .map_err(|e| ProtocolError::new_js(500, "internal", e))?;
    let mut validated = Vec::new();
    for input in events {
        let mut event = lossless_writes::prepare_repository_write(input).map_err(|message| {
            let prefix = S::from("invalid compatibility metadata: ");
            if message.units().starts_with(prefix.units()) {
                ProtocolError::new_js(
                    500,
                    "internal",
                    S::from_units(message.units()[prefix.len()..].to_vec()),
                )
            } else {
                ProtocolError::new_js(422, "validation", message)
            }
        })?;
        if input.get("compatibility").is_none() {
            event
                .as_object_mut()
                .unwrap()
                .retain(|(k, _)| !k.eq_str("compatibility"));
        }
        validated.push(event);
    }
    if validated.is_empty() && same(&completion["outcome"], "completed") {
        return Ok(validated);
    }
    if validated.len() != 2 {
        return Err(invalid(
            "tick finish requires start and terminal boundaries",
        ));
    }
    let start = &validated[0];
    let end = &validated[1];
    let terminal = if same(&completion["outcome"], "completed") {
        "dispatcher.tick-completed"
    } else {
        "dispatcher.tick-failed"
    };
    if !same(&start["type"], "dispatcher.tick-started")
        || !same(&end["type"], terminal)
        || validated.iter().any(|event| {
            !same(&event["actor"]["kind"], "dispatcher")
                || event["payload"]["run"] != J::String(holder.clone())
        })
    {
        return Err(invalid("invalid tick finish boundaries"));
    }
    if same(&end["type"], "dispatcher.tick-failed")
        && same(&completion["outcome"], "failed")
        && end["payload"]["error"] != completion["error"]
    {
        return Err(invalid("tick error mismatch"));
    }
    if same(&end["type"], "dispatcher.tick-completed")
        && same(&completion["outcome"], "completed")
        && end["payload"]["counters"].stringify() != parsed["counters"].stringify()
    {
        return Err(invalid("tick counters mismatch"));
    }
    Ok(validated)
}
impl Store {
    pub async fn begin_repo_tick_lossless(
        &self,
        repo: &str,
        holder: &S,
    ) -> Result<J, ProtocolError> {
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = lock(&tx, Scope::Repo(repo)).await?;
        if !held(&row, holder, self.now()) {
            return Ok(J::Null);
        }
        let now = self.now();
        let mut tick = J::Object(vec![
            (S::from("run"), J::String(holder.clone())),
            (
                S::from("open"),
                J::Object(vec![(
                    S::from("startedAt"),
                    J::String(S::from(timestamp(now))),
                )]),
            ),
        ]);
        if let Some(previous) = row
            .get::<_, Option<crate::protocol::js_json::JsValue>>("tick")
            .map(|v| v.0)
        {
            if let Some(finished) = previous.get("finished").filter(|v| !v.is_null()) {
                tick["finished"] = J::from_serde(finished);
            }
        }
        tx.execute(
            "UPDATE repo_streams SET tick=$1,updated_at=$2 WHERE repo=$3",
            &[&PgJson(&tick), &now, &repo],
        )
        .await
        .map_err(ProtocolError::query)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(J::String(S::from(timestamp(now))))
    }
    pub async fn finish_repo_tick_lossless(
        &self,
        repo: &str,
        holder: &S,
        completion: &J,
        events: &[J],
    ) -> Result<J, ProtocolError> {
        let validated = validate(holder, completion, events)?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let scope = Scope::Repo(repo);
        let row = lock(&tx, scope).await?;
        if !held(&row, holder, self.now()) {
            return Ok(J::Null);
        }
        let previous = J::from_serde(
            &row.get::<_, Option<crate::protocol::js_json::JsValue>>("tick")
                .map(|v| v.0)
                .unwrap_or(serde_json::Value::Null),
        );
        if previous["run"] != J::String(holder.clone())
            || previous.get("open").is_none_or(J::is_null)
        {
            return Err(ProtocolError::new(
                500,
                "internal",
                "no open repository tick",
            ));
        }
        let now = self.now();
        let mut seq = tail(&tx, scope).await?;
        let mut envelopes = Vec::new();
        for event in &validated {
            seq = seq
                .checked_add(1)
                .filter(|seq| *seq <= 9_007_199_254_740_991)
                .ok_or_else(ProtocolError::internal)?;
            envelopes.push(J::from_serde(
                &insert_prepared_lossless(&tx, scope, event, seq, now).await?,
            ));
        }
        let mut finished = completion.clone();
        finished["run"] = J::String(holder.clone());
        finished["startedAt"] = previous["open"]["startedAt"].clone();
        finished["completedAt"] = J::String(S::from(timestamp(now)));
        let observation = J::Object(vec![
            (S::from("run"), J::String(holder.clone())),
            (S::from("finished"), finished),
        ]);
        tx.execute(
            "UPDATE repo_streams SET tick=$1,updated_at=$2 WHERE repo=$3",
            &[&PgJson(&observation), &now, &repo],
        )
        .await
        .map_err(ProtocolError::query)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(J::Object(vec![
            (S::from("observation"), observation),
            (S::from("events"), J::Array(envelopes)),
        ]))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tick_boundaries_match_existing_oracle_losslessly() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol-ticks.json")).unwrap();
        for row in cases["cases"].as_array().unwrap() {
            let holder = S::from(row["holder"].as_str().unwrap());
            let completion = J::from_serde(&row["completion"]);
            let events: J = J::from_serde(&row["events"]);
            let actual = match validate(&holder, &completion, events.as_array().unwrap()) {
                Ok(events) => {
                    serde_json::json!({"accepted":J::Array(events).to_serde_checked().unwrap()})
                }
                Err(error) => {
                    serde_json::json!({"rejected":{"status":error.status.as_u16(),"message":error.error}})
                }
            };
            assert_eq!(actual, row["oracle"], "{}", row["id"]);
        }
    }
}
