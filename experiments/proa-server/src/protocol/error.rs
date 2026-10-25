use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
#[error("{error}")]
pub struct ProtocolError {
    pub status: StatusCode,
    pub kind: &'static str,
    pub error: String,
}
#[derive(Serialize)]
struct ErrorBody {
    kind: &'static str,
    error: String,
}
impl ProtocolError {
    pub fn new(status: u16, kind: &'static str, error: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).expect("static HTTP status"),
            kind,
            error: error.into(),
        }
    }
    pub fn validation(error: impl Into<String>) -> Self {
        Self::new(400, "validation", error)
    }
    pub fn missing(scope: &str, key: &str) -> Self {
        Self::new(404, "not-found", format!("unknown {scope} \"{key}\""))
    }
    pub fn internal() -> Self {
        Self::new(500, "internal", "internal server error")
    }
}
impl From<tokio_postgres::Error> for ProtocolError {
    fn from(_: tokio_postgres::Error) -> Self {
        Self::internal()
    }
}
impl From<crate::data::error::DataError> for ProtocolError {
    fn from(_: crate::data::error::DataError) -> Self {
        Self::internal()
    }
}
impl IntoResponse for ProtocolError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                kind: self.kind,
                error: self.error,
            }),
        )
            .into_response()
    }
}
