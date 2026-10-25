use std::time::Duration;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

mod app;
mod auth;
mod components;
mod config;
mod endpoints;
mod error;
mod layouts;
mod pages;
mod routes;
mod server;
mod static_assets;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let config = config::Config::from_env()?;
    let dev = config.auth.dev.is_some();
    let state = app::AppState {
        auth: std::sync::Arc::new(auth::Auth::new(config.auth)),
    };
    let app = routes::router(state);
    let listener = TcpListener::bind(config.address).await?;
    tracing::info!(address = %listener.local_addr()?, "Proa site listening");
    if dev {
        server::serve(listener, app).await?;
    } else {
        let _ = proa_framework_axum::serve(listener, app, Duration::from_secs(30)).await?;
    }
    Ok(())
}
