//! Durable CLI/browser connection requests, sharing the TypeScript-owned tables.
//! HTTP admission and browser rendering are separate from this persistence boundary.
pub mod http;
use crate::data::writer::PostgresWriter;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio_postgres::Row;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ConnectionError {
    pub status: u16,
    pub message: &'static str,
}
impl ConnectionError {
    fn new(status: u16, message: &'static str) -> Self {
        Self { status, message }
    }
    fn backend(_: impl std::fmt::Display) -> Self {
        Self::new(503, "connection service is unavailable; retry")
    }
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Approved,
    Denied,
    Expired,
}
impl Status {
    fn text(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Expired => "expired",
        }
    }
    fn parse(raw: &str) -> Result<Self, ConnectionError> {
        match raw {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "denied" => Ok(Self::Denied),
            "expired" => Ok(Self::Expired),
            _ => Err(ConnectionError::backend("invalid stored status")),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRecord {
    pub id: String,
    pub repo: String,
    pub credential_id: String,
    pub code: String,
    pub status: Status,
    pub expires_at: String,
}
// Capability intentionally has no Debug implementation.
#[derive(Serialize)]
pub struct StartedConnection {
    #[serde(flatten)]
    pub record: ConnectionRecord,
    pub capability: String,
}
fn record(row: &Row) -> Result<ConnectionRecord, ConnectionError> {
    Ok(ConnectionRecord {
        id: row.get("id"),
        repo: row.get("repo"),
        credential_id: row.get("credential_id"),
        code: row.get("code"),
        status: Status::parse(row.get("status"))?,
        expires_at: row
            .get::<_, DateTime<Utc>>("expires_at")
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn random_hex(bytes: usize) -> String {
    let mut data = vec![0; bytes];
    OsRng.fill_bytes(&mut data);
    data.iter().map(|b| format!("{b:02x}")).collect()
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn capability_matches(capability: &str, stored: &str) -> bool {
    lower_hex(stored, 64) && bool::from(digest(capability).as_bytes().ct_eq(stored.as_bytes()))
}
/// Same accepted repository forms as normalizeConnectionRepository.
pub fn normalize_repository(raw: &str) -> Result<String, ConnectionError> {
    let invalid = || ConnectionError::new(400, "invalid repository identity");
    let value = raw.trim_matches(crate::operator::auth::js_space);
    if value.is_empty()
        || value
            .chars()
            .any(|c| crate::operator::auth::js_space(c) || "\\?#".contains(c))
    {
        return Err(invalid());
    }
    if !value.contains("://") && regex::Regex::new(r"^[^/]*:[^/]*@").unwrap().is_match(value) {
        return Err(invalid());
    }
    let candidate = if value.contains("://") {
        value.to_owned()
    } else {
        let re = regex::Regex::new(r"^(?:[^@/]+@)?([^/:]+):([^/].*)$").unwrap();
        if !regex::Regex::new(r"^[A-Za-z]:").unwrap().is_match(value) {
            if let Some(parts) = re.captures(value) {
                format!("https://{}/{}", &parts[1], &parts[2])
            } else {
                value.to_owned()
            }
        } else {
            value.to_owned()
        }
    };
    let url = url::Url::parse(&candidate).map_err(|_| invalid())?;
    if url.password().is_some()
        || (!url.username().is_empty() && !["ssh", "git+ssh"].contains(&url.scheme()))
    {
        return Err(invalid());
    }
    let scheme = match url.scheme() {
        "ssh" | "git" | "git+ssh" => "https",
        other => other,
    };
    let path = regex::Regex::new(r"(?i)\.git/?$")
        .unwrap()
        .replace(url.path(), "")
        .trim_end_matches('/')
        .to_owned();
    if scheme != "https"
        || url.host_str().is_none()
        || path.is_empty()
        || path.contains(['%', '\\'])
    {
        return Err(invalid());
    }
    let host = &url[url::Position::BeforeHost..url::Position::AfterPort];
    Ok(format!("https://{}{path}", host.to_lowercase()))
}

/// An explicit time argument makes expiry, polling and lookup windows reproducible.
/// All authority is durable; recreating this service loses no flow state.
pub struct ConnectionService<'a> {
    pub writer: &'a PostgresWriter,
}
impl ConnectionService<'_> {
    pub async fn start(
        &self,
        raw_repo: &str,
        credential_id: &str,
        prepared_digest: &str,
        now: DateTime<Utc>,
    ) -> Result<StartedConnection, ConnectionError> {
        if raw_repo.encode_utf16().count() > 2048
            || !lower_hex(credential_id, 32)
            || !lower_hex(prepared_digest, 64)
        {
            return Err(ConnectionError::new(400, "invalid connection proposal"));
        }
        let repo = normalize_repository(raw_repo)?;
        let connection = self
            .writer
            .client()
            .await
            .map_err(ConnectionError::backend)?;
        connection.client.execute("DELETE FROM project_connections WHERE id IN (SELECT id FROM project_connections WHERE expires_at < $1 LIMIT 100)", &[&(now - Duration::days(1))]).await.map_err(ConnectionError::backend)?;
        let capability = random_hex(32);
        let capability_hash = digest(&capability);
        for _ in 0..5 {
            let id = random_hex(16);
            let code = random_hex(5).to_uppercase();
            let row = connection.client.query_opt("INSERT INTO project_connections (id,repo,credential_id,digest,capability_hash,code,created_at,expires_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT DO NOTHING RETURNING *", &[&id,&repo,&credential_id,&prepared_digest,&capability_hash,&code,&now,&(now+Duration::minutes(10))]).await.map_err(ConnectionError::backend)?;
            if let Some(row) = row {
                return Ok(StartedConnection {
                    record: record(&row)?,
                    capability,
                });
            }
        }
        Err(ConnectionError::new(
            503,
            "connection creation unavailable; retry",
        ))
    }
    pub async fn poll(
        &self,
        id: &str,
        capability: &str,
        cancel: bool,
        now: DateTime<Utc>,
    ) -> Result<ConnectionRecord, ConnectionError> {
        let unknown = || ConnectionError::new(404, "unknown connection");
        if !lower_hex(id, 32) || !lower_hex(capability, 64) {
            return Err(unknown());
        }
        let mut connection = self
            .writer
            .client()
            .await
            .map_err(ConnectionError::backend)?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(ConnectionError::backend)?;
        let row = tx
            .query_opt(
                "SELECT * FROM project_connections WHERE id=$1 FOR UPDATE",
                &[&id],
            )
            .await
            .map_err(ConnectionError::backend)?
            .ok_or_else(unknown)?;
        if !capability_matches(capability, row.get("capability_hash")) {
            return Err(unknown());
        }
        let mut result = record(&row)?;
        if !cancel {
            if row
                .get::<_, Option<DateTime<Utc>>>("polled_at")
                .is_some_and(|at| now.signed_duration_since(at).num_milliseconds() < 4500)
            {
                return Err(ConnectionError::new(429, "poll again in five seconds"));
            }
            if row.get::<_, i32>("poll_attempts") >= 130 {
                return Err(ConnectionError::new(
                    429,
                    "connection polling limit reached",
                ));
            }
        }
        if cancel {
            if result.status == Status::Approved {
                tx.execute("UPDATE project_credentials SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2 AND repo=$3", &[&now,&result.credential_id,&result.repo]).await.map_err(ConnectionError::backend)?;
            }
            result.status = Status::Denied;
        } else if result.status == Status::Pending
            && row.get::<_, DateTime<Utc>>("expires_at") <= now
        {
            result.status = Status::Expired;
        }
        tx.execute("UPDATE project_connections SET status=$1,polled_at=$2,poll_attempts=poll_attempts+1 WHERE id=$3", &[&result.status.text(),&now,&id]).await.map_err(ConnectionError::backend)?;
        tx.commit().await.map_err(ConnectionError::backend)?;
        Ok(result)
    }
    pub async fn lookup(
        &self,
        code: &str,
        actor: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<ConnectionRecord>, ConnectionError> {
        if actor.is_empty()
            || actor.encode_utf16().count() > 320
            || code.len() != 10
            || !code
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        {
            return Err(ConnectionError::new(
                400,
                "enter the ten-character connection code",
            ));
        }
        let connection = self
            .writer
            .client()
            .await
            .map_err(ConnectionError::backend)?;
        let limit = connection.client.query_one("INSERT INTO connection_lookup_limits (actor,started_at,attempts) VALUES ($1,$2,1) ON CONFLICT (actor) DO UPDATE SET attempts=CASE WHEN connection_lookup_limits.started_at<$3 THEN 1 ELSE connection_lookup_limits.attempts+1 END, started_at=CASE WHEN connection_lookup_limits.started_at<$3 THEN $2 ELSE connection_lookup_limits.started_at END RETURNING attempts", &[&actor,&now,&(now-Duration::minutes(1))]).await.map_err(ConnectionError::backend)?;
        if limit.get::<_, i32>("attempts") > 20 {
            return Err(ConnectionError::new(
                429,
                "too many code lookups; retry in a minute",
            ));
        }
        let row = connection
            .client
            .query_opt("SELECT * FROM project_connections WHERE code=$1", &[&code])
            .await
            .map_err(ConnectionError::backend)?;
        row.map(|row| {
            let mut result = record(&row)?;
            if result.status == Status::Pending && row.get::<_, DateTime<Utc>>("expires_at") <= now
            {
                result.status = Status::Expired;
            }
            Ok(result)
        })
        .transpose()
    }
    pub async fn decide(
        &self,
        code: &str,
        actor: &str,
        approve: bool,
        now: DateTime<Utc>,
    ) -> Result<ConnectionRecord, ConnectionError> {
        if self.lookup(code, actor, now).await?.is_none() {
            return Err(ConnectionError::new(404, "unknown connection"));
        }
        let mut connection = self
            .writer
            .client()
            .await
            .map_err(ConnectionError::backend)?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(ConnectionError::backend)?;
        let row = tx
            .query_one(
                "SELECT * FROM project_connections WHERE code=$1 FOR UPDATE",
                &[&code],
            )
            .await
            .map_err(ConnectionError::backend)?;
        let mut result = record(&row)?;
        if result.status != Status::Pending {
            return Ok(result);
        }
        result.status = if row.get::<_, DateTime<Utc>>("expires_at") <= now {
            Status::Expired
        } else if approve {
            Status::Approved
        } else {
            Status::Denied
        };
        if result.status == Status::Approved {
            tx.execute("INSERT INTO project_registry_state (singleton,legacy_imported) VALUES (true,false) ON CONFLICT DO NOTHING", &[]).await.map_err(ConnectionError::backend)?;
            tx.query_one(
                "SELECT singleton FROM project_registry_state WHERE singleton=true FOR UPDATE",
                &[],
            )
            .await
            .map_err(ConnectionError::backend)?;
            let previous = tx
                .query_opt(
                    "SELECT action FROM project_journal WHERE repo=$1 ORDER BY seq DESC LIMIT 1",
                    &[&result.repo],
                )
                .await
                .map_err(ConnectionError::backend)?;
            if previous
                .as_ref()
                .is_none_or(|r| r.get::<_, String>("action") != "added")
            {
                tx.execute("INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'),$1,'added',$2,$3)", &[&result.repo,&actor,&now]).await.map_err(ConnectionError::backend)?;
            }
            let by = actor.trim_matches(crate::operator::auth::js_space);
            if by.is_empty() {
                return Err(ConnectionError::backend(
                    "credential creator must be nonblank",
                ));
            }
            let prepared_digest: String = row.get("digest");
            if !lower_hex(&result.credential_id, 32) || !lower_hex(&prepared_digest, 64) {
                return Err(ConnectionError::backend("invalid prepared credential"));
            }
            tx.execute("INSERT INTO project_credentials (id,digest,repo,created_at,created_by,purpose,expires_at) VALUES ($1,$2,$3,$4,$5,'project-owner',NULL)", &[&result.credential_id,&prepared_digest,&result.repo,&now,&by]).await.map_err(ConnectionError::backend)?;
        }
        let approved_by = if result.status == Status::Approved {
            Some(actor)
        } else {
            None
        };
        tx.execute(
            "UPDATE project_connections SET status=$1,approved_by=$2 WHERE id=$3",
            &[&result.status.text(), &approved_by, &result.id],
        )
        .await
        .map_err(ConnectionError::backend)?;
        tx.commit().await.map_err(ConnectionError::backend)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_identities_match_cli_oracle() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/connect-identities.json")).unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let actual = normalize_repository(input);
            if let Some(expected) = case["output"].as_str() {
                assert_eq!(actual.unwrap(), expected, "{input}");
            } else {
                assert!(actual.is_err(), "{input}");
            }
        }
    }
    #[test]
    fn repository_identity_and_capabilities() {
        assert_eq!(
            normalize_repository(" git@GitHub.com:Owner/Repo.git ").unwrap(),
            "https://github.com/Owner/Repo"
        );
        assert_eq!(
            normalize_repository("ssh://git@github.com/Owner/Repo.git").unwrap(),
            "https://github.com/Owner/Repo"
        );
        for value in [
            "owner/repo",
            "https://user@github.com/a/b",
            "https://github.com/a%20b",
            "file:///tmp/a",
            "https://github.com/",
            "https://github.com/a?x",
            "https://github.com/a#x",
            "git:secret@github.com:a/b",
        ] {
            assert!(normalize_repository(value).is_err(), "{value}");
        }
        let secret = random_hex(32);
        assert!(lower_hex(&secret, 64));
        assert!(capability_matches(&secret, &digest(&secret)));
        assert!(!capability_matches(&secret, &"0".repeat(64)));
        assert!(!capability_matches(&secret, "broken"));
    }
}
