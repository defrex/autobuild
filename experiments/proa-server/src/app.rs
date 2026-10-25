use std::sync::Arc;
#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<crate::auth::Auth>,
}
