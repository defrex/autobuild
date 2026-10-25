//! Ticket asset strings stay UTF-16 through validation, manifest JSON and
//! snapshot decoding. PostgreSQL TEXT conversion is confined to query binding.
use super::*;
use crate::protocol::{
    js_postgres::{PgJson, PgText, PgValue},
    js_value::{JsJson as J, JsString as S},
};

pub type PreparedAssetLossless = (J, Vec<(String, Vec<u8>)>, usize);
fn obj(fields: Vec<(&str, J)>) -> J {
    J::Object(fields.into_iter().map(|(k, v)| (S::from(k), v)).collect())
}
fn text(v: impl Into<S>) -> J {
    J::String(v.into())
}
fn field<'a>(v: &'a J, key: &str) -> Result<&'a S, ProtocolError> {
    v.get(key)
        .and_then(J::as_string)
        .ok_or_else(ProtocolError::internal)
}
fn n(v: &J, key: &str) -> Result<u64, ProtocolError> {
    v.get(key)
        .and_then(J::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0)
        .map(|n| n as u64)
        .ok_or_else(ProtocolError::internal)
}
fn message(template: &str, values: &[&S]) -> S {
    let mut units = Vec::new();
    let mut parts = template.split("{}");
    units.extend(parts.next().unwrap().encode_utf16());
    for (part, value) in parts.zip(values) {
        units.extend(value.units());
        units.extend(part.encode_utf16());
    }
    S::from_units(units)
}
fn invalid_js(template: &str, values: &[&S]) -> ProtocolError {
    let mut e = ProtocolError::validation_js(message(template, values));
    e.status = axum::http::StatusCode::UNPROCESSABLE_ENTITY;
    e
}
fn corrupt_js(template: &str, values: &[&S]) -> ProtocolError {
    let mut e = ProtocolError::validation_js(message(template, values));
    e.status = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
    e.kind = "internal";
    e
}
pub fn validate_label_lossless(field: &str, value: &S) -> Result<(), ProtocolError> {
    if value.trim_js().is_empty() {
        return Err(invalid(format!("ticket asset {field} is required")));
    }
    if value.len() > 64 {
        return Err(invalid(format!(
            "ticket asset {field} must be at most 64 characters"
        )));
    }
    if value.eq_str(".")
        || value.eq_str("..")
        || !value
            .units()
            .iter()
            .all(|c| matches!(*c,48..=57|65..=90|97..=122|46|95|45))
    {
        return Err(invalid_js(
            &format!(
                "ticket asset {field} \"{{}}\" may contain only letters, digits, '.', '_' and '-'"
            ),
            &[value],
        ));
    }
    Ok(())
}
pub fn validate_path_lossless(path: &S) -> Result<(), ProtocolError> {
    if path.is_empty() {
        return Err(invalid("ticket asset entry path is required"));
    }
    if path.units().contains(&0) {
        return Err(invalid_js(
            "ticket asset entry path \"{}\" contains a NUL byte",
            &[path],
        ));
    }
    if path.units().contains(&92) {
        return Err(invalid_js(
            "ticket asset entry path \"{}\" must use '/' separators",
            &[path],
        ));
    }
    let prefix = S::from_units(path.units().iter().take(40).copied().collect());
    if path.to_usv_string().len() > 256 {
        return Err(invalid_js(
            "ticket asset entry path exceeds 256 bytes: \"{}…\"",
            &[&prefix],
        ));
    }
    if path.units().first() == Some(&47) {
        return Err(invalid_js(
            "ticket asset entry path \"{}\" must be relative",
            &[path],
        ));
    }
    for segment in path.units().split(|c| *c == 47) {
        if segment.is_empty() || segment == [46] || segment == [46, 46] {
            return Err(invalid_js(
                "ticket asset entry path \"{}\" has an empty, '.' or '..' segment",
                &[path],
            ));
        }
        if S::from_units(segment.to_vec()).to_usv_string().len() > 128 {
            return Err(invalid_js(
                "ticket asset entry path segment exceeds 128 bytes in \"{}…\"",
                &[&prefix],
            ));
        }
    }
    Ok(())
}
pub fn validate_structure_lossless(
    input: &J,
    max_bytes: usize,
    max_entries: usize,
) -> Result<usize, ProtocolError> {
    validate_label_lossless("kind", field(input, "kind")?)?;
    validate_label_lossless("name", field(input, "name")?)?;
    let layout = field(input, "layout")?;
    if !layout.eq_str("file") && !layout.eq_str("tree") {
        return Err(invalid("ticket asset layout must be 'file' or 'tree'"));
    }
    let entries = input
        .get("entries")
        .and_then(J::as_array)
        .ok_or_else(ProtocolError::internal)?;
    let files: Vec<_> = entries
        .iter()
        .filter(|e| {
            e.get("type")
                .and_then(J::as_string)
                .is_some_and(|t| t.eq_str("file"))
        })
        .collect();
    if layout.eq_str("file") {
        if entries.len() != 1 || files.len() != 1 {
            return Err(invalid(
                "a 'file' ticket asset has exactly one file entry and no directories",
            ));
        }
        if field(files[0], "path")?.units().contains(&47) {
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
        let typ = field(entry, "type")?;
        if !typ.eq_str("file") && !typ.eq_str("dir") {
            return Err(invalid("ticket asset entry type must be 'file' or 'dir'"));
        }
        let path = field(entry, "path")?;
        validate_path_lossless(path)?;
        if kinds.insert(path, typ).is_some() {
            return Err(invalid_js(
                "duplicate ticket asset entry path \"{}\"",
                &[path],
            ));
        }
        ordered.push(path);
        if typ.eq_str("file") {
            size = size
                .checked_add(n(entry, "size")? as usize)
                .ok_or_else(ProtocolError::internal)?;
        }
    }
    for path in ordered {
        for (i, c) in path.units().iter().enumerate() {
            if *c == 47 {
                let ancestor = S::from_units(path.units()[..i].to_vec());
                if kinds.get(&ancestor).is_some_and(|t| t.eq_str("file")) {
                    return Err(invalid_js(
                        "ticket asset entry \"{}\" has a file as its ancestor directory \"{}\"",
                        &[path, &ancestor],
                    ));
                }
            }
        }
    }
    if size > max_bytes {
        // Reuse the exact shared byte-limit message without projecting any strings.
        let scalar = json!({"kind":"k","name":"n","layout":"file","entries":[{"type":"file","path":"f","size":size}]});
        return Err(validate_structure(&scalar, max_bytes, max_entries).unwrap_err());
    }
    Ok(size)
}
pub fn prepare_asset_lossless(input: &J) -> Result<PreparedAssetLossless, ProtocolError> {
    prepare_asset_with_limits_lossless(input, MAX_BYTES, MAX_ENTRIES)
}
pub fn prepare_asset_with_limits_lossless(
    input: &J,
    max_bytes: usize,
    max_entries: usize,
) -> Result<PreparedAssetLossless, ProtocolError> {
    let mut structure = input.clone();
    let mut files = Vec::new();
    let mut manifest = Vec::new();
    for entry in input
        .get("entries")
        .and_then(J::as_array)
        .ok_or_else(ProtocolError::internal)?
    {
        let typ = field(entry, "type")?;
        let path = field(entry, "path")?;
        if typ.eq_str("dir") {
            manifest.push(obj(vec![
                ("type", text("dir")),
                ("path", text(path.clone())),
            ]));
            continue;
        }
        let encoded = field(entry, "contentBase64")?
            .to_scalar()
            .map_err(|_| ProtocolError::validation("ticket asset content is not valid base64"))?;
        let bytes = STANDARD
            .decode(&encoded)
            .map_err(|_| ProtocolError::validation("ticket asset content is not valid base64"))?;
        if STANDARD.encode(&bytes) != encoded {
            return Err(ProtocolError::validation(
                "ticket asset content is not valid base64",
            ));
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        manifest.push(obj(vec![
            ("type", text("file")),
            ("path", text(path.clone())),
            ("size", J::Number(bytes.len() as f64)),
            ("blobRef", text(hash.clone())),
        ]));
        files.push((hash, bytes));
    }
    *structure
        .get_mut("entries")
        .ok_or_else(ProtocolError::internal)? = J::Array(manifest.clone());
    let size = validate_structure_lossless(&structure, max_bytes, max_entries)?;
    Ok((J::Array(manifest), files, size))
}
async fn asset_meta_lossless<C: GenericClient + Sync>(
    client: &C,
    row: &Row,
) -> Result<J, ProtocolError> {
    // Only the manifest envelope can retain non-scalar code units in PostgreSQL.
    let raw = row.get::<_, PgValue>("manifest").0;
    let entries = crate::protocol::js_postgres::decode_json_column(raw)?;
    let repo: String = row.get("repo");
    let id: String = row.get("ticket_id");
    let display = hosted_ticket(client, &repo, &id)
        .await?
        .and_then(|v| v.1)
        .filter(|s| !s.is_empty())
        .unwrap_or(id);
    let revision: i64 = row.get("revision");
    let size: i64 = row.get("size");
    if revision > 9_007_199_254_740_991 || size > 9_007_199_254_740_991 {
        return Err(ProtocolError::internal());
    }
    let scalar = json!({"repo":repo,"ticketId":display,"kind":row.get::<_,String>("kind"),"name":row.get::<_,String>("name"),"revision":revision,"layout":row.get::<_,String>("layout"),"size":size,"entries":[],"createdAt":super::super::records::row_timestamp(row,"created_at")});
    let mut result = J::from_serde(&scalar);
    *result.get_mut("entries").unwrap() = entries;
    Ok(result)
}
impl Store {
    pub async fn put_ticket_asset_lossless(
        &self,
        repo: &str,
        ticket: &str,
        input: &J,
    ) -> Result<J, ProtocolError> {
        let (manifest, files, size) = prepare_asset_lossless(input)?;
        let kind = field(input, "kind")?;
        let name = field(input, "name")?;
        let layout = field(input, "layout")?;
        let blobs = self.blobs.as_ref().ok_or_else(ProtocolError::internal)?;
        for (hash, bytes) in files {
            blobs.put(&hash, &bytes).await?;
        }
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let key = storage_key(&tx, repo, ticket).await?;
        let identity = J::Array(vec![
            text(repo),
            text(key.clone()),
            text(kind.clone()),
            text(name.clone()),
        ])
        .stringify();
        tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            &[&identity],
        )
        .await
        .map_err(ProtocolError::query)?;
        let revision:i64=tx.query_one("SELECT COALESCE(MAX(revision),-1)+1 FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 AND kind=$3 AND name=$4",&[&repo,&key,&PgText(kind),&PgText(name)]).await.map_err(ProtocolError::query)?.get(0);
        let manifest_envelope = J::String(S::from(manifest.stringify()));
        let size = size as i64;
        let now = self.now();
        let row=tx.query_one("INSERT INTO ticket_assets(repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,$9) RETURNING *",&[&repo,&key,&PgText(kind),&PgText(name),&revision,&PgText(layout),&PgJson(&manifest_envelope),&size,&now]).await.map_err(ProtocolError::query)?;
        let meta = asset_meta_lossless(&tx, &row).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(meta)
    }
    pub async fn remove_ticket_asset_lossless(
        &self,
        repo: &str,
        ticket: &str,
        kind: &S,
        name: &S,
    ) -> Result<J, ProtocolError> {
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let key = storage_key(&tx, repo, ticket).await?;
        let identity = J::Array(vec![
            text(repo),
            text(key.clone()),
            text(kind.clone()),
            text(name.clone()),
        ])
        .stringify();
        tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            &[&identity],
        )
        .await
        .map_err(ProtocolError::query)?;
        let row=tx.query_opt("SELECT * FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 AND kind=$3 AND name=$4 ORDER BY revision DESC LIMIT 1",&[&repo,&key,&PgText(kind),&PgText(name)]).await.map_err(ProtocolError::query)?;
        let Some(row) = row else { return Ok(J::Null) };
        if row.get::<_, bool>("removed") {
            return Ok(J::Null);
        }
        let revision = row
            .get::<_, i64>("revision")
            .checked_add(1)
            .ok_or_else(ProtocolError::internal)?;
        let layout: String = row.get("layout");
        let now = self.now();
        let empty = J::Array(vec![]);
        tx.execute("INSERT INTO ticket_assets(repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,0,true,$8)",&[&repo,&key,&PgText(kind),&PgText(name),&revision,&layout,&PgJson(&empty),&now]).await.map_err(ProtocolError::query)?;
        let meta = asset_meta_lossless(&tx, &row).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(meta)
    }
    pub async fn list_ticket_assets_lossless(
        &self,
        repo: &str,
        ticket: &str,
        revisions: bool,
    ) -> Result<J, ProtocolError> {
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
                selected.push(summarize_lossless(
                    &asset_meta_lossless(&**client, row).await?,
                )?);
            }
        }
        Ok(J::Array(selected))
    }
    pub async fn get_ticket_asset_lossless(
        &self,
        repo: &str,
        ticket: &str,
        kind: &str,
        name: &str,
        rev: Option<i64>,
    ) -> Result<J, ProtocolError> {
        self.get_ticket_asset_identity_lossless(repo, ticket, &S::from(kind), &S::from(name), rev)
            .await
    }
    pub async fn get_ticket_asset_identity_lossless(
        &self,
        repo: &str,
        ticket: &str,
        kind: &S,
        name: &S,
        rev: Option<i64>,
    ) -> Result<J, ProtocolError> {
        let client = self.database.client().await?;
        let key = storage_key(&**client, repo, ticket).await?;
        let row=client.query_opt("SELECT * FROM ticket_assets WHERE repo=$1 AND ticket_id=$2 AND kind=$3 AND name=$4 AND ($5::bigint IS NULL OR revision=$5) ORDER BY revision DESC LIMIT 1",&[&repo,&key,&PgText(kind),&PgText(name),&rev]).await.map_err(ProtocolError::query)?;
        let Some(row) = row else { return Ok(J::Null) };
        if row.get::<_, bool>("removed") {
            return Ok(J::Null);
        }
        let meta = asset_meta_lossless(&**client, &row).await?;
        drop(client);
        self.load_asset_lossless(meta).await
    }
    async fn load_asset_lossless(&self, meta: J) -> Result<J, ProtocolError> {
        let mut entries = Vec::new();
        for entry in meta
            .get("entries")
            .and_then(J::as_array)
            .ok_or_else(ProtocolError::internal)?
        {
            if field(entry, "type")?.eq_str("dir") {
                entries.push(entry.clone());
                continue;
            }
            let hash = field(entry, "blobRef")?
                .to_scalar()
                .map_err(|_| ProtocolError::internal())?;
            let bytes = match self
                .blobs
                .as_ref()
                .ok_or_else(ProtocolError::internal)?
                .get(&hash)
                .await
            {
                Ok(v) => v,
                Err(DataError::MissingBlob) => {
                    let revision = S::from(
                        meta.get("revision")
                            .ok_or_else(ProtocolError::internal)?
                            .stringify(),
                    );
                    return Err(corrupt_js(
                        "ticket asset {}/{} revision {}: blob for \"{}\" is missing",
                        &[
                            field(&meta, "kind")?,
                            field(&meta, "name")?,
                            &revision,
                            field(entry, "path")?,
                        ],
                    ));
                }
                Err(e) => return Err(e.into()),
            };
            entries.push(obj(vec![
                ("type", text("file")),
                ("path", text(field(entry, "path")?.clone())),
                ("contentBase64", text(STANDARD.encode(bytes))),
            ]));
        }
        Ok(obj(vec![("meta", meta), ("entries", J::Array(entries))]))
    }
    pub async fn get_pinned_ticket_asset_lossless(
        &self,
        slug: &str,
        kind: &str,
        name: &str,
        rev: Option<i64>,
    ) -> Result<J, ProtocolError> {
        let scope = Scope::Build(slug);
        let record = self.get_record_lossless(scope).await?;
        if record.is_null() {
            return Err(ProtocolError::missing("build", slug));
        }
        if record.get("ticket").is_none() {
            return Ok(J::Null);
        }
        let request = |name| obj(vec![("reducer", text(name)), ("args", J::Object(vec![]))]);
        let sets = self
            .get_reducer_value_lossless(scope, &request("pinnedAssets"))
            .await?;
        let sets = sets["value"]["pins"]
            .as_array()
            .ok_or_else(ProtocolError::internal)?;
        let mut selected = None;
        if rev.is_none() {
            selected = sets
                .last()
                .and_then(J::as_array)
                .and_then(|set| set.iter().find(|p| p["kind"] == kind && p["name"] == name))
                .cloned();
        } else {
            for set in sets {
                if let Some(pin) = set.as_array().and_then(|set| {
                    set.iter().find(|p| {
                        p["kind"] == kind && p["name"] == name && p["revision"].as_i64() == rev
                    })
                }) {
                    selected = Some(pin.clone());
                    break;
                }
            }
        }
        let Some(pin) = selected else {
            return Ok(J::Null);
        };
        // Repo is a PostgreSQL TEXT field. Ticket is a decoded JSON value and
        // remains an original JavaScript string for immutable snapshot checks.
        let repo = field(&record, "repo")?
            .to_scalar()
            .map_err(|_| ProtocolError::internal())?;
        let ticket = field(&record["ticket"], "id")?;
        if pin.get("snapshot").is_none() {
            return self
                .get_ticket_asset_lossless(
                    &repo,
                    &ticket.to_usv_string(),
                    kind,
                    name,
                    pin["revision"].as_i64(),
                )
                .await;
        }
        let facts = self
            .get_reducer_value_lossless(scope, &request("buildReadFacts"))
            .await?;
        let created = &facts["value"]["created"];
        let historical = if created["type"] == "build.created" {
            created["payload"]["ticket"]["id"].as_string()
        } else {
            None
        };
        self.read_asset_snapshot_lossless(&repo, ticket, &pin, historical)
            .await
    }
}
fn summarize_lossless(meta: &J) -> Result<J, ProtocolError> {
    let entries = meta
        .get("entries")
        .and_then(J::as_array)
        .ok_or_else(|| corrupt("inconsistent ticket asset snapshot metadata"))?;
    let files = entries
        .iter()
        .filter(|e| {
            e.get("type")
                .and_then(J::as_string)
                .is_some_and(|v| v.eq_str("file"))
        })
        .count();
    let mut result = meta.clone();
    result
        .as_object_mut()
        .ok_or_else(ProtocolError::internal)?
        .retain(|(k, _)| !k.eq_str("entries"));
    let object = result.as_object_mut().unwrap();
    object.push((S::from("fileCount"), J::Number(files as f64)));
    object.push((
        S::from("dirCount"),
        J::Number((entries.len() - files) as f64),
    ));
    Ok(result)
}
impl Store {
    async fn snapshot_artifact_bytes_lossless(
        &self,
        repo: &str,
        reference: &J,
    ) -> Result<Option<Vec<u8>>, ProtocolError> {
        let kind = field(reference, "kind")?.to_usv_string();
        let revision = n(reference, "revision")? as i64;
        let artifact = self
            .get_artifact_lossless(Scope::Repo(repo), &kind, Some(revision))
            .await?;
        if artifact.is_null() {
            return Ok(None);
        }
        Ok(Some(
            STANDARD
                .decode(
                    field(&artifact, "contentBase64")?
                        .to_scalar()
                        .map_err(|_| ProtocolError::internal())?,
                )
                .map_err(|_| ProtocolError::internal())?,
        ))
    }
    async fn read_asset_snapshot_lossless(
        &self,
        repo: &str,
        ticket: &S,
        pin: &J,
        historical: Option<&S>,
    ) -> Result<J, ProtocolError> {
        let bytes = self
            .snapshot_artifact_bytes_lossless(
                repo,
                pin.get("snapshot").ok_or_else(ProtocolError::internal)?,
            )
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
        // This is JSON.parse over decoded text, including escaped lone units.
        let raw = crate::protocol::js_value::parse(String::from_utf8_lossy(&decoded).as_bytes())
            .map_err(|_| corrupt("invalid ticket asset snapshot manifest"))?;
        static FIXTURE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        let fixture = FIXTURE.get_or_init(|| {
            parse_js_json(include_bytes!("../../../fixtures/protocol-assets.json"))
                .expect("asset schema fixture")
        });
        let manifest = crate::protocol::validation::lossless::validate_schema(
            &fixture["manifestSchema"],
            &raw,
        )
        .map_err(|message| {
            let mut e = ProtocolError::validation_js(message);
            e.status = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
            e.kind = "internal";
            e
        })?;
        let meta = manifest.get("meta").ok_or_else(ProtocolError::internal)?;
        let summary = summarize_lossless(meta)?;
        let expected_ticket =
            if historical.is_some_and(|v| field(meta, "ticketId").is_ok_and(|id| id == v)) {
                historical.unwrap()
            } else {
                ticket
            };
        if !field(meta, "repo")?.eq_str(repo)
            || field(meta, "ticketId")? != expected_ticket
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
            .any(|k| summary.get(k) != pin.get(k))
            || validate_structure_lossless(meta, MAX_BYTES, MAX_ENTRIES)? as u64 != n(meta, "size")?
        {
            return Err(corrupt("inconsistent ticket asset snapshot metadata"));
        }
        let files = manifest
            .get("files")
            .and_then(J::as_array)
            .ok_or_else(|| corrupt("invalid ticket asset snapshot manifest"))?;
        let mut file_map = HashMap::new();
        for file in files {
            file_map.insert(field(file, "path")?, file);
        }
        let meta_entries = meta
            .get("entries")
            .and_then(J::as_array)
            .ok_or_else(ProtocolError::internal)?;
        if file_map.len() != files.len()
            || file_map.len()
                != meta_entries
                    .iter()
                    .filter(|e| field(e, "type").is_ok_and(|v| v.eq_str("file")))
                    .count()
        {
            return Err(corrupt("inconsistent ticket asset snapshot files"));
        }
        let mut entries = Vec::new();
        for entry in meta_entries {
            if field(entry, "type")?.eq_str("dir") {
                entries.push(entry.clone());
                continue;
            }
            let file = file_map
                .get(field(entry, "path")?)
                .ok_or_else(|| corrupt("inconsistent ticket asset snapshot chunks"))?;
            let chunks = file
                .get("chunks")
                .and_then(J::as_array)
                .ok_or_else(|| corrupt("inconsistent ticket asset snapshot chunks"))?;
            let size = n(entry, "size")?;
            let mut total = 0u64;
            for chunk in chunks {
                let count = n(chunk, "size")?;
                if count == 0 || count > 256 * 1024 {
                    return Err(corrupt("inconsistent ticket asset snapshot chunks"));
                }
                total = total
                    .checked_add(count)
                    .ok_or_else(ProtocolError::internal)?;
            }
            if total != size {
                return Err(corrupt("inconsistent ticket asset snapshot chunks"));
            }
            let mut content = Vec::new();
            for chunk in chunks {
                let bytes = self
                    .snapshot_artifact_bytes_lossless(repo, chunk)
                    .await?
                    .ok_or_else(|| corrupt("ticket asset snapshot chunk is missing or corrupt"))?;
                if bytes.len() as u64 != n(chunk, "size")?
                    || !field(chunk, "hash")?.eq_str(&format!("{:x}", Sha256::digest(&bytes)))
                {
                    return Err(corrupt("ticket asset snapshot chunk is missing or corrupt"));
                }
                content.extend(bytes);
            }
            if content.len() as u64 != size
                || !field(entry, "blobRef")?.eq_str(&format!("{:x}", Sha256::digest(&content)))
            {
                return Err(corrupt("inconsistent ticket asset snapshot content"));
            }
            entries.push(obj(vec![
                ("type", text("file")),
                ("path", text(field(entry, "path")?.clone())),
                ("contentBase64", text(STANDARD.encode(content))),
            ]));
        }
        let mut meta = meta.clone();
        *meta.get_mut("ticketId").unwrap() = text(ticket.clone());
        Ok(obj(vec![("meta", meta), ("entries", J::Array(entries))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scalar_asset_structure_oracles_are_unchanged_and_lone_paths_remain_distinct() {
        let fixture =
            parse_js_json(include_bytes!("../../../fixtures/protocol-assets.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = match validate_structure_lossless(
                &J::from_serde(&case["input"]),
                MAX_BYTES,
                MAX_ENTRIES,
            ) {
                Ok(size) => json!({"accepted":size}),
                Err(e) => {
                    json!({"rejected":{"status":e.status.as_u16(),"kind":e.kind,"error":e.error}})
                }
            };
            assert_eq!(actual, case["oracle"], "{}", case["id"]);
        }
        let raw=crate::protocol::js_value::parse(br#"{"kind":"design","name":"a","layout":"tree","entries":[{"type":"file","path":"\ud800","contentBase64":"YQ=="},{"type":"dir","path":"\ufffd"}]}"#).unwrap();
        let (manifest, _, size) = prepare_asset_lossless(&raw).unwrap();
        assert_eq!(size, 1);
        assert_eq!(
            field(&manifest.as_array().unwrap()[0], "path")
                .unwrap()
                .units(),
            &[0xd800]
        );
        let long = S::from_units(vec![0xd800; 43]);
        assert!(validate_path_lossless(&long).is_err());
        assert!(validate_path_lossless(&S::from_units(vec![0xd800; 42])).is_ok());
        assert!(validate_label_lossless("kind", &S::from_units(vec![0xd800])).is_err());
    }
    #[test]
    fn lossless_snapshot_manifest_schema_matches_all_scalar_core_oracles() {
        let fixture =
            parse_js_json(include_bytes!("../../../fixtures/protocol-assets.json")).unwrap();
        for case in fixture["snapshots"].as_array().unwrap() {
            let actual = match crate::protocol::validation::lossless::validate_schema(
                &fixture["manifestSchema"],
                &J::from_serde(&case["input"]),
            ) {
                Ok(value) => json!({"accepted":value.to_serde_checked().unwrap()}),
                Err(message) => json!({"rejected":message.to_scalar().unwrap()}),
            };
            // Numeric f64 representation is intentionally normalized by JS stringify.
            assert_eq!(
                J::from_serde(&actual),
                J::from_serde(&case["oracle"]),
                "{}",
                case["id"]
            );
        }
    }
}
