//! Read column semantics follow the source adapter, independently of producer
//! validation. Legacy encoded documents retain JavaScript UTF-16 values.
use super::{
    assets,
    records::{row_timestamp, Scope},
    timestamp, Store,
};
use crate::protocol::{
    error::ProtocolError,
    js_postgres::{decode_json_column, json_truthy, PgText, PgValue},
    js_value::{JsJson as J, JsString as S},
};
use chrono::{DateTime, Utc};
use tokio_postgres::{GenericClient, Row};
fn text(v: impl Into<S>) -> J {
    J::String(v.into())
}
fn put(value: &mut J, field: &str, data: J) {
    value[field] = data;
}
pub(crate) fn record_lossless(row: &Row, scope: Scope<'_>) -> Result<J, ProtocolError> {
    let mut value = J::Object(vec![
        (S::from("repo"), text(row.get::<_, String>("repo"))),
        (S::from("createdAt"), text(row_timestamp(row, "created_at"))),
        (S::from("updatedAt"), text(row_timestamp(row, "updated_at"))),
    ]);
    match scope {
        Scope::Build(_) => {
            put(&mut value, "slug", text(row.get::<_, String>("slug")));
            if let Some(ticket) = row
                .get::<_, Option<PgValue>>("ticket")
                .map(|v| v.0)
                .filter(json_truthy)
            {
                put(&mut value, "ticket", decode_json_column(ticket)?);
            }
            for (column, field) in [("branch", "branch"), ("repo_origin", "repoOrigin")] {
                if let Some(v) = row
                    .get::<_, Option<String>>(column)
                    .filter(|v| !v.is_empty())
                {
                    put(&mut value, field, text(v));
                }
            }
        }
        Scope::Repo(_) => {
            // Source repoRecord copies this column directly: it is not json().
            if let Some(tick) = row
                .get::<_, Option<PgValue>>("tick")
                .map(|v| v.0)
                .filter(json_truthy)
            {
                put(&mut value, "tick", tick);
            }
        }
        Scope::Session(_) => {
            put(&mut value, "id", text(row.get::<_, String>("id")));
            put(
                &mut value,
                "operator",
                text(row.get::<_, String>("operator")),
            );
            if let Some(v) = row.get::<_, Option<String>>("title") {
                put(&mut value, "title", text(v));
            }
            return Ok(value);
        }
    }
    if let Some(v) = row.get::<_, Option<DateTime<Utc>>>("heartbeat_at") {
        put(&mut value, "heartbeatAt", text(timestamp(v)));
    }
    if let (Some(holder), Some(expiry)) = (
        row.get::<_, Option<String>>("lease_holder"),
        row.get::<_, Option<DateTime<Utc>>>("lease_expires_at"),
    ) {
        if !holder.is_empty() {
            put(
                &mut value,
                "lease",
                J::Object(vec![
                    (S::from("holder"), text(holder)),
                    (S::from("expiresAt"), text(timestamp(expiry))),
                ]),
            );
        }
    }
    Ok(value)
}
async fn current_record_lossless<C: GenericClient + Sync>(
    client: &C,
    row: &Row,
    scope: Scope<'_>,
) -> Result<J, ProtocolError> {
    let mut value = record_lossless(row, scope)?;
    if matches!(scope, Scope::Build(_)) && value["ticket"]["source"] == "hosted" {
        if let Some(id) = value["ticket"]["id"].as_js_string() {
            let repo = value["repo"]
                .as_js_string()
                .unwrap()
                .to_scalar()
                .map_err(|_| ProtocolError::internal())?;
            // hosted_ticket only binds TEXT and returns a database identity;
            // retain the original ticket value unless a readable id is found.
            if let Some((_, Some(id))) =
                assets::hosted_ticket(client, &repo, &id.to_usv_string()).await?
            {
                if !id.is_empty() {
                    value["ticket"]["id"] = text(id);
                }
            }
        }
    }
    Ok(value)
}
impl Store {
    pub async fn get_record_lossless(&self, scope: Scope<'_>) -> Result<J, ProtocolError> {
        let client = self.database.client().await?;
        match client
            .query_opt(
                &format!("SELECT * FROM {} WHERE {}=$1", scope.table(), scope.key()),
                &[&scope.id()],
            )
            .await?
        {
            Some(row) => current_record_lossless(&**client, &row, scope).await,
            None => Ok(J::Null),
        }
    }
    pub async fn list_builds_lossless(&self, repo: Option<&S>) -> Result<J, ProtocolError> {
        let repo = repo.map(PgText);
        let client = self.database.client().await?;
        // Keep the source's SQL projection semantics: list projection examines
        // the stored JSONB object, while a single-record lookup decodes first.
        let rows = if assets::has_readable_ticket_schema(&**client).await? {
            client.query("SELECT b.*, t.readable_id AS projected_ticket_id FROM builds b LEFT JOIN LATERAL (SELECT readable_id FROM ab_tickets WHERE b.ticket->>'source'='hosted' AND repo=b.repo AND (id=b.ticket->>'id' OR lower(readable_id)=lower(b.ticket->>'id')) LIMIT 1) t ON true WHERE ($1::text IS NULL OR b.repo=$1) ORDER BY b.created_at,b.slug",&[&repo]).await?
        } else {
            client.query("SELECT b.*,NULL::text AS projected_ticket_id FROM builds b WHERE ($1::text IS NULL OR b.repo=$1) ORDER BY b.created_at,b.slug",&[&repo]).await?
        };
        let mut values = Vec::new();
        for row in rows {
            let mut value = record_lossless(&row, Scope::Build(""))?;
            if value.get("ticket").is_some_and(json_truthy) {
                if let Some(id) = row
                    .get::<_, Option<String>>("projected_ticket_id")
                    .filter(|v| !v.is_empty())
                {
                    value["ticket"]["id"] = text(id);
                }
            }
            values.push(value);
        }
        Ok(J::Array(values))
    }
    pub async fn list_sessions_lossless(&self, repo: &str) -> Result<J, ProtocolError> {
        let client = self.database.client().await?;
        let rows = client
            .query(
                "SELECT * FROM sessions WHERE repo=$1 ORDER BY created_at,creation_seq",
                &[&repo],
            )
            .await?;
        Ok(J::Array(
            rows.iter()
                .map(|row| record_lossless(row, Scope::Session("")))
                .collect::<Result<_, _>>()?,
        ))
    }
    pub async fn read_events_lossless(
        &self,
        scope: Scope<'_>,
        since: i64,
    ) -> Result<J, ProtocolError> {
        let client = self.database.client().await?;
        if client
            .query_opt(
                &format!("SELECT 1 FROM {} WHERE {}=$1", scope.table(), scope.key()),
                &[&scope.id()],
            )
            .await?
            .is_none()
        {
            return Err(ProtocolError::missing(scope.name(), scope.id()));
        }
        let rows = client
            .query(
                &format!(
                    "SELECT * FROM {} WHERE {}=$1 AND seq>$2 ORDER BY seq",
                    scope.events(),
                    scope.event_key()
                ),
                &[&scope.id(), &since],
            )
            .await?;
        Ok(J::Array(
            rows.iter()
                .map(|row| super::events::event_record_lossless(row, scope))
                .collect::<Result<_, _>>()?,
        ))
    }
    pub async fn read_events_held_lossless(
        &self,
        scope: Scope<'_>,
        since: i64,
        wait_seconds: u64,
    ) -> Result<J, ProtocolError> {
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(wait_seconds.min(30));
        loop {
            let events = self.read_events_lossless(scope, since).await?;
            if events.as_array().is_some_and(|v| !v.is_empty())
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(events);
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
}
