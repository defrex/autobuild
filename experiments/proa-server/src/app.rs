use crate::data::{blobs::BlobReader, config::DataConfig, reader::DataReader};
use crate::protocol::{
    router::{Authority, MachineState},
    store::Store,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<crate::auth::Auth>,
    pub data: Option<Arc<DataReader>>,
    pub machine: Option<MachineState>,
}
impl AppState {
    pub async fn from_env(auth: crate::config::AuthConfig) -> anyhow::Result<Self> {
        let config = DataConfig::from_env().map_err(anyhow::Error::msg)?;
        let (data, machine) = if let Some(config) = config {
            let secret = std::env::var("AB_STORE_SECRET")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "AB_STORE_SECRET is required and must be nonblank when storage is configured"
                    )
                })?;
            // Defer backend I/O, not validation or authorization: each first
            // connection preflights before use, and production never uses Open.
            let data = Arc::new(DataReader::deferred(config.clone())?);
            let mut store = Store::deferred(&config.database_url, Arc::new(chrono::Utc::now))?;
            store.blobs = Some(Arc::new(BlobReader::new(config.blobs, config.prefix)?));
            (
                Some(data),
                Some(MachineState {
                    store: Arc::new(store),
                    authority: Authority::Project,
                    secret: Some(secret),
                }),
            )
        } else {
            (None, None)
        };
        Ok(Self {
            auth: Arc::new(crate::auth::Auth::new(auth)),
            data,
            machine,
        })
    }
}
