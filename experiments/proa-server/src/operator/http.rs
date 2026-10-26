//! Bearer HTTP adapter. Cookie authority is deliberately absent here.
use super::{
    auth::{self, NativeAuth},
    error::OperatorError,
    protocol, requests,
    sessions::{Mutation, SessionService},
};
use crate::app::AppState;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Extension, Json, Router,
};
use serde_json::{json, Value};

pub type HttpClock = std::sync::Arc<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send + Sync>;
pub fn router() -> Router<AppState> {
    router_with_clock(std::sync::Arc::new(chrono::Utc::now))
}
pub fn router_with_clock(clock: HttpClock) -> Router<AppState> {
    Router::new()
        .route("/operator/v1/repos/:repo/*tail", any(handle))
        .layer(Extension(clock))
}
fn json_response(status: u16, body: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json;charset=utf-8",
        )],
        Json(body),
    )
        .into_response()
}
async fn handle(
    State(state): State<AppState>,
    Extension(clock): Extension<HttpClock>,
    Path((repo, tail)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let segments: Vec<&str> = tail.split('/').collect();
    if method == Method::GET {
        if let ["builds", slug, "artifacts", kind] = segments.as_slice() {
            return match artifact(&state, &repo, slug, kind, &uri, &headers, clock()).await {
                Ok(response) => response,
                Err(error) => error.into_response(),
            };
        }
    }
    match execute(
        &state,
        &repo,
        &tail,
        &method,
        &uri,
        &headers,
        &bytes,
        clock(),
    )
    .await
    {
        Ok((status, body)) => json_response(status, body),
        Err(error) => error.into_response(),
    }
}
async fn admit(
    state: &AppState,
    repo: &str,
    headers: &HeaderMap,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<auth::Principal, OperatorError> {
    // Version admission must precede even configuration/auth/resource lookup.
    protocol::check_identity(headers)?;
    let reader = state.data.as_deref().ok_or_else(OperatorError::internal)?;
    let writer = state
        .writer
        .as_deref()
        .ok_or_else(OperatorError::internal)?;
    let backend = NativeAuth { reader, writer };
    let principal = auth::authenticate_operator(
        headers,
        repo,
        state.operator_secret.as_deref().unwrap_or(""),
        now.timestamp_millis(),
        &backend,
    )
    .await?;
    if state.operator_secret.is_none() && !matches!(principal, auth::Principal::Project { .. }) {
        return Err(OperatorError::auth(401, auth::RETIRED_CREDENTIAL_MESSAGE));
    }
    Ok(principal)
}
// Keep the explicit resource, authority and storage inputs visible at this boundary.
#[allow(clippy::too_many_arguments)]
async fn execute(
    state: &AppState,
    repo: &str,
    tail: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    bytes: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(u16, Value), OperatorError> {
    let principal = admit(state, repo, headers, now).await?;
    let reader = state.data.as_deref().ok_or_else(OperatorError::internal)?;
    let writer = state
        .writer
        .as_deref()
        .ok_or_else(OperatorError::internal)?;
    let segments: Vec<&str> = tail.split('/').collect();
    let session = SessionService { reader, writer };
    if let Some(result) = super::ticket_http::handle(
        method, &segments, repo, &principal, reader, writer, bytes, uri,
    )
    .await
    {
        return result;
    }
    let control = super::control::ControlService {
        reader,
        writer,
        blobs: state.blobs.as_deref(),
    };
    let actor = principal.actor();
    match (method.as_str(), segments.as_slice()) {
        ("POST", ["tools", name]) => Ok((
            200,
            super::registry::Registry {
                state,
                repo,
                principal: &principal,
                now,
            }
            .call(name, bytes)
            .await?,
        )),
        ("GET", ["builds", slug]) => Ok((200, super::query::get(reader, repo, slug, now).await?)),
        ("GET", ["dashboard"]) => Ok((200, super::query::dashboard(reader, repo, now).await?)),
        ("GET", ["status"]) => Ok((200, super::query::status(reader, repo, now).await?)),
        ("GET", ["harvest", "status"]) => Ok((200, super::query::harvest(reader, repo).await?)),
        ("GET", ["builds"]) => {
            let query = url::Url::parse(&format!("http://operator.invalid{uri}"))
                .map_err(|_| OperatorError::internal())?;
            let scope = query
                .query_pairs()
                .find(|(k, _)| k == "scope")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_else(|| "active".into());
            if !["active", "queued", "all"].contains(&scope.as_str()) {
                return Err(OperatorError::validation(
                    "scope must be active, queued, or all",
                ));
            }
            Ok((200, super::query::builds(reader, repo, &scope, now).await?))
        }
        ("POST", ["builds", slug, "control"]) => {
            let body = super::request_schema::parse("buildControlRequestSchema", bytes)?;
            Ok((
                200,
                control
                    .control(repo, slug, &actor, body["action"].as_str().unwrap(), now)
                    .await?,
            ))
        }
        ("POST", ["builds", slug, "answer"]) => {
            let body = super::request_schema::parse("answerRequestSchema", bytes)?;
            Ok((200, control.answer(repo, slug, &actor, &body, now).await?))
        }
        ("POST", ["builds", slug, "restack"]) => {
            Ok((200, control.restack(repo, slug, &actor, now).await?))
        }
        ("PUT", ["settings", "intake"]) => {
            let body = super::request_schema::parse("settingRequestSchema", bytes)?;
            Ok((
                200,
                control
                    .setting(repo, &actor, body["enabled"].as_bool(), now)
                    .await?,
            ))
        }
        ("POST", ["settings", "intake", "toggle"]) => {
            Ok((200, control.setting(repo, &actor, None, now).await?))
        }
        ("PUT", ["settings", "auto-merge-default"]) => {
            super::request_schema::parse("settingRequestSchema", bytes)?;
            Err(OperatorError::refusal(
                "Auto-merge default is retired; configure [[landing]] rules in autobuild.toml",
            )
            .with_code("retired-setting"))
        }
        ("POST", ["settings", "auto-merge-default", "toggle"]) => Err(OperatorError::refusal(
            "Auto-merge default is retired; configure [[landing]] rules in autobuild.toml",
        )
        .with_code("retired-setting")),
        ("POST", ["bulk-control"]) => {
            let body = super::request_schema::parse("bulkControlRequestSchema", bytes)?;
            Ok((
                200,
                control
                    .bulk(repo, &actor, body["action"].as_str().unwrap(), now)
                    .await?,
            ))
        }
        ("POST", ["harvest", "control"]) => {
            let body = super::request_schema::parse("harvestControlRequestSchema", bytes)?;
            Ok((
                200,
                control
                    .harvest(repo, &actor, body["run"].as_str(), now)
                    .await?,
            ))
        }
        ("GET", ["sessions"]) => Ok((200, json!(session.list(repo).await?))),
        ("POST", ["sessions"]) => {
            let body = requests::session_body(bytes, "create")?;
            Ok((
                201,
                session
                    .create_http(repo, principal.user(), body["title"].as_str(), now)
                    .await?,
            ))
        }
        ("GET", ["sessions", id]) => Ok((200, session.get(repo, id).await?)),
        ("POST", ["sessions", id, "messages"]) => {
            let body = requests::session_body(bytes, "message")?;
            session
                .mutate(
                    repo,
                    id,
                    principal.user(),
                    Mutation::Message(body["text"].as_str().unwrap()),
                    now,
                )
                .await?;
            Ok((200, json!({"ok":true})))
        }
        ("PUT", ["sessions", id, "wake"]) => {
            let body = requests::session_body(bytes, "wake")?;
            let globs: Vec<String> = body["globs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g.as_str().unwrap().to_owned())
                .collect();
            session
                .mutate(repo, id, principal.user(), Mutation::Wake(&globs), now)
                .await?;
            Ok((200, json!({"ok":true})))
        }
        ("POST", ["sessions", id, "approvals"]) => {
            let body = requests::session_body(bytes, "approval")?;
            session
                .mutate(
                    repo,
                    id,
                    principal.user(),
                    Mutation::Approval {
                        turn: body["turn"].as_str().unwrap(),
                        tool_call_id: body["toolCallId"].as_str().unwrap(),
                        decision: body["decision"].as_str().unwrap(),
                    },
                    now,
                )
                .await?;
            Ok((200, json!({"ok":true})))
        }
        ("GET", ["sessions", id, "turns", turn, "stream"]) => {
            let query = url::Url::parse(&format!("http://operator.invalid{uri}"))
                .map_err(|_| OperatorError::internal())?;
            let params: Vec<_> = query.query_pairs().collect();
            let since = params
                .iter()
                .find(|(k, _)| k == "since")
                .map(|(_, v)| v.as_ref());
            let wait = params
                .iter()
                .find(|(k, _)| k == "wait")
                .map(|(_, v)| v.as_ref());
            let since = parse_integer(since, false, "since must be a nonnegative integer")?
                .max(0.0)
                .min(i64::MAX as f64) as i64;
            let wait = parse_integer(wait, true, "wait must be an integer number of seconds")?
                .clamp(0.0, 30.0) as u64;
            Ok((200, session.stream(repo, id, turn, since, wait).await?))
        }
        ("POST", ["sessions", id, "archive"]) => {
            session
                .mutate(repo, id, principal.user(), Mutation::Archive, now)
                .await?;
            Ok((200, json!({"ok":true})))
        }
        _ => Err(OperatorError::not_found(format!(
            "no route: {method} {}",
            uri.path()
        ))),
    }
}

fn parse_integer(value: Option<&str>, signed: bool, error: &str) -> Result<f64, OperatorError> {
    let Some(value) = value else {
        return Ok(0.0);
    };
    let digits = if signed {
        value.strip_prefix('-').unwrap_or(value)
    } else {
        value
    };
    if digits.is_empty() || !digits.bytes().all(|v| v.is_ascii_digit()) {
        return Err(OperatorError::validation(error));
    }
    Ok(value.parse::<f64>().unwrap_or(f64::INFINITY))
}

fn component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
async fn artifact(
    state: &AppState,
    repo: &str,
    slug: &str,
    kind: &str,
    uri: &Uri,
    headers: &HeaderMap,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Response, OperatorError> {
    admit(state, repo, headers, now).await?;
    let reader = state.data.as_deref().ok_or_else(OperatorError::internal)?;
    let query = url::Url::parse(&format!("http://operator.invalid{uri}"))
        .map_err(|_| OperatorError::internal())?;
    let revision = query
        .query_pairs()
        .find(|(key, _)| key == "rev")
        .map(|(_, raw)| super::query::artifact_revision(&raw))
        .transpose()?;
    if reader
        .postgres()
        .build_record(repo, slug)
        .await
        .map_err(|_| OperatorError::internal())?
        .is_none()
    {
        return Err(OperatorError::not_found(format!(
            "unknown build \"{slug}\""
        )));
    }
    let missing = || {
        OperatorError::not_found(format!(
            "artifact {kind}{} not found",
            revision.map(|r| format!("@{r}")).unwrap_or_default()
        ))
    };
    let scope = crate::data::postgres::Scope::Build(slug);
    let metadata = reader
        .postgres()
        .artifact(repo, scope, kind, revision)
        .await
        .map_err(|_| OperatorError::internal())?
        .ok_or_else(missing)?;
    let selected = metadata["revision"]
        .as_i64()
        .ok_or_else(OperatorError::internal)?;
    let bytes = reader
        .artifact(repo, scope, kind, Some(selected))
        .await
        .map_err(|_| OperatorError::internal())?
        .ok_or_else(missing)?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    for (key, value) in [
        ("content-type", "application/octet-stream".to_owned()),
        (
            "content-disposition",
            format!(
                "attachment; filename=\"{}-{}-{selected}\"",
                component(slug),
                component(kind)
            ),
        ),
        ("x-autobuild-artifact-kind", kind.to_owned()),
        ("x-autobuild-artifact-revision", selected.to_string()),
        (
            "x-autobuild-artifact-blob-ref",
            metadata["blobRef"]
                .as_str()
                .ok_or_else(OperatorError::internal)?
                .to_owned(),
        ),
    ] {
        headers.insert(key, value.parse().map_err(|_| OperatorError::internal())?);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;
    #[tokio::test]
    async fn identity_refusal_precedes_unconfigured_store_and_cookie_admission() {
        let state = AppState {
            auth: std::sync::Arc::new(crate::auth::Auth::new(
                crate::config::Config::parse(|_| None).unwrap().auth,
            )),
            data: None,
            machine: None,
            writer: None,
            blobs: None,
            operator_secret: None,
        };
        let response = router()
            .with_state(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/operator/v1/repos/acme%2Fapp/sessions")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 409);
        assert_eq!(
            response.headers()["content-type"],
            "application/json;charset=utf-8"
        );
        assert!(response.headers().get("location").is_none());
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 8192)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["kind"], "conflict");
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("remote store version mismatch"));
    }
}
