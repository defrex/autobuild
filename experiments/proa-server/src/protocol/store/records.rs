pub(crate) use super::records_lossless::record_lossless;
use super::{timestamp, Store};
use crate::protocol::error::ProtocolError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_postgres::{GenericClient, Row};

/// Parsed identity fields. The optional initial event is validated separately
/// before either the record or its first fact may become visible.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmptyBuildInput {
    pub slug: String,
    pub repo: String,
    pub ticket: Option<Value>,
    pub branch: Option<String>,
    pub repo_origin: Option<String>,
}
#[derive(Clone, Copy)]
pub enum Scope<'a> {
    Build(&'a str),
    Repo(&'a str),
    Session(&'a str),
}
impl<'a> Scope<'a> {
    pub fn id(self) -> &'a str {
        match self {
            Self::Build(id) | Self::Repo(id) | Self::Session(id) => id,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Build(_) => "build",
            Self::Repo(_) => "repo",
            Self::Session(_) => "session",
        }
    }
    pub fn table(self) -> &'static str {
        match self {
            Self::Build(_) => "builds",
            Self::Repo(_) => "repo_streams",
            Self::Session(_) => "sessions",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Build(_) => "slug",
            Self::Repo(_) => "repo",
            Self::Session(_) => "id",
        }
    }
    pub fn events(self) -> &'static str {
        match self {
            Self::Build(_) => "events",
            Self::Repo(_) => "repo_events",
            Self::Session(_) => "session_events",
        }
    }
    pub fn event_key(self) -> &'static str {
        self.name()
    }
}
pub fn row_timestamp(row: &Row, key: &str) -> String {
    timestamp(row.get::<_, DateTime<Utc>>(key))
}
pub fn record(row: &Row, scope: Scope<'_>) -> Value {
    let mut result = json!({"repo": row.get::<_, String>("repo"), "createdAt": row_timestamp(row, "created_at"), "updatedAt": row_timestamp(row, "updated_at")});
    match scope {
        Scope::Build(_) => {
            result["slug"] = row.get::<_, String>("slug").into();
            if let Some(ticket) = row
                .get::<_, Option<crate::protocol::js_json::JsValue>>("ticket")
                .map(|value| value.0)
            {
                result["ticket"] = ticket;
            }
            for (column, field) in [("branch", "branch"), ("repo_origin", "repoOrigin")] {
                if let Some(value) = row.get::<_, Option<String>>(column) {
                    if !value.is_empty() {
                        result[field] = value.into();
                    }
                }
            }
        }
        Scope::Repo(_) => {
            if let Some(tick) = row
                .get::<_, Option<crate::protocol::js_json::JsValue>>("tick")
                .map(|value| value.0)
            {
                result["tick"] = tick;
            }
        }
        Scope::Session(_) => {
            result["id"] = row.get::<_, String>("id").into();
            result["operator"] = row.get::<_, String>("operator").into();
            if let Some(title) = row.get::<_, Option<String>>("title") {
                result["title"] = title.into();
            }
            return result;
        }
    }
    if let Some(heartbeat) = row.get::<_, Option<DateTime<Utc>>>("heartbeat_at") {
        result["heartbeatAt"] = timestamp(heartbeat).into();
    }
    if let (Some(holder), Some(expiry)) = (
        row.get::<_, Option<String>>("lease_holder"),
        row.get::<_, Option<DateTime<Utc>>>("lease_expires_at"),
    ) {
        if !holder.is_empty() {
            result["lease"] = json!({"holder": holder, "expiresAt": timestamp(expiry)});
        }
    }
    result
}
pub async fn lock<C: GenericClient + Sync>(
    client: &C,
    scope: Scope<'_>,
) -> Result<Row, ProtocolError> {
    client
        .query_opt(
            &format!(
                "SELECT * FROM {} WHERE {}=$1 FOR UPDATE",
                scope.table(),
                scope.key()
            ),
            &[&scope.id()],
        )
        .await?
        .ok_or_else(|| ProtocolError::missing(scope.name(), scope.id()))
}
// The TypeScript adapter projects hosted IDs only in record reads. Stored bytes
// and event history remain unchanged. The shared schema owns the ticket table.
async fn current_record<C: GenericClient + Sync>(
    client: &C,
    row: &Row,
    scope: Scope<'_>,
) -> Result<Value, ProtocolError> {
    let mut value = record(row, scope);
    if matches!(scope, Scope::Build(_)) && value["ticket"]["source"] == "hosted" {
        if let Some(id) = value["ticket"]["id"].as_str() {
            let repo = value["repo"].as_str().unwrap();
            if let Some((_, Some(id))) = super::assets::hosted_ticket(client, repo, id).await? {
                if !id.is_empty() {
                    value["ticket"]["id"] = id.into();
                }
            }
        }
    }
    Ok(value)
}
impl Store {
    pub async fn create_build_lossless(
        &self,
        input: &crate::protocol::js_value::JsJson,
    ) -> Result<Value, ProtocolError> {
        use crate::protocol::{
            js_postgres::{PgJson, PgText},
            js_value::JsString,
            validation::lossless_writes,
        };
        let created = lossless_writes::validate_created_event(input)
            .map_err(|error| ProtocolError::new_js(422, "validation", error))?;
        let slug = input["slug"]
            .as_js_string()
            .ok_or_else(ProtocolError::internal)?;
        let repo = input["repo"]
            .as_js_string()
            .ok_or_else(ProtocolError::internal)?;
        let ticket = input.get("ticket").map(PgJson);
        let branch = input
            .get("branch")
            .and_then(|v| v.as_js_string())
            .map(PgText);
        let origin = input
            .get("repoOrigin")
            .and_then(|v| v.as_js_string())
            .map(PgText);
        let now = self.now();
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let inserted = tx.query_opt("INSERT INTO builds(slug,repo,ticket,branch,repo_origin,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(slug) DO NOTHING RETURNING slug",&[&PgText(slug),&PgText(repo),&ticket,&branch,&origin,&now]).await.map_err(ProtocolError::query)?;
        // This identifier names an already encoded database row, not authority.
        let sql_slug = slug.to_usv_string();
        let scope = Scope::Build(&sql_slug);
        let row = lock(&tx, scope).await?;
        if inserted.is_none() {
            let mut error = JsString::from("build \"");
            error.0.extend_from_slice(slug.units());
            error.0.extend("\" already exists".encode_utf16());
            return Err(ProtocolError::new_js(409, "conflict", error));
        }
        let row = if let Some(created) = created {
            super::events::insert_prepared_lossless(&tx, scope, &created, 1, self.now()).await?;
            lock(&tx, scope).await?
        } else {
            row
        };
        let value = current_record(&tx, &row, scope).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(value)
    }
    pub async fn create_empty_build(&self, input: EmptyBuildInput) -> Result<Value, ProtocolError> {
        self.create_build_inner(input, None).await
    }
    pub async fn create_build(&self, input: &Value) -> Result<Value, ProtocolError> {
        let created = crate::protocol::validation::writes::validate_created_event(input)
            .map_err(|error| ProtocolError::new(422, "validation", error))?;
        let mut identity = input.clone();
        identity
            .as_object_mut()
            .ok_or_else(ProtocolError::internal)?
            .remove("created");
        let identity: EmptyBuildInput =
            serde_json::from_value(identity).map_err(|_| ProtocolError::internal())?;
        self.create_build_inner(identity, created).await
    }
    async fn create_build_inner(
        &self,
        input: EmptyBuildInput,
        created: Option<Value>,
    ) -> Result<Value, ProtocolError> {
        let now = self.now();
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let inserted = tx.query_opt("INSERT INTO builds(slug,repo,ticket,branch,repo_origin,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(slug) DO NOTHING RETURNING slug", &[&input.slug, &input.repo, &input.ticket, &input.branch, &input.repo_origin, &now]).await?;
        let scope = Scope::Build(&input.slug);
        let row = lock(&tx, scope).await?;
        if inserted.is_none() {
            return Err(ProtocolError::new(
                409,
                "conflict",
                format!("build \"{}\" already exists", input.slug),
            ));
        }
        let row = if let Some(created) = created {
            super::events::insert_prepared(&tx, scope, &created, 1, self.now()).await?;
            lock(&tx, scope).await?
        } else {
            row
        };
        let value = current_record(&tx, &row, scope).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(value)
    }
    pub async fn ensure_repo_lossless(
        &self,
        repo: &crate::protocol::js_value::JsString,
    ) -> Result<Value, ProtocolError> {
        use crate::protocol::js_postgres::PgText;
        if repo.is_empty() {
            return Err(ProtocolError::validation("repo is required"));
        }
        let now = self.now();
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        tx.execute("INSERT INTO repo_streams(repo,created_at,updated_at) VALUES($1,$2,$2) ON CONFLICT(repo) DO NOTHING", &[&PgText(repo),&now]).await?;
        let row = tx
            .query_one(
                "SELECT * FROM repo_streams WHERE repo=$1 FOR UPDATE",
                &[&PgText(repo)],
            )
            .await?;
        let value = record(&row, Scope::Repo(""));
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(value)
    }
    pub async fn ensure_repo(&self, repo: &str) -> Result<Value, ProtocolError> {
        if repo.is_empty() {
            return Err(ProtocolError::validation("repo is required"));
        }
        let now = self.now();
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        tx.execute("INSERT INTO repo_streams(repo,created_at,updated_at) VALUES($1,$2,$2) ON CONFLICT(repo) DO NOTHING", &[&repo, &now]).await?;
        let value = record(&lock(&tx, Scope::Repo(repo)).await?, Scope::Repo(repo));
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(value)
    }
    pub async fn get_record(&self, scope: Scope<'_>) -> Result<Value, ProtocolError> {
        self.get_record_lossless(scope)
            .await?
            .to_serde_checked()
            .map_err(|_| ProtocolError::internal())
    }
    pub async fn list_builds(&self, repo: Option<&str>) -> Result<Value, ProtocolError> {
        let repo = repo.map(crate::protocol::js_value::JsString::from);
        self.list_builds_js(repo.as_ref()).await
    }
    pub async fn list_builds_js(
        &self,
        repo: Option<&crate::protocol::js_value::JsString>,
    ) -> Result<Value, ProtocolError> {
        let repo = repo.map(crate::protocol::js_postgres::PgText);
        let client = self.database.client().await?;
        let rows = if super::assets::has_readable_ticket_schema(&**client).await? {
            client.query("SELECT b.*, t.readable_id AS projected_ticket_id FROM builds b LEFT JOIN LATERAL (SELECT readable_id FROM ab_tickets WHERE b.ticket->>'source'='hosted' AND repo=b.repo AND (id=b.ticket->>'id' OR lower(readable_id)=lower(b.ticket->>'id')) LIMIT 1) t ON true WHERE ($1::text IS NULL OR b.repo=$1) ORDER BY b.created_at,b.slug", &[&repo]).await?
        } else {
            client.query("SELECT b.*,NULL::text AS projected_ticket_id FROM builds b WHERE ($1::text IS NULL OR b.repo=$1) ORDER BY b.created_at,b.slug", &[&repo]).await?
        };
        let mut values = Vec::new();
        for row in rows {
            let mut value = record(&row, Scope::Build(""));
            if let Some(id) = row.get::<_, Option<String>>("projected_ticket_id") {
                value["ticket"]["id"] = id.into();
            }
            values.push(value);
        }
        Ok(values.into())
    }
    pub async fn list_sessions(&self, repo: &str) -> Result<Value, ProtocolError> {
        let client = self.database.client().await?;
        let rows = client
            .query(
                "SELECT * FROM sessions WHERE repo=$1 ORDER BY created_at,creation_seq",
                &[&repo],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|row| record(row, Scope::Session("")))
            .collect::<Vec<_>>()
            .into())
    }
    pub async fn change_position(&self, repo: &str) -> Result<String, ProtocolError> {
        let client = self.database.client().await?;
        Ok(client
            .query_opt(
                "SELECT position::text AS position FROM repo_change_positions WHERE repo=$1",
                &[&repo],
            )
            .await?
            .map(|row| row.get(0))
            .unwrap_or_else(|| "0".into()))
    }
    pub async fn read_events(&self, scope: Scope<'_>, since: i64) -> Result<Value, ProtocolError> {
        let client = self.database.client().await?;
        // Match store existence gates without routing data through a browser projection.
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
        let mut events = Vec::new();
        for row in rows {
            events.push(super::events::event_record(&row, scope)?);
        }
        Ok(events.into())
    }
}

impl Store {
    /// Each iteration releases the pooled connection; frozen test clocks never
    /// control held-read deadlines. Dropping the future drops its sleep/query.
    pub async fn read_events_held(
        &self,
        scope: Scope<'_>,
        since: i64,
        wait_seconds: u64,
    ) -> Result<Value, ProtocolError> {
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(wait_seconds.min(30));
        loop {
            let events = self.read_events(scope, since).await?;
            let now = tokio::time::Instant::now();
            if events.as_array().is_some_and(|events| !events.is_empty()) || now >= deadline {
                return Ok(events);
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
}
