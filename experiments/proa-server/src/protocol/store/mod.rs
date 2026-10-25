pub mod leases;
pub mod postgres;
pub mod records;
use chrono::{DateTime, SecondsFormat, Utc};
use std::sync::Arc;

pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;
pub struct Store {
    pub database: Arc<postgres::Database>,
    pub clock: Clock,
}
impl Store {
    pub async fn connect(url: &str, clock: Clock) -> Result<Self, super::error::ProtocolError> {
        Ok(Self {
            database: Arc::new(postgres::Database::connect(url).await?),
            clock,
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
