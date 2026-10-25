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
    client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl std::ops::Deref for Connection {
    type Target = Client;
    fn deref(&self) -> &Client {
        &self.client
    }
}
impl std::ops::DerefMut for Connection {
    fn deref_mut(&mut self) -> &mut Client {
        &mut self.client
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn timestamp(row: &Row, name: &str) -> String {
    row.get::<_, DateTime<Utc>>(name)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
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
impl PostgresReader {
    pub async fn connect(url: &str) -> Result<Self, DataError> {
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
        let tls = MakeRustlsConnect::new(config);
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

    async fn open(url: &str, tls: MakeRustlsConnect) -> Result<Connection, DataError> {
        // The URL's sslmode and certificate validation apply on every reconnect.
        let (client, connection) = tokio_postgres::connect(url, tls)
            .await
            .map_err(|_| DataError::Connection)?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut result = Connection { client, task };
        Self::preflight_client(&mut result.client).await?;
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
        if client.is_closed() {
            *client = Self::open(&self.url, self.tls.clone()).await?;
        }
        Ok(client)
    }

    pub async fn preflight(&self) -> Result<(), DataError> {
        let mut client = self.client().await?;
        Self::preflight_client(&mut client).await
    }

    async fn preflight_client(client: &mut Client) -> Result<(), DataError> {
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
        let rows = tx.query("SELECT b.slug,b.ticket,b.branch,b.created_at,b.updated_at,(SELECT COALESCE(MAX(seq),0) FROM events WHERE build=b.slug) AS event_seq, false AS deleted FROM builds b LEFT JOIN jsonb_to_recordset($2::jsonb) AS k(slug text,seq bigint,updated text) ON k.slug=b.slug WHERE b.repo=$1 AND (k.slug IS NULL OR b.updated_at <> k.updated::timestamptz OR EXISTS(SELECT 1 FROM events e WHERE e.build=b.slug AND e.seq>k.seq)) UNION ALL SELECT k.slug,NULL::jsonb,NULL::text,now(),now(),0::bigint,true FROM jsonb_to_recordset($2::jsonb) AS k(slug text,seq bigint,updated text) WHERE NOT EXISTS(SELECT 1 FROM builds b WHERE b.repo=$1 AND b.slug=k.slug) ORDER BY 4,1", &[&repo,known]).await.map_err(|_|DataError::Query)?;
        let result = rows.iter().map(|row| {
            if row.get::<_,bool>("deleted") {return json!({"slug":row.get::<_,String>("slug"),"deleted":true});}
            let mut record = json!({"slug":row.get::<_,String>("slug"),"repo":repo,"createdAt":timestamp(row,"created_at"),"updatedAt":timestamp(row,"updated_at"),"eventSeq":row.get::<_,i64>("event_seq")});
            if let Some(ticket) = row.get::<_,Option<Value>>("ticket") {record["ticket"]=ticket;}
            if let Some(branch) = row.get::<_,Option<String>>("branch") {record["branch"]=json!(branch);}
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
                    "actor": row.get::<_, Value>("actor"), "type": row.get::<_, String>("type"),
                    "payload": row.get::<_, Value>("payload"),
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
                if let Ok(Some(compatibility)) = row.try_get::<_, Option<Value>>("compatibility") {
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
        let rows = tx.query("SELECT slug, repo, ticket, branch, created_at, updated_at FROM builds WHERE repo = $1 ORDER BY created_at, slug", &[&repo])
            .await.map_err(|_| DataError::Query)?;
        let result = rows.iter().map(|row| {
            let mut record = json!({ "slug": row.get::<_, String>("slug"), "repo": repo,
                "createdAt": timestamp(row, "created_at"), "updatedAt": timestamp(row, "updated_at") });
            if let Some(ticket) = row.get::<_, Option<Value>>("ticket") { record["ticket"] = ticket; }
            if let Some(branch) = row.get::<_, Option<String>>("branch") { record["branch"] = json!(branch); }
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
        let rows = tx
            .query(
                "SELECT ticket,branch,created_at,updated_at FROM builds WHERE repo=$1 AND slug=$2",
                &[&repo, &slug],
            )
            .await
            .map_err(|_| DataError::Query)?;
        let result=rows.first().map(|row|{
            let mut value=json!({"slug":slug,"repo":repo,"createdAt":timestamp(row,"created_at"),"updatedAt":timestamp(row,"updated_at")});
            if let Some(ticket)=row.get::<_,Option<Value>>("ticket"){value["ticket"]=ticket;}
            if let Some(branch)=row.get::<_,Option<String>>("branch"){value["branch"]=json!(branch);}
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

    pub async fn sessions(&self, repo: &str) -> Result<Vec<Value>, DataError> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| DataError::Query)?;
        let rows = tx.query("SELECT id, repo, operator, title, created_at, updated_at FROM sessions WHERE repo = $1 ORDER BY created_at, id", &[&repo])
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
            "blobRef": row.get::<_, String>("blob_ref"), "metadata": row.get::<_, Value>("metadata"),
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
