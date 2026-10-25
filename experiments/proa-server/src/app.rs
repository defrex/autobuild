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
fn signing_secret(raw: String) -> Option<String> {
    let secret = crate::protocol::js_value::JsString::from(raw)
        .trim_js()
        .to_scalar()
        .expect("trimming scalar input preserves Unicode scalars");
    (!secret.is_empty()).then_some(secret)
}
impl AppState {
    pub async fn from_env(auth: crate::config::AuthConfig) -> anyhow::Result<Self> {
        let config = DataConfig::from_env().map_err(anyhow::Error::msg)?;
        let (data, machine) = if let Some(config) = config {
            let secret = std::env::var("AB_STORE_SECRET")
                .ok()
                .and_then(signing_secret)
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

#[cfg(test)]
mod tests {
    use super::signing_secret;
    #[test]
    fn store_secret_uses_js_whitespace_without_changing_key_bytes() {
        assert_eq!(
            signing_secret("\u{feff} secret \u{2029}".into()),
            Some("secret".into())
        );
        assert_eq!(
            signing_secret("\u{85}secret\u{85}".into()),
            Some("\u{85}secret\u{85}".into())
        );
        assert_eq!(signing_secret("\u{feff} \u{2029}".into()), None);
    }
}
