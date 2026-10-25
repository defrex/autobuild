use crate::data::{config::DataConfig, reader::DataReader};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<crate::auth::Auth>,
    pub data: Option<Arc<DataReader>>,
    pub writer: Option<Arc<crate::data::writer::PostgresWriter>>,
    pub blobs: Option<Arc<crate::data::blobs::BlobWriter>>,
    pub operator_secret: Option<Arc<str>>,
}
impl AppState {
    pub async fn from_env(auth: crate::config::AuthConfig) -> anyhow::Result<Self> {
        let operator_secret = std::env::var("AB_STORE_SECRET")
            .ok()
            .filter(|s| !s.is_empty())
            .map(Arc::from);
        let config = DataConfig::from_env().map_err(anyhow::Error::msg)?;
        let blobs = config
            .as_ref()
            .map(|c| {
                crate::data::blobs::BlobWriter::new(c.blobs.clone(), c.prefix.clone()).map(Arc::new)
            })
            .transpose()?;
        let writer = match config.as_ref() {
            Some(config) => Some(Arc::new(
                crate::data::writer::PostgresWriter::connect(
                    &std::env::var("PROA_POSTGRES_WRITE_URL")
                        .unwrap_or_else(|_| config.database_url.clone()),
                )
                .await?,
            )),
            None => None,
        };
        let data = match config {
            Some(config) => Some(Arc::new(DataReader::connect(config).await?)),
            None => None,
        };
        Ok(Self {
            auth: Arc::new(crate::auth::Auth::new(auth)),
            data,
            writer,
            blobs,
            operator_secret,
        })
    }
}
