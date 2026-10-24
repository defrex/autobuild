use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[path = "../src/app.rs"]
mod app;
#[path = "../src/components/mod.rs"]
mod components;
#[path = "../src/endpoints/mod.rs"]
mod endpoints;
#[path = "../src/error.rs"]
mod error;
#[path = "../src/layouts/mod.rs"]
mod layouts;
#[path = "../src/pages/mod.rs"]
mod pages;
#[path = "../src/routes.rs"]
mod routes;
#[path = "../src/static_assets.rs"]
mod static_assets;

async fn body(response: Response) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}

#[tokio::test(flavor = "multi_thread")]
async fn canonical_and_explicit_markdown_share_one_page_policy() {
    let app = routes::router(app::AppState);

    let html = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(html.status(), StatusCode::OK);
    assert!(html.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/html"));
    assert_eq!(html.headers()[header::VARY], "Accept");
    assert!(html.headers()[header::LINK]
        .to_str()
        .unwrap()
        .contains("/index.md"));

    let refused_markdown = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::ACCEPT, "text/markdown;q=0, text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(refused_markdown.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/html"));

    let negotiated = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::ACCEPT, "text/markdown")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(negotiated.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/markdown"));
    let negotiated = body(negotiated).await;

    let explicit = app
        .oneshot(
            Request::builder()
                .uri("/index.md")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(explicit.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/markdown"));
    let explicit = body(explicit).await;
    assert_eq!(negotiated, explicit);
    let markdown = String::from_utf8(explicit).unwrap();
    assert!(!markdown.contains("<html"));
    assert!(!markdown.contains("/static/"));
}

#[tokio::test]
async fn health_and_shell() {
    let app = routes::router(app::AppState);
    let health = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let health = String::from_utf8(body(health).await).unwrap();
    assert!(health.contains(env!("CARGO_PKG_VERSION")));
    let html = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let html = String::from_utf8(body(html).await).unwrap();
    for marker in [
        "data-shell=",
        "account-trigger",
        "No build data connected yet.",
        "/static/styles.css",
        "/static/theme-init.js",
        "/static/shell.js",
    ] {
        assert!(html.contains(marker), "missing {marker}");
    }
    assert!(!html.contains("fonts.googleapis"));
}
