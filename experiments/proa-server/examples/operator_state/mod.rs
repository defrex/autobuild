//! Private operator-only fixture state. These executables do not mount machine routes.
//! In particular they exercise an absent operator signing key independently of
//! the production machine server's mandatory key configuration.
use proa_server::{
    app::AppState,
    data::{blobs::BlobWriter, config::DataConfig, reader::DataReader, writer::PostgresWriter},
};
use std::sync::Arc;

pub async fn from_env(auth: proa_server::config::AuthConfig) -> anyhow::Result<AppState> {
    let config = DataConfig::from_env().map_err(anyhow::Error::msg)?.unwrap();
    Ok(AppState {
        auth: Arc::new(proa_server::auth::Auth::new(auth)),
        data: Some(Arc::new(DataReader::connect(config.clone()).await?)),
        writer: Some(Arc::new(
            PostgresWriter::connect(&config.database_url).await?,
        )),
        blobs: Some(Arc::new(BlobWriter::new(config.blobs, config.prefix)?)),
        operator_secret: std::env::var("AB_STORE_SECRET")
            .ok()
            .filter(|s| !s.is_empty())
            .map(Arc::from),
        machine: None,
    })
}
