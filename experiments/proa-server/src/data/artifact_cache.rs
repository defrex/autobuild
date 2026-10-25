//! Bounded immutable bytes with per-object single flight; no global lock spans I/O.
use super::error::DataError;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::{Arc, Weak},
};
use tokio::sync::Mutex;
#[derive(Default)]
pub(super) struct ArtifactCache {
    entries: Mutex<VecDeque<(String, Vec<u8>)>>,
    flights: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}
impl ArtifactCache {
    async fn cached(&self, key: &str) -> Option<Vec<u8>> {
        self.entries
            .lock()
            .await
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }
    pub async fn load<F: Future<Output = Result<Vec<u8>, DataError>>>(
        &self,
        key: String,
        fetch: impl FnOnce() -> F,
    ) -> Result<Vec<u8>, DataError> {
        if let Some(bytes) = self.cached(&key).await {
            return Ok(bytes);
        }
        let flight = {
            let mut flights = self.flights.lock().await;
            flights.retain(|_, v| v.strong_count() > 0);
            let flight = flights
                .get(&key)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(Mutex::new(())));
            flights.insert(key.clone(), Arc::downgrade(&flight));
            flight
        };
        let _guard = flight.lock().await;
        if let Some(bytes) = self.cached(&key).await {
            return Ok(bytes);
        }
        let bytes = fetch().await?;
        if bytes.len() <= 8 * 1024 * 1024 {
            let mut entries = self.entries.lock().await;
            while entries.len() >= 128
                || entries.iter().map(|(_, b)| b.len()).sum::<usize>() + bytes.len()
                    > 64 * 1024 * 1024
            {
                entries.pop_front();
            }
            entries.push_back((key, bytes.clone()));
        }
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        sync::Notify,
        time::{timeout, Duration},
    };
    #[tokio::test]
    async fn slow_object_does_not_block_hits_or_other_objects_and_same_object_coalesces() {
        let cache = Arc::new(ArtifactCache::default());
        cache
            .load("warm".into(), || async { Ok(vec![1]) })
            .await
            .unwrap();
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (c, s, r) = (cache.clone(), started.clone(), release.clone());
        let slow = tokio::spawn(async move {
            c.load("slow".into(), || async {
                s.notify_one();
                r.notified().await;
                Ok(vec![2])
            })
            .await
        });
        started.notified().await;
        let same_cache = cache.clone();
        let same = tokio::spawn(async move {
            same_cache
                .load("slow".into(), || async { panic!("duplicate fetch") })
                .await
        });
        timeout(Duration::from_secs(1), async {
            assert_eq!(
                cache
                    .load("warm".into(), || async { panic!("cache miss") })
                    .await
                    .unwrap(),
                vec![1]
            );
            assert_eq!(
                cache
                    .load("other".into(), || async { Ok(vec![3]) })
                    .await
                    .unwrap(),
                vec![3]
            );
        })
        .await
        .expect("unrelated artifact blocked behind slow fetch");
        release.notify_one();
        assert_eq!(slow.await.unwrap().unwrap(), vec![2]);
        assert_eq!(same.await.unwrap().unwrap(), vec![2]);
    }
}
