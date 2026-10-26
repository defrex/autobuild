//! Store-backed, read-only dashboard and detail snapshots.
use super::{error::DataError, postgres::Scope, reader::DataReader};
use crate::dashboard::{
    detail,
    model::{self, array},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Debug, serde::Serialize)]
pub struct Snapshot {
    pub projects: Vec<String>,
    pub project: Option<String>,
    pub rows: Vec<Value>,
    pub settings: Value,
    pub error: Option<String>,
}
#[derive(Default)]
pub(super) struct DashboardIndex {
    records: Vec<Value>,
    states: HashMap<String, Result<(Value, Value, i64), DataError>>,
    pinned: HashMap<String, (i64, Option<Value>)>,
}
impl Snapshot {
    pub fn unavailable(error: &str) -> Self {
        Self {
            projects: vec![],
            project: None,
            rows: vec![],
            settings: Value::Null,
            error: Some(error.into()),
        }
    }
}
fn decode_config(bytes: &[u8]) -> Result<Value, DataError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| DataError::Blob)?;
    if !value["verify"]["steps"].is_array() || !value["finalize"]["steps"].is_array() {
        return Err(DataError::Blob);
    }
    Ok(value)
}
fn projected(
    record: &Value,
    state: &Value,
    facts: &Value,
    config: &Value,
    streams: Option<&[Value]>,
    pinned: Option<&Value>,
) -> Value {
    let slug = record["slug"].as_str().unwrap_or_default();
    let row = model::project(
        record,
        &state["build"],
        model::ProjectionFacts {
            dashboard: &facts["dashboard"],
            restack: &facts["restack"],
            deferral: &facts["deferral"],
        },
        config,
        streams,
        pinned,
    );
    row.unwrap_or_else(||json!({"slug":slug,"status":state["build"]["status"],"hidden":true,"kind":if state["build"]["kind"]=="node"{"integration"}else{"work"},"target":state["build"]["target"]["ticket"]["id"].as_str().or(state["build"]["baseBranch"].as_str()),"landing":state["build"]["landing"],"autoMerge":crate::dashboard::landing::auto_merge(&state["build"]),"collectionIdentity":{"repo":record["repo"],"source":record["ticket"]["source"],"id":record["ticket"]["id"],"targetBuild":state["build"]["target"]["build"],"targetSource":state["build"]["target"]["ticket"]["source"],"targetId":state["build"]["target"]["ticket"]["id"],"title":record["ticket"]["title"],"status":state["build"]["status"],"createdAt":record["createdAt"]},"steps":[]}))
}
impl DataReader {
    pub async fn dashboard_snapshot(&self, selected: Option<&str>) -> Result<Snapshot, DataError> {
        let projects: Vec<String> = self
            .postgres()
            .projects()
            .await?
            .iter()
            .filter_map(|p| p["repo"].as_str().map(str::to_owned))
            .collect();
        let project = match selected {
            Some(id) => Some(
                projects
                    .iter()
                    .find(|p| p.as_str() == id)
                    .ok_or(DataError::MissingScope { scope: "project" })?
                    .clone(),
            ),
            None => projects.first().cloned(),
        };
        let mut snapshot = Snapshot {
            projects,
            project,
            rows: vec![],
            settings: Value::Null,
            error: None,
        };
        let Some(repo) = snapshot.project.as_deref() else {
            return Ok(snapshot);
        };
        let entry = self
            .dashboards
            .lock()
            .await
            .entry(repo.into())
            .or_insert_with(|| {
                std::sync::Arc::new(tokio::sync::Mutex::new(DashboardIndex::default()))
            })
            .clone();
        let mut index = entry.lock().await;
        let known = Value::Array(
            index
                .records
                .iter()
                .map(|r| {
                    let seq = if index
                        .states
                        .contains_key(r["slug"].as_str().unwrap_or_default())
                    {
                        r["eventSeq"].clone()
                    } else {
                        json!(-1)
                    };
                    json!({"slug":r["slug"],"seq":seq,"updated":r["updatedAt"]})
                })
                .collect(),
        );
        let changed = self.postgres().changed_builds(repo, &known).await?;
        for record in changed {
            let slug = record["slug"].as_str().ok_or(DataError::Query)?.to_owned();
            if record["deleted"] == true {
                index.records.retain(|r| r["slug"] != slug);
                index.states.remove(&slug);
                index.pinned.remove(&slug);
                continue;
            }
            let state = self.build_display(repo, &slug).await;
            // Transient backend errors retry next poll; deterministic decode failures
            // remain isolated until explicit cache clear/restart.
            if state
                .as_ref()
                .is_err_and(|e| !matches!(e, DataError::Decode { .. }))
            {
                index.states.remove(&slug);
            } else {
                index.states.insert(slug.clone(), state);
            }
            if let Some(old) = index.records.iter_mut().find(|r| r["slug"] == slug) {
                *old = record;
            } else {
                index.records.push(record);
            }
        }
        let records = index.records.clone();
        let repository = self.repository(repo).await?;
        let facts = &repository["repositoryReadFacts"];
        snapshot.settings = facts["settings"].clone();
        snapshot.settings["harvest"] = facts["harvest"].clone();
        snapshot.settings["dismissedThrough"] = facts["dismissedThrough"].clone();
        if records.is_empty() {
            return Ok(snapshot);
        }
        let reference = &facts["status"]["effectiveConfig"];
        let Some(kind) = reference["kind"].as_str() else {
            snapshot.error = Some("Effective configuration unavailable for this project.".into());
            return Ok(snapshot);
        };
        let bytes = self
            .artifact(repo, Scope::Repository, kind, reference["rev"].as_i64())
            .await?
            .ok_or(DataError::MissingBlob)?;
        let config = decode_config(&bytes)?;
        let mut entries = Vec::new();
        for record in &records {
            let slug = record["slug"].as_str().ok_or(DataError::Query)?;
            match index.states.get(slug) {
                Some(Ok((state,facts,_)))=>entries.push(projected(record,state,facts,&config,None,None)),
                Some(Err(error))=>entries.push(json!({"slug":slug,"status":"unreadable","error":error.to_string(),"steps":[]})),
                None=>entries.push(json!({"slug":slug,"status":"unreadable","error":"Build read failed; retrying.","steps":[]})),
            }
        }
        let parents: HashMap<String, String> = entries
            .iter()
            .filter_map(|row| {
                Some((
                    row["slug"].as_str()?.into(),
                    row["collectionIdentity"]["targetBuild"].as_str()?.into(),
                ))
            })
            .collect();
        let mut visible: HashSet<String> = entries
            .iter()
            .filter(|r| r["hidden"] != true)
            .filter_map(|r| r["slug"].as_str().map(str::to_owned))
            .collect();
        for child in visible.clone() {
            let mut cursor = child;
            let mut seen = HashSet::new();
            while seen.insert(cursor.clone()) {
                let Some(parent) = parents.get(&cursor) else {
                    break;
                };
                visible.insert(parent.clone());
                cursor = parent.clone();
            }
        }
        snapshot.rows = entries
            .into_iter()
            .filter(|r| visible.contains(r["slug"].as_str().unwrap_or_default()))
            .collect();
        for row in &mut snapshot.rows {
            let slug = row["slug"].as_str().unwrap_or_default().to_owned();
            let Some(Ok((state, facts, cursor))) = index.states.get(&slug).cloned() else {
                continue;
            };
            if !index
                .pinned
                .get(&slug)
                .is_some_and(|(version, _)| *version == cursor)
            {
                let pinned = self
                    .artifact(
                        repo,
                        Scope::Build(&slug),
                        state["verify"]["configPin"]["artifact"]["kind"]
                            .as_str()
                            .unwrap_or("build-runner-effective-config"),
                        state["verify"]["configPin"]["artifact"]["rev"].as_i64(),
                    )
                    .await
                    .ok()
                    .flatten()
                    .and_then(|bytes| decode_config(&bytes).ok());
                index.pinned.insert(slug.clone(), (cursor, pinned));
            }
            let streams = match self.build_streams(repo, &slug).await {
                Ok(value) => value,
                Err(error) => {
                    *row = json!({"slug":slug,"status":"unreadable","error":error.to_string(),"steps":[]});
                    continue;
                }
            };
            let record = records
                .iter()
                .find(|r| r["slug"] == slug)
                .ok_or(DataError::Query)?;
            *row = projected(
                record,
                &state,
                &facts,
                &config,
                Some(&streams),
                index.pinned.get(&slug).and_then(|(_, v)| v.as_ref()),
            );
        }
        crate::dashboard::integration::enrich(&mut snapshot.rows, &records);
        order_rows(&mut snapshot.rows);
        Ok(snapshot)
    }
    pub async fn detail_snapshot(&self, repo: &str, slug: &str) -> Result<Value, DataError> {
        if !self
            .postgres()
            .projects()
            .await?
            .iter()
            .any(|p| p["repo"] == repo)
        {
            return Err(DataError::MissingScope { scope: "project" });
        }
        let record = self
            .postgres()
            .build_record(repo, slug)
            .await?
            .ok_or(DataError::MissingScope { scope: "build" })?;
        let (state, facts, cursor) = self.build_display(repo, slug).await?;
        let build = &state["build"];
        let streams = self.build_streams(repo, slug).await?;
        let mut sessions =
            detail::project_sessions(array(&facts["dashboard"]["sessionEvents"]), Some(&streams));
        for session in &mut sessions {
            session["text"] = json!({"text":"No transcript available."});
            let transcript = &session["transcript"];
            if let (Some(kind), Some(rev)) =
                (transcript["kind"].as_str(), transcript["rev"].as_i64())
            {
                session["text"] = self.text_artifact(repo, slug, kind, rev).await;
            } else if let Some(id) = session["stream"].as_str() {
                if let Some(record) = streams
                    .iter()
                    .find(|record| record["id"] == id && record["status"] == "closed")
                {
                    if let (Some(kind), Some(rev)) = (
                        record["artifact"]["kind"].as_str(),
                        record["artifact"]["revision"].as_i64(),
                    ) {
                        session["text"] = self.text_artifact(repo, slug, kind, rev).await;
                        continue;
                    }
                }
                let text = self.stream_text(repo, slug, id).await;
                session["text"] = match text {
                    Ok(text) if !text.is_empty() => json!({"text":text}),
                    Ok(_) => {
                        let artifact = streams
                            .iter()
                            .find(|s| s["id"] == id)
                            .map(|s| &s["artifact"]);
                        if let Some(a) = artifact {
                            if let (Some(kind), Some(rev)) =
                                (a["kind"].as_str(), a["revision"].as_i64())
                            {
                                self.text_artifact(repo, slug, kind, rev).await
                            } else {
                                json!({"text":"No transcript text yet."})
                            }
                        } else {
                            json!({"text":"No transcript text yet."})
                        }
                    }
                    Err(error) => json!({"error":error.to_string()}),
                };
            }
        }
        let mut artifacts = Vec::new();
        let mut frames = Vec::new();
        for (kind, rev) in [
            ("spec", build["specRev"].as_i64()),
            ("plan", build["plan"]["artifactRev"].as_i64()),
        ] {
            if let Some(rev) = rev {
                artifacts.push(self.text_artifact(repo, slug, kind, rev).await);
            }
        }
        for result in array(&build["verify"]["results"]) {
            let report = &result["report"];
            if let (Some(kind), Some(rev)) = (report["kind"].as_str(), report["rev"].as_i64()) {
                let artifact = self.text_artifact(repo, slug, kind, rev).await;
                if let Some(text) = artifact["raw"].as_str() {
                    if let Ok(report) = serde_json::from_str::<Value>(text) {
                        for frame in array(&report["frames"]) {
                            if valid_frame(frame) {
                                frames.push(frame.clone());
                            }
                        }
                    }
                }
                artifacts.push(artifact);
            }
        }
        Ok(
            json!({"project":repo,"record":record,"state":build,"cursor":cursor,"sessions":sessions,"artifacts":artifacts,"frames":frames}),
        )
    }
    async fn text_artifact(&self, repo: &str, slug: &str, kind: &str, rev: i64) -> Value {
        match self
            .artifact(repo, Scope::Build(slug), kind, Some(rev))
            .await
        {
            Ok(Some(bytes)) => {
                let raw = String::from_utf8_lossy(&bytes).into_owned();
                json!({"kind":kind,"rev":rev,"text":transcript_text(&raw),"raw":raw})
            }
            Ok(None) => json!({"kind":kind,"rev":rev,"error":"Artifact unavailable"}),
            Err(error) => json!({"kind":kind,"rev":rev,"error":error.to_string()}),
        }
    }
}
pub fn valid_frame(frame: &Value) -> bool {
    frame["kind"].as_str().is_some_and(|k| !k.is_empty())
        && frame["rev"].as_i64().is_some_and(|r| r >= 0)
        && matches!(
            frame["mediaType"].as_str(),
            Some("image/png" | "image/jpeg" | "image/webp")
        )
}
pub fn transcript_text(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return raw.into();
    };
    if let Some(turns) = value["turns"].as_array() {
        let mut out = Vec::new();
        for (index, turn) in turns.iter().enumerate() {
            let Some(text) = turn["text"].as_str().or(turn["result"]["text"].as_str()) else {
                return serde_json::to_string_pretty(&value).unwrap_or_else(|_| raw.into());
            };
            out.push(format!(
                "{}\n\n{text}",
                turn["prompt"]
                    .as_str()
                    .or(turn["message"].as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| if index == 0 {
                        "(initial skill invocation)".into()
                    } else {
                        format!("(turn {})", index + 1)
                    })
            ));
        }
        return out.join("\n\n");
    }
    if let Some(messages) = value
        .as_array()
        .filter(|messages| messages.iter().all(|message| message["parts"].is_array()))
    {
        return messages
            .iter()
            .map(|m| {
                array(&m["parts"])
                    .iter()
                    .map(|part| {
                        part["text"].as_str().map(str::to_owned).unwrap_or_else(|| {
                            serde_json::to_string_pretty(part).unwrap_or_default()
                        })
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    if value["note"]
        .as_str()
        .is_some_and(|n| n.contains("producer session"))
    {
        if let Some(text) = value["turn"]["text"].as_str() {
            return format!(
                "Producer boundary record: only this round's final turn was deposited.\n\n{text}"
            );
        }
    }
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| raw.into())
}
pub fn order_rows(rows: &mut Vec<Value>) {
    let source = std::mem::take(rows);
    let slugs: HashSet<_> = source.iter().filter_map(|r| r["slug"].as_str()).collect();
    let mut seen = HashSet::new();
    fn visit(
        i: usize,
        depth: usize,
        source: &[Value],
        seen: &mut HashSet<usize>,
        out: &mut Vec<Value>,
    ) {
        if !seen.insert(i) {
            return;
        }
        let mut row = source[i].clone();
        row["depth"] = json!(depth);
        out.push(row);
        for (child, row) in source.iter().enumerate() {
            if row["collectionIdentity"]["targetBuild"] == source[i]["slug"] {
                visit(child, depth + 1, source, seen, out);
            }
        }
    }
    for (i, row) in source.iter().enumerate() {
        if row["collectionIdentity"]["targetBuild"]
            .as_str()
            .is_none_or(|p| !slugs.contains(p))
        {
            visit(i, 0, &source, &mut seen, rows);
        }
    }
    for i in 0..source.len() {
        visit(i, 0, &source, &mut seen, rows);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transcript_formats_remain_readable_and_malformed_content_is_retained() {
        assert_eq!(
            transcript_text("plain <script>text</script>"),
            "plain <script>text</script>"
        );
        assert_eq!(
            transcript_text(r#"{"turns":[{"prompt":"Question","result":{"text":"Answer"}}]}"#),
            "Question\n\nAnswer"
        );
        assert_eq!(
            transcript_text(
                r#"[{"role":"assistant","parts":[{"type":"text","text":"Closed stream"}]}]"#
            ),
            "Closed stream"
        );
        assert!(transcript_text(r#"{"turns":[{"unexpected":true}]}"#).contains("unexpected"));
    }
    #[test]
    fn frames_require_a_scoped_revision_and_known_image_type() {
        assert!(valid_frame(
            &json!({"kind":"frame","rev":0,"mediaType":"image/png"})
        ));
        for frame in [
            json!({"url":"https://example.test/frame.png"}),
            json!({"kind":"frame","rev":-1,"mediaType":"image/png"}),
            json!({"kind":"frame","rev":0,"mediaType":"image/svg+xml"}),
        ] {
            assert!(!valid_frame(&frame));
        }
    }
}
