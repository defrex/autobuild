//! Fresh browser admission is provided by the shared gateway, with CSRF on forms.
use crate::{
    auth::Viewer,
    pages::connect::{canonical_code, response},
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    Extension, Form,
};
use proa_server::{app::AppState, connection::ConnectionService};
use serde::Deserialize;
#[derive(Deserialize)]
pub struct Decision {
    csrf: String,
    code: String,
    decision: String,
}
pub async fn submit(
    State(state): State<AppState>,
    Extension(viewer): Extension<Viewer>,
    headers: HeaderMap,
    Form(form): Form<Decision>,
) -> Response {
    let code = canonical_code(&form.code);
    if !super::auth::same_origin(&headers, &state) || form.csrf != viewer.csrf {
        return response(
            viewer,
            code,
            None,
            Some("Approval refused. Reload the page and try again.".into()),
            StatusCode::FORBIDDEN,
        );
    }
    let approve = match form.decision.as_str() {
        "approve" => true,
        "deny" => false,
        _ => {
            return response(
                viewer,
                code,
                None,
                Some("Choose Approve or Deny.".into()),
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let Some(writer) = &state.writer else {
        return response(
            viewer,
            code,
            None,
            Some("Connection service is unavailable. Try again.".into()),
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    let now = state
        .machine
        .as_ref()
        .map(|m| m.store.now())
        .unwrap_or_else(chrono::Utc::now);
    match (ConnectionService { writer })
        .decide(&code, &viewer.email, approve, now)
        .await
    {
        Ok(record) => response(viewer, code, Some(record), None, StatusCode::OK),
        Err(error) => response(
            viewer,
            code,
            None,
            Some(error.message.into()),
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
        ),
    }
}

/// JSON browser protocol has explicit admission errors rather than redirects.
pub async fn browser(state: AppState, request: axum::extract::Request) -> Response {
    use proa_server::connection::http::respond;
    use serde_json::json;
    if request.method() != axum::http::Method::POST {
        return respond(json!({"error":"method not allowed"}), 405);
    }
    if !request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return respond(json!({"error":"application/json required"}), 400);
    }
    if request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        != Some(
            state
                .auth
                .config
                .origin
                .origin()
                .ascii_serialization()
                .as_str(),
        )
    {
        return respond(json!({"error":"cross-origin approval refused"}), 403);
    }
    let id = state.auth.read_cookie(request.headers(), "proa-session");
    let viewer = {
        let mut sessions = state.auth.sessions.lock().unwrap();
        sessions.retain(|_, s| s.expires > state.auth.now());
        id.and_then(|id| sessions.get(&id))
            .map(|s| s.viewer.clone())
    };
    let Some(viewer) = viewer else {
        return respond(json!({"error":"sign in required"}), 401);
    };
    if !(state.auth.allowed)().contains(&viewer.email.to_ascii_lowercase()) {
        return respond(json!({"error":"this identity is not allowed"}), 403);
    }
    match state.machine {
        Some(machine) => {
            proa_server::connection::http::browser(&machine, request, &viewer.email).await
        }
        None => respond(
            json!({"error":"connection service is unavailable; retry"}),
            503,
        ),
    }
}
