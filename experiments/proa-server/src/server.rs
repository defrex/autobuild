use std::{future::IntoFuture, net::SocketAddr, time::Duration};

/// Proa's helper does not insert peer metadata. Only explicit dev auth uses this adapter.
pub async fn serve(listener: tokio::net::TcpListener, app: axum::Router) -> anyhow::Result<()> {
    let (shutdown, receiver) = tokio::sync::oneshot::channel();
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = receiver.await;
    })
    .into_future();
    let signal = async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = shutdown.send(());
    };
    tokio::pin!(server, signal);
    tokio::select! {
        result = &mut server => { result?; },
        _ = &mut signal => { if let Ok(result) = tokio::time::timeout(Duration::from_secs(30), server).await { result?; } },
    }
    Ok(())
}
