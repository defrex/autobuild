//! Scope-keyed, process-local accumulators. Durable logs remain authoritative.
use super::{
    blobs::BlobReader,
    config::DataConfig,
    error::DataError,
    postgres::{PostgresReader, Scope},
    reducers::{Accumulator, Scope as ReduceScope},
};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum Key {
    Build(String, String),
    Repository(String),
    Session(String, String),
}
struct Cached {
    cursor: i64,
    accumulator: Accumulator,
    display: crate::dashboard::facts::DashboardFacts,
    restack: crate::dashboard::restack::RestackFacts,
    deferral: crate::dashboard::routing::DeferralFacts,
    failure: Option<DataError>,
    api: super::api_facts::ApiFacts,
}
impl Cached {
    fn advance(&mut self, events: &[Value]) -> Result<(), DataError> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let mut cursor = self.cursor;
        for event in events {
            let next = event["seq"].as_i64().ok_or(DataError::Query)?;
            if next <= cursor {
                return Err(DataError::Query);
            }
            cursor = next;
        }
        // The reducer commits its candidate only after the complete suffix succeeds.
        if let Err(error) = self.accumulator.advance(events) {
            // Append-only history cannot repair an unreadable fact. Retain the
            // failure without publishing a partial accumulator or replaying its suffix.
            if matches!(error, DataError::Decode { .. }) {
                self.failure = Some(error.clone());
            }
            return Err(error);
        }
        if self.accumulator.scope() == ReduceScope::Build {
            self.display.advance(events);
            self.restack.advance(events);
            self.deferral.advance(events);
            self.api.advance(events);
        }
        self.cursor = cursor;
        Ok(())
    }
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct QueryRead {
    pub project: String,
    pub scope: String,
    pub after: i64,
    pub rows: usize,
}
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum BuildRead {
    Readable { slug: String, value: Value },
    Unreadable { slug: String, error: String },
}
#[derive(Default)]
struct StreamText {
    cursor: i64,
    text: String,
}
type StreamKey = (String, String, String);
type StreamEntry = Arc<Mutex<StreamText>>;
type StreamMetadataEntries = HashMap<(String, String), Arc<Mutex<Vec<Value>>>>;
pub struct DataReader {
    postgres: PostgresReader,
    blobs: BlobReader,
    cache: Mutex<HashMap<Key, Arc<Mutex<Cached>>>>,
    queries: Mutex<VecDeque<QueryRead>>,
    artifacts: super::artifact_cache::ArtifactCache,
    pub(super) dashboards: Mutex<HashMap<String, Arc<Mutex<super::dashboard::DashboardIndex>>>>,
    stream_metadata: Mutex<StreamMetadataEntries>,
    streams: Mutex<HashMap<StreamKey, StreamEntry>>,
}
impl DataReader {
    pub async fn connect(config: DataConfig) -> Result<Self, DataError> {
        let blobs = BlobReader::new(config.blobs, config.prefix)?;
        let postgres = PostgresReader::connect(&config.database_url).await?;
        Ok(Self {
            postgres,
            blobs,
            cache: Mutex::new(HashMap::new()),
            queries: Mutex::new(VecDeque::new()),
            artifacts: Default::default(),
            dashboards: Default::default(),
            stream_metadata: Default::default(),
            streams: Mutex::new(HashMap::new()),
        })
    }
    pub async fn blob_bytes(&self, hash: &str) -> Result<Vec<u8>, DataError> {
        self.blobs.get(hash).await
    }
    pub fn postgres(&self) -> &PostgresReader {
        &self.postgres
    }
    pub async fn query_counts(&self) -> Vec<QueryRead> {
        let mut reads: Vec<_> = self.queries.lock().await.iter().cloned().collect();
        reads.extend(self.postgres.metadata_counts().await);
        reads
    }
    pub async fn reset_query_counts(&self) {
        self.queries.lock().await.clear();
        self.postgres.reset_metadata_counts().await;
    }
    pub async fn clear_cache(&self) {
        self.cache.lock().await.clear();
        self.streams.lock().await.clear();
        self.dashboards.lock().await.clear();
        self.stream_metadata.lock().await.clear();
    }
    async fn read(&self, repo: &str, scope: Scope<'_>) -> Result<(Value, Value, i64), DataError> {
        let (key, reduce_scope) = match scope {
            Scope::Build(slug) => (Key::Build(repo.into(), slug.into()), ReduceScope::Build),
            Scope::Repository => (Key::Repository(repo.into()), ReduceScope::Repository),
            Scope::Session(id) => (Key::Session(repo.into(), id.into()), ReduceScope::Session),
        };
        let entry = self
            .cache
            .lock()
            .await
            .entry(key)
            .or_insert_with(|| {
                Arc::new(Mutex::new(Cached {
                    cursor: 0,
                    accumulator: Accumulator::new(reduce_scope),
                    display: Default::default(),
                    restack: Default::default(),
                    deferral: Default::default(),
                    failure: None,
                    api: Default::default(),
                }))
            })
            .clone();
        // This lock covers fetching and folding: concurrent polls cannot fold the same suffix.
        let mut cached = entry.lock().await;
        if let Some(error) = &cached.failure {
            return Err(error.clone());
        }
        let events = self.postgres.events(repo, scope, cached.cursor).await?;
        let mut queries = self.queries.lock().await;
        // Test/diagnostic evidence is bounded independently of long-lived accumulators.
        if queries.len() == 1024 {
            queries.pop_front();
        }
        queries.push_back(QueryRead {
            project: repo.into(),
            scope: match scope {
                Scope::Build(id) => format!("build:{id}"),
                Scope::Repository => "repository".into(),
                Scope::Session(id) => format!("session:{id}"),
            },
            after: cached.cursor,
            rows: events.len(),
        });
        if let Some(query) = queries.back() {
            tracing::debug!(
                "suffix-read {}",
                serde_json::to_string(query).unwrap_or_default()
            );
        }
        drop(queries);
        if !events.is_empty() {
            cached.advance(&events)?;
        }
        Ok((
            cached.accumulator.finish(),
            serde_json::json!({"dashboard":cached.display.finish(),"restack":cached.restack.finish(),"deferral":cached.deferral.finish(),"api":cached.api.finish()}),
            cached.cursor,
        ))
    }
    pub async fn build(&self, repo: &str, slug: &str) -> Result<Value, DataError> {
        self.read(repo, Scope::Build(slug)).await.map(|read| read.0)
    }
    /// Lifecycle, display facts and suffix cursor from the same locked fold.
    pub async fn build_display(
        &self,
        repo: &str,
        slug: &str,
    ) -> Result<(Value, Value, i64), DataError> {
        self.read(repo, Scope::Build(slug)).await
    }
    pub async fn repository(&self, repo: &str) -> Result<Value, DataError> {
        self.read(repo, Scope::Repository).await.map(|read| read.0)
    }
    pub async fn session(&self, repo: &str, id: &str) -> Result<Value, DataError> {
        self.read(repo, Scope::Session(id)).await.map(|read| read.0)
    }
    pub async fn project_builds(&self, repo: &str) -> Result<Vec<BuildRead>, DataError> {
        let mut result = Vec::new();
        for metadata in self.postgres.builds(repo).await? {
            let slug = metadata["slug"]
                .as_str()
                .ok_or(DataError::Query)?
                .to_owned();
            match self.build(repo, &slug).await {
                Ok(value) => result.push(BuildRead::Readable { slug, value }),
                Err(error) => result.push(BuildRead::Unreadable {
                    slug,
                    error: error.to_string(),
                }),
            }
        }
        Ok(result)
    }
    pub async fn build_streams(&self, repo: &str, slug: &str) -> Result<Vec<Value>, DataError> {
        let entry = self
            .stream_metadata
            .lock()
            .await
            .entry((repo.into(), slug.into()))
            .or_insert_with(|| Arc::new(Mutex::new(Vec::new())))
            .clone();
        let mut records = entry.lock().await;
        let closed: Vec<String> = records
            .iter()
            .filter(|v| v["status"] == "closed")
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect();
        let changed = self.postgres.build_streams(repo, slug, &closed).await?;
        for value in changed {
            if let Some(old) = records.iter_mut().find(|v| v["id"] == value["id"]) {
                *old = value;
            } else {
                records.push(value);
            }
        }
        records.sort_by(|a, b| {
            a["createdAt"]
                .as_str()
                .cmp(&b["createdAt"].as_str())
                .then(a["id"].as_str().cmp(&b["id"].as_str()))
        });
        Ok(records.clone())
    }
    pub async fn stream_text(&self, repo: &str, slug: &str, id: &str) -> Result<String, DataError> {
        let key = (repo.to_owned(), slug.to_owned(), id.to_owned());
        let entry = self
            .streams
            .lock()
            .await
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(StreamText::default())))
            .clone();
        let mut cached = entry.lock().await;
        let chunks = self
            .postgres
            .stream_chunks(repo, slug, id, cached.cursor)
            .await?;
        let mut evidence = self.queries.lock().await;
        if evidence.len() == 1024 {
            evidence.pop_front();
        }
        evidence.push_back(QueryRead {
            project: repo.into(),
            scope: format!("stream:{id}"),
            after: cached.cursor,
            rows: chunks.len(),
        });
        if let Some(query) = evidence.back() {
            tracing::debug!(
                "suffix-read {}",
                serde_json::to_string(query).unwrap_or_default()
            );
        }
        drop(evidence);
        for chunk in chunks {
            let seq = chunk["seq"].as_i64().ok_or(DataError::Query)?;
            if seq <= cached.cursor {
                return Err(DataError::Query);
            }
            for part in crate::dashboard::model::array(&chunk["parts"]) {
                match part["type"].as_str().unwrap_or_default() {
                    "text-delta" | "reasoning-delta" => cached
                        .text
                        .push_str(part["delta"].as_str().unwrap_or_default()),
                    "text-end" | "reasoning-end" => cached.text.push('\n'),
                    "tool-output-available" => {
                        cached.text.push_str(&part["output"].to_string());
                        cached.text.push('\n');
                    }
                    _ => {}
                }
            }
            cached.cursor = seq;
        }
        Ok(cached.text.clone())
    }
    /// None means missing metadata; MissingBlob means metadata pointed at a missing object.
    pub async fn artifact(
        &self,
        repo: &str,
        scope: Scope<'_>,
        kind: &str,
        revision: Option<i64>,
    ) -> Result<Option<Vec<u8>>, DataError> {
        let Some(metadata) = self.postgres.artifact(repo, scope, kind, revision).await? else {
            return Ok(None);
        };
        let reference = metadata["blobRef"].as_str().ok_or(DataError::Blob)?;
        let key = format!(
            "{repo}:{}:{}:{reference}",
            scope.name(),
            match scope {
                Scope::Build(id) | Scope::Session(id) => id,
                Scope::Repository => repo,
            }
        );
        let bytes = self
            .artifacts
            .load(key, || async {
                let bytes = self.blobs.get(reference).await?;

                let mut queries = self.queries.lock().await;
                if queries.len() == 1024 {
                    queries.pop_front();
                }
                queries.push_back(QueryRead {
                    project: repo.into(),
                    scope: format!(
                        "artifact:{kind}@{}:{}",
                        metadata["revision"],
                        match scope {
                            Scope::Build(id) | Scope::Session(id) => id,
                            Scope::Repository => repo,
                        }
                    ),
                    after: metadata["revision"].as_i64().unwrap_or(0),
                    rows: bytes.len(),
                });
                if let Some(query) = queries.back() {
                    tracing::debug!(
                        "suffix-read {}",
                        serde_json::to_string(query).unwrap_or_default()
                    );
                }
                drop(queries);

                Ok(bytes)
            })
            .await?;
        Ok(Some(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn a_failed_suffix_cannot_advance_the_cursor_or_accumulator() {
        let mut cached = Cached {
            cursor: 0,
            accumulator: Accumulator::new(ReduceScope::Session),
            display: Default::default(),
            restack: Default::default(),
            deferral: Default::default(),
            failure: None,
            api: Default::default(),
        };
        let before = cached.accumulator.finish();
        let unknown = json!({"seq":1,"type":"unknown.future-event","payload":{},"ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"system"},"session":"test"});
        assert!(cached.advance(&[unknown]).is_err());
        assert_eq!(cached.cursor, 0);
        assert!(matches!(
            cached.failure,
            Some(DataError::Decode {
                scope: "session",
                seq: 1,
                ..
            })
        ));
        assert_eq!(cached.accumulator.finish(), before);
        assert!(cached.advance(&[]).is_err());
        assert_eq!(cached.accumulator.finish(), before);
    }
    #[test]
    fn invalid_or_repeated_sequences_never_mutate_state() {
        let mut cached = Cached {
            cursor: 7,
            accumulator: Accumulator::new(ReduceScope::Build),
            display: Default::default(),
            restack: Default::default(),
            deferral: Default::default(),
            failure: None,
            api: Default::default(),
        };
        let before = cached.accumulator.finish();
        let display_before = cached.display.finish();
        let restack_before = cached.restack.finish();
        for seq in [json!(null), json!(7), json!(6)] {
            assert!(matches!(
                cached.advance(&[json!({"seq":seq})]),
                Err(DataError::Query)
            ));
            assert_eq!(cached.cursor, 7);
            assert_eq!(cached.accumulator.finish(), before);
            assert_eq!(cached.display.finish(), display_before);
            assert_eq!(cached.restack.finish(), restack_before);
        }
    }
}
