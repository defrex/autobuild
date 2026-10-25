use std::sync::Arc;

use crate::data::{config::DataConfig, reader::DataReader};

/// Shared storage boundary; pages currently render the offline shell only.
#[derive(Clone, Default)]
pub struct AppState {
    pub data: Option<Arc<DataReader>>,
}

impl AppState {
    pub async fn from_env() -> anyhow::Result<Self> {
        let data = match DataConfig::from_env().map_err(anyhow::Error::msg)? {
            Some(config) => Some(Arc::new(DataReader::connect(config).await?)),
            None => None,
        };
        Ok(Self { data })
    }
}
