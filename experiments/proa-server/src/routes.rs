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

pub fn router(state: AppState) -> Router {
    let (router, metadata) = router_from_spec(vec![
        // proa:route-specs:start
        Route::endpoint("/", get(pages::home::handler)),
        Route::endpoint("/builds/:slug", get(pages::build::handler)),
        // proa:route-specs:end
    ]);
    let manifest = Arc::new(IslandManifest {
        islands: HashMap::new(),
        assets: Default::default(),
        import_map: HashMap::new(),
        ssr_bundle: None,
    });
    let security = SecurityHeadersConfig::new().with_content_security_policy(
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
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
    router
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
        .layer(SecurityHeadersLayer::new(security))
}
