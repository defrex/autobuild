use tower_http::services::ServeDir;

pub fn service() -> ServeDir {
    ServeDir::new("public").append_index_html_on_directories(false)
}
