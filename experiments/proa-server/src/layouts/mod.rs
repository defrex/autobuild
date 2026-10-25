mod root;

pub use root::RootDocument;

/// Shared browser policy. OAuth consent may navigate only to its validated callback origin.
pub fn browser_csp(callback_origin: Option<&str>) -> String {
    let callback = callback_origin
        .map(|origin| format!(" {origin}"))
        .unwrap_or_default();
    format!("default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'{callback}")
}
