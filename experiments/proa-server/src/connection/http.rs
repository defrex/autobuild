//! Public capability endpoints. Browser admission is intentionally a separate surface.
use super::{ConnectionError, ConnectionService};
use crate::protocol::{js_value::JsJson, router::MachineState};
use axum::{
    body::to_bytes,
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

pub fn is_public_path(path: &str) -> bool {
    matches!(
        path,
        "/connect/v1/requests" | "/connect/v1/poll" | "/connect/v1/cancel"
    )
}

pub fn is_machine_path(path: &str) -> bool {
    matches!(path, "/connect/v1/status" | "/connect/v1/revoke")
}

/// Fresh credential admission without release negotiation or browser cookies.
pub async fn credential(state: &MachineState, req: Request) -> Response {
    let path = req.uri().path();
    let revoke = path == "/connect/v1/revoke";
    let expected = if revoke {
        axum::http::Method::POST
    } else {
        axum::http::Method::GET
    };
    if req.method() != expected {
        return respond(json!({"error":"method not allowed"}), 405);
    }
    let authorization = crate::protocol::wire::header_text(req.headers(), "authorization");
    let principal =
        match crate::protocol::router::authenticate(state, authorization.as_deref()).await {
            Ok(Some(crate::protocol::delegation::Principal::Project(principal))) => principal,
            Ok(_) => return respond(json!({"error":"project credential required"}), 403),
            Err(error) if error.kind == "auth" => {
                return respond(json!({"error":error.error}), error.status.as_u16())
            }
            Err(_) => {
                return failure(ConnectionError::backend(
                    "authentication backend unavailable",
                ))
            }
        };
    if revoke {
        // Authentication just read registration and revocation from authoritative storage.
        // Preserve idempotent COALESCE semantics of the shared credential adapter.
        let result = async {
            let writer = state.store.database.ticket_writer().map_err(ConnectionError::backend)?;
            let connection = writer.client().await.map_err(ConnectionError::backend)?;
            connection.client.execute("UPDATE project_credentials SET revoked_at=COALESCE(revoked_at,$1) WHERE repo=$2 AND id=$3", &[&state.store.now(),&principal.repo,&principal.credential.id]).await.map_err(ConnectionError::backend)?;
            Ok::<(),ConnectionError>(())
        }.await;
        if let Err(error) = result {
            return failure(error);
        }
    }
    respond(
        json!({"repo":principal.repo,"credentialId":principal.credential.id,"accepted":true}),
        200,
    )
}

/// Browser admission (fresh session, allowlist and canonical Origin) is owned by
/// the caller. This handler receives only the admitted normalized email.
pub async fn browser(state: &MachineState, req: Request, actor: &str) -> Response {
    match browser_dispatch(state, req, actor).await {
        Ok(value) => respond(value, 200),
        Err(error) => failure(error),
    }
}
async fn browser_dispatch(
    state: &MachineState,
    req: Request,
    actor: &str,
) -> Result<Value, ConnectionError> {
    if req.method() != axum::http::Method::POST {
        return Err(ConnectionError::new(405, "method not allowed"));
    }
    let content_type = req
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if content_type != "application/json" {
        return Err(ConnectionError::new(400, "application/json required"));
    }
    let path = req.uri().path().to_owned();
    let bytes = to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(ConnectionError::backend)?;
    let raw = crate::protocol::js_value::decode_http_utf8(&bytes);
    if raw.encode_utf16().count() > 8192 {
        return Err(ConnectionError::new(413, "request too large"));
    }
    let body = crate::protocol::js_value::parse(raw.as_bytes())
        .map_err(|_| ConnectionError::new(400, "invalid JSON"))?;
    if body.as_object().is_none() {
        return Err(ConnectionError::new(400, "invalid request"));
    }
    let writer = state
        .store
        .database
        .ticket_writer()
        .map_err(ConnectionError::backend)?;
    let service = ConnectionService { writer: &writer };
    if let Some(code) = text(&body, "code") {
        let code = code
            .trim_matches(crate::operator::auth::js_space)
            .to_uppercase();
        if path == "/connect/v1/browser/lookup" {
            return Ok(json!({"connection":service.lookup(&code,actor,state.store.now()).await?}));
        }
        if path == "/connect/v1/browser/decide" {
            if let Some(approve) = body["approve"].as_bool() {
                return Ok(
                    json!({"connection":service.decide(&code,actor,approve,state.store.now()).await?}),
                );
            }
        }
    }
    Err(ConnectionError::new(404, "unknown connection route"))
}

pub fn respond(body: Value, status: u16) -> Response {
    let mut response = (
        StatusCode::from_u16(status).expect("valid connection status"),
        Json(body),
    )
        .into_response();
    let headers = response.headers_mut();
    for (key, value) in [
        ("cache-control", "no-store"),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
    ] {
        headers.insert(
            axum::http::HeaderName::from_static(key),
            axum::http::HeaderValue::from_static(value),
        );
    }
    if status == 429 {
        headers.insert("retry-after", axum::http::HeaderValue::from_static("5"));
    }
    response
}
fn failure(error: ConnectionError) -> Response {
    respond(json!({"error":error.message}), error.status)
}
fn text(body: &JsJson, key: &str) -> Option<String> {
    body[key]
        .as_js_string()
        .map(|value| String::from_utf16_lossy(&value.0))
}

/// Origin comes from configured canonical server URL, never a request Host header.
pub async fn public(state: &MachineState, req: Request, base_url: &str) -> Response {
    match dispatch(state, req, base_url).await {
        Ok(value) => respond(value, 200),
        Err(error) => failure(error),
    }
}
async fn dispatch(
    state: &MachineState,
    req: Request,
    base_url: &str,
) -> Result<Value, ConnectionError> {
    if req.method() != axum::http::Method::POST {
        return Err(ConnectionError::new(405, "method not allowed"));
    }
    let content_type = req
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if content_type != "application/json" {
        return Err(ConnectionError::new(400, "application/json required"));
    }
    let path = req.uri().path().to_owned();
    let bytes = to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(ConnectionError::backend)?;
    let raw = crate::protocol::js_value::decode_http_utf8(&bytes);
    if raw.encode_utf16().count() > 8192 {
        return Err(ConnectionError::new(413, "request too large"));
    }
    let body = crate::protocol::js_value::parse(raw.as_bytes())
        .map_err(|_| ConnectionError::new(400, "invalid JSON"))?;
    if body.as_object().is_none() {
        return Err(ConnectionError::new(400, "invalid request"));
    }
    let writer = state
        .store
        .database
        .ticket_writer()
        .map_err(ConnectionError::backend)?;
    let service = ConnectionService { writer: &writer };
    let now = state.store.now();
    match path.as_str() {
        "/connect/v1/requests" => {
            let (Some(repo), Some(id), Some(digest)) = (
                text(&body, "repo"),
                text(&body, "credentialId"),
                text(&body, "digest"),
            ) else {
                return Err(ConnectionError::new(400, "invalid proposal"));
            };
            let started = service.start(&repo, &id, &digest, now).await?;
            let verification_url = format!("{base_url}/connect?code={}", started.record.code);
            let mut value = serde_json::to_value(started).map_err(ConnectionError::backend)?;
            value["interval"] = json!(5);
            value["verificationURL"] = json!(verification_url);
            Ok(value)
        }
        "/connect/v1/poll" | "/connect/v1/cancel" => {
            let (Some(id), Some(capability)) = (text(&body, "id"), text(&body, "capability"))
            else {
                return Err(ConnectionError::new(400, "invalid capability"));
            };
            serde_json::to_value(
                service
                    .poll(&id, &capability, path.ends_with("cancel"), now)
                    .await?,
            )
            .map_err(ConnectionError::backend)
        }
        _ => Err(ConnectionError::new(404, "unknown connection route")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_paths_exclude_browser_and_credential_authority() {
        for path in [
            "/connect/v1/requests",
            "/connect/v1/poll",
            "/connect/v1/cancel",
        ] {
            assert!(is_public_path(path));
        }
        for path in [
            "/connect",
            "/connect/v1/status",
            "/connect/v1/revoke",
            "/connect/v1/browser/lookup",
            "/connect/v1/browser/decide",
            "/connect/v1/requests/extra",
        ] {
            assert!(!is_public_path(path));
        }
    }
    #[test]
    fn credential_paths_are_separate_from_public_capabilities() {
        for path in ["/connect/v1/status", "/connect/v1/revoke"] {
            assert!(is_machine_path(path));
            assert!(!is_public_path(path));
        }
        for path in [
            "/connect",
            "/connect/v1/requests",
            "/connect/v1/browser/decide",
            "/connect/v1/status/extra",
        ] {
            assert!(!is_machine_path(path));
        }
    }
    #[tokio::test]
    async fn public_admission_is_independent_of_browser_and_protocol_headers() {
        use crate::protocol::{router::Authority, store::Store};
        use std::sync::Arc;
        let state = MachineState {
            store: Arc::new(
                Store::deferred(
                    "postgres://localhost:1/unavailable",
                    Arc::new(chrono::Utc::now),
                )
                .unwrap(),
            ),
            authority: Authority::Project,
            secret: None,
        };
        for (method, content_type, bytes, status, message) in [
            ("GET", "", "", 405, "method not allowed"),
            ("POST", "text/plain", "{}", 400, "application/json required"),
            ("POST", "application/json", "{", 400, "invalid JSON"),
            ("POST", "application/json", "null", 400, "invalid request"),
            ("POST", "application/json", "[]", 400, "invalid request"),
            (
                "POST",
                "application/json; charset=utf-8",
                "{}",
                400,
                "invalid proposal",
            ),
        ] {
            let req = Request::builder()
                .method(method)
                .uri("/connect/v1/requests")
                .header("content-type", content_type)
                .body(axum::body::Body::from(bytes))
                .unwrap();
            let response = public(&state, req, "https://service.example").await;
            assert_eq!(response.status().as_u16(), status);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes).unwrap(),
                json!({"error":message})
            );
        }
        let req = Request::builder()
            .method("POST")
            .uri("/connect/v1/requests")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(" ".repeat(8193)))
            .unwrap();
        assert_eq!(
            public(&state, req, "https://service.example")
                .await
                .status()
                .as_u16(),
            413
        );
    }
    #[test]
    fn capability_responses_do_not_cache_or_send_referrers() {
        let response = respond(json!({"error":"poll again in five seconds"}), 429);
        for (key, value) in [
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
            ("retry-after", "5"),
        ] {
            assert_eq!(response.headers()[key], value);
        }
    }
}
