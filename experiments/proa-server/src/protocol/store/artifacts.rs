//! Immutable uploads precede one row-locked metadata/event transaction. Orphan
//! objects after rollback are safe; deleting them could destroy a concurrent ref.
use super::{
    events::{insert_prepared, tail},
    records::{lock, Scope},
    Store,
};
use crate::data::error::DataError;
use crate::protocol::{
    artifact_preparation::{
        decode_artifact, decode_artifacts, substitute_placeholder_refs, ArtifactInput,
    },
    error::ProtocolError,
    validation::{
        session::validate_session_write,
        writes::{prepare_build_write, prepare_repository_write, validate_expected_seq},
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use tokio_postgres::{Row, Transaction};

pub struct PreparedArtifact {
    pub kind: String,
    pub blob_ref: String,
    pub metadata: Value,
}
fn table(scope: Scope<'_>) -> &'static str {
    match scope {
        Scope::Build(_) => "artifacts",
        Scope::Repo(_) => "repo_artifacts",
        Scope::Session(_) => "session_artifacts",
    }
}
fn meta(row: &Row, scope: Scope<'_>) -> Result<Value, ProtocolError> {
    meta_lossless(row, scope)?
        .to_serde_checked()
        .map_err(|_| ProtocolError::internal())
}
fn meta_lossless(
    row: &Row,
    scope: Scope<'_>,
) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
    use crate::protocol::{
        js_postgres::{decode_json_column, PgValue},
        js_value::{JsJson as J, JsString as S},
    };
    let revision: i64 = row.get("revision");
    if revision > 9_007_199_254_740_991 {
        return Err(ProtocolError::internal());
    }
    Ok(J::Object(vec![
        (S::from(scope.event_key()), J::String(S::from(scope.id()))),
        (
            S::from("kind"),
            J::String(S::from(row.get::<_, String>("kind"))),
        ),
        (S::from("revision"), J::Number(revision as f64)),
        (
            S::from("blobRef"),
            J::String(S::from(row.get::<_, String>("blob_ref"))),
        ),
        (
            S::from("metadata"),
            decode_json_column(row.get::<_, PgValue>("metadata").0)?,
        ),
        (
            S::from("createdAt"),
            J::String(S::from(super::records::row_timestamp(row, "created_at"))),
        ),
    ]))
}
fn managed(kind: &str) -> bool {
    matches!(
        kind,
        "dispatcher-effective-config"
            | "dispatcher-config"
            | "operator-notes"
            | "build-runner-effective-config"
    )
}
impl Store {
    async fn prepare_artifact(
        &self,
        input: ArtifactInput,
    ) -> Result<PreparedArtifact, ProtocolError> {
        if input.kind.is_empty() {
            return Err(ProtocolError::new(
                500,
                "internal",
                "artifact kind is required",
            ));
        }
        self.blobs
            .as_ref()
            .ok_or_else(ProtocolError::internal)?
            .put(&input.blob_ref, &input.bytes)
            .await?;
        Ok(PreparedArtifact {
            kind: input.kind,
            blob_ref: input.blob_ref,
            metadata: crate::protocol::js_json::serializable(input.metadata),
        })
    }
    pub(crate) async fn deposit_artifact_locked(
        &self,
        tx: &Transaction<'_>,
        scope: Scope<'_>,
        artifact: &PreparedArtifact,
    ) -> Result<Value, ProtocolError> {
        let revision: i64 = tx
            .query_one(
                &format!(
                    "SELECT COALESCE(MAX(revision),-1)+1 FROM {} WHERE {}=$1 AND kind=$2",
                    table(scope),
                    scope.event_key()
                ),
                &[&scope.id(), &artifact.kind],
            )
            .await
            .map_err(ProtocolError::query)?
            .get(0);
        let now = self.now();
        let row=tx.query_one(&format!("INSERT INTO {}({},kind,revision,blob_ref,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",table(scope),scope.event_key()),&[&scope.id(),&artifact.kind,&revision,&artifact.blob_ref,&artifact.metadata,&now]).await.map_err(ProtocolError::query)?;
        tx.execute(
            &format!(
                "UPDATE {} SET updated_at=$1 WHERE {}=$2",
                scope.table(),
                scope.key()
            ),
            &[&now, &scope.id()],
        )
        .await
        .map_err(ProtocolError::query)?;
        meta(&row, scope)
    }
    pub(crate) async fn prune_artifacts_locked(
        &self,
        tx: &Transaction<'_>,
        scope: Scope<'_>,
        kind: &str,
    ) -> Result<(), ProtocolError> {
        if matches!(scope, Scope::Session(_)) || !managed(kind) {
            return Ok(());
        }
        if self.max_revisions == 0 {
            return Err(ProtocolError::new(
                500,
                "internal",
                "maxRevisions must be a positive integer, got 0",
            ));
        }
        // A JS Number may be a positive integer beyond i64/usize. Such a
        // bound cannot prune any realizable journal; do not turn it into a
        // native conversion error after publishing a valid configuration.
        let Ok(offset) = i64::try_from(self.max_revisions) else {
            return Ok(());
        };
        tx.execute(&format!("DELETE FROM {table} WHERE {key}=$1 AND kind=$2 AND revision IN (SELECT revision FROM {table} WHERE {key}=$1 AND kind=$2 ORDER BY revision DESC OFFSET $3)",table=table(scope),key=scope.event_key()),&[&scope.id(),&kind,&offset]).await.map_err(ProtocolError::query)?;
        Ok(())
    }
    pub async fn put_artifact(
        &self,
        scope: Scope<'_>,
        input: &Value,
    ) -> Result<Value, ProtocolError> {
        let prepared = self.prepare_artifact(decode_artifact(input)?).await?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let result = self.deposit_artifact_locked(&tx, scope, &prepared).await?;
        self.prune_artifacts_locked(&tx, scope, &prepared.kind)
            .await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(result)
    }
    pub async fn deposit(
        &self,
        scope: Scope<'_>,
        input: &Value,
        expected: Option<&Value>,
    ) -> Result<Value, ProtocolError> {
        let expected = expected
            .map(validate_expected_seq)
            .transpose()
            .map_err(|error| ProtocolError::new(500, "internal", error))?;
        let mut prepared = Vec::new();
        for artifact in decode_artifacts(
            input["artifacts"]
                .as_array()
                .ok_or_else(ProtocolError::internal)?,
        )? {
            prepared.push(self.prepare_artifact(artifact).await?);
        }
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let current = tail(&tx, scope).await?;
        if expected.is_some_and(|expected| expected != current) {
            return Ok(Value::Null);
        }
        let mut deposited = Vec::new();
        for artifact in &prepared {
            deposited.push(self.deposit_artifact_locked(&tx, scope, artifact).await?);
        }
        let mut input_event = input["event"].clone();
        input_event["payload"] = substitute_placeholder_refs(&input_event["payload"], &deposited);
        let prepared_event = match scope {
            Scope::Build(_) => prepare_build_write(&input_event),
            Scope::Repo(_) => prepare_repository_write(&input_event),
            Scope::Session(_) => validate_session_write(&input_event)
                .map(|v| json!({"actor":v.actor,"type":v.kind,"payload":v.payload})),
        }
        .map_err(|error| ProtocolError::new(422, "validation", error))?;
        let kinds: BTreeSet<_> = prepared.iter().map(|a| a.kind.as_str()).collect();
        for kind in kinds {
            self.prune_artifacts_locked(&tx, scope, kind).await?;
        }
        let seq = current
            .checked_add(1)
            .filter(|s| *s <= 9_007_199_254_740_991)
            .ok_or_else(ProtocolError::internal)?;
        let event = insert_prepared(&tx, scope, &prepared_event, seq, self.now()).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(json!({"event":event,"artifacts":deposited}))
    }

    /// Preserve JSON strings through blob preparation and the locked JSONB write.
    pub async fn put_artifact_lossless(
        &self,
        scope: Scope<'_>,
        input: &crate::protocol::js_value::JsJson,
    ) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
        let artifact = crate::protocol::artifact_preparation::decode_artifact_lossless(input)?;
        let artifact = self.prepare_artifact_lossless(artifact).await?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let result = self
            .deposit_artifact_lossless_locked(&tx, scope, &artifact)
            .await?;
        self.prune_artifacts_locked(&tx, scope, &artifact.kind.to_usv_string())
            .await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(result)
    }
    async fn prepare_artifact_lossless(
        &self,
        input: crate::protocol::artifact_preparation::LosslessArtifactInput,
    ) -> Result<crate::protocol::artifact_preparation::LosslessArtifactInput, ProtocolError> {
        if input.kind.is_empty() {
            return Err(ProtocolError::new(
                500,
                "internal",
                "artifact kind is required",
            ));
        }
        self.blobs
            .as_ref()
            .ok_or_else(ProtocolError::internal)?
            .put(&input.blob_ref, &input.bytes)
            .await?;
        Ok(input)
    }
    pub(crate) async fn deposit_artifact_lossless_locked(
        &self,
        tx: &Transaction<'_>,
        scope: Scope<'_>,
        artifact: &crate::protocol::artifact_preparation::LosslessArtifactInput,
    ) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
        use crate::protocol::js_postgres::{PgJson, PgText};
        let kind = PgText(&artifact.kind);
        let revision: i64 = tx
            .query_one(
                &format!(
                    "SELECT COALESCE(MAX(revision),-1)+1 FROM {} WHERE {}=$1 AND kind=$2",
                    table(scope),
                    scope.event_key()
                ),
                &[&scope.id(), &kind],
            )
            .await
            .map_err(ProtocolError::query)?
            .get(0);
        let now = self.now();
        let metadata = PgJson(&artifact.metadata);
        let row=tx.query_one(&format!("INSERT INTO {}({},kind,revision,blob_ref,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",table(scope),scope.event_key()),&[&scope.id(),&kind,&revision,&artifact.blob_ref,&metadata,&now]).await.map_err(ProtocolError::query)?;
        tx.execute(
            &format!(
                "UPDATE {} SET updated_at=$1 WHERE {}=$2",
                scope.table(),
                scope.key()
            ),
            &[&now, &scope.id()],
        )
        .await
        .map_err(ProtocolError::query)?;
        let mut result = crate::protocol::js_value::JsJson::from_serde(&meta(&row, scope)?);
        *result.get_mut("kind").unwrap() =
            crate::protocol::js_value::JsJson::String(artifact.kind.clone());
        Ok(result)
    }
    pub async fn deposit_lossless(
        &self,
        scope: Scope<'_>,
        input: &crate::protocol::js_value::JsJson,
        expected: Option<&crate::protocol::js_value::JsJson>,
    ) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
        use crate::protocol::{
            artifact_preparation::{
                decode_artifacts_lossless, substitute_placeholder_refs_lossless,
            },
            js_value::{JsJson, JsString},
            validation::lossless_writes,
        };
        let error = |status, kind, message| {
            let mut e = ProtocolError::validation_js(message);
            e.status = axum::http::StatusCode::from_u16(status).unwrap();
            e.kind = kind;
            e
        };
        let expected = expected
            .map(lossless_writes::validate_expected_seq)
            .transpose()
            .map_err(|message| error(500, "internal", message))?;
        // Decode every input before the first upload, just as the scalar adapter.
        let decoded = decode_artifacts_lossless(
            input
                .get("artifacts")
                .and_then(JsJson::as_array)
                .ok_or_else(ProtocolError::internal)?,
        )?;
        let mut prepared = Vec::new();
        for artifact in decoded {
            prepared.push(self.prepare_artifact_lossless(artifact).await?);
        }
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let current = tail(&tx, scope).await?;
        if expected.is_some_and(|expected| expected != current) {
            return Ok(JsJson::Null);
        }
        let mut deposited = Vec::new();
        for artifact in &prepared {
            deposited.push(
                self.deposit_artifact_lossless_locked(&tx, scope, artifact)
                    .await?,
            );
        }
        let mut event = input
            .get("event")
            .ok_or_else(ProtocolError::internal)?
            .clone();
        let payload = event.get("payload").ok_or_else(ProtocolError::internal)?;
        let payload = substitute_placeholder_refs_lossless(payload, &deposited);
        *event
            .get_mut("payload")
            .ok_or_else(ProtocolError::internal)? = payload;
        let event = match scope {
            Scope::Build(_) => lossless_writes::prepare_build_write(&event),
            Scope::Repo(_) => lossless_writes::prepare_repository_write(&event),
            Scope::Session(_) => lossless_writes::prepare_session_write(&event),
        }
        .map_err(|message| error(422, "validation", message))?;
        let mut pruned = Vec::new();
        for artifact in &prepared {
            if !pruned.contains(&artifact.kind) {
                self.prune_artifacts_locked(&tx, scope, &artifact.kind.to_usv_string())
                    .await?;
                pruned.push(artifact.kind.clone());
            }
        }
        let seq = current
            .checked_add(1)
            .filter(|s| *s <= 9_007_199_254_740_991)
            .ok_or_else(ProtocolError::internal)?;
        let event =
            super::events::insert_prepared_lossless(&tx, scope, &event, seq, self.now()).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(JsJson::Object(vec![
            (JsString::from("event"), JsJson::from_serde(&event)),
            (JsString::from("artifacts"), JsJson::Array(deposited)),
        ]))
    }
    async fn require_artifact_scope(&self, scope: Scope<'_>) -> Result<(), ProtocolError> {
        if self.get_record_lossless(scope).await?.is_null() {
            return Err(ProtocolError::missing(scope.name(), scope.id()));
        }
        Ok(())
    }
    pub async fn get_artifact_lossless(
        &self,
        scope: Scope<'_>,
        kind: &str,
        revision: Option<i64>,
    ) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
        self.require_artifact_scope(scope).await?;
        let client = self.database.client().await?;
        let row=client.query_opt(&format!("SELECT * FROM {} WHERE {}=$1 AND kind=$2 AND ($3::bigint IS NULL OR revision=$3) ORDER BY revision DESC LIMIT 1",table(scope),scope.event_key()),&[&scope.id(),&kind,&revision]).await.map_err(ProtocolError::query)?;
        drop(client);
        let Some(row) = row else {
            return Ok(crate::protocol::js_value::JsJson::Null);
        };
        let hash: String = row.get("blob_ref");
        let bytes = match self
            .blobs
            .as_ref()
            .ok_or_else(ProtocolError::internal)?
            .get(&hash)
            .await
        {
            Ok(bytes) => bytes,
            Err(DataError::MissingBlob) => return Ok(crate::protocol::js_value::JsJson::Null),
            Err(error) => return Err(error.into()),
        };
        Ok(crate::protocol::js_value::JsJson::Object(vec![
            (
                crate::protocol::js_value::JsString::from("meta"),
                meta_lossless(&row, scope)?,
            ),
            (
                crate::protocol::js_value::JsString::from("contentBase64"),
                crate::protocol::js_value::JsJson::String(
                    crate::protocol::js_value::JsString::from(STANDARD.encode(bytes)),
                ),
            ),
        ]))
    }
    pub async fn list_artifacts_lossless(
        &self,
        scope: Scope<'_>,
        kind: Option<&str>,
    ) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
        self.require_artifact_scope(scope).await?;
        let client = self.database.client().await?;
        let rows=client.query(&format!("SELECT * FROM {} WHERE {}=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY kind,revision",table(scope),scope.event_key()),&[&scope.id(),&kind]).await.map_err(ProtocolError::query)?;
        Ok(crate::protocol::js_value::JsJson::Array(
            rows.iter()
                .map(|row| meta_lossless(row, scope))
                .collect::<Result<Vec<_>, _>>()?,
        ))
    }
}

impl Store {
    pub async fn get_artifact(
        &self,
        scope: Scope<'_>,
        kind: &str,
        revision: Option<i64>,
    ) -> Result<Value, ProtocolError> {
        self.get_artifact_lossless(scope, kind, revision)
            .await?
            .to_serde_checked()
            .map_err(|_| ProtocolError::internal())
    }
    pub async fn list_artifacts(
        &self,
        scope: Scope<'_>,
        kind: Option<&str>,
    ) -> Result<Value, ProtocolError> {
        self.list_artifacts_lossless(scope, kind)
            .await?
            .to_serde_checked()
            .map_err(|_| ProtocolError::internal())
    }
}
