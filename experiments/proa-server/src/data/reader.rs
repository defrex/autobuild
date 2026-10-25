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
    failure: Option<DataError>,
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
pub struct DataReader {
    postgres: PostgresReader,
    blobs: BlobReader,
    cache: Mutex<HashMap<Key, Arc<Mutex<Cached>>>>,
    queries: Mutex<VecDeque<QueryRead>>,
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
        })
    }
    pub fn postgres(&self) -> &PostgresReader {
        &self.postgres
    }
    pub async fn query_counts(&self) -> Vec<QueryRead> {
        self.queries.lock().await.iter().cloned().collect()
    }
    pub async fn clear_cache(&self) {
        self.cache.lock().await.clear();
    }
    async fn read(&self, repo: &str, scope: Scope<'_>) -> Result<Value, DataError> {
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
                    failure: None,
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
        drop(queries);
        if !events.is_empty() {
            cached.advance(&events)?;
        }
        Ok(cached.accumulator.finish())
    }
    pub async fn build(&self, repo: &str, slug: &str) -> Result<Value, DataError> {
        self.read(repo, Scope::Build(slug)).await
    }
    pub async fn repository(&self, repo: &str) -> Result<Value, DataError> {
        self.read(repo, Scope::Repository).await
    }
    pub async fn session(&self, repo: &str, id: &str) -> Result<Value, DataError> {
        self.read(repo, Scope::Session(id)).await
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
                Err(error @ DataError::Decode { .. }) => result.push(BuildRead::Unreadable {
                    slug,
                    error: error.to_string(),
                }),
                Err(error) => return Err(error),
            }
        }
        Ok(result)
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
        self.blobs.get(reference).await.map(Some)
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
            failure: None,
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
            failure: None,
        };
        let before = cached.accumulator.finish();
        for seq in [json!(null), json!(7), json!(6)] {
            assert!(matches!(
                cached.advance(&[json!({"seq":seq})]),
                Err(DataError::Query)
            ));
            assert_eq!(cached.cursor, 7);
            assert_eq!(cached.accumulator.finish(), before);
        }
    }
}
