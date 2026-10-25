//! Isolated protocol harness executable. Clock control and open auth are private
//! to this test entry, never environment switches in the production binary.
use chrono::{DateTime, Utc};
use proa_server::protocol::{
    router::{router, Authority, MachineState},
    store::Store,
};
use serde_json::{json, Value};
use std::{
    io::Write,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncBufReadExt, BufReader};

fn output(value: Value) -> anyhow::Result<()> {
    println!("{value}");
    std::io::stdout().flush()?;
    Ok(())
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("AB_POSTGRES_URL")?;
    let parsed = url::Url::parse(&url)?;
    anyhow::ensure!(
        matches!(parsed.scheme(), "postgres" | "postgresql")
            && !parsed
                .query_pairs()
                .any(|(key, _)| matches!(key.as_ref(), "host" | "hostaddr" | "service"))
            && ["127.0.0.1", "localhost", "[::1]"].contains(&parsed.host_str().unwrap_or(""))
            && parsed.path().starts_with("/proa_protocol_"),
        "protocol test database must be an isolated loopback database"
    );
    let now = Arc::new(Mutex::new(Utc::now()));
    let clock = now.clone();
    let mut store =
        Store::connect(&url, Arc::new(move || *clock.lock().expect("test clock"))).await?;
    let config = proa_server::data::config::DataConfig::from_env()
        .map_err(anyhow::Error::msg)?
        .ok_or_else(|| anyhow::anyhow!("missing test storage configuration"))?;
    store.max_revisions = config.artifact_retention_max_revisions.unwrap_or(200);
    store.blobs = Some(Arc::new(proa_server::data::blobs::BlobReader::new(
        config.blobs,
        config.prefix,
    )?));
    if let Ok(retention) = std::env::var("PROA_TEST_RETENTION") {
        let retention: Value = serde_json::from_str(&retention)?;
        store.max_revisions = retention["maxRevisions"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| anyhow::anyhow!("invalid test retention"))?
            .try_into()?;
    }
    store.asset_max_request_bytes = std::env::var("PROA_TEST_ASSET_MAX_BYTES")
        .ok()
        .map(|v| v.parse())
        .transpose()?;
    let store = Arc::new(store);
    let authority = if std::env::var("PROA_TEST_AUTH").as_deref() == Ok("project") {
        Authority::Project
    } else {
        Authority::Open
    };
    let app = router(MachineState {
        store,
        authority,
        secret: std::env::var("PROA_TEST_SECRET").ok(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    output(json!({"ready":true,"port":port}))?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            ended = &mut server => { ended??; anyhow::bail!("test server exited before control EOF"); }
            line = lines.next_line() => {
                let Some(line) = line? else { break; };
                let command: Value = serde_json::from_str(&line)?;
                let timestamp = DateTime::parse_from_rfc3339(command["now"].as_str().ok_or_else(|| anyhow::anyhow!("missing test time"))?)?.with_timezone(&Utc);
                *now.lock().expect("test clock") = timestamp;
                output(json!({"ok":true}))?;
            }
        }
    }
    let _ = stop.send(());
    server.await??;
    Ok(())
}
