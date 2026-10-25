use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[path = "../src/app.rs"]
mod app;
#[path = "../src/auth/mod.rs"]
mod auth;
#[path = "../src/components/mod.rs"]
mod components;
// The executable alone consumes address/from_env; integration constructs config directly.
#[allow(dead_code)]
#[path = "../src/config.rs"]
mod config;
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
#[path = "../src/server.rs"]
mod server;
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
    let (state, cookie) = admitted();
    let app = routes::router(state);

    let html = app
        .clone()
        .oneshot(
            Request::builder()
                .header(header::COOKIE, &cookie)
                .uri("/")
                .body(Body::empty())
                .unwrap(),
        )
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
                .header(header::COOKIE, &cookie)
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
                .header(header::COOKIE, &cookie)
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
                .header(header::COOKIE, &cookie)
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
    let (state, cookie) = admitted();
    let app = routes::router(state);
    let health = app
        .clone()
        .oneshot(
            Request::builder()
                .header(header::COOKIE, &cookie)
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
        .oneshot(
            Request::builder()
                .header(header::COOKIE, &cookie)
                .uri("/")
                .body(Body::empty())
                .unwrap(),
        )
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

fn admitted() -> (app::AppState, String) {
    let mut auth = auth::Auth::new(config::Config::parse(|_| None).unwrap().auth);
    auth.allowed = std::sync::Arc::new(|| vec!["operator@example.com".into()]);
    let (cookie, _) = auth.issue("operator@example.com".into()).unwrap();
    (
        app::AppState {
            auth: std::sync::Arc::new(auth),
        },
        cookie.split(';').next().unwrap().to_owned(),
    )
}
#[tokio::test]
async fn tcp_development_path_supplies_peer() {
    let config = config::Config::parse(|key| match key {
        "PROA_ENV" => Some("development".into()),
        "PROA_DEV_AUTH" => Some("true".into()),
        "PROA_DEV_AUTH_EMAIL" => Some("operator@example.com".into()),
        "PROA_DEV_AUTH_CAPABILITY" | "PROA_SESSION_SECRET" => Some("a".repeat(40)),
        "AB_WEB_ALLOWED_EMAILS" => Some("operator@example.com".into()),
        _ => None,
    })
    .unwrap();
    let mut auth = auth::Auth::new(config.auth);
    auth.allowed = std::sync::Arc::new(|| vec!["operator@example.com".into()]);
    let app = routes::router(app::AppState {
        auth: std::sync::Arc::new(auth),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/auth/dev-session", listener.local_addr().unwrap());
    let task = tokio::spawn(server::serve(listener, app));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client
        .post(&url)
        .header("x-proa-dev-capability", "a".repeat(40))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert!(response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .any(|c| c.to_str().unwrap().starts_with("proa-session=")
            && !c.to_str().unwrap().contains("Max-Age=0")));
    assert_eq!(
        client.post(url).send().await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    task.abort();
}
