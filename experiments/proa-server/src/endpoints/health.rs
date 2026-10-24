use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct StatusBody {
    status: &'static str,
    version: &'static str,
}

pub async fn live() -> Json<StatusBody> {
    Json(StatusBody {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

pub async fn ready() -> Json<StatusBody> {
    Json(StatusBody {
        status: "ready",
        version: env!("CARGO_PKG_VERSION"),
    })
}
