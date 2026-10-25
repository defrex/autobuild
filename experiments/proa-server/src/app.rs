use crate::data::{config::DataConfig, reader::DataReader};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<crate::auth::Auth>,
    pub data: Option<Arc<DataReader>>,
}
impl AppState {
    pub async fn from_env(auth: crate::config::AuthConfig) -> anyhow::Result<Self> {
        let data = match DataConfig::from_env().map_err(anyhow::Error::msg)? {
            Some(config) => Some(Arc::new(DataReader::connect(config).await?)),
            None => None,
        };
        Ok(Self {
            auth: Arc::new(crate::auth::Auth::new(auth)),
            data,
        })
    }
}
