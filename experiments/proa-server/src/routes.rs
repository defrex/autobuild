use std::{collections::HashMap, sync::Arc};

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use proa_framework_axum::{router_from_spec, IslandManifest, Route, RouteContextLayer};
use proa_framework_axum::{
    CrossOriginProtectionLayer, SecurityHeadersConfig, SecurityHeadersLayer,
};

use crate::{app::AppState, endpoints, pages, static_assets};
use axum::extract::Request;
use proa_server::protocol;
use tower::{service_fn, ServiceExt};

pub fn router(state: AppState) -> Router {
    let machine = state
        .machine
        .clone()
        .map(protocol::router::router)
        .unwrap_or_else(protocol::router::unavailable_router);
    let (router, metadata) = router_from_spec(vec![
        // proa:route-specs:start
        Route::endpoint("/", get(pages::home::handler)),
        Route::endpoint(
            "/oauth/consent",
            get(pages::consent::handler).post(pages::consent::submit),
        ),
        Route::endpoint("/connect", get(pages::connect::handler)),
        Route::endpoint("/dashboard/builds/:slug", get(pages::build::handler)),
        // proa:route-specs:end
    ]);
    let manifest = Arc::new(IslandManifest {
        islands: HashMap::new(),
        assets: Default::default(),
        import_map: HashMap::new(),
        ssr_bundle: None,
    });
    let security = SecurityHeadersConfig::new()
        .with_content_security_policy(crate::layouts::browser_csp(None));
    let security = if state.auth.config.origin.scheme() == "https" {
        security.with_hsts_max_age_secs(31536000)
    } else {
        security
    };
    let router = if state.auth.config.dev.is_some() {
        router.route("/auth/dev-session", post(endpoints::auth::dev_session))
    } else {
        router
    };
    let cross_origin = CrossOriginProtectionLayer::new()
        .with_trusted_origin(state.auth.config.origin.origin().ascii_serialization());
    let connection_origin = state.auth.config.origin.origin().ascii_serialization();
    let connection_machine = state.machine.clone();
    let connection_browser = state.clone();
    let browser = router
        .route("/health", get(endpoints::health::live))
        .route("/readyz", get(endpoints::health::ready))
        // proa:explicit-routes:start
        .route("/index.md", get(pages::home::markdown))
        .route("/refresh", get(endpoints::live::refresh))
        .route("/frame", get(endpoints::live::frame))
        .route("/sign-in", get(endpoints::auth::sign_in))
        .route("/auth/github", get(endpoints::auth::initiate))
        .route("/auth/github/callback", get(endpoints::auth::callback))
        .route("/auth/sign-out", post(endpoints::auth::sign_out))
        .route("/controls", post(endpoints::controls::submit))
        .route("/connect/decide", post(endpoints::connect::submit))
        // proa:explicit-routes:end
        .layer(cross_origin)
        .merge(proa_server::operator::http::router())
        .merge(proa_server::operator::delegation::router())
        .nest_service("/static", static_assets::service())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            endpoints::auth::gateway,
        ))
        .with_state(state)
        .layer(RouteContextLayer::new(manifest, metadata))
        .layer(middleware::from_fn(endpoints::auth::privacy))
        .layer(SecurityHeadersLayer::new(security));
    Router::new().fallback_service(service_fn(move |request: Request| {
        let connection = connection_machine.clone();
        let browser_state = connection_browser.clone();
        let origin = connection_origin.clone();
        let public_connection = proa_server::connection::http::is_public_path(request.uri().path());
        let credential_connection =
            proa_server::connection::http::is_machine_path(request.uri().path());
        let browser_connection = matches!(
            request.uri().path(),
            "/connect/v1/browser/lookup" | "/connect/v1/browser/decide"
        );
        let selected = if protocol::router::is_machine_path(request.uri().path()) {
            machine.clone()
        } else {
            browser.clone()
        };
        async move {
            if request.uri().path() == "/mcp" {
                return Ok(proa_server::mcp::http::handle(browser_state, request).await);
            }
            if proa_server::oauth::http::is_public_path(request.uri().path()) {
                return Ok(proa_server::oauth::http::handle(browser_state, request).await);
            }
            if browser_connection {
                return Ok(endpoints::connect::browser(browser_state, request).await);
            }
            if public_connection || credential_connection {
                return Ok(match connection {
                    Some(state) => {
                        if public_connection {
                            proa_server::connection::http::public(&state, request, &origin).await
                        } else {
                            proa_server::connection::http::credential(&state, request).await
                        }
                    }
                    None => proa_server::connection::http::respond(
                        serde_json::json!({"error":"connection service is unavailable; retry"}),
                        503,
                    ),
                });
            }
            selected.oneshot(request).await
        }
    }))
}
