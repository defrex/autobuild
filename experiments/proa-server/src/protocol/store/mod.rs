pub mod leases;
pub mod postgres;
pub mod records;
mod records_lossless;
use chrono::{DateTime, SecondsFormat, Utc};
use std::sync::Arc;

pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;
pub struct Store {
    pub database: Arc<postgres::Database>,
    pub clock: Clock,
    pub blobs: Option<Arc<crate::data::blobs::BlobReader>>,
    pub max_revisions: usize,
    pub asset_max_request_bytes: Option<usize>,
}
impl Store {
    pub async fn connect(url: &str, clock: Clock) -> Result<Self, super::error::ProtocolError> {
        Ok(Self {
            database: Arc::new(postgres::Database::connect(url).await?),
            clock,
            blobs: None,
            max_revisions: 200,
            asset_max_request_bytes: None,
        })
    }
    pub fn deferred(url: &str, clock: Clock) -> Result<Self, super::error::ProtocolError> {
        Ok(Self {
            database: Arc::new(postgres::Database::deferred(url)?),
            clock,
            blobs: None,
            max_revisions: 200,
            asset_max_request_bytes: None,
        })
    }
    pub fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis((self.clock)().timestamp_millis())
            .expect("valid clock timestamp")
    }
}
pub fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub mod sessions;

pub mod presence;
pub mod snapshots;

pub mod events;

pub mod artifacts;
pub mod ticks;

pub mod assets;
pub mod streams;
