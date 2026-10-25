//! Upload-before-publication artifact deposits needed by operator answers.
use super::{
    blobs::BlobWriter,
    writer::{PostgresWriter, WriteError},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
impl PostgresWriter {
    pub async fn ensure_repo(&self, repo: &str, now: DateTime<Utc>) -> Result<(), WriteError> {
        if repo.is_empty() {
            return Err(WriteError::Validation("repo is required".into()));
        }
        let mut connection = self.client().await?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(|_| WriteError::Storage)?;
        tx.execute("INSERT INTO repo_streams (repo,created_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT (repo) DO NOTHING",&[&repo,&now]).await.map_err(|_|WriteError::Storage)?;
        tx.query_one(
            "SELECT repo FROM repo_streams WHERE repo=$1 FOR UPDATE",
            &[&repo],
        )
        .await
        .map_err(|_| WriteError::Storage)?;
        tx.commit().await.map_err(|_| WriteError::Storage)?;
        Ok(())
    }
    // Keep the explicit resource, authority and storage inputs visible at this boundary.
    #[allow(clippy::too_many_arguments)]
    pub async fn put_artifact(
        &self,
        blobs: &BlobWriter,
        repo: &str,
        slug: &str,
        kind: &str,
        bytes: &[u8],
        metadata: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, WriteError> {
        if kind.is_empty() {
            return Err(WriteError::Validation("artifact kind is required".into()));
        }
        let hash = blobs.put(bytes).await.map_err(WriteError::Schema)?;
        let mut connection = self.client().await?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(|_| WriteError::Storage)?;
        let record = tx
            .query_opt("SELECT repo FROM builds WHERE slug=$1 FOR UPDATE", &[&slug])
            .await
            .map_err(|_| WriteError::Storage)?;
        let record = record.ok_or_else(|| WriteError::Missing {
            scope: "build",
            id: slug.to_owned(),
        })?;
        if record.get::<_, String>("repo") != repo {
            return Err(WriteError::WrongProject);
        }
        let revision:i64=tx.query_one("SELECT COALESCE(MAX(revision),-1)+1 AS revision FROM artifacts WHERE build=$1 AND kind=$2",&[&slug,&kind]).await.map_err(|_|WriteError::Storage)?.get(0);
        tx.execute("INSERT INTO artifacts (build,kind,revision,blob_ref,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6)",&[&slug,&kind,&revision,&hash,metadata,&now]).await.map_err(|_|WriteError::Storage)?;
        // Spec and guidance are immutable audit inputs, never retention-managed.
        if matches!(
            kind,
            "build-runner-effective-config"
                | "dispatcher-effective-config"
                | "dispatcher-config"
                | "operator-notes"
        ) {
            tx.execute("DELETE FROM artifacts WHERE build=$1 AND kind=$2 AND revision IN (SELECT revision FROM artifacts WHERE build=$1 AND kind=$2 ORDER BY revision DESC OFFSET 200)",&[&slug,&kind]).await.map_err(|_|WriteError::Storage)?;
        }
        tx.execute(
            "UPDATE builds SET updated_at=$1 WHERE slug=$2",
            &[&now, &slug],
        )
        .await
        .map_err(|_| WriteError::Storage)?;
        tx.commit().await.map_err(|_| WriteError::Storage)?;
        Ok(
            json!({"build":slug,"kind":kind,"revision":revision,"blobRef":hash,"metadata":metadata,"createdAt":now.to_rfc3339_opts(SecondsFormat::Millis,true)}),
        )
    }
}

impl PostgresWriter {
    /// Exclusive short-lived publication fence for an idle node spec revision.
    /// The trusted service clock is injected for reproducible storage tests;
    /// production callers sample it server-side, never from a request body.
    pub async fn claim_revision_fence(
        &self,
        repo: &str,
        slug: &str,
        holder: &str,
        node_writer: bool,
        now: DateTime<Utc>,
    ) -> Result<bool, WriteError> {
        let mut connection = self.client().await?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(|_| WriteError::Storage)?;
        let row = tx
            .query_opt("SELECT * FROM builds WHERE slug=$1 FOR UPDATE", &[&slug])
            .await
            .map_err(|_| WriteError::Storage)?
            .ok_or_else(|| WriteError::Missing {
                scope: "build",
                id: slug.to_owned(),
            })?;
        if row.get::<_, String>("repo") != repo {
            return Err(WriteError::WrongProject);
        }
        let prefix = if node_writer { "node_writer" } else { "lease" };
        let current: Option<String> = row.get(format!("{prefix}_holder").as_str());
        let expires: Option<DateTime<Utc>> = row.get(format!("{prefix}_expires_at").as_str());
        if current.as_deref().is_some_and(|value| value != holder)
            && expires.is_some_and(|ts| ts > now)
        {
            return Ok(false);
        }
        let expires = now + chrono::Duration::seconds(60);
        tx.execute(&format!("UPDATE builds SET {prefix}_holder=$1,{prefix}_expires_at=$2,{prefix}_ttl_ms=60000,updated_at=$3 WHERE slug=$4"),&[&holder,&expires,&now,&slug]).await.map_err(|_|WriteError::Storage)?;
        tx.commit().await.map_err(|_| WriteError::Storage)?;
        Ok(true)
    }
    pub async fn release_revision_fence(
        &self,
        repo: &str,
        slug: &str,
        holder: &str,
        node_writer: bool,
        now: DateTime<Utc>,
    ) -> Result<(), WriteError> {
        let mut connection = self.client().await?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(|_| WriteError::Storage)?;
        let row = tx
            .query_opt("SELECT repo FROM builds WHERE slug=$1 FOR UPDATE", &[&slug])
            .await
            .map_err(|_| WriteError::Storage)?
            .ok_or_else(|| WriteError::Missing {
                scope: "build",
                id: slug.to_owned(),
            })?;
        if row.get::<_, String>("repo") != repo {
            return Err(WriteError::WrongProject);
        }
        let prefix = if node_writer { "node_writer" } else { "lease" };
        tx.execute(&format!("UPDATE builds SET {prefix}_holder=NULL,{prefix}_expires_at=NULL,{prefix}_ttl_ms=NULL,updated_at=$1 WHERE slug=$2 AND {prefix}_holder=$3"),&[&now,&slug,&holder]).await.map_err(|_|WriteError::Storage)?;
        tx.commit().await.map_err(|_| WriteError::Storage)?;
        Ok(())
    }
}

impl PostgresWriter {
    #[allow(clippy::too_many_arguments)]
    pub async fn put_repo_artifact(
        &self,
        blobs: &BlobWriter,
        repo: &str,
        kind: &str,
        bytes: &[u8],
        metadata: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, WriteError> {
        if kind.is_empty() {
            return Err(WriteError::Validation("artifact kind is required".into()));
        }
        let hash = blobs.put(bytes).await.map_err(WriteError::Schema)?;
        let mut connection = self.client().await?;
        let tx = connection
            .client
            .transaction()
            .await
            .map_err(|_| WriteError::Storage)?;
        if tx
            .query_opt(
                "SELECT repo FROM repo_streams WHERE repo=$1 FOR UPDATE",
                &[&repo],
            )
            .await
            .map_err(|_| WriteError::Storage)?
            .is_none()
        {
            return Err(WriteError::Missing {
                scope: "repo",
                id: repo.into(),
            });
        }
        let revision: i64 = tx
            .query_one(
                "SELECT COALESCE(MAX(revision),-1)+1 FROM repo_artifacts WHERE repo=$1 AND kind=$2",
                &[&repo, &kind],
            )
            .await
            .map_err(|_| WriteError::Storage)?
            .get(0);
        tx.execute("INSERT INTO repo_artifacts(repo,kind,revision,blob_ref,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6)",&[&repo,&kind,&revision,&hash,metadata,&now]).await.map_err(|_|WriteError::Storage)?;
        if matches!(
            kind,
            "dispatcher-effective-config"
                | "dispatcher-config"
                | "build-runner-effective-config"
                | "operator-notes"
        ) {
            tx.execute("DELETE FROM repo_artifacts WHERE repo=$1 AND kind=$2 AND revision IN(SELECT revision FROM repo_artifacts WHERE repo=$1 AND kind=$2 ORDER BY revision DESC OFFSET 200)",&[&repo,&kind]).await.map_err(|_|WriteError::Storage)?;
        }
        tx.execute(
            "UPDATE repo_streams SET updated_at=$1 WHERE repo=$2",
            &[&now, &repo],
        )
        .await
        .map_err(|_| WriteError::Storage)?;
        tx.commit().await.map_err(|_| WriteError::Storage)?;
        Ok(
            json!({"repo":repo,"kind":kind,"revision":revision,"blobRef":hash,"metadata":metadata,"createdAt":now.to_rfc3339_opts(SecondsFormat::Millis,true)}),
        )
    }
}
