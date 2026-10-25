//! Private JSON-lines whole-object interoperability bridge; never an HTTP/admin route.
use base64::{engine::general_purpose::STANDARD, Engine};
use proa_server::data::{
    blobs::BlobReader,
    config::{BlobConfig, DataConfig},
};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = DataConfig::from_env()
        .map_err(anyhow::Error::msg)?
        .ok_or_else(|| anyhow::anyhow!("missing test blob configuration"))?;
    let BlobConfig::S3 {
        endpoint: Some(endpoint),
        bucket,
        ..
    } = &config.blobs
    else {
        anyhow::bail!("blob proof requires isolated S3 emulator");
    };
    let url = reqwest::Url::parse(endpoint)?;
    anyhow::ensure!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && bucket == "proa-data-proof",
        "blob proof requires isolated loopback S3 emulator"
    );
    let blobs = BlobReader::new(config.blobs, config.prefix)?;
    println!("{}", json!({"ready":true}));
    std::io::stdout().flush()?;
    for line in std::io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let hash = command["hash"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing test hash"))?;
        anyhow::ensure!(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "invalid test hash"
        );
        let result = match command["op"].as_str() {
            Some("put") => {
                let bytes = STANDARD.decode(
                    command["base64"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("missing test bytes"))?,
                )?;
                blobs.put(hash, &bytes).await.map(|_| Value::Null)
            }
            Some("get") => blobs
                .get(hash)
                .await
                .map(|bytes| json!(STANDARD.encode(bytes))),
            _ => anyhow::bail!("unknown test operation"),
        };
        let reply = match result {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"error":error.to_string()}),
        };
        println!("{reply}");
        std::io::stdout().flush()?;
    }
    Ok(())
}
