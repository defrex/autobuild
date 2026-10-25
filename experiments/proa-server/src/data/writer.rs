//! Native operator mutation boundary. Connections are independent of the SELECT-only reader.
//! Parent row locks serialize with the TypeScript store; no database migrations run here.
use super::{
    error::DataError,
    events,
    postgres::{SCHEMA_CHECKSUM, SCHEMA_VERSION},
    reducers::Scope,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use thiserror::Error;
use tokio::sync::{Mutex, MutexGuard};
use tokio_postgres::{Client, Row};
use tokio_postgres_rustls::MakeRustlsConnect;

#[derive(Debug, Error)]
pub enum WriteError {
    #[error("PostgreSQL connection failed")]
    Connection,
    #[error("PostgreSQL write failed")]
    Storage,
    // PostgreSQL's primary diagnostic only. Query text, details, connection
    // strings and provider response bodies are never retained here.
    #[error("{0}")]
    Database(String),
    #[error(transparent)]
    Schema(#[from] DataError),
    #[error("{0}")]
    Validation(String),
    #[error("unknown {scope} \"{id}\"")]
    Missing { scope: &'static str, id: String },
    #[error("wrong project")]
    WrongProject,
    #[error("project not registered")]
    ProjectNotRegistered,
}
impl WriteError {
    pub(crate) fn database(error: tokio_postgres::Error) -> Self {
        error
            .as_db_error()
            .map(|error| Self::Database(error.message().to_owned()))
            .unwrap_or(Self::Storage)
    }
}
pub(crate) struct Connection {
    pub(crate) client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub struct PostgresWriter {
    connection: Mutex<Connection>,
    url: String,
    tls: MakeRustlsConnect,
}

pub fn normalize_operator(operator: &str) -> Result<&str, WriteError> {
    let operator = operator.trim_matches(crate::operator::auth::js_space);
    if operator.is_empty() {
        return Err(WriteError::Validation("operator is required".into()));
    }
    Ok(operator)
}

fn policy() -> &'static Value {
    static POLICY: OnceLock<Value> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/writer-policy.json"))
            .expect("generated writer policy")
    })
}
fn nonempty(value: &Value, key: &str) -> bool {
    value[key].as_str().is_some_and(|v| !v.is_empty())
}
fn strict_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.keys().all(|k| keys.contains(&k.as_str())))
}
fn actor_valid(actor: &Value) -> bool {
    let keys: &[&str] = match actor["kind"].as_str() {
        Some("human") if nonempty(actor, "user") => &["kind", "user", "via"],
        Some("agent") if nonempty(actor, "role") && nonempty(actor, "session") => {
            &["kind", "role", "session"]
        }
        Some("ingester") if nonempty(actor, "source") => &["kind", "source"],
        Some("kernel" | "dispatcher") => &["kind"],
        _ => return false,
    };
    if !strict_keys(actor, keys) {
        return false;
    }
    match actor.get("via") {
        None => true,
        Some(via) if actor["kind"] == "human" => match via["kind"].as_str() {
            Some("session") => strict_keys(via, &["kind", "id"]) && nonempty(via, "id"),
            Some("mcp") => strict_keys(via, &["kind", "client"]) && nonempty(via, "client"),
            _ => false,
        },
        _ => false,
    }
}
// The read decoder removes unknown object keys. Producers must never do that.
// Defaults and string transforms may add/change values, but cannot drop input keys.
fn no_dropped_keys(raw: &Value, decoded: &Value) -> bool {
    match raw {
        Value::Object(o) => o
            .iter()
            .all(|(key, value)| decoded.get(key).is_some_and(|v| no_dropped_keys(value, v))),
        Value::Array(a) => decoded.as_array().is_some_and(|d| {
            a.len() == d.len() && a.iter().zip(d).all(|(v, d)| no_dropped_keys(v, d))
        }),
        _ => true,
    }
}
pub fn validate_write(scope: Scope, write: &Value) -> Result<Value, WriteError> {
    let bad = || WriteError::Validation("invalid event write".into());
    let kind = write["type"].as_str().ok_or_else(bad)?;
    if !actor_valid(&write["actor"]) {
        return Err(bad());
    }
    let allowed = policy()["actors"][scope.name()][kind]
        .as_array()
        .ok_or_else(bad)?;
    if !allowed.contains(&write["actor"]["kind"]) {
        return Err(bad());
    }
    let mut envelope = json!({"seq":1,"ts":"2026-01-01T00:00:00.000Z","actor":write["actor"],"type":kind,"payload":write["payload"]});
    envelope = events::decode(scope, &envelope).map_err(|_| bad())?;
    if !no_dropped_keys(&write["payload"], &envelope["payload"]) {
        return Err(bad());
    }
    // Catalog custom refinements not expressible in the generated JSON Schema.
    if scope == Scope::Build && kind == "escalation.raised" {
        let p = &envelope["payload"];
        let policy_source = p["source"] == "policy";
        if policy_source != p.get("policyCause").is_some()
            || (write["actor"]["kind"] == "dispatcher"
                && (!policy_source
                    || ![
                        "infrastructure-failure-limit",
                        "dispatch-failure-limit",
                        "execution-no-progress",
                    ]
                    .iter()
                    .any(|cause| p["policyCause"] == *cause)))
        {
            return Err(bad());
        }
    }
    let mut out = json!({"actor":envelope["actor"],"type":kind,"payload":envelope["payload"]});
    if scope != Scope::Session {
        if let Some(c) = write.get("compatibility") {
            if !strict_keys(c, &["writerVersion", "classification"])
                || !nonempty(c, "writerVersion")
                || !matches!(c["classification"].as_str(), Some("advisory" | "decisive"))
            {
                return Err(bad());
            }
            // stampCompatibility rejects a classification that disagrees with the catalog.
            if c["classification"] != policy()["classification"][scope.name()][kind] {
                return Err(bad());
            }
            out["compatibility"] = c.clone();
        } else {
            out["compatibility"] = json!({
                "writerVersion": crate::operator::protocol::service_version(),
                "classification": policy()["classification"][scope.name()][kind],
            });
        }
    }
    Ok(out)
}
fn check_expected(expected: Option<i64>) -> Result<(), WriteError> {
    if expected.is_some_and(|n| n < 0) {
        return Err(WriteError::Validation(format!(
            "expectedSeq must be a nonnegative integer, got {}",
            expected.unwrap()
        )));
    }
    Ok(())
}
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn row_stamp(row: &Row, key: &str) -> String {
    stamp(row.get::<_, DateTime<Utc>>(key))
}
fn session_record(row: &Row) -> Value {
    let mut out = json!({"id":row.get::<_,String>("id"),"repo":row.get::<_,String>("repo"),"operator":row.get::<_,String>("operator"),"createdAt":row_stamp(row,"created_at"),"updatedAt":row_stamp(row,"updated_at")});
    if let Some(title) = row.get::<_, Option<String>>("title") {
        out["title"] = json!(title);
    }
    out
}
fn uuid() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = b.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "os_{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
impl PostgresWriter {
    pub async fn connect(url: &str) -> Result<Self, WriteError> {
        let mut roots = rustls::RootCertStore::empty();
        roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
        let config = rustls::ClientConfig::builder_with_provider(
            rustls::crypto::aws_lc_rs::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .map_err(|_| WriteError::Connection)?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let tls = MakeRustlsConnect::new(config);
        let connection = Self::open(url, tls.clone()).await?;
        Ok(Self {
            connection: Mutex::new(connection),
            url: url.into(),
            tls,
        })
    }
    async fn open(url: &str, tls: MakeRustlsConnect) -> Result<Connection, WriteError> {
        let (client, connection) = tokio_postgres::connect(url, tls)
            .await
            .map_err(|_| WriteError::Connection)?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let result = Connection { client, task };
        // Same marker/checksum as the reader. No DDL, and reconnects repeat this check.
        let exists: bool = result
            .client
            .query_one(
                "SELECT to_regclass('ab_schema_migrations') IS NOT NULL",
                &[],
            )
            .await
            .map_err(|_| WriteError::Storage)?
            .get(0);
        if !exists {
            return Err(DataError::Schema {
                expected: SCHEMA_VERSION,
                found: "absent".into(),
            }
            .into());
        }
        let rows = result
            .client
            .query(
                "SELECT version, checksum FROM ab_schema_migrations WHERE singleton = true",
                &[],
            )
            .await
            .map_err(|_| WriteError::Storage)?;
        let Some(row) = rows.first().filter(|_| rows.len() == 1) else {
            return Err(DataError::Schema {
                expected: SCHEMA_VERSION,
                found: "absent or malformed".into(),
            }
            .into());
        };
        let version: i32 = row.try_get("version").map_err(|_| WriteError::Storage)?;
        if version != SCHEMA_VERSION {
            return Err(DataError::Schema {
                expected: SCHEMA_VERSION,
                found: version.to_string(),
            }
            .into());
        }
        if row.try_get::<_, String>("checksum").ok().as_deref() != Some(SCHEMA_CHECKSUM) {
            return Err(DataError::Checksum { version }.into());
        }
        Ok(result)
    }
    pub(crate) async fn client(&self) -> Result<MutexGuard<'_, Connection>, WriteError> {
        let mut connection = self.connection.lock().await;
        if connection.client.is_closed() {
            *connection = Self::open(&self.url, self.tls.clone()).await?;
        }
        Ok(connection)
    }
    async fn append_scope(
        &self,
        repo: &str,
        id: &str,
        scope: Scope,
        expected: Option<i64>,
        write: &Value,
        now: DateTime<Utc>,
    ) -> Result<Option<Value>, WriteError> {
        check_expected(expected)?;
        let write = validate_write(scope, write)?;
        let database_error = |error| {
            if scope == Scope::Session {
                WriteError::Storage
            } else {
                WriteError::database(error)
            }
        };
        let (table, key, events, envelope_key) = match scope {
            Scope::Build => ("builds", "slug", "events", "build"),
            Scope::Repository => ("repo_streams", "repo", "repo_events", "repo"),
            Scope::Session => ("sessions", "id", "session_events", "session"),
        };
        let mut connection = self.client().await?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(database_error)?;
        let row = tx
            .query_opt(
                &format!("SELECT repo FROM {table} WHERE {key} = $1 FOR UPDATE"),
                &[&id],
            )
            .await
            .map_err(database_error)?;
        let Some(row) = row else {
            return Err(WriteError::Missing {
                scope: match scope {
                    Scope::Repository => "repo",
                    _ => scope.name(),
                },
                id: id.into(),
            });
        };
        if row.get::<_, String>("repo") != repo {
            return Err(WriteError::WrongProject);
        }
        let tail: i64 = tx
            .query_one(
                &format!(
                    "SELECT COALESCE(MAX(seq),0) AS seq FROM {events} WHERE {envelope_key}=$1"
                ),
                &[&id],
            )
            .await
            .map_err(database_error)?
            .get(0);
        if expected.is_some_and(|seq| seq != tail) {
            tx.commit().await.map_err(database_error)?;
            return Ok(None);
        }
        let seq = tail
            .checked_add(1)
            .ok_or_else(|| WriteError::Validation("event sequence exhausted".into()))?;
        let timestamp = stamp(now);
        let actor = &write["actor"];
        let kind = write["type"].as_str().unwrap();
        let payload = &write["payload"];
        if scope == Scope::Session {
            tx.execute("INSERT INTO session_events (session,seq,ts,actor,type,payload) VALUES ($1,$2,$3,$4,$5,$6)",&[&id,&seq,&now,actor,&kind,payload]).await.map_err(|error| if scope == Scope::Session { WriteError::Storage } else { WriteError::database(error) })?;
        } else {
            let compatibility = write.get("compatibility");
            tx.execute(&format!("INSERT INTO {events} ({envelope_key},seq,ts,actor,type,payload,compatibility) VALUES ($1,$2,$3,$4,$5,$6,$7)"),&[&id,&seq,&now,actor,&kind,payload,&compatibility]).await.map_err(|error| if scope == Scope::Session { WriteError::Storage } else { WriteError::database(error) })?;
        }
        tx.execute(
            &format!("UPDATE {table} SET updated_at=$1 WHERE {key}=$2"),
            &[&now, &id],
        )
        .await
        .map_err(database_error)?;
        tx.commit().await.map_err(database_error)?;
        let mut out = json!({envelope_key:id,"seq":seq,"ts":timestamp,"actor":actor,"type":kind,"payload":payload});
        if let Some(c) = write.get("compatibility") {
            out["compatibility"] = c.clone();
        }
        Ok(Some(out))
    }
    pub async fn append_build(
        &self,
        repo: &str,
        slug: &str,
        write: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, WriteError> {
        Ok(self
            .append_scope(repo, slug, Scope::Build, None, write, now)
            .await?
            .unwrap())
    }
    pub async fn append_build_if_current(
        &self,
        repo: &str,
        slug: &str,
        expected_seq: i64,
        write: &Value,
        now: DateTime<Utc>,
    ) -> Result<Option<Value>, WriteError> {
        self.append_scope(repo, slug, Scope::Build, Some(expected_seq), write, now)
            .await
    }
    pub async fn append_repo(
        &self,
        repo: &str,
        write: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, WriteError> {
        Ok(self
            .append_scope(repo, repo, Scope::Repository, None, write, now)
            .await?
            .unwrap())
    }
    pub async fn append_session(
        &self,
        repo: &str,
        id: &str,
        write: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, WriteError> {
        Ok(self
            .append_scope(repo, id, Scope::Session, None, write, now)
            .await?
            .unwrap())
    }
    pub async fn append_session_if_current(
        &self,
        repo: &str,
        id: &str,
        expected_seq: i64,
        write: &Value,
        now: DateTime<Utc>,
    ) -> Result<Option<Value>, WriteError> {
        self.append_scope(repo, id, Scope::Session, Some(expected_seq), write, now)
            .await
    }
    pub async fn create_session(
        &self,
        repo: &str,
        operator: &str,
        title: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Value, WriteError> {
        let operator = normalize_operator(operator)?;
        if operator.is_empty() {
            return Err(WriteError::Validation("operator is required".into()));
        }
        if repo.is_empty() {
            return Err(WriteError::Validation("repo is required".into()));
        }
        let mut payload = json!({});
        if let Some(title) = title {
            payload["title"] = json!(title);
        }
        let write = validate_write(
            Scope::Session,
            &json!({"actor":{"kind":"human","user":operator},"type":"session.created","payload":payload}),
        )?;
        let id = uuid();
        let mut connection = self.client().await?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(|_| WriteError::Storage)?;
        tx.execute("INSERT INTO sessions (id,repo,operator,title,creation_seq,created_at,updated_at) VALUES ($1,$2,$3,$4,nextval('sessions_creation_seq'),$5,$5)",&[&id,&repo,&operator,&title,&now]).await.map_err(|_|WriteError::Storage)?;
        tx.execute("INSERT INTO session_events (session,seq,ts,actor,type,payload) VALUES ($1,1,$2,$3,'session.created',$4)",&[&id,&now,&write["actor"],&write["payload"]]).await.map_err(|_|WriteError::Storage)?;
        let row = tx
            .query_one("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", &[&id])
            .await
            .map_err(|_| WriteError::Storage)?;
        let record = session_record(&row);
        tx.commit().await.map_err(|_| WriteError::Storage)?;
        Ok(record)
    }
    pub async fn project_registered(&self, repo: &str) -> Result<bool, WriteError> {
        let connection = self.client().await?;
        Ok(connection
            .client
            .query_opt(
                "SELECT action FROM project_journal WHERE repo=$1 ORDER BY seq DESC LIMIT 1",
                &[&repo],
            )
            .await
            .map_err(|_| WriteError::Storage)?
            .is_some_and(|r| r.get::<_, String>(0) == "added"))
    }
    pub async fn authenticate_credential(
        &self,
        token: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<Value>, WriteError> {
        let Some((id, digest)) = credential_parts(token) else {
            return Ok(None);
        };
        let connection = self.client().await?;
        let row=connection.client.query_opt("SELECT c.*, (SELECT action FROM project_journal WHERE repo=c.repo ORDER BY seq DESC LIMIT 1) AS project_action FROM project_credentials c WHERE id=$1",&[&id]).await.map_err(|_|WriteError::Storage)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let stored: String = row.get("digest");
        if !digest_equal(&digest, &stored)
            || row.get::<_, Option<DateTime<Utc>>>("revoked_at").is_some()
            || row
                .get::<_, Option<DateTime<Utc>>>("expires_at")
                .is_some_and(|ts| ts <= now)
        {
            return Ok(None);
        }
        if row.get::<_, Option<String>>("project_action").as_deref() != Some("added") {
            return Err(WriteError::ProjectNotRegistered);
        }
        let cutoff = now - chrono::Duration::seconds(60);
        if row
            .get::<_, Option<DateTime<Utc>>>("last_used_at")
            .is_some_and(|ts| ts > cutoff)
        {
            return Ok(Some(credential_record(&row)));
        }
        let used=connection.client.query_opt("UPDATE project_credentials SET last_used_at=$1 WHERE id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$1) AND (last_used_at IS NULL OR last_used_at<=$3) RETURNING *",&[&now,&id,&cutoff]).await.map_err(|_|WriteError::Storage)?;
        Ok(Some(credential_record(used.as_ref().unwrap_or(&row))))
    }
}
fn credential_parts(token: &str) -> Option<(&str, String)> {
    let rest = token.strip_prefix("abp_1_")?;
    let (id, secret) = rest.split_once('_')?;
    let hex = |v: &str, n| {
        v.len() == n
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !hex(id, 32) || !hex(secret, 64) {
        return None;
    }
    Some((id, format!("{:x}", Sha256::digest(secret.as_bytes()))))
}
fn digest_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
fn credential_record(row: &Row) -> Value {
    let optional = |key| row.get::<_, Option<DateTime<Utc>>>(key).map(stamp);
    json!({"id":row.get::<_,String>("id"),"repo":row.get::<_,String>("repo"),"createdAt":row_stamp(row,"created_at"),"createdBy":row.get::<_,String>("created_by"),"lastUsedAt":optional("last_used_at"),"revokedAt":optional("revoked_at"),"expiresAt":optional("expires_at"),"purpose":row.get::<_,String>("purpose")})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operator_normalization_matches_typescript_generated_unicode_cases() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/operator-corpus.json")).unwrap();
        for case in corpus["manifest"]["operatorNormalization"]
            .as_array()
            .unwrap()
        {
            let result = normalize_operator(case["input"].as_str().unwrap());
            if let Some(owner) = case["owner"].as_str() {
                assert_eq!(result.unwrap(), owner);
            } else {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    case["error"].as_str().unwrap()
                );
            }
        }
    }
    #[test]
    fn producer_rejects_read_tolerated_fields_and_wrong_actor() {
        let write = json!({"actor":{"kind":"human","user":"owner"},"type":"build.pause-requested","payload":{}});
        assert!(validate_write(Scope::Build, &write).is_ok());
        let mut wrong = write.clone();
        wrong["payload"]["future"] = json!(true);
        assert!(validate_write(Scope::Build, &wrong).is_err());
        wrong = write.clone();
        wrong["actor"]["future"] = json!(true);
        assert!(validate_write(Scope::Build, &wrong).is_err());
        wrong = write;
        wrong["actor"] = json!({"kind":"kernel"});
        assert!(validate_write(Scope::Build, &wrong).is_err());
    }
    #[test]
    fn producer_rejects_nested_additions_and_preserves_transport_identity() {
        let actor = json!({"kind":"human","user":"owner","via":{"kind":"mcp","client":"test"}});
        let write = json!({"actor":actor,"type":"escalation.answered","payload":{"id":"esc","answer":"guidance","resolution":"guidance","artifact":{"kind":"guidance","rev":0}}});
        assert_eq!(
            validate_write(Scope::Build, &write).unwrap()["actor"],
            actor
        );
        let mut wrong = write;
        wrong["payload"]["artifact"]["future"] = json!(true);
        assert!(validate_write(Scope::Build, &wrong).is_err());
        let mut wrong_actor =
            json!({"actor":actor,"type":"dispatcher.intake-set","payload":{"enabled":false}});
        assert!(validate_write(Scope::Repository, &wrong_actor).is_ok());
        wrong_actor["actor"]["via"]["future"] = json!(true);
        assert!(validate_write(Scope::Repository, &wrong_actor).is_err());
    }
    #[test]
    fn session_defaults_transforms_and_actor_policy() {
        let write = json!({"actor":{"kind":"human","user":"owner"},"type":"message.posted","payload":{"text":"hello"}});
        assert!(validate_write(Scope::Session, &write).is_ok());
        let mut wrong = write;
        wrong["type"] = json!("turn.started");
        wrong["payload"] =
            json!({"turn":"t","stream":"s","trigger":{"kind":"message","messageSeq":1}});
        assert!(validate_write(Scope::Session, &wrong).is_err());
        assert!(check_expected(Some(-1)).is_err());
        assert!(check_expected(Some(9_007_199_254_740_992)).is_ok());
        assert!(check_expected(Some(0)).is_ok());
    }
    #[test]
    fn compatibility_requires_catalog_classification() {
        let out=validate_write(Scope::Build,&json!({"actor":{"kind":"human","user":"owner"},"type":"build.pause-requested","payload":{},"compatibility":{"writerVersion":"1.0.0","classification":"decisive"}})).unwrap();
        assert_eq!(out["compatibility"]["classification"], "decisive");
        let mut wrong = out;
        wrong["compatibility"]["classification"] = json!("advisory");
        assert!(validate_write(Scope::Build, &wrong).is_err());
    }
    #[test]
    fn credential_shape_and_digest_are_exact() {
        let token = format!("abp_1_{}_{}", "a".repeat(32), "b".repeat(64));
        assert!(credential_parts(&token).is_some());
        assert!(credential_parts(&token.to_uppercase()).is_none());
        assert!(credential_parts(&(token + "_extra")).is_none());
        assert!(digest_equal("abcdef", "abcdef"));
        assert!(!digest_equal("abcdef", "abcdeg"));
        assert!(!digest_equal("ab", "abc"));
        let id = uuid();
        assert_eq!(id.len(), 39);
        assert_eq!(&id[17..18], "4");
    }
}
