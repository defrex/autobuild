//! Ticket assets are independent of the repository journal. Immutable file
//! uploads precede advisory-locked revision publication; tombstones retain all
//! historical bytes so build pins remain readable after replacements/removal.
use super::{records::Scope, Store};
use crate::{
    data::error::DataError,
    protocol::{
        error::ProtocolError,
        js_json::{parse_js_json, JsValue},
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Read};
use tokio_postgres::{GenericClient, Row};

pub const MAX_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 1000;
pub type PreparedAsset = (Value, Vec<(String, Vec<u8>)>, usize);
fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(422, "validation", message)
}
fn corrupt(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(500, "internal", message)
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, ProtocolError> {
    v[key].as_str().ok_or_else(ProtocolError::internal)
}
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
pub fn validate_label(field: &str, value: &str) -> Result<(), ProtocolError> {
    if value.trim_matches(js_space).is_empty() {
        return Err(invalid(format!("ticket asset {field} is required")));
    }
    if value.encode_utf16().count() > 64 {
        return Err(invalid(format!(
            "ticket asset {field} must be at most 64 characters"
        )));
    }
    if value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err(invalid(format!(
            "ticket asset {field} \"{value}\" may contain only letters, digits, '.', '_' and '-'"
        )));
    }
    Ok(())
}
fn prefix40(value: &str) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(40).collect::<Vec<_>>())
}
pub fn validate_path(path: &str) -> Result<(), ProtocolError> {
    if path.is_empty() {
        return Err(invalid("ticket asset entry path is required"));
    }
    if path.contains('\0') {
        return Err(invalid(format!(
            "ticket asset entry path \"{path}\" contains a NUL byte"
        )));
    }
    if path.contains('\\') {
        return Err(invalid(format!(
            "ticket asset entry path \"{path}\" must use '/' separators"
        )));
    }
    if path.len() > 256 {
        return Err(invalid(format!(
            "ticket asset entry path exceeds 256 bytes: \"{}…\"",
            prefix40(path)
        )));
    }
    if path.starts_with('/') {
        return Err(invalid(format!(
            "ticket asset entry path \"{path}\" must be relative"
        )));
    }
    for segment in path.split('/') {
        if matches!(segment, "" | "." | "..") {
            return Err(invalid(format!(
                "ticket asset entry path \"{path}\" has an empty, '.' or '..' segment"
            )));
        }
        if segment.len() > 128 {
            return Err(invalid(format!(
                "ticket asset entry path segment exceeds 128 bytes in \"{}…\"",
                prefix40(path)
            )));
        }
    }
    Ok(())
}
pub fn validate_structure(
    input: &Value,
    max_bytes: usize,
    max_entries: usize,
) -> Result<usize, ProtocolError> {
    validate_label("kind", string(input, "kind")?)?;
    validate_label("name", string(input, "name")?)?;
    let layout = string(input, "layout")?;
    if !matches!(layout, "file" | "tree") {
        return Err(invalid("ticket asset layout must be 'file' or 'tree'"));
    }
    let entries = input["entries"]
        .as_array()
        .ok_or_else(ProtocolError::internal)?;
    let files = entries
        .iter()
        .filter(|e| e["type"] == "file")
        .collect::<Vec<_>>();
    if layout == "file" {
        if entries.len() != 1 || files.len() != 1 {
            return Err(invalid(
                "a 'file' ticket asset has exactly one file entry and no directories",
            ));
        }
        if string(files[0], "path")?.contains('/') {
            return Err(invalid("a 'file' ticket asset's path is its filename"));
        }
    }
    if entries.len() > max_entries {
        return Err(invalid(format!("ticket asset exceeds the {max_entries}-entry limit: {} entries (files plus directories)",entries.len())));
    }
    let mut kinds = HashMap::new();
    let mut ordered = Vec::new();
    let mut size = 0usize;
    for entry in entries {
        let typ = string(entry, "type")?;
        if !matches!(typ, "file" | "dir") {
            return Err(invalid("ticket asset entry type must be 'file' or 'dir'"));
        }
        let path = string(entry, "path")?;
        validate_path(path)?;
        if kinds.insert(path, typ).is_some() {
            return Err(invalid(format!(
                "duplicate ticket asset entry path \"{path}\""
            )));
        }
        ordered.push(path);
        if typ == "file" {
            size = size
                .checked_add(entry["size"].as_u64().ok_or_else(ProtocolError::internal)? as usize)
                .ok_or_else(ProtocolError::internal)?;
        }
    }
    for path in ordered {
        for (index, _) in path.match_indices('/') {
            let ancestor = &path[..index];
            if kinds.get(ancestor) == Some(&"file") {
                return Err(invalid(format!("ticket asset entry \"{path}\" has a file as its ancestor directory \"{ancestor}\"")));
            }
        }
    }
    if size > max_bytes {
        let formatted = if max_bytes >= 1024 * 1024 && max_bytes.is_multiple_of(1024 * 1024) {
            format!("{} MiB", max_bytes / (1024 * 1024))
        } else if max_bytes >= 1024 * 1024 {
            format!("{:.1} MiB", max_bytes as f64 / (1024.0 * 1024.0))
        } else if max_bytes >= 1024 && max_bytes.is_multiple_of(1024) {
            format!("{} KiB", max_bytes / 1024)
        } else {
            format!("{max_bytes} bytes")
        };
        return Err(invalid(format!(
            "ticket asset exceeds the {max_bytes}-byte ({formatted}) limit: {size} bytes"
        )));
    }
    Ok(size)
}
/// Decode the whole request before uploading any file. Wire schema parsing is
/// separate; this applies the shared structural validator in its exact order.
pub fn prepare_asset(input: &Value) -> Result<PreparedAsset, ProtocolError> {
    prepare_asset_with_limits(input, MAX_BYTES, MAX_ENTRIES)
}
pub fn prepare_asset_with_limits(
    input: &Value,
    max_bytes: usize,
    max_entries: usize,
) -> Result<PreparedAsset, ProtocolError> {
    let mut structure = input.clone();
    let mut files = Vec::new();
    let mut manifest = Vec::new();
    for entry in input["entries"]
        .as_array()
        .ok_or_else(ProtocolError::internal)?
    {
        let typ = string(entry, "type")?;
        let path = string(entry, "path")?;
        if typ == "dir" {
            manifest.push(json!({"type":"dir","path":path}));
            continue;
        }
        let encoded = string(entry, "contentBase64")?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| ProtocolError::validation("ticket asset content is not valid base64"))?;
        if STANDARD.encode(&bytes) != encoded {
            return Err(ProtocolError::validation(
                "ticket asset content is not valid base64",
            ));
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        manifest.push(json!({"type":"file","path":path,"size":bytes.len(),"blobRef":hash}));
        files.push((hash, bytes));
    }
    structure["entries"] = Value::Array(manifest.clone());
    let size = validate_structure(&structure, max_bytes, max_entries)?;
    Ok((Value::Array(manifest), files, size))
}
pub(crate) async fn has_readable_ticket_schema<C: GenericClient + Sync>(
    client: &C,
) -> Result<bool, ProtocolError> {
    let exists: bool = client
        .query_one(
            "SELECT to_regclass('ab_ticket_schema_migrations') IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    if !exists {
        return Ok(false);
    }
    let marker = client
        .query_opt(
            "SELECT version FROM ab_ticket_schema_migrations WHERE singleton=true",
            &[],
        )
        .await?;
    if marker.as_ref().is_none_or(|row| row.get::<_, i32>(0) < 3) {
        return Ok(false);
    }
    Ok(true)
}
pub(crate) async fn hosted_ticket<C: GenericClient + Sync>(
    client: &C,
    repo: &str,
    id: &str,
) -> Result<Option<(String, Option<String>)>, ProtocolError> {
    if !has_readable_ticket_schema(client).await? {
        return Ok(None);
    }
    let row=client.query_opt("SELECT id,readable_id FROM ab_tickets WHERE repo=$1 AND (id=$2 OR lower(readable_id)=lower($2)) LIMIT 1",&[&repo,&id]).await?;
    Ok(row.map(|r| (r.get("id"), r.get("readable_id"))))
}
async fn storage_key<C: GenericClient + Sync>(
    client: &C,
    repo: &str,
    id: &str,
) -> Result<String, ProtocolError> {
    Ok(hosted_ticket(client, repo, id)
        .await?
        .map(|v| v.0)
        .unwrap_or_else(|| id.to_owned()))
}
async fn asset_meta<C: GenericClient + Sync>(
    client: &C,
    row: &Row,
) -> Result<Value, ProtocolError> {
    let repo: String = row.get("repo");
    let id: String = row.get("ticket_id");
    let display = hosted_ticket(client, &repo, &id)
        .await?
        .and_then(|v| v.1)
        .filter(|id| !id.is_empty())
        .unwrap_or(id);
    let revision: i64 = row.get("revision");
    let size: i64 = row.get("size");
    if revision > 9_007_199_254_740_991 || size > 9_007_199_254_740_991 {
        return Err(ProtocolError::internal());
    }
    let raw = row.get::<_, JsValue>("manifest").0;
    let entries = match raw {
        Value::String(raw) => {
            parse_js_json(raw.as_bytes()).map_err(|_| ProtocolError::internal())?
        }
        v => v,
    };
    Ok(
        json!({"repo":repo,"ticketId":display,"kind":row.get::<_,String>("kind"),"name":row.get::<_,String>("name"),"revision":revision,"layout":row.get::<_,String>("layout"),"size":size,"entries":entries,"createdAt":super::records::row_timestamp(row,"created_at")}),
    )
}
fn summarize(meta: &Value) -> Value {
    let entries = meta["entries"].as_array().expect("stored manifest");
    let files = entries.iter().filter(|e| e["type"] == "file").count();
    let mut result = meta.clone();
    result.as_object_mut().unwrap().remove("entries");
    result["fileCount"] = files.into();
    result["dirCount"] = (entries.len() - files).into();
    result
}
impl Store {
    pub async fn ticket_asset_limits(&self, _repo: &str) -> Result<Value, ProtocolError> {
        Ok(json!({"maxBytes":MAX_BYTES,"maxEntries":MAX_ENTRIES}))
    }
    pub async fn put_ticket_asset(
        &self,
        repo: &str,
        ticket: &str,
        input: &Value,
    ) -> Result<Value, ProtocolError> {
        let (manifest, files, size) = prepare_asset(input)?;
        let kind = string(input, "kind")?;
        let name = string(input, "name")?;
        let layout = string(input, "layout")?;
        let blobs = self.blobs.as_ref().ok_or_else(ProtocolError::internal)?;
        for (hash, bytes) in files {
            blobs.put(&hash, &bytes).await?;
        }
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let key = storage_key(&tx, repo, ticket).await?;
        let identity = serde_json::to_string(&json!([repo, key, kind, name]))
            .map_err(|_| ProtocolError::internal())?;
        tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            &[&identity],
        )
        .await
        .map_err(ProtocolError::query)?;
        let revision:i64=tx.query_one("SELECT COALESCE(MAX(revision),-1)+1 FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 AND kind=$3 AND name=$4",&[&repo,&key,&kind,&name]).await.map_err(ProtocolError::query)?.get(0);
        let size = size as i64;
        let now = self.now();
        let row=tx.query_one("INSERT INTO ticket_assets(repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,$9) RETURNING *",&[&repo,&key,&kind,&name,&revision,&layout,&manifest,&size,&now]).await.map_err(ProtocolError::query)?;
        let meta = asset_meta(&tx, &row).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(meta)
    }
    pub async fn get_ticket_asset(
        &self,
        repo: &str,
        ticket: &str,
        kind: &str,
        name: &str,
        rev: Option<i64>,
    ) -> Result<Value, ProtocolError> {
        let client = self.database.client().await?;
        let key = storage_key(&**client, repo, ticket).await?;
        let row=client.query_opt("SELECT * FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 AND kind=$3 AND name=$4 AND ($5::bigint IS NULL OR revision=$5) ORDER BY revision DESC LIMIT 1",&[&repo,&key,&kind,&name,&rev]).await.map_err(ProtocolError::query)?;
        let Some(row) = row else {
            return Ok(Value::Null);
        };
        if row.get::<_, bool>("removed") {
            return Ok(Value::Null);
        }
        let meta = asset_meta(&**client, &row).await?;
        drop(client);
        self.load_asset(meta).await
    }
    async fn load_asset(&self, meta: Value) -> Result<Value, ProtocolError> {
        let mut entries = Vec::new();
        for entry in meta["entries"]
            .as_array()
            .ok_or_else(ProtocolError::internal)?
        {
            if entry["type"] == "dir" {
                entries.push(entry.clone());
                continue;
            }
            let hash = string(entry, "blobRef")?;
            let bytes = match self
                .blobs
                .as_ref()
                .ok_or_else(ProtocolError::internal)?
                .get(hash)
                .await
            {
                Ok(v) => v,
                Err(DataError::MissingBlob) => {
                    return Err(corrupt(format!(
                        "ticket asset {}/{} revision {}: blob for \"{}\" is missing",
                        meta["kind"].as_str().unwrap_or(""),
                        meta["name"].as_str().unwrap_or(""),
                        meta["revision"],
                        entry["path"].as_str().unwrap_or("")
                    )))
                }
                Err(e) => return Err(e.into()),
            };
            entries.push(
                json!({"type":"file","path":entry["path"],"contentBase64":STANDARD.encode(bytes)}),
            );
        }
        Ok(json!({"meta":meta,"entries":entries}))
    }
    pub async fn list_ticket_assets(
        &self,
        repo: &str,
        ticket: &str,
        revisions: bool,
    ) -> Result<Value, ProtocolError> {
        let client = self.database.client().await?;
        let key = storage_key(&**client, repo, ticket).await?;
        let rows=client.query("SELECT * FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 ORDER BY kind,name,revision",&[&repo,&key]).await.map_err(ProtocolError::query)?;
        let mut selected = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            if !revisions
                && rows.get(index + 1).is_some_and(|next| {
                    next.get::<_, String>("kind") == row.get::<_, String>("kind")
                        && next.get::<_, String>("name") == row.get::<_, String>("name")
                })
            {
                continue;
            }
            if !row.get::<_, bool>("removed") {
                selected.push(summarize(&asset_meta(&**client, row).await?));
            }
        }
        Ok(selected.into())
    }
    pub async fn remove_ticket_asset(
        &self,
        repo: &str,
        ticket: &str,
        kind: &str,
        name: &str,
    ) -> Result<Value, ProtocolError> {
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let key = storage_key(&tx, repo, ticket).await?;
        let identity = serde_json::to_string(&json!([repo, key, kind, name]))
            .map_err(|_| ProtocolError::internal())?;
        tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            &[&identity],
        )
        .await
        .map_err(ProtocolError::query)?;
        let row=tx.query_opt("SELECT * FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 AND kind=$3 AND name=$4 ORDER BY revision DESC LIMIT 1",&[&repo,&key,&kind,&name]).await.map_err(ProtocolError::query)?;
        let Some(row) = row else {
            return Ok(Value::Null);
        };
        if row.get::<_, bool>("removed") {
            return Ok(Value::Null);
        }
        let revision = row
            .get::<_, i64>("revision")
            .checked_add(1)
            .ok_or_else(ProtocolError::internal)?;
        let layout: String = row.get("layout");
        let now = self.now();
        let empty = json!([]);
        tx.execute("INSERT INTO ticket_assets(repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,0,true,$8)",&[&repo,&key,&kind,&name,&revision,&layout,&empty,&now]).await.map_err(ProtocolError::query)?;
        let meta = asset_meta(&tx, &row).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(meta)
    }
    pub async fn get_pinned_ticket_asset(
        &self,
        slug: &str,
        kind: &str,
        name: &str,
        rev: Option<i64>,
    ) -> Result<Value, ProtocolError> {
        let record = self.get_record(Scope::Build(slug)).await?;
        if record.is_null() {
            return Err(ProtocolError::missing("build", slug));
        }
        if record.get("ticket").is_none() {
            return Ok(Value::Null);
        }
        let events = self.read_events_held(Scope::Build(slug), 0, 0).await?;
        let mut selected = None;
        let mut historical = None;
        let mut created_seen = false;
        for event in events.as_array().ok_or_else(ProtocolError::internal)? {
            if event["type"] == "build.created" && !created_seen {
                created_seen = true;
                historical = event["payload"]["ticket"]["id"].as_str().map(str::to_owned);
            }
            if matches!(
                event["type"].as_str(),
                Some("build.created" | "spec.revised")
            ) {
                if let Some(pins) = event["payload"].get("assets").and_then(Value::as_array) {
                    if rev.is_none() {
                        selected = pins
                            .iter()
                            .find(|p| p["kind"] == kind && p["name"] == name)
                            .cloned();
                    } else if selected.is_none() {
                        selected = pins
                            .iter()
                            .find(|p| {
                                p["kind"] == kind
                                    && p["name"] == name
                                    && p["revision"].as_i64() == rev
                            })
                            .cloned();
                    }
                }
            }
        }
        let Some(pin) = selected else {
            return Ok(Value::Null);
        };
        let repo = string(&record, "repo")?;
        let ticket = string(&record["ticket"], "id")?;
        if pin.get("snapshot").is_none() {
            return self
                .get_ticket_asset(repo, ticket, kind, name, pin["revision"].as_i64())
                .await;
        }
        self.read_asset_snapshot(repo, ticket, &pin, historical.as_deref())
            .await
    }
    async fn snapshot_artifact_bytes(
        &self,
        repo: &str,
        reference: &Value,
    ) -> Result<Option<Vec<u8>>, ProtocolError> {
        let artifact = self
            .get_artifact(
                Scope::Repo(repo),
                string(reference, "kind")?,
                reference["revision"].as_i64(),
            )
            .await?;
        if artifact.is_null() {
            return Ok(None);
        }
        Ok(Some(
            STANDARD
                .decode(string(&artifact, "contentBase64")?)
                .map_err(|_| ProtocolError::internal())?,
        ))
    }
    async fn read_asset_snapshot(
        &self,
        repo: &str,
        ticket: &str,
        pin: &Value,
        historical: Option<&str>,
    ) -> Result<Value, ProtocolError> {
        let bytes = self
            .snapshot_artifact_bytes(repo, &pin["snapshot"])
            .await?
            .ok_or_else(|| corrupt("ticket asset snapshot manifest is missing"))?;
        let mut decoded = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes.as_slice())
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut decoded)
            .map_err(|_| corrupt("invalid ticket asset snapshot manifest"))?;
        if decoded.len() > 4 * 1024 * 1024 {
            return Err(corrupt("invalid ticket asset snapshot manifest"));
        }
        let raw = parse_js_json(&decoded)
            .map_err(|_| corrupt("invalid ticket asset snapshot manifest"))?;
        let manifest = validate_snapshot_manifest(&raw)?;
        let meta = &manifest["meta"];
        let snapshot_ticket = if meta["ticketId"].as_str() == historical {
            historical.unwrap_or(ticket)
        } else {
            ticket
        };
        verify_snapshot_metadata(meta, repo, snapshot_ticket, pin)?;
        let files = manifest["files"]
            .as_array()
            .ok_or_else(|| corrupt("invalid ticket asset snapshot manifest"))?;
        let mut file_map = HashMap::new();
        for file in files {
            file_map.insert(string(file, "path")?, file);
        }
        let meta_entries = meta["entries"]
            .as_array()
            .ok_or_else(ProtocolError::internal)?;
        if file_map.len() != files.len()
            || file_map.len() != meta_entries.iter().filter(|e| e["type"] == "file").count()
        {
            return Err(corrupt("inconsistent ticket asset snapshot files"));
        }
        let mut entries = Vec::new();
        for entry in meta_entries {
            if entry["type"] == "dir" {
                entries.push(entry.clone());
                continue;
            }
            let file = file_map
                .get(string(entry, "path")?)
                .ok_or_else(|| corrupt("inconsistent ticket asset snapshot chunks"))?;
            let chunks = file["chunks"]
                .as_array()
                .ok_or_else(|| corrupt("inconsistent ticket asset snapshot chunks"))?;
            let size = entry["size"].as_u64().ok_or_else(ProtocolError::internal)?;
            let mut total = 0u64;
            for chunk in chunks {
                let n = chunk["size"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 256 * 1024)
                    .ok_or_else(|| corrupt("inconsistent ticket asset snapshot chunks"))?;
                total = total.checked_add(n).ok_or_else(ProtocolError::internal)?;
            }
            if total != size {
                return Err(corrupt("inconsistent ticket asset snapshot chunks"));
            }
            let mut content = Vec::new();
            for chunk in chunks {
                let bytes = self
                    .snapshot_artifact_bytes(repo, chunk)
                    .await?
                    .ok_or_else(|| corrupt("ticket asset snapshot chunk is missing or corrupt"))?;
                if bytes.len() as u64 != chunk["size"].as_u64().unwrap()
                    || format!("{:x}", Sha256::digest(&bytes)) != string(chunk, "hash")?
                {
                    return Err(corrupt("ticket asset snapshot chunk is missing or corrupt"));
                }
                content.extend(bytes);
            }
            if content.len() as u64 != size
                || format!("{:x}", Sha256::digest(&content)) != string(entry, "blobRef")?
            {
                return Err(corrupt("inconsistent ticket asset snapshot content"));
            }
            entries.push(json!({"type":"file","path":entry["path"],"contentBase64":STANDARD.encode(content)}));
        }
        let mut meta = meta.clone();
        meta["ticketId"] = ticket.into();
        Ok(json!({"meta":meta,"entries":entries}))
    }
}
fn verify_snapshot_metadata(
    meta: &Value,
    repo: &str,
    ticket: &str,
    pin: &Value,
) -> Result<(), ProtocolError> {
    let summary = summarize_checked(meta)?;
    if meta["repo"] != repo
        || meta["ticketId"] != ticket
        || [
            "kind",
            "name",
            "revision",
            "layout",
            "size",
            "fileCount",
            "dirCount",
        ]
        .iter()
        .any(|k| summary[*k] != pin[*k])
        || validate_structure(meta, MAX_BYTES, MAX_ENTRIES)? as u64
            != meta["size"].as_u64().unwrap_or(u64::MAX)
    {
        return Err(corrupt("inconsistent ticket asset snapshot metadata"));
    }
    Ok(())
}
fn summarize_checked(meta: &Value) -> Result<Value, ProtocolError> {
    if !meta.is_object() || meta["entries"].as_array().is_none() {
        return Err(corrupt("inconsistent ticket asset snapshot metadata"));
    }
    Ok(summarize(meta))
}

fn validate_snapshot_manifest(value: &Value) -> Result<Value, ProtocolError> {
    static FIXTURE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let fixture = FIXTURE.get_or_init(|| {
        parse_js_json(include_bytes!("../../../fixtures/protocol-assets.json"))
            .expect("generated asset schemas")
    });
    crate::protocol::validation::validate_schema(&fixture["manifestSchema"], value).map_err(corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_structure_validation_matches_typescript() {
        let fixture =
            parse_js_json(include_bytes!("../../../fixtures/protocol-assets.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = match validate_structure(&case["input"], MAX_BYTES, MAX_ENTRIES) {
                Ok(size) => json!({"accepted":size}),
                Err(error) => {
                    json!({"rejected":{"status":error.status.as_u16(),"kind":error.kind,"error":error.error}})
                }
            };
            assert_eq!(actual, case["oracle"], "{}", case["id"]);
        }
    }
    #[test]
    fn private_snapshot_manifest_schema_matches_core_zod() {
        let fixture =
            parse_js_json(include_bytes!("../../../fixtures/protocol-assets.json")).unwrap();
        for case in fixture["snapshots"].as_array().unwrap() {
            let actual = match validate_snapshot_manifest(&case["input"]) {
                Ok(value) => json!({"accepted":value}),
                Err(error) => json!({"rejected":error.error}),
            };
            assert_eq!(actual, case["oracle"], "{}", case["id"]);
        }
    }
    #[test]
    fn decoding_is_canonical_and_validates_entire_batch_before_publication() {
        for encoded in ["Zg", "Zh==", " Zg==", "-___"] {
            let input = json!({"kind":"design","name":"a","layout":"file","entries":[{"type":"file","path":"a","contentBase64":encoded}]});
            let error = prepare_asset(&input).unwrap_err();
            assert_eq!(error.status.as_u16(), 400);
            assert_eq!(error.error, "ticket asset content is not valid base64");
        }
        let input = json!({"kind":"design","name":"a","layout":"tree","entries":[{"type":"dir","path":"empty"},{"type":"file","path":"a","contentBase64":"AP+A"}]});
        let (manifest, files, size) = prepare_asset(&input).unwrap();
        assert_eq!(size, 3);
        assert_eq!(files[0].1, vec![0, 255, 128]);
        assert_eq!(manifest[1]["size"], 3);
    }
}

#[path = "assets_lossless.rs"]
mod lossless;
pub use lossless::{
    prepare_asset_lossless, prepare_asset_with_limits_lossless, validate_label_lossless,
    validate_path_lossless, validate_structure_lossless, PreparedAssetLossless,
};
