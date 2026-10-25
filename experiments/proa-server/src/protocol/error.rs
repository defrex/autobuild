use super::js_value::{JsJson, JsString};
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
    // Wire text retains UTF-16. `error` remains a scalar diagnostic only; when
    // unpaired units occur it contains their quoted spelling, never replacement.
    lossless_error: Option<JsString>,
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
            lossless_error: None,
        }
    }
    pub fn validation(error: impl Into<String>) -> Self {
        Self::new(400, "validation", error)
    }
    pub fn new_js(status: u16, kind: &'static str, error: JsString) -> Self {
        let diagnostic = error.to_scalar().unwrap_or_else(|_| error.quote());
        let mut result = Self::new(status, kind, diagnostic);
        result.lossless_error = Some(error);
        result
    }
    pub fn message_js(&self) -> JsString {
        self.lossless_error
            .clone()
            .unwrap_or_else(|| JsString::from(self.error.clone()))
    }
    pub fn validation_js(error: JsString) -> Self {
        Self::new_js(400, "validation", error)
    }
    pub fn missing(scope: &str, key: &str) -> Self {
        Self::new(404, "not-found", format!("unknown {scope} \"{key}\""))
    }
    /// Query refusals preserve only the PostgreSQL server message, as the TS
    /// endpoint does. Never expose connection URLs, query text or error details.
    pub fn query(error: tokio_postgres::Error) -> Self {
        error
            .as_db_error()
            .map(|db| Self::new(500, "internal", db.message()))
            .unwrap_or_else(Self::internal)
    }
    pub fn internal() -> Self {
        Self::new(500, "internal", "internal server error")
    }
}
impl From<tokio_postgres::Error> for ProtocolError {
    fn from(error: tokio_postgres::Error) -> Self {
        Self::query(error)
    }
}
impl From<crate::data::error::DataError> for ProtocolError {
    fn from(_: crate::data::error::DataError) -> Self {
        Self::internal()
    }
}
impl IntoResponse for ProtocolError {
    fn into_response(self) -> Response {
        if let Some(error) = self.lossless_error {
            let body = JsJson::Object(vec![
                (
                    JsString::from("kind"),
                    JsJson::String(JsString::from(self.kind)),
                ),
                (JsString::from("error"), JsJson::String(error)),
            ])
            .stringify();
            return (
                self.status,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                body,
            )
                .into_response();
        }
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
