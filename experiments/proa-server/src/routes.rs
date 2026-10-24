use std::{collections::HashMap, sync::Arc};

use axum::{routing::get, Router};
use proa_framework_axum::{router_from_spec, IslandManifest, Route, RouteContextLayer};
use tower_http::trace::TraceLayer;

use crate::{app::AppState, endpoints, pages, static_assets};

pub fn router(state: AppState) -> Router {
    let (router, metadata) = router_from_spec(vec![
        // proa:route-specs:start
        Route::endpoint("/", get(pages::home::handler)),
        // proa:route-specs:end
    ]);
    let manifest = Arc::new(IslandManifest {
        islands: HashMap::new(),
        assets: Default::default(),
        import_map: HashMap::new(),
        ssr_bundle: None,
    });
    router
        .route("/health", get(endpoints::health::live))
        .route("/readyz", get(endpoints::health::ready))
        // proa:explicit-routes:start
        .route("/index.md", get(pages::home::markdown))
        // proa:explicit-routes:end
        .nest_service("/static", static_assets::service())
        .with_state(state)
        .layer(RouteContextLayer::new(manifest, metadata))
        .layer(TraceLayer::new_for_http())
}
