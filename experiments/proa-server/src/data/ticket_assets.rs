//! Immutable ticket-asset reads and copy-before-pin snapshots for spec answers.
//! Source revisions are sampled once. Removing a current asset cannot change a
//! sampled revision or the independently deposited snapshot consumed by core.
use super::{blobs::BlobWriter, reader::DataReader, writer::PostgresWriter};
use crate::operator::{control::random_uuid, error::OperatorError};
use chrono::{DateTime, SecondsFormat, Utc};
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write};
fn internal(_: impl std::fmt::Display) -> OperatorError {
    OperatorError::internal()
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn metadata(row: &tokio_postgres::Row, canonical: &str) -> Value {
    let entries: Value = row.get("manifest");
    let entries = if let Some(raw) = entries.as_str() {
        serde_json::from_str(raw).unwrap_or(Value::Null)
    } else {
        entries
    };
    json!({"repo":row.get::<_,String>("repo"),"ticketId":canonical,"kind":row.get::<_,String>("kind"),"name":row.get::<_,String>("name"),"revision":row.get::<_,i64>("revision"),"layout":row.get::<_,String>("layout"),"size":row.get::<_,i64>("size"),"entries":entries,"createdAt":row.get::<_,DateTime<Utc>>("created_at").to_rfc3339_opts(SecondsFormat::Millis,true)})
}
fn pin(meta: &Value) -> Value {
    let files = array(&meta["entries"])
        .iter()
        .filter(|entry| entry["type"] == "file")
        .count();
    json!({"kind":meta["kind"],"name":meta["name"],"revision":meta["revision"],"layout":meta["layout"],"size":meta["size"],"fileCount":files,"dirCount":array(&meta["entries"]).len()-files})
}
/// The structural checks applied by core before any source bytes authorize a pin.
fn validate(meta: &Value) -> Result<(), OperatorError> {
    let bad = OperatorError::internal;
    for label in ["kind", "name"] {
        let label = text(meta, label);
        if label.is_empty()
            || label.len() > 64
            || matches!(label, "." | "..")
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(bad());
        }
    }
    let entries = meta["entries"].as_array().ok_or_else(bad)?;
    if entries.len() > 1000 || !matches!(meta["layout"].as_str(), Some("file" | "tree")) {
        return Err(bad());
    }
    if meta["layout"] == "file"
        && (entries.len() != 1
            || entries[0]["type"] != "file"
            || text(&entries[0], "path").contains('/'))
    {
        return Err(bad());
    }
    let mut paths = BTreeMap::new();
    let mut total = 0u64;
    for entry in entries {
        let path = text(entry, "path");
        let kind = text(entry, "type");
        if !matches!(kind, "file" | "dir")
            || path.is_empty()
            || path.len() > 256
            || path.contains(['\\', '\0'])
            || path
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | "..") || part.len() > 128)
            || paths.insert(path, kind).is_some()
        {
            return Err(bad());
        }
        let allowed = if kind == "file" {
            &["type", "path", "size", "blobRef"][..]
        } else {
            &["type", "path"][..]
        };
        if entry.as_object().is_none_or(|o| {
            o.len() != allowed.len() || o.keys().any(|k| !allowed.contains(&k.as_str()))
        }) {
            return Err(bad());
        }
        if kind == "file" {
            let size = entry["size"].as_u64().ok_or_else(bad)?;
            if size > 25 * 1024 * 1024 || entry["blobRef"].as_str().is_none() {
                return Err(bad());
            }
            total = total.checked_add(size).ok_or_else(bad)?;
        }
    }
    for path in paths.keys() {
        let parts = path.split('/').collect::<Vec<_>>();
        for end in 1..parts.len() {
            if paths.get(parts[..end].join("/").as_str()) == Some(&"file") {
                return Err(bad());
            }
        }
    }
    if total > 25 * 1024 * 1024
        || meta["size"].as_u64() != Some(total)
        || meta["revision"]
            .as_u64()
            .is_none_or(|rev| rev > 9_007_199_254_740_991)
    {
        return Err(bad());
    }
    Ok(())
}
struct Sample {
    storage: String,
    canonical: String,
    meta: Value,
}
async fn sample(
    writer: &PostgresWriter,
    repo: &str,
    ticket: &str,
) -> Result<Vec<Sample>, OperatorError> {
    let connection = writer.client().await.map_err(internal)?;
    let canonical=connection.client.query_opt("SELECT id,readable_id FROM ab_tickets WHERE repo=$1 AND (id=$2 OR lower(readable_id)=lower($2))",&[&repo,&ticket]).await.map_err(internal)?;
    let (storage, canonical) = canonical
        .map(|row| {
            (
                row.get::<_, String>("id"),
                row.get::<_, String>("readable_id"),
            )
        })
        .unwrap_or_else(|| (ticket.into(), ticket.into()));
    let rows=connection.client.query("SELECT DISTINCT ON (kind,name) * FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 ORDER BY kind,name,revision DESC",&[&repo,&storage]).await.map_err(internal)?;
    Ok(rows
        .iter()
        .filter(|row| !row.get::<_, bool>("removed"))
        .map(|row| Sample {
            storage: storage.clone(),
            canonical: canonical.clone(),
            meta: metadata(row, &canonical),
        })
        .collect())
}
pub async fn sample_pins(
    writer: &PostgresWriter,
    repo: &str,
    ticket: &str,
) -> Result<Value, OperatorError> {
    Ok(json!(sample(writer, repo, ticket)
        .await?
        .iter()
        .map(|sample| pin(&sample.meta))
        .collect::<Vec<_>>()))
}
pub async fn snapshot(
    reader: &DataReader,
    writer: &PostgresWriter,
    blobs: &BlobWriter,
    repo: &str,
    ticket: &str,
    now: DateTime<Utc>,
) -> Result<Value, OperatorError> {
    let samples = sample(writer, repo, ticket).await?;
    if !samples.is_empty() {
        writer.ensure_repo(repo, now).await.map_err(internal)?;
    }
    let mut pins = Vec::new();
    for sampled in samples {
        // Re-read the exact sampled revision, never the newest revision. This
        // preserves the TS list→get boundary under concurrent removals/updates.
        let meta = {
            let connection = writer.client().await.map_err(internal)?;
            let kind = text(&sampled.meta, "kind");
            let name = text(&sampled.meta, "name");
            let revision = sampled.meta["revision"]
                .as_i64()
                .ok_or_else(OperatorError::internal)?;
            let row=connection.client.query_opt("SELECT * FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 AND kind=$3 AND name=$4 AND revision=$5",&[&repo,&sampled.storage,&kind,&name,&revision]).await.map_err(internal)?.filter(|row|!row.get::<_,bool>("removed")).ok_or_else(OperatorError::internal)?;
            metadata(&row, &sampled.canonical)
        };
        validate(&meta)?;
        if pin(&meta) != pin(&sampled.meta) {
            return Err(OperatorError::internal());
        }
        let mut files = Vec::new();
        for entry in array(&meta["entries"]) {
            if entry["type"] != "file" {
                continue;
            }
            let bytes = reader
                .blob_bytes(text(entry, "blobRef"))
                .await
                .map_err(internal)?;
            if entry["size"].as_u64() != Some(bytes.len() as u64)
                || format!("{:x}", Sha256::digest(&bytes)) != text(entry, "blobRef")
            {
                return Err(OperatorError::internal());
            }
            let mut chunks = Vec::new();
            for bytes in bytes.chunks(256 * 1024) {
                let kind = format!("ticket-snapshot-{}", random_uuid());
                let deposited = writer
                    .put_repo_artifact(blobs, repo, &kind, bytes, &json!({}), now)
                    .await
                    .map_err(internal)?;
                chunks.push(json!({"kind":kind,"revision":deposited["revision"],"size":bytes.len(),"hash":format!("{:x}",Sha256::digest(bytes))}));
            }
            files.push(json!({"path":entry["path"],"chunks":chunks}));
        }
        let mut manifest_meta = meta;
        manifest_meta["ticketId"] = json!(ticket);
        let manifest = json!({"version":1,"meta":manifest_meta,"files":files});
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&serde_json::to_vec(&manifest).map_err(internal)?)
            .map_err(internal)?;
        let bytes = gzip.finish().map_err(internal)?;
        let kind = format!("ticket-snapshot-{}", random_uuid());
        let deposited = writer
            .put_repo_artifact(blobs, repo, &kind, &bytes, &json!({}), now)
            .await
            .map_err(internal)?;
        let mut pinned = pin(&sampled.meta);
        pinned["snapshot"] = json!({"kind":kind,"revision":deposited["revision"]});
        pins.push(pinned);
    }
    Ok(json!(pins))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structural_validation_refuses_ambiguous_or_corrupt_manifests() {
        let good = json!({"kind":"design","name":"reference","layout":"tree","size":1,"revision":0,"entries":[{"type":"file","path":"a/b","size":1,"blobRef":"hash"}]});
        assert!(validate(&good).is_ok());
        let mut bad = good.clone();
        bad["entries"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"file","path":"a","size":0,"blobRef":"hash"}));
        assert!(validate(&bad).is_err());
        bad = good;
        bad["size"] = json!(2);
        assert!(validate(&bad).is_err());
    }
}
