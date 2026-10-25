use crate::{
    app::AppState,
    pages::{build::BuildPage, home::HomePage},
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use proa_core::{WebContext, WebRenderSync};
use sha2::{Digest, Sha256};
#[derive(serde::Deserialize)]
pub struct Refresh {
    project: Option<String>,
    slug: Option<String>,
}
pub async fn refresh(
    State(state): State<AppState>,
    Query(query): Query<Refresh>,
    headers: HeaderMap,
) -> Response {
    let Some(reader) = state.data else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Data store unavailable").into_response();
    };
    let result = if let Some(slug) = query.slug {
        match query.project {
            Some(project) => reader.detail_snapshot(&project, &slug).await.map(|v| {
                let version = format!("\"{:x}\"", Sha256::digest(v.to_string().as_bytes()));
                (version, Page::Detail(v))
            }),
            None => return (StatusCode::NOT_FOUND, "Project unavailable").into_response(),
        }
    } else {
        reader
            .dashboard_snapshot(query.project.as_deref())
            .await
            .map(|v| {
                let version = format!(
                    "\"{:x}\"",
                    Sha256::digest(serde_json::to_vec(&v).unwrap_or_default())
                );
                (version, Page::Dashboard(v))
            })
    };
    let (version, page) = match result {
        Ok(v) => v,
        Err(e) => return (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response(),
    };
    if headers
        .get("if-none-match")
        .is_some_and(|v| v.as_bytes() == version.as_bytes())
    {
        return (StatusCode::NOT_MODIFIED, [("etag", version)]).into_response();
    }
    let mut cx = WebContext::new();
    let result = match page {
        Page::Detail(value) => BuildPage::new(value).render(&mut cx),
        Page::Dashboard(snapshot) => HomePage::new(snapshot).render(&mut cx),
    };
    if result.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Render failed").into_response();
    }
    (
        [
            ("content-type", "text/html; charset=utf-8"),
            ("etag", version.as_str()),
        ],
        cx.into_output().into_vec(),
    )
        .into_response()
}
enum Page {
    Dashboard(proa_server::data::dashboard::Snapshot),
    Detail(serde_json::Value),
}
#[derive(serde::Deserialize)]
pub struct Frame {
    project: String,
    slug: String,
    index: usize,
}
pub async fn frame(State(state): State<AppState>, Query(query): Query<Frame>) -> Response {
    let Some(reader) = state.data else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(detail) = reader.detail_snapshot(&query.project, &query.slug).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(frame) = detail["frames"]
        .as_array()
        .and_then(|frames| frames.get(query.index))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !proa_server::data::dashboard::valid_frame(frame) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match reader
        .artifact(
            &query.project,
            proa_server::data::postgres::Scope::Build(&query.slug),
            frame["kind"].as_str().unwrap_or_default(),
            frame["rev"].as_i64(),
        )
        .await
    {
        Ok(Some(bytes)) => (
            [
                (
                    "content-type",
                    frame["mediaType"]
                        .as_str()
                        .unwrap_or("application/octet-stream"),
                ),
                ("x-content-type-options", "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
