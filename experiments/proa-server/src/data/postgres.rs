//! SELECT-only access to TypeScript-owned storage. No snapshot reads or DDL.
use super::error::DataError;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{Mutex, MutexGuard};
use tokio_postgres::{Client, Row, Transaction};
use tokio_postgres_rustls::MakeRustlsConnect;

pub const SCHEMA_VERSION: i32 = 17;
pub const SCHEMA_CHECKSUM: &str =
    "e1e0e705b2707f3497c2c0cfc607a3720396c6dc1428b34546bbf2b46944577f";

fn validate_marker(version: i32, checksum: Option<&str>) -> Result<(), DataError> {
    if version != SCHEMA_VERSION {
        return Err(DataError::Schema {
            expected: SCHEMA_VERSION,
            found: version.to_string(),
        });
    }
    if checksum != Some(SCHEMA_CHECKSUM) {
        return Err(DataError::Checksum { version });
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub enum Scope<'a> {
    Build(&'a str),
    Repository,
    Session(&'a str),
}
impl Scope<'_> {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Build(_) => "build",
            Self::Repository => "repository",
            Self::Session(_) => "session",
        }
    }
}

/// Four independent read-only connections let unrelated scopes advance concurrently.
/// Transactions never share a connection, including during schema preflight.
pub struct PostgresReader {
    connections: Vec<Mutex<Connection>>,
    url: String,
    tls: MakeRustlsConnect,
    next: AtomicUsize,
    metadata_reads: Mutex<std::collections::VecDeque<super::reader::QueryRead>>,
}
struct Connection {
    client: Option<Client>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl std::ops::Deref for Connection {
    type Target = Client;
    fn deref(&self) -> &Client {
        self.client.as_ref().expect("connected reader slot")
    }
}
impl std::ops::DerefMut for Connection {
    fn deref_mut(&mut self) -> &mut Client {
        self.client.as_mut().expect("connected reader slot")
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn timestamp(row: &Row, name: &str) -> String {
    row.get::<_, DateTime<Utc>>(name)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn enrich_build_liveness(record: &mut Value, row: &Row) {
    if let Some(at) = row.get::<_, Option<DateTime<Utc>>>("heartbeat_at") {
        record["heartbeatAt"] = json!(at.to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    if let (Some(holder), Some(expires)) = (
        row.get::<_, Option<String>>("lease_holder"),
        row.get::<_, Option<DateTime<Utc>>>("lease_expires_at"),
    ) {
        record["lease"] = json!({"holder":holder,"expiresAt":expires.to_rfc3339_opts(SecondsFormat::Millis,true)});
    }
}

async fn readable_ticket_schema(tx: &Transaction<'_>) -> Result<bool, DataError> {
    let present: bool = tx
        .query_one(
            "SELECT to_regclass('ab_ticket_schema_migrations') IS NOT NULL",
            &[],
        )
        .await
        .map_err(|_| DataError::Query)?
        .get(0);
    if !present {
        return Ok(false);
    }
    Ok(tx
        .query_opt(
            "SELECT version FROM ab_ticket_schema_migrations WHERE singleton=true",
            &[],
        )
        .await
        .map_err(|_| DataError::Query)?
        .is_some_and(|r| r.get::<_, i32>(0) >= 3))
}
fn projected_ticket(record: &mut Value, row: &Row) {
    if let Some(id) = row.get::<_, Option<String>>("projected_ticket_id") {
        if !record["ticket"].is_null() {
            record["ticket"]["id"] = json!(id);
        }
    }
}

fn stream_parts(raw: Value) -> Result<Value, DataError> {
    // The TypeScript adapter accepts driver-decoded JSON and JSONB strings.
    let value = match raw {
        Value::String(text) => serde_json::from_str(&text).map_err(|_| DataError::Query)?,
        value => value,
    };
    if !value.as_array().is_some_and(|parts| {
        parts
            .iter()
            .all(|part| part["type"].as_str().is_some_and(|kind| !kind.is_empty()))
    }) {
        return Err(DataError::Query);
    }
    Ok(value)
}
/// Shared native-root TLS setup for independent reader and writer pools.
pub(crate) fn connector() -> Result<MakeRustlsConnect, DataError> {
    // Native roots (including SSL_CERT_FILE/SSL_CERT_DIR overrides) preserve
    // platform trust without linking OpenSSL into the captured Proa binary.
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    let config = rustls::ClientConfig::builder_with_provider(
        rustls::crypto::aws_lc_rs::default_provider().into(),
    )
    .with_safe_default_protocol_versions()
    .map_err(|_| DataError::Connection)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(MakeRustlsConnect::new(config))
}

impl PostgresReader {
    pub async fn connect(url: &str) -> Result<Self, DataError> {
        let tls = connector()?;
        let mut connections = Vec::new();
        for _ in 0..4 {
            connections.push(Mutex::new(Self::open(url, tls.clone()).await?));
        }
        let result = Self {
            connections,
            url: url.to_owned(),
            tls,
            next: AtomicUsize::new(0),
            metadata_reads: Mutex::new(Default::default()),
        };
        result.preflight().await?;
        Ok(result)
    }

    /// Application startup may defer network I/O so public health is always
    /// available. Every first/replacement connection still preflights before use.
    pub fn deferred(url: &str) -> Result<Self, DataError> {
        Ok(Self {
            connections: (0..4)
                .map(|_| {
                    Mutex::new(Connection {
                        client: None,
                        task: None,
                    })
                })
                .collect(),
            url: url.into(),
            tls: connector()?,
            next: AtomicUsize::new(0),
            metadata_reads: Mutex::new(std::collections::VecDeque::new()),
        })
    }
    async fn open(url: &str, tls: MakeRustlsConnect) -> Result<Connection, DataError> {
        // The URL's sslmode and certificate validation apply on every reconnect.
        let (client, connection) = tokio_postgres::connect(url, tls)
            .await
            .map_err(|_| DataError::Connection)?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut result = Connection {
            client: Some(client),
            task: Some(task),
        };
        Self::preflight_client(result.client.as_mut().expect("connected reader slot")).await?;
        Ok(result)
    }

    async fn client(&self) -> Result<MutexGuard<'_, Connection>, DataError> {
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.connections.len();
        let mut selected = None;
        for offset in 0..self.connections.len() {
            if let Ok(client) =
                self.connections[(index + offset) % self.connections.len()].try_lock()
            {
                selected = Some(client);
                break;
            }
        }
        let mut client = match selected {
            Some(client) => client,
            None => self.connections[index].lock().await,
        };
        // Replacement stays under the slot lock, so concurrent callers cannot
        // race reconnection. Failed connects leave a closed slot retryable.
        if client.client.as_ref().is_none_or(Client::is_closed) {
            *client = Self::open(&self.url, self.tls.clone()).await?;
        }
        Ok(client)
    }

    pub async fn preflight(&self) -> Result<(), DataError> {
        let mut client = self.client().await?;
        Self::preflight_client(&mut client).await
    }

    pub(crate) async fn preflight_client(client: &mut Client) -> Result<(), DataError> {
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let exists: bool = tx
            .query_one(
                "SELECT to_regclass('ab_schema_migrations') IS NOT NULL",
                &[],
            )
            .await
            .map_err(|_| DataError::Query)?
            .get(0);
        if !exists {
            return Err(DataError::Schema {
                expected: SCHEMA_VERSION,
                found: "absent".into(),
            });
        }
        let rows = tx
            .query(
                "SELECT version, checksum FROM ab_schema_migrations WHERE singleton = true",
                &[],
            )
            .await
            .map_err(|_| DataError::Schema {
                expected: SCHEMA_VERSION,
                found: "malformed".into(),
            })?;
        let Some(row) = rows.first().filter(|_| rows.len() == 1) else {
            return Err(DataError::Schema {
                expected: SCHEMA_VERSION,
                found: "absent or malformed".into(),
            });
        };
        let version: i32 = row.try_get("version").map_err(|_| DataError::Schema {
            expected: SCHEMA_VERSION,
            found: "malformed".into(),
        })?;
        validate_marker(
            version,
            row.try_get::<_, String>("checksum").ok().as_deref(),
        )?;
        tx.commit().await.map_err(|_| DataError::Query)
    }

    pub async fn reset_metadata_counts(&self) {
        self.metadata_reads.lock().await.clear();
    }
    pub async fn metadata_counts(&self) -> Vec<super::reader::QueryRead> {
        self.metadata_reads.lock().await.iter().cloned().collect()
    }
    async fn metadata_read(&self, repo: &str, scope: &str, rows: usize) {
        let read = super::reader::QueryRead {
            project: repo.into(),
            scope: format!("metadata:{scope}"),
            after: 0,
            rows,
        };
        tracing::debug!(
            "suffix-read {}",
            serde_json::to_string(&read).unwrap_or_default()
        );
        let mut reads = self.metadata_reads.lock().await;
        if reads.len() == 1024 {
            reads.pop_front();
        }
        reads.push_back(read);
    }
    /// One indexed discovery query returns only new/changed records. The durable
    /// event cursor, not timestamps, detects appends even with a backdated clock.
    pub async fn changed_builds(&self, repo: &str, known: &Value) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let projected = if readable_ticket_schema(&tx).await? {
            "(SELECT readable_id FROM ab_tickets WHERE b.ticket->>'source'='hosted' AND repo=b.repo AND (id=b.ticket->>'id' OR lower(readable_id)=lower(b.ticket->>'id')) LIMIT 1)"
        } else {
            "NULL::text"
        };
        let query=format!("SELECT b.slug,b.ticket,b.branch,b.created_at,b.updated_at,b.heartbeat_at,b.lease_holder,b.lease_expires_at,(SELECT COALESCE(MAX(seq),0) FROM events WHERE build=b.slug) AS event_seq, false AS deleted,{projected} AS projected_ticket_id FROM builds b LEFT JOIN jsonb_to_recordset($2::jsonb) AS k(slug text,seq bigint,updated text) ON k.slug=b.slug WHERE b.repo=$1 AND (k.slug IS NULL OR b.updated_at <> k.updated::timestamptz OR EXISTS(SELECT 1 FROM events e WHERE e.build=b.slug AND e.seq>k.seq)) UNION ALL SELECT k.slug,NULL::jsonb,NULL::text,now(),now(),NULL::timestamptz,NULL::text,NULL::timestamptz,0::bigint,true,NULL::text FROM jsonb_to_recordset($2::jsonb) AS k(slug text,seq bigint,updated text) WHERE NOT EXISTS(SELECT 1 FROM builds b WHERE b.repo=$1 AND b.slug=k.slug) ORDER BY 4,1");
        let rows = tx
            .query(&query, &[&repo, known])
            .await
            .map_err(|_| DataError::Query)?;
        let result = rows.iter().map(|row| {
            if row.get::<_,bool>("deleted") {return json!({"slug":row.get::<_,String>("slug"),"deleted":true});}
            let mut record = json!({"slug":row.get::<_,String>("slug"),"repo":repo,"createdAt":timestamp(row,"created_at"),"updatedAt":timestamp(row,"updated_at"),"eventSeq":row.get::<_,i64>("event_seq")});
            if let Some(ticket) = row.get::<_,Option<Value>>("ticket") {record["ticket"]=ticket;}
            if let Some(branch) = row.get::<_,Option<String>>("branch") {record["branch"]=json!(branch);}
            enrich_build_liveness(&mut record,row);
            projected_ticket(&mut record,row);
            record
        }).collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, "build-discovery", rows.len())
            .await;
        Ok(result)
    }
    pub async fn projects(&self) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let rows = tx.query("SELECT repo, actor, ts FROM (SELECT DISTINCT ON (repo) repo, action, actor, ts FROM project_journal ORDER BY repo, seq DESC) latest WHERE action = 'added' ORDER BY repo", &[])
            .await.map_err(|_| DataError::Query)?;
        let result = rows.iter().map(|row| json!({ "repo": row.get::<_, String>("repo"), "addedAt": timestamp(row, "ts"), "addedBy": row.get::<_, String>("actor") })).collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read("registry", "projects", rows.len()).await;
        Ok(result)
    }

    async fn assert_scope(
        tx: &Transaction<'_>,
        repo: &str,
        scope: Scope<'_>,
    ) -> Result<(), DataError> {
        let exists: bool = match scope {
            Scope::Build(slug) => {
                tx.query_one(
                    "SELECT EXISTS(SELECT 1 FROM builds WHERE repo = $1 AND slug = $2)",
                    &[&repo, &slug],
                )
                .await
            }
            Scope::Repository => {
                tx.query_one(
                    "SELECT EXISTS(SELECT 1 FROM repo_streams WHERE repo = $1)",
                    &[&repo],
                )
                .await
            }
            Scope::Session(id) => {
                tx.query_one(
                    "SELECT EXISTS(SELECT 1 FROM sessions WHERE repo = $1 AND id = $2)",
                    &[&repo, &id],
                )
                .await
            }
        }
        .map_err(|_| DataError::Query)?
        .get(0);
        if !exists {
            return Err(DataError::MissingScope {
                scope: scope.name(),
            });
        }
        Ok(())
    }

    /// The cursor and every sequence/revision are signed PostgreSQL bigint,
    /// never converted through a floating point value.
    pub async fn events(
        &self,
        repo: &str,
        scope: Scope<'_>,
        after: i64,
    ) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        Self::assert_scope(&tx, repo, scope).await?;
        let rows = match scope {
            Scope::Build(slug) => tx.query("SELECT e.* FROM events e JOIN builds b ON b.slug = e.build WHERE b.repo = $1 AND e.build = $2 AND e.seq > $3 ORDER BY e.seq", &[&repo, &slug, &after]).await,
            Scope::Repository => tx.query("SELECT * FROM repo_events WHERE repo = $1 AND seq > $2 ORDER BY seq", &[&repo, &after]).await,
            Scope::Session(id) => tx.query("SELECT e.* FROM session_events e JOIN sessions s ON s.id = e.session WHERE s.repo = $1 AND e.session = $2 AND e.seq > $3 ORDER BY e.seq", &[&repo, &id, &after]).await,
        }.map_err(|_| DataError::Query)?;
        let result = rows
            .iter()
            .map(|row| {
                let mut event = json!({
                    "seq": row.get::<_, i64>("seq"), "ts": timestamp(row, "ts"),
                    "actor": row.get::<_,crate::protocol::js_json::JsValue>("actor").0, "type": row.get::<_, String>("type"),
                    "payload": row.get::<_,crate::protocol::js_json::JsValue>("payload").0,
                });
                match scope {
                    Scope::Build(slug) => {
                        event["build"] = json!(slug);
                    }
                    Scope::Repository => {
                        event["repo"] = json!(repo);
                    }
                    Scope::Session(id) => {
                        event["session"] = json!(id);
                    }
                }
                if let Ok(Some(compatibility)) = row.try_get::<_,Option<crate::protocol::js_json::JsValue>>("compatibility").map(|value|value.map(|value|value.0)) {
                    event["compatibility"] = compatibility;
                }
                event
            })
            .collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        Ok(result)
    }

    pub async fn builds(&self, repo: &str) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let readable = readable_ticket_schema(&tx).await?;
        let query = if readable {
            "SELECT b.*,t.readable_id AS projected_ticket_id FROM builds b LEFT JOIN LATERAL (SELECT readable_id FROM ab_tickets WHERE b.ticket->>'source'='hosted' AND repo=b.repo AND (id=b.ticket->>'id' OR lower(readable_id)=lower(b.ticket->>'id')) LIMIT 1) t ON true WHERE b.repo=$1 ORDER BY b.created_at,b.slug"
        } else {
            "SELECT *,NULL::text AS projected_ticket_id FROM builds WHERE repo=$1 ORDER BY created_at,slug"
        };
        let rows = tx
            .query(query, &[&repo])
            .await
            .map_err(|_| DataError::Query)?;
        let result = rows.iter().map(|row| {
            let mut record = json!({ "slug": row.get::<_, String>("slug"), "repo": repo,
                "createdAt": timestamp(row, "created_at"), "updatedAt": timestamp(row, "updated_at") });
            if let Some(ticket) = row.get::<_,Option<crate::protocol::js_json::JsValue>>("ticket").map(|value|value.0) { record["ticket"] = ticket; }
            if let Some(branch) = row.get::<_, Option<String>>("branch") { record["branch"] = json!(branch); }
            enrich_build_liveness(&mut record,row);
            projected_ticket(&mut record,row);
            record
        }).collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, "builds", rows.len()).await;
        Ok(result)
    }

    pub async fn build_record(&self, repo: &str, slug: &str) -> Result<Option<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let readable = readable_ticket_schema(&tx).await?;
        let query = if readable {
            "SELECT b.*,t.readable_id AS projected_ticket_id FROM builds b LEFT JOIN LATERAL (SELECT readable_id FROM ab_tickets WHERE b.ticket->>'source'='hosted' AND repo=b.repo AND (id=b.ticket->>'id' OR lower(readable_id)=lower(b.ticket->>'id')) LIMIT 1) t ON true WHERE b.repo=$1 AND b.slug=$2"
        } else {
            "SELECT *,NULL::text AS projected_ticket_id FROM builds WHERE repo=$1 AND slug=$2"
        };
        let rows = tx
            .query(query, &[&repo, &slug])
            .await
            .map_err(|_| DataError::Query)?;
        let result=rows.first().map(|row|{
            let mut value=json!({"slug":slug,"repo":repo,"createdAt":timestamp(row,"created_at"),"updatedAt":timestamp(row,"updated_at")});
            if let Some(ticket)=row.get::<_,Option<Value>>("ticket"){value["ticket"]=ticket;}
            if let Some(branch)=row.get::<_,Option<String>>("branch"){value["branch"]=json!(branch);}
            enrich_build_liveness(&mut value,row);
            projected_ticket(&mut value,row);
            value
        });
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, &format!("build-record:{slug}"), rows.len())
            .await;
        Ok(result)
    }
    pub async fn build_streams(
        &self,
        repo: &str,
        slug: &str,
        closed: &[String],
    ) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        Self::assert_scope(&tx, repo, Scope::Build(slug)).await?;
        let rows=tx.query("SELECT s.* FROM streams s JOIN builds b ON b.slug=s.build WHERE b.repo=$1 AND s.build=$2 AND s.scope_kind='build' AND NOT(s.id=ANY($3)) ORDER BY s.created_at,s.id", &[&repo,&slug,&closed]).await.map_err(|_|DataError::Query)?;
        let result=rows.iter().map(|row| {
            let mut value=json!({"id":row.get::<_,String>("id"),"scope":{"kind":"build","build":slug},"label":row.get::<_,String>("label"),"format":row.get::<_,String>("format"),"status":row.get::<_,String>("status"),"createdAt":timestamp(row,"created_at")});
            if let Some(outcome)=row.get::<_,Option<String>>("outcome") {value["outcome"]=json!(outcome);}
            if let Some(kind)=row.get::<_,Option<String>>("artifact_kind") {value["artifact"]=json!({"kind":kind,"revision":row.get::<_,Option<i64>>("artifact_revision"),"blobRef":row.get::<_,Option<String>>("artifact_blob_ref")});}
            value
        }).collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, &format!("streams:{slug}"), rows.len())
            .await;
        Ok(result)
    }
    pub async fn stream_chunks(
        &self,
        repo: &str,
        slug: &str,
        stream: &str,
        after: i64,
    ) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        Self::assert_scope(&tx, repo, Scope::Build(slug)).await?;
        let rows=tx.query("SELECT c.seq,c.ts,c.parts FROM stream_chunks c JOIN streams s ON s.id=c.stream JOIN builds b ON b.slug=s.build WHERE b.repo=$1 AND s.build=$2 AND s.id=$3 AND s.scope_kind='build' AND c.seq>$4 ORDER BY c.seq", &[&repo,&slug,&stream,&after]).await.map_err(|_|DataError::Query)?;
        let result = rows
            .iter()
            .map(|row| {
                let parts = stream_parts(row.get::<_, Value>("parts"))?;
                Ok(json!({"stream":stream,"seq":row.get::<_,i64>("seq"),"parts":parts}))
            })
            .collect::<Result<Vec<_>, DataError>>()?;
        tx.commit().await.map_err(|_| DataError::Query)?;
        Ok(result)
    }

    /// Session-scoped stream reads keep chunks and record on the same read-only connection.
    pub async fn session_stream(
        &self,
        repo: &str,
        session: &str,
        stream: &str,
        after: i64,
    ) -> Result<Value, DataError> {
        let mut connection = self.client().await?;
        let tx = connection
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        Self::assert_scope(&tx, repo, Scope::Session(session)).await?;
        let row = tx.query_opt("SELECT s.* FROM streams s JOIN sessions o ON o.id=s.session WHERE s.id=$1 AND s.scope_kind='session' AND s.session=$2 AND o.repo=$3", &[&stream,&session,&repo]).await.map_err(|_| DataError::Query)?.ok_or(DataError::Query)?;
        let rows = tx
            .query(
                "SELECT * FROM stream_chunks WHERE stream=$1 AND seq>$2 ORDER BY seq",
                &[&stream, &after],
            )
            .await
            .map_err(|_| DataError::Query)?;
        let chunks = rows.iter().map(|r| Ok(json!({"stream":stream,"seq":r.get::<_,i64>("seq"),"ts":timestamp(r,"ts"),"parts":stream_parts(r.get("parts"))?}))).collect::<Result<Vec<Value>,DataError>>()?;
        let mut value = json!({"chunks":chunks,"status":row.get::<_,String>("status")});
        if let Some(outcome) = row.get::<_, Option<String>>("outcome") {
            value["outcome"] = json!(outcome);
        }
        if let (Some(kind), Some(revision), Some(blob)) = (
            row.get::<_, Option<String>>("artifact_kind"),
            row.get::<_, Option<i64>>("artifact_revision"),
            row.get::<_, Option<String>>("artifact_blob_ref"),
        ) {
            value["artifact"] = json!({"kind":kind,"revision":revision,"blobRef":blob});
        }
        tx.commit().await.map_err(|_| DataError::Query)?;
        Ok(value)
    }

    pub async fn sessions(&self, repo: &str) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let rows = tx.query("SELECT id, repo, operator, title, created_at, updated_at FROM sessions WHERE repo = $1 ORDER BY created_at, creation_seq", &[&repo])
            .await.map_err(|_| DataError::Query)?;
        let result = rows.iter().map(|row| {
            let mut record = json!({ "id": row.get::<_, String>("id"), "repo": repo,
                "operator": row.get::<_, String>("operator"), "createdAt": timestamp(row, "created_at"), "updatedAt": timestamp(row, "updated_at") });
            if let Some(title) = row.get::<_, Option<String>>("title") { record["title"] = json!(title); }
            record
        }).collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, "sessions", rows.len()).await;
        Ok(result)
    }

    pub async fn artifact(
        &self,
        repo: &str,
        scope: Scope<'_>,
        kind: &str,
        revision: Option<i64>,
    ) -> Result<Option<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        Self::assert_scope(&tx, repo, scope).await?;
        let rows = match scope {
            Scope::Build(slug) => tx.query("SELECT a.* FROM artifacts a JOIN builds b ON b.slug = a.build WHERE b.repo = $1 AND a.build = $2 AND a.kind = $3 AND ($4::bigint IS NULL OR a.revision = $4) ORDER BY a.revision DESC LIMIT 1", &[&repo, &slug, &kind, &revision]).await,
            Scope::Repository => tx.query("SELECT * FROM repo_artifacts WHERE repo = $1 AND kind = $2 AND ($3::bigint IS NULL OR revision = $3) ORDER BY revision DESC LIMIT 1", &[&repo, &kind, &revision]).await,
            Scope::Session(id) => tx.query("SELECT a.* FROM session_artifacts a JOIN sessions s ON s.id = a.session WHERE s.repo = $1 AND a.session = $2 AND a.kind = $3 AND ($4::bigint IS NULL OR a.revision = $4) ORDER BY a.revision DESC LIMIT 1", &[&repo, &id, &kind, &revision]).await,
        }.map_err(|_| DataError::Query)?;
        let result = rows.first().map(|row| json!({
            "kind": row.get::<_, String>("kind"), "revision": row.get::<_, i64>("revision"),
            "blobRef": row.get::<_, String>("blob_ref"), "metadata": row.get::<_,crate::protocol::js_json::JsValue>("metadata").0,
            "createdAt": timestamp(row, "created_at"),
        }));
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(
            repo,
            &format!(
                "artifact:{kind}:{}",
                match scope {
                    Scope::Build(id) | Scope::Session(id) => id,
                    Scope::Repository => repo,
                }
            ),
            rows.len(),
        )
        .await;
        Ok(result)
    }
}

impl PostgresReader {
    /// Mutable repository liveness is separate from durable event reduction.
    pub async fn repository_record(&self, repo: &str) -> Result<Option<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let row=tx.query_opt("SELECT repo,created_at,updated_at,heartbeat_at,lease_holder,lease_expires_at,tick FROM repo_streams WHERE repo=$1",&[&repo]).await.map_err(|_|DataError::Query)?;
        let out=row.as_ref().map(|r|{let mut v=json!({"repo":repo,"createdAt":timestamp(r,"created_at"),"updatedAt":timestamp(r,"updated_at")});enrich_build_liveness(&mut v,r);if let Some(tick)=r.get::<_,Option<Value>>("tick"){v["tick"]=tick;}v});
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, "repository-record", usize::from(row.is_some()))
            .await;
        Ok(out)
    }
    pub async fn build_exists(&self, repo: &str, slug: &str) -> Result<bool, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let exists = tx
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM builds WHERE slug=$1)",
                &[&slug],
            )
            .await
            .map_err(|_| DataError::Query)?
            .get(0);
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, "build-existence", 1).await;
        Ok(exists)
    }
    /// Correlate the current/last/held runs even when the bounded latest-run journal pruned an older holder.
    pub async fn dispatcher_events(
        &self,
        repo: &str,
        runs: &[String],
    ) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let rows=tx.query("SELECT seq,ts,actor,type,payload FROM repo_events WHERE repo=$1 AND payload->>'run'=ANY($2::text[]) AND type IN ('dispatcher.run-started','dispatcher.run-stopped','dispatcher.runtime-recorded','dispatcher.tick-completed','dispatcher.tick-failed') ORDER BY seq",&[&repo,&runs]).await.map_err(|_|DataError::Query)?;
        let out=rows.iter().map(|r|json!({"repo":repo,"seq":r.get::<_,i64>("seq"),"ts":timestamp(r,"ts"),"actor":r.get::<_,Value>("actor"),"type":r.get::<_,String>("type"),"payload":r.get::<_,Value>("payload")})).collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, "dispatcher-correlations", rows.len())
            .await;
        Ok(out)
    }
}

impl PostgresReader {
    /// Terminal/observation gates are derived from event facts, never snapshots.
    pub async fn api_build_digests(&self, repo: &str) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let rows=tx.query("SELECT b.slug,(SELECT type FROM events e WHERE e.build=b.slug AND type IN ('build.completed','build.aborted') ORDER BY seq DESC LIMIT 1) AS terminal,COALESCE((SELECT jsonb_agg(jsonb_build_object('seq',seq,'ts',ts) ORDER BY seq) FROM events e WHERE e.build=b.slug AND type='observation.recorded'),'[]'::jsonb) AS observations FROM builds b WHERE b.repo=$1 ORDER BY b.created_at,b.slug",&[&repo]).await.map_err(|_|DataError::Query)?;
        let out=rows.iter().map(|r|{let mut v=json!({"slug":r.get::<_,String>("slug"),"observations":r.get::<_,Value>("observations")});if let Some(t)=r.get::<_,Option<String>>("terminal"){v["terminal"]=json!(if t=="build.completed"{"done"}else{"aborted"});}v}).collect();
        tx.commit().await.map_err(|_| DataError::Query)?;
        self.metadata_read(repo, "build-digests", rows.len()).await;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_jsonb_strings_and_decoded_arrays_have_the_same_parts() {
        let parts = json!([{"type":"text-delta","id":"text","delta":"Readable"}]);
        assert_eq!(stream_parts(parts.clone()).unwrap(), parts);
        assert_eq!(stream_parts(json!(parts.to_string())).unwrap(), parts);
        assert!(stream_parts(json!("malformed")).is_err());
        assert!(stream_parts(json!({"type":"text-delta"})).is_err());
    }
    #[test]
    fn refuses_unknown_versions_and_modified_schema() {
        for version in [0, SCHEMA_VERSION - 1, SCHEMA_VERSION + 1] {
            let error = validate_marker(version, Some(SCHEMA_CHECKSUM)).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                "unsupported PostgreSQL schema: expected version {SCHEMA_VERSION}, found {version}"
            )
            );
        }
        assert!(validate_marker(SCHEMA_VERSION, None).is_err());
        assert!(validate_marker(SCHEMA_VERSION, Some("incorrect")).is_err());
        assert!(validate_marker(SCHEMA_VERSION, Some(SCHEMA_CHECKSUM)).is_ok());
    }
}
