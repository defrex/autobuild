use crate::app::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;

#[derive(Serialize)]
pub struct StatusBody {
    status: &'static str,
    version: &'static str,
}

pub async fn live() -> Json<proa_server::protocol::identity::ProtocolHealth<'static>> {
    Json(proa_server::protocol::identity::health_body())
}

pub async fn ready(State(state): State<AppState>) -> (StatusCode, Json<StatusBody>) {
    let ready = match &state.data {
        None => true,
        Some(reader) => matches!(
            tokio::time::timeout(
                std::time::Duration::from_secs(3),
                reader.postgres().preflight()
            )
            .await,
            Ok(Ok(()))
        ),
    };
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(StatusBody {
            status: if ready { "ready" } else { "not ready" },
            version: env!("CARGO_PKG_VERSION"),
        }),
    )
}
