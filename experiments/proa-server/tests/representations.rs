use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

use proa_server::{app, auth};
#[path = "../src/components/mod.rs"]
mod components;
// The executable alone consumes address/from_env; integration constructs config directly.
use proa_server::config;
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
    assert_eq!(
        proa_server::protocol::js_json::parse_js_json(health.as_bytes()).unwrap(),
        serde_json::to_value(proa_server::protocol::identity::health_body()).unwrap()
    );
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
        "No data store configured.",
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
            data: None,
            writer: None,
            blobs: None,
            operator_secret: None,
            machine: None,
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
        "AB_WEB_SUPER_USER_EMAILS" => Some("operator@example.com".into()),
        _ => None,
    })
    .unwrap();
    let mut auth = auth::Auth::new(config.auth);
    auth.allowed = std::sync::Arc::new(|| vec!["operator@example.com".into()]);
    let app = routes::router(app::AppState {
        auth: std::sync::Arc::new(auth),
        data: None,
        writer: None,
        blobs: None,
        operator_secret: None,
        machine: None,
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

#[tokio::test]
async fn projected_row_diagnostics_tokens_and_bounded_message_preview_reach_html() {
    use proa_server::data::dashboard::Snapshot;
    use serde_json::json;
    let page = pages::home::HomePage::new(Snapshot {
        projects: vec!["repo".into()],
        project: Some("repo".into()),
        settings: json!({}),
        error: None,
        rows: vec![
            json!({"slug":"blocked","status":"blocked","alsoPaused":true,
            "pr":{"url":"https://github.com/acme/web/pull/612","state":"open"},
            "reviewRoundCeilings":{"plan":3,"code":5},"setupError":"Setup command failed",
            "blockers":["Question first line\n\nParagraph preserved\nTHE CONFLICT\nHidden explanation"],"steps":[]}),
            json!({"slug":"node","status":"running","integrationRow":{"steps":[],"children":{"known":true,"landed":2,"total":5,"building":1,"queued":2}},"steps":[]}),
        ],
    });
    let html = proa_core::render_to_string(page);
    for expected in [
        "Setup command failed",
        "PR #612 open",
        "https://github.com/acme/web/pull/612",
        "(paused)",
        "review round ceiling: plan 3, code 5",
        "2/5 landed · 1 building · 2 queued",
        "message-alert",
        "Question first line",
        "Paragraph preserved",
        "... 2 more rows",
        "View details",
    ] {
        assert!(
            html.contains(expected),
            "missing projected display field: {expected}: {html}"
        );
    }
    assert!(!html.contains("THE CONFLICT"));
    assert!(!html.contains("Hidden explanation"));
    assert!(html.contains("<p></p>"), "paragraph boundary was collapsed");
    assert!(html.contains("/dashboard/builds/blocked?project=repo"));
}

#[tokio::test]
async fn production_machine_namespaces_bypass_browser_auth_and_origin_middleware() {
    let (state, cookie) = admitted();
    let app = routes::router(state);
    for path in [
        "/builds",
        "/repos",
        "/sessions/unknown/events",
        "/streams/unknown/chunks",
        "/%62uilds/unknown",
        "//repos//unknown",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("origin", "https://foreign.invalid")
                    .header("sec-fetch-site", "cross-site")
                    .header(header::ACCEPT, "text/html")
                    .header(header::COOKIE, format!("{cookie}; proa-session=invalid"))
                    .header(
                        "x-autobuild-version",
                        proa_server::protocol::identity::health_body().autobuild_version,
                    )
                    .header(
                        "x-autobuild-protocol-version",
                        proa_server::protocol::identity::health_body().protocol_version,
                    )
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "{path}");
        assert!(response.headers().get(header::LOCATION).is_none(), "{path}");
        assert!(
            response.headers().get(header::SET_COOKIE).is_none(),
            "{path}"
        );
        assert!(response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("application/json"));
        let value: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind":"internal","error":"store backend unavailable"}),
            "{path}"
        );
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/credentials/delegate")
                .header(
                    "x-autobuild-version",
                    proa_server::protocol::identity::health_body().autobuild_version,
                )
                .header(
                    "x-autobuild-protocol-version",
                    proa_server::protocol::identity::health_body().protocol_version,
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body(response).await).unwrap(),
        serde_json::json!({"kind":"not-found","error":"credential issuance unavailable"})
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/buildsx")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert!(response.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .starts_with("/sign-in"));
}

#[tokio::test]
async fn production_machine_identity_and_path_errors_remain_json_without_storage() {
    let (state, _) = admitted();
    let app = routes::router(state);
    for (path, status) in [
        ("/builds/unknown", StatusCode::CONFLICT),
        ("/repos/%GG/events", StatusCode::BAD_REQUEST),
        ("/health/unknown", StatusCode::NOT_FOUND),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::ACCEPT, "text/html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
        assert!(response.headers().get(header::LOCATION).is_none());
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let value: serde_json::Value = serde_json::from_slice(&body(response).await).unwrap();
        assert!(value["error"].is_string());
    }
}

#[tokio::test]
async fn production_machine_auth_and_health_do_not_connect_to_deferred_storage() {
    use proa_server::protocol::{
        router::{Authority, MachineState},
        store::Store,
    };
    use std::{sync::Arc, time::Duration};
    let (mut state, _) = admitted();
    state.machine = Some(MachineState {
        store: Arc::new(
            Store::deferred(
                "postgres://unused:unused@127.0.0.1:9/unreachable",
                Arc::new(chrono::Utc::now),
            )
            .unwrap(),
        ),
        authority: Authority::Project,
        secret: Some("production-routing-test".into()),
    });
    let app = routes::router(state);
    for path in [
        "/builds",
        "/repos/unknown/events",
        "/streams/unknown/chunks",
        "/credentials/delegate",
    ] {
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("origin", "https://foreign.invalid")
                    .header(
                        "x-autobuild-version",
                        proa_server::protocol::identity::health_body().autobuild_version,
                    )
                    .header(
                        "x-autobuild-protocol-version",
                        proa_server::protocol::identity::health_body().protocol_version,
                    )
                    .body(Body::from("{"))
                    .unwrap(),
            ),
        )
        .await
        .expect("authentication must not contact storage")
        .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body(response).await).unwrap(),
            serde_json::json!({"kind":"auth","error":"missing bearer credential"})
        );
    }
    let response = tokio::time::timeout(
        Duration::from_secs(1),
        app.oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("health must not contact storage")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body(response).await).unwrap(),
        serde_json::to_value(proa_server::protocol::identity::health_body()).unwrap()
    );
}

#[tokio::test]
async fn production_readiness_reports_unreachable_storage_while_health_stays_live() {
    use proa_server::data::{
        config::{BlobConfig, DataConfig},
        reader::DataReader,
    };
    use std::sync::Arc;
    let (mut state, _) = admitted();
    state.data = Some(Arc::new(
        DataReader::deferred(DataConfig {
            database_url: "postgres://unused:unused@127.0.0.1:9/unreachable".into(),
            blobs: BlobConfig::S3 {
                bucket: "routing-test".into(),
                region: "us-east-1".into(),
                access_key_id: "unused".into(),
                secret_access_key: "unused".into(),
                endpoint: Some("http://127.0.0.1:9".into()),
                session_token: None,
                force_path_style: Some(true),
            },
            prefix: "routing-test".into(),
            artifact_retention_max_revisions: None,
        })
        .unwrap(),
    ));
    let app = routes::router(state);
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        app.clone().oneshot(
            Request::builder()
                .uri("/readyz")
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body(response).await).unwrap(),
        serde_json::json!({"status":"not ready","version":env!("CARGO_PKG_VERSION")})
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body(response).await).unwrap(),
        serde_json::to_value(proa_server::protocol::identity::health_body()).unwrap()
    );
}

#[tokio::test]
async fn build_detail_browser_path_is_distinct_from_machine_namespace() {
    let (state, cookie) = admitted();
    let app = routes::router(state);
    let machine = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/builds/example")
                .header(header::ACCEPT, "text/html")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(machine.status(), StatusCode::CONFLICT);
    assert!(machine.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
    let value: serde_json::Value = serde_json::from_slice(&body(machine).await).unwrap();
    assert!(value["error"].is_string());
    let browser = app
        .oneshot(
            Request::builder()
                .uri("/dashboard/builds/example?project=repo")
                .header(header::ACCEPT, "text/html")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // This router fixture has no DataReader; the real seeded HTML is asserted by capture.
    assert_eq!(browser.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(browser).await, b"Project unavailable");
}
