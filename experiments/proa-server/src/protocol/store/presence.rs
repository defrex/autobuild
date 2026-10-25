//! Presence is advisory and has no dependency on repository journal existence.
use super::{records::row_timestamp, Store};
use crate::protocol::{error::ProtocolError, validation::validate_request};
use chrono::Duration;
use serde_json::{json, Value};
use tokio_postgres::Row;

pub const OPERATOR_PRESENCE_TTL_MS: i64 = 300_000;
fn presence(row: &Row) -> Value {
    json!({
        "repo":row.get::<_,String>("repo"),
        "id":row.get::<_,String>("id"),
        "host":row.get::<_,String>("host"),
        "pid":row.get::<_,i32>("pid"),
        "startedAt":row_timestamp(row,"started_at"),
        "heartbeatAt":row_timestamp(row,"heartbeat_at"),
    })
}
// SQL diagnostics are protocol error text in the TypeScript service. Preserve
// only the server message, never transport errors, connection strings or detail.
fn storage_error(error: tokio_postgres::Error) -> ProtocolError {
    if let Some(database) = error.as_db_error() {
        ProtocolError::new(500, "internal", database.message())
    } else {
        error.into()
    }
}
impl Store {
    pub async fn upsert_operator_presence(
        &self,
        repo: &str,
        input: &Value,
    ) -> Result<Value, ProtocolError> {
        if repo.is_empty() {
            return Err(ProtocolError::new(500, "internal", "repo is required"));
        }
        let identity = validate_request("operatorPresence", input)
            .map_err(|error| ProtocolError::validation(format!("invalid request body: {error}")))?;
        let id = identity["id"].as_str().unwrap();
        let host = identity["host"].as_str().unwrap();
        let pid = identity["pid"]
            .as_i64()
            .or_else(|| identity["pid"].as_f64().map(|value| value as i64))
            .unwrap();
        let started_at = identity["startedAt"].as_str().unwrap();
        let client = self.database.client().await?;
        let row = client
            .query_one(
                "INSERT INTO operator_presence(repo,id,host,pid,started_at,heartbeat_at)
             VALUES($1,$2,$3,$4::bigint::integer,$5::text::timestamptz,$6)
             ON CONFLICT(repo,id) DO UPDATE SET host=EXCLUDED.host,pid=EXCLUDED.pid,
               heartbeat_at=GREATEST(operator_presence.heartbeat_at,EXCLUDED.heartbeat_at)
             RETURNING repo,id,host,pid,started_at,heartbeat_at",
                &[&repo, &id, &host, &pid, &started_at, &self.now()],
            )
            .await
            .map_err(storage_error)?;
        Ok(presence(&row))
    }
    pub async fn upsert_operator_presence_lossless(
        &self,
        repo: &str,
        input: &crate::protocol::js_value::JsJson,
    ) -> Result<Value, ProtocolError> {
        if repo.is_empty() {
            return Err(ProtocolError::new(500, "internal", "repo is required"));
        }
        let identity =
            crate::protocol::validation::lossless::validate_request("operatorPresence", input)
                .map_err(|error| {
                    let mut prefix =
                        crate::protocol::js_value::JsString::from("invalid request body: ");
                    prefix.0.extend_from_slice(error.units());
                    ProtocolError::validation_js(prefix)
                })?;
        let id = identity["id"].as_js_string().unwrap();
        let host = identity["host"].as_js_string().unwrap();
        let pid = identity["pid"]
            .as_i64()
            .or_else(|| identity["pid"].as_f64().map(|value| value as i64))
            .unwrap();
        let started_at = identity["startedAt"].as_js_string().unwrap();
        let client = self.database.client().await?;
        let row = client
            .query_one(
                "INSERT INTO operator_presence(repo,id,host,pid,started_at,heartbeat_at)
             VALUES($1,$2,$3,$4::bigint::integer,$5::text::timestamptz,$6)
             ON CONFLICT(repo,id) DO UPDATE SET host=EXCLUDED.host,pid=EXCLUDED.pid,
               heartbeat_at=GREATEST(operator_presence.heartbeat_at,EXCLUDED.heartbeat_at)
             RETURNING repo,id,host,pid,started_at,heartbeat_at",
                &[
                    &repo,
                    &crate::protocol::js_postgres::PgText(id),
                    &crate::protocol::js_postgres::PgText(host),
                    &pid,
                    &crate::protocol::js_postgres::PgText(started_at),
                    &self.now(),
                ],
            )
            .await
            .map_err(storage_error)?;
        Ok(presence(&row))
    }
    pub async fn list_operator_presence(&self, repo: &str) -> Result<Value, ProtocolError> {
        let cutoff = self.now() - Duration::milliseconds(OPERATOR_PRESENCE_TTL_MS);
        let client = self.database.client().await?;
        let rows = client
            .query(
                "SELECT repo,id,host,pid,started_at,heartbeat_at FROM operator_presence
             WHERE repo=$1 AND heartbeat_at>$2 ORDER BY id",
                &[&repo, &cutoff],
            )
            .await
            .map_err(storage_error)?;
        Ok(rows.iter().map(presence).collect::<Vec<_>>().into())
    }
}
