//! Streams serialize against their own row; close publishes its artifact and
//! lifecycle atomically, re-reading chunks under lock after lock-free upload.
use super::{
    artifacts::PreparedArtifact,
    records::{lock, Scope},
    timestamp, Store,
};
use crate::protocol::{
    error::ProtocolError,
    js_json::{parse_js_json, serializable, JsValue},
    stream_document::{artifact_input, assemble},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_postgres::{Row, Transaction};
const FORMAT: &str = "ai-ui-message-stream/v1";
pub const BATCH_MAX_BYTES: usize = 1_048_576;

pub fn scope_value(scope: Scope<'_>) -> Value {
    json!({"kind":scope.name(),scope.event_key():scope.id()})
}
pub fn record_scope(record: &Value) -> Result<Scope<'_>, ProtocolError> {
    let scope = &record["scope"];
    match scope["kind"].as_str() {
        Some("build") => scope["build"].as_str().map(Scope::Build),
        Some("repo") => scope["repo"].as_str().map(Scope::Repo),
        Some("session") => scope["session"].as_str().map(Scope::Session),
        _ => None,
    }
    .ok_or_else(ProtocolError::internal)
}
fn record(row: &Row) -> Result<Value, ProtocolError> {
    let id: String = row.get("id");
    let kind: String = row.get("scope_kind");
    let owner = match kind.as_str() {
        "build" | "repo" | "session" => row.get::<_, Option<String>>(kind.as_str()),
        _ => None,
    };
    let owner = owner.ok_or_else(|| {
        ProtocolError::new(
            500,
            "internal",
            format!("stream \"{id}\" has an unreadable scope"),
        )
    })?;
    let mut value = json!({"id":id,"scope":{"kind":kind.clone(),kind:owner},"label":row.get::<_,String>("label"),"format":row.get::<_,String>("format"),"status":row.get::<_,String>("status"),"createdAt":super::records::row_timestamp(row,"created_at")});
    if let Some(closed) = row.get::<_, Option<chrono::DateTime<chrono::Utc>>>("closed_at") {
        value["closedAt"] = timestamp(closed).into();
    }
    if let Some(outcome) = row
        .get::<_, Option<String>>("outcome")
        .filter(|s| !s.is_empty())
    {
        value["outcome"] = outcome.into();
    }
    if let (Some(kind), Some(revision), Some(blob_ref)) = (
        row.get::<_, Option<String>>("artifact_kind"),
        row.get::<_, Option<i64>>("artifact_revision"),
        row.get::<_, Option<String>>("artifact_blob_ref"),
    ) {
        if !kind.is_empty() && !blob_ref.is_empty() {
            value["artifact"] = json!({"kind":kind,"revision":revision,"blobRef":blob_ref});
        }
    }
    Ok(value)
}
fn chunk(row: &Row) -> Result<Value, ProtocolError> {
    let seq: i64 = row.get("seq");
    if seq > 9_007_199_254_740_991 {
        return Err(ProtocolError::internal());
    }
    let parts = row.get::<_, JsValue>("parts").0;
    let parts = if let Value::String(text) = parts {
        parse_js_json(text.as_bytes()).map_err(|_| ProtocolError::internal())?
    } else {
        parts
    };
    Ok(
        json!({"stream":row.get::<_,String>("stream"),"seq":seq,"ts":super::records::row_timestamp(row,"ts"),"parts":parts}),
    )
}
async fn locked(tx: &Transaction<'_>, id: &str) -> Result<Row, ProtocolError> {
    tx.query_opt("SELECT * FROM streams WHERE id=$1 FOR UPDATE", &[&id])
        .await
        .map_err(ProtocolError::query)?
        .ok_or_else(|| ProtocolError::missing("stream", id))
}
async fn chunks(tx: &Transaction<'_>, id: &str, since: i64) -> Result<Vec<Value>, ProtocolError> {
    tx.query(
        "SELECT * FROM stream_chunks WHERE stream=$1 AND seq>$2 ORDER BY seq",
        &[&id, &since],
    )
    .await
    .map_err(ProtocolError::query)?
    .iter()
    .map(chunk)
    .collect()
}
fn prepare_parts(parts: &Value) -> Result<Value, ProtocolError> {
    let values = parts.as_array().filter(|p| !p.is_empty()).ok_or_else(|| {
        ProtocolError::new(500, "internal", "stream parts must be a nonempty array")
    })?;
    for part in values {
        if !part.is_object() {
            return Err(ProtocolError::new(
                500,
                "internal",
                "every stream part must be a JSON object",
            ));
        }
        if !part["type"].as_str().is_some_and(|s| !s.is_empty()) {
            return Err(ProtocolError::new(
                500,
                "internal",
                "every stream part must carry a nonempty string \"type\"",
            ));
        }
    }
    let normalized = serializable(parts.clone());
    let bytes = serde_json::to_vec(&normalized)
        .map_err(|_| ProtocolError::internal())?
        .len();
    if bytes > BATCH_MAX_BYTES {
        return Err(ProtocolError::new(
            413,
            "validation",
            format!("stream batch of {bytes} bytes exceeds the {BATCH_MAX_BYTES}-byte ceiling"),
        ));
    }
    Ok(normalized)
}
fn fresh_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "st_{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
impl Store {
    pub async fn create_stream(
        &self,
        scope: Scope<'_>,
        label: &str,
    ) -> Result<Value, ProtocolError> {
        if label.is_empty() {
            return Err(ProtocolError::new(
                500,
                "internal",
                "stream label is required",
            ));
        }
        let id = fresh_id();
        let now = self.now();
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let kind = scope.name();
        let owner = scope.id();
        let build = matches!(scope, Scope::Build(_)).then_some(owner);
        let repo = matches!(scope, Scope::Repo(_)).then_some(owner);
        let session = matches!(scope, Scope::Session(_)).then_some(owner);
        tx.execute("DELETE FROM stream_chunks WHERE stream IN (SELECT id FROM streams WHERE status='closed' AND scope_kind=$1 AND ((scope_kind='build' AND build=$2) OR (scope_kind='repo' AND repo=$3) OR (scope_kind='session' AND session=$4)) ORDER BY closed_at DESC,id DESC OFFSET 1)",&[&kind,&build,&repo,&session]).await.map_err(ProtocolError::query)?;
        let row=tx.query_one("INSERT INTO streams(id,scope_kind,build,repo,session,label,format,status,creation_seq,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'open',nextval('streams_creation_seq'),$8) RETURNING *",&[&id,&kind,&build,&repo,&session,&label,&FORMAT,&now]).await.map_err(ProtocolError::query)?;
        let value = record(&row)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(value)
    }
    pub async fn get_stream(&self, id: &str) -> Result<Value, ProtocolError> {
        let client = self.database.client().await?;
        client
            .query_opt("SELECT * FROM streams WHERE id=$1", &[&id])
            .await
            .map_err(ProtocolError::query)?
            .as_ref()
            .map(record)
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
    pub async fn list_streams(&self, scope: Scope<'_>) -> Result<Value, ProtocolError> {
        let client = self.database.client().await?;
        let rows=client.query(&format!("SELECT * FROM streams WHERE scope_kind=$1 AND {}=$2 ORDER BY created_at,creation_seq",scope.event_key()),&[&scope.name(),&scope.id()]).await.map_err(ProtocolError::query)?;
        Ok(rows
            .iter()
            .map(record)
            .collect::<Result<Vec<_>, _>>()?
            .into())
    }
    pub async fn append_stream_parts(
        &self,
        id: &str,
        parts: &Value,
    ) -> Result<Value, ProtocolError> {
        let parts = prepare_parts(parts)?;
        let encoded =
            Value::String(serde_json::to_string(&parts).map_err(|_| ProtocolError::internal())?);
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = locked(&tx, id).await?;
        if row.get::<_, String>("status") == "closed" {
            return Err(ProtocolError::new(
                409,
                "conflict",
                format!("stream \"{id}\" is closed"),
            ));
        }
        let tail: i64 = tx
            .query_one(
                "SELECT COALESCE(MAX(seq),0) FROM stream_chunks WHERE stream=$1",
                &[&id],
            )
            .await
            .map_err(ProtocolError::query)?
            .get(0);
        let seq = tail
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(ProtocolError::internal)?;
        let now = self.now();
        tx.execute(
            "INSERT INTO stream_chunks(stream,seq,ts,parts) VALUES($1,$2,$3,$4)",
            &[&id, &seq, &now, &encoded],
        )
        .await
        .map_err(ProtocolError::query)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(json!({"stream":id,"seq":seq,"ts":timestamp(now),"parts":parts}))
    }
    async fn stream_snapshot(
        &self,
        id: &str,
        since: i64,
    ) -> Result<(Value, Vec<Value>), ProtocolError> {
        let mut client = self.database.client().await?;
        let tx = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let row = tx
            .query_opt("SELECT * FROM streams WHERE id=$1", &[&id])
            .await
            .map_err(ProtocolError::query)?
            .ok_or_else(|| ProtocolError::missing("stream", id))?;
        let value = record(&row)?;
        let parts = chunks(&tx, id, since).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok((value, parts))
    }
    pub async fn read_stream(
        &self,
        id: &str,
        since: i64,
        wait: u64,
    ) -> Result<Value, ProtocolError> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait.min(30));
        loop {
            let (record, chunks) = self.stream_snapshot(id, since).await?;
            let ready = !chunks.is_empty()
                || record["status"] == "closed"
                || tokio::time::Instant::now() >= deadline;
            if ready {
                let mut read = json!({"chunks":chunks,"status":record["status"]});
                for key in ["outcome", "artifact"] {
                    if let Some(value) = record.get(key) {
                        read[key] = value.clone();
                    }
                }
                return Ok(read);
            }
            tokio::time::sleep_until(
                (tokio::time::Instant::now() + std::time::Duration::from_secs(1)).min(deadline),
            )
            .await;
        }
    }
    async fn prepare_stream_close(
        &self,
        record: &Value,
        chunks: &[Value],
        outcome: &str,
    ) -> Result<PreparedArtifact, ProtocolError> {
        let parts = chunks
            .iter()
            .flat_map(|c| c["parts"].as_array().into_iter().flatten().cloned())
            .collect::<Vec<_>>();
        let assembly = assemble(&parts);
        let input = artifact_input(
            record["id"].as_str().unwrap(),
            &record["scope"],
            record["label"].as_str().unwrap(),
            outcome,
            &assembly,
            chunks.len(),
        );
        let bytes = input["content"]
            .as_str()
            .ok_or_else(ProtocolError::internal)?
            .as_bytes();
        let blob_ref = format!("{:x}", Sha256::digest(bytes));
        self.blobs
            .as_ref()
            .ok_or_else(ProtocolError::internal)?
            .put(&blob_ref, bytes)
            .await?;
        Ok(PreparedArtifact {
            kind: input["kind"].as_str().unwrap().into(),
            blob_ref,
            metadata: serializable(input["metadata"].clone()),
        })
    }
    pub async fn close_stream(&self, id: &str, outcome: &str) -> Result<Value, ProtocolError> {
        let (snapshot, prepared_chunks) = self.stream_snapshot(id, 0).await?;
        if snapshot["status"] == "closed" {
            return Ok(snapshot);
        }
        let mut prepared = self
            .prepare_stream_close(&snapshot, &prepared_chunks, outcome)
            .await?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = locked(&tx, id).await?;
        if row.get::<_, String>("status") == "closed" {
            return record(&row);
        }
        let fresh = chunks(&tx, id, 0).await?;
        if fresh.len() != prepared_chunks.len() {
            prepared = self
                .prepare_stream_close(&snapshot, &fresh, outcome)
                .await?;
        }
        let scope = record_scope(&snapshot)?;
        let meta = self.deposit_artifact_locked(&tx, scope, &prepared).await?;
        let revision = meta["revision"]
            .as_i64()
            .ok_or_else(ProtocolError::internal)?;
        let closed_at = chrono::DateTime::parse_from_rfc3339(meta["createdAt"].as_str().unwrap())
            .map_err(|_| ProtocolError::internal())?
            .with_timezone(&chrono::Utc);
        tx.execute("UPDATE streams SET status='closed',outcome=$1,closed_at=$2,artifact_kind=$3,artifact_revision=$4,artifact_blob_ref=$5 WHERE id=$6",&[&outcome,&closed_at,&prepared.kind,&revision,&prepared.blob_ref,&id]).await.map_err(ProtocolError::query)?;
        let value = record(&locked(&tx, id).await?)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(value)
    }
}

// Parallel typed APIs retain arbitrary UTF-16 stream envelopes through the
// encoded JSONB-string storage format used by the TypeScript adapter.
use crate::protocol::{
    artifact_preparation::LosslessArtifactInput,
    js_postgres::{PgJson, PgText, PgValue},
    js_value::{JsJson, JsString},
};
fn chunk_lossless(row: &Row) -> Result<JsJson, ProtocolError> {
    let seq: i64 = row.get("seq");
    if seq > 9_007_199_254_740_991 {
        return Err(ProtocolError::internal());
    }
    let parts = row.get::<_, PgValue>("parts").0;
    let parts = crate::protocol::js_postgres::decode_json_column(parts)?;
    let mut out = JsJson::from_serde(
        &json!({"stream":row.get::<_,String>("stream"),"seq":seq,"ts":super::records::row_timestamp(row,"ts")}),
    );
    out["parts"] = parts;
    Ok(out)
}
async fn chunks_lossless(
    tx: &Transaction<'_>,
    id: &str,
    since: i64,
) -> Result<Vec<JsJson>, ProtocolError> {
    tx.query(
        "SELECT * FROM stream_chunks WHERE stream=$1 AND seq>$2 ORDER BY seq",
        &[&id, &since],
    )
    .await
    .map_err(ProtocolError::query)?
    .iter()
    .map(chunk_lossless)
    .collect()
}
fn prepare_parts_lossless(parts: &JsJson) -> Result<JsJson, ProtocolError> {
    let values = parts.as_array().filter(|p| !p.is_empty()).ok_or_else(|| {
        ProtocolError::new(500, "internal", "stream parts must be a nonempty array")
    })?;
    for part in values {
        if !part.is_object() {
            return Err(ProtocolError::new(
                500,
                "internal",
                "every stream part must be a JSON object",
            ));
        }
        if !part["type"].as_string().is_some_and(|s| !s.is_empty()) {
            return Err(ProtocolError::new(
                500,
                "internal",
                "every stream part must carry a nonempty string \"type\"",
            ));
        }
    }
    let encoded = parts.stringify();
    let bytes = encoded.len();
    if bytes > BATCH_MAX_BYTES {
        return Err(ProtocolError::new(
            413,
            "validation",
            format!("stream batch of {bytes} bytes exceeds the {BATCH_MAX_BYTES}-byte ceiling"),
        ));
    }
    // The JSON wire, persisted envelope and HTTP reply all use JSON.stringify's
    // number normalization while isolated UTF-16 units remain escaped intact.
    JsJson::parse(encoded.as_bytes()).map_err(|_| ProtocolError::internal())
}
impl Store {
    pub async fn create_stream_lossless(
        &self,
        scope: Scope<'_>,
        label: &JsString,
    ) -> Result<JsJson, ProtocolError> {
        if label.is_empty() {
            return Err(ProtocolError::new(
                500,
                "internal",
                "stream label is required",
            ));
        }
        let id = fresh_id();
        let now = self.now();
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let kind = scope.name();
        let owner = scope.id();
        let build = matches!(scope, Scope::Build(_)).then_some(owner);
        let repo = matches!(scope, Scope::Repo(_)).then_some(owner);
        let session = matches!(scope, Scope::Session(_)).then_some(owner);
        let label = PgText(label);
        tx.execute("DELETE FROM stream_chunks WHERE stream IN (SELECT id FROM streams WHERE status='closed' AND scope_kind=$1 AND ((scope_kind='build' AND build=$2) OR (scope_kind='repo' AND repo=$3) OR (scope_kind='session' AND session=$4)) ORDER BY closed_at DESC,id DESC OFFSET 1)",&[&kind,&build,&repo,&session]).await.map_err(ProtocolError::query)?;
        let row=tx.query_one("INSERT INTO streams(id,scope_kind,build,repo,session,label,format,status,creation_seq,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'open',nextval('streams_creation_seq'),$8) RETURNING *",&[&id,&kind,&build,&repo,&session,&label,&FORMAT,&now]).await.map_err(ProtocolError::query)?;
        let out = JsJson::from_serde(&record(&row)?);
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(out)
    }
    pub async fn append_stream_parts_lossless(
        &self,
        id: &str,
        parts: &JsJson,
    ) -> Result<JsJson, ProtocolError> {
        let parts = prepare_parts_lossless(parts)?;
        let envelope = JsJson::String(JsString::from(parts.stringify()));
        let encoded = PgJson(&envelope);
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = locked(&tx, id).await?;
        if row.get::<_, String>("status") == "closed" {
            return Err(ProtocolError::new(
                409,
                "conflict",
                format!("stream \"{id}\" is closed"),
            ));
        }
        let tail: i64 = tx
            .query_one(
                "SELECT COALESCE(MAX(seq),0) FROM stream_chunks WHERE stream=$1",
                &[&id],
            )
            .await
            .map_err(ProtocolError::query)?
            .get(0);
        let seq = tail
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(ProtocolError::internal)?;
        let now = self.now();
        tx.execute(
            "INSERT INTO stream_chunks(stream,seq,ts,parts) VALUES($1,$2,$3,$4)",
            &[&id, &seq, &now, &encoded],
        )
        .await
        .map_err(ProtocolError::query)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        let mut out = JsJson::from_serde(&json!({"stream":id,"seq":seq,"ts":timestamp(now)}));
        out["parts"] = parts;
        Ok(out)
    }
    async fn stream_snapshot_lossless(
        &self,
        id: &str,
        since: i64,
    ) -> Result<(Value, Vec<JsJson>), ProtocolError> {
        let mut client = self.database.client().await?;
        let tx = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let row = tx
            .query_opt("SELECT * FROM streams WHERE id=$1", &[&id])
            .await
            .map_err(ProtocolError::query)?
            .ok_or_else(|| ProtocolError::missing("stream", id))?;
        let value = record(&row)?;
        let parts = chunks_lossless(&tx, id, since).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok((value, parts))
    }
    pub async fn read_stream_lossless(
        &self,
        id: &str,
        since: i64,
        wait: u64,
    ) -> Result<JsJson, ProtocolError> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait.min(30));
        loop {
            let (record, chunks) = self.stream_snapshot_lossless(id, since).await?;
            if !chunks.is_empty()
                || record["status"] == "closed"
                || tokio::time::Instant::now() >= deadline
            {
                let mut out = JsJson::from_serde(&json!({"status":record["status"]}));
                out["chunks"] = JsJson::Array(chunks);
                for key in ["outcome", "artifact"] {
                    if let Some(value) = record.get(key) {
                        out[key] = JsJson::from_serde(value)
                    }
                }
                return Ok(out);
            }
            tokio::time::sleep_until(
                (tokio::time::Instant::now() + std::time::Duration::from_secs(1)).min(deadline),
            )
            .await;
        }
    }
    async fn prepare_stream_close_lossless(
        &self,
        record: &Value,
        chunks: &[JsJson],
        outcome: &str,
    ) -> Result<LosslessArtifactInput, ProtocolError> {
        let parts = chunks
            .iter()
            .flat_map(|c| c["parts"].as_array().into_iter().flatten().cloned())
            .collect::<Vec<_>>();
        let assembly = crate::protocol::stream_document::assemble_js(&parts);
        let input = crate::protocol::stream_document::artifact_input_js(
            record["id"].as_str().unwrap(),
            &JsJson::from_serde(&record["scope"]),
            &JsString::from(record["label"].as_str().unwrap()),
            outcome,
            &assembly,
            chunks.len(),
        );
        let bytes = input["content"]
            .as_string()
            .ok_or_else(ProtocolError::internal)?
            .to_scalar()
            .map_err(|_| ProtocolError::internal())?
            .into_bytes();
        let blob_ref = format!("{:x}", Sha256::digest(&bytes));
        self.blobs
            .as_ref()
            .ok_or_else(ProtocolError::internal)?
            .put(&blob_ref, &bytes)
            .await?;
        Ok(LosslessArtifactInput {
            kind: input["kind"]
                .as_string()
                .ok_or_else(ProtocolError::internal)?
                .clone(),
            bytes,
            blob_ref,
            metadata: input["metadata"].clone(),
        })
    }
    pub async fn close_stream_lossless(
        &self,
        id: &str,
        outcome: &str,
    ) -> Result<JsJson, ProtocolError> {
        let (snapshot, prepared_chunks) = self.stream_snapshot_lossless(id, 0).await?;
        if snapshot["status"] == "closed" {
            return Ok(JsJson::from_serde(&snapshot));
        }
        let mut prepared = self
            .prepare_stream_close_lossless(&snapshot, &prepared_chunks, outcome)
            .await?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = locked(&tx, id).await?;
        if row.get::<_, String>("status") == "closed" {
            return record(&row).map(|v| JsJson::from_serde(&v));
        }
        let fresh = chunks_lossless(&tx, id, 0).await?;
        if fresh.len() != prepared_chunks.len() {
            prepared = self
                .prepare_stream_close_lossless(&snapshot, &fresh, outcome)
                .await?
        }
        let scope = record_scope(&snapshot)?;
        let meta = self
            .deposit_artifact_lossless_locked(&tx, scope, &prepared)
            .await?;
        let revision = meta["revision"]
            .as_i64()
            .ok_or_else(ProtocolError::internal)?;
        let closed_at = chrono::DateTime::parse_from_rfc3339(
            &meta["createdAt"]
                .as_string()
                .ok_or_else(ProtocolError::internal)?
                .to_scalar()
                .map_err(|_| ProtocolError::internal())?,
        )
        .map_err(|_| ProtocolError::internal())?
        .with_timezone(&chrono::Utc);
        let kind = PgText(&prepared.kind);
        tx.execute("UPDATE streams SET status='closed',outcome=$1,closed_at=$2,artifact_kind=$3,artifact_revision=$4,artifact_blob_ref=$5 WHERE id=$6",&[&outcome,&closed_at,&kind,&revision,&prepared.blob_ref,&id]).await.map_err(ProtocolError::query)?;
        let value = record(&locked(&tx, id).await?)?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(JsJson::from_serde(&value))
    }
}
