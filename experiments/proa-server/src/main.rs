use std::time::Duration;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

mod app;
mod components;
mod config;
mod endpoints;
mod error;
mod layouts;
mod pages;
mod routes;
mod static_assets;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let config = config::Config::from_env()?;
    let state = app::AppState;
    let app = routes::router(state);
    let listener = TcpListener::bind(config.address).await?;
    tracing::info!(address = %listener.local_addr()?, "Proa site listening");
    let _ = proa_framework_axum::serve(listener, app, Duration::from_secs(30)).await?;
    Ok(())
}
