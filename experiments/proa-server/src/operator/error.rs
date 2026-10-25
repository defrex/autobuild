use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::Value;

/// The shared operator wire failure. Storage errors must be translated before
/// reaching this boundary so connection strings and provider bodies stay private.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OperatorError {
    #[serde(skip)]
    pub status: u16,
    pub kind: &'static str,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Box<Value>>,
}
impl OperatorError {
    pub fn new(status: u16, kind: &'static str, error: impl Into<String>) -> Self {
        Self {
            status,
            kind,
            error: error.into(),
            code: None,
            progress: None,
        }
    }
    pub fn validation(error: impl Into<String>) -> Self {
        Self::new(400, "validation", error)
    }
    pub fn auth(status: u16, error: impl Into<String>) -> Self {
        Self::new(status, "auth", error)
    }
    pub fn refusal(error: impl Into<String>) -> Self {
        Self::new(409, "refusal", error)
    }
    pub fn not_found(error: impl Into<String>) -> Self {
        Self::new(404, "not-found", error)
    }
    pub fn internal() -> Self {
        Self::new(500, "internal", "operator API is unavailable")
    }
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}
impl std::fmt::Display for OperatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.error)
    }
}
impl std::error::Error for OperatorError {}
impl IntoResponse for OperatorError {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            [(
                axum::http::header::CONTENT_TYPE,
                "application/json;charset=utf-8",
            )],
            Json(self),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wire_error_matches_typescript_content_type_and_omits_status_field() {
        let response = OperatorError::refusal("already answered")
            .with_code("stale")
            .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "application/json;charset=utf-8"
        );
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            serde_json::json!({"kind":"refusal","error":"already answered","code":"stale"})
        );
    }
}
