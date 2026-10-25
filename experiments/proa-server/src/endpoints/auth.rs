use crate::{
    app::AppState,
    auth::{self, return_path, Transaction, Viewer},
    pages::sign_in,
};
use axum::{
    extract::{ConnectInfo, OriginalUri, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
    Extension, Form,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::net::SocketAddr;

fn set_cookie(response: &mut Response, cookie: String) {
    response
        .headers_mut()
        .append(header::SET_COOKIE, cookie.parse().expect("cookie"));
}
fn clear(response: &mut Response, state: &AppState) {
    set_cookie(
        response,
        state.auth.cookie("proa-session", String::new(), true),
    );
    set_cookie(
        response,
        state.auth.cookie("proa-oauth", String::new(), true),
    );
}
fn refused(state: &AppState, headers: &HeaderMap, email: Option<String>) -> Response {
    state.auth.revoke(headers);
    let mut response = sign_in::response(email, true, state.auth.config.client_id.is_some(), "/");
    *response.status_mut() = StatusCode::FORBIDDEN;
    clear(&mut response, state);
    response
}
#[derive(Default, Deserialize)]
pub struct ReturnQuery {
    #[serde(rename = "returnTo")]
    return_to: Option<String>,
}
pub async fn sign_in(State(state): State<AppState>, Query(query): Query<ReturnQuery>) -> Response {
    let path = return_path::validate(
        query.return_to.as_deref().unwrap_or("/"),
        &state.auth.config.origin,
    );
    sign_in::response(None, false, state.auth.config.client_id.is_some(), &path)
}
pub async fn initiate(
    State(state): State<AppState>,
    Query(query): Query<ReturnQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(client_id) = &state.auth.config.client_id else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let now = state.auth.now();
    let id = auth::random();
    let binding = auth::random();
    let verifier = auth::random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut transactions = state.auth.transactions.lock().unwrap();
    transactions.retain(|_, t| t.expires > now);
    if transactions.len() >= 4096 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if let Some(old) = state.auth.read_cookie(&headers, "proa-oauth") {
        transactions.retain(|_, t| t.binding != old);
    }
    transactions.insert(
        id.clone(),
        Transaction {
            binding: binding.clone(),
            verifier,
            return_to: return_path::validate(
                query.return_to.as_deref().unwrap_or("/"),
                &state.auth.config.origin,
            ),
            expires: now + 600,
        },
    );
    drop(transactions);
    let mut url = url::Url::parse("https://github.com/login/oauth/authorize").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id.as_str()),
        (
            "redirect_uri",
            state
                .auth
                .config
                .origin
                .join("/auth/github/callback")
                .unwrap()
                .as_str(),
        ),
        ("scope", "user:email"),
        ("state", id.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ]);
    let mut response = Redirect::temporary(url.as_str()).into_response();
    set_cookie(
        &mut response,
        state.auth.cookie("proa-oauth", binding, false),
    );
    response
}
#[derive(Deserialize)]
pub struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Response {
    let transaction = query
        .state
        .and_then(|id| state.auth.transactions.lock().unwrap().remove(&id));
    let Some(transaction) = transaction else {
        return refused(&state, &headers, None);
    };
    if transaction.expires <= state.auth.now()
        || state.auth.read_cookie(&headers, "proa-oauth").as_deref()
            != Some(transaction.binding.as_str())
        || query.error.is_some()
    {
        return refused(&state, &headers, None);
    }
    let Some(code) = query.code.filter(|s| !s.is_empty() && s.len() < 4096) else {
        return refused(&state, &headers, None);
    };
    let Ok(records) = state.auth.provider.emails(code, transaction.verifier).await else {
        return refused(&state, &headers, None);
    };
    let Some(email) = auth::github::select(&records, &(state.auth.allowed)()) else {
        let actual = records
            .iter()
            .find(|e| e.primary)
            .or(records.first())
            .map(|e| e.email.clone());
        return refused(&state, &headers, actual);
    };
    state.auth.revoke(&headers);
    let Some((cookie, _)) = state.auth.issue(email) else {
        return refused(&state, &headers, None);
    };
    let path = return_path::validate(&transaction.return_to, &state.auth.config.origin);
    let mut response = Redirect::to(&path).into_response();
    clear(&mut response, &state);
    set_cookie(&mut response, cookie);
    response
}
pub fn same_origin(headers: &HeaderMap, state: &AppState) -> bool {
    let origin = &state.auth.config.origin;
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v != "same-origin" && v != "none")
    {
        return false;
    }
    if let Some(value) = headers.get(header::ORIGIN) {
        return value.to_str().ok() == Some(origin.origin().ascii_serialization().as_str());
    }
    headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| url::Url::parse(v).ok())
        .is_some_and(|v| v.origin() == origin.origin())
}
#[derive(Deserialize)]
pub struct Logout {
    csrf: String,
}
pub async fn sign_out(
    State(state): State<AppState>,
    Extension(viewer): Extension<Viewer>,
    headers: HeaderMap,
    Form(form): Form<Logout>,
) -> Response {
    if !same_origin(&headers, &state) || form.csrf != viewer.csrf {
        return StatusCode::FORBIDDEN.into_response();
    }
    state.auth.revoke(&headers);
    let mut response = Redirect::to("/sign-in").into_response();
    clear(&mut response, &state);
    response
}
pub async fn dev_session(
    State(state): State<AppState>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
) -> Response {
    let Some(dev) = &state.auth.config.dev else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !peer.is_some_and(|p| p.0.ip().is_loopback())
        || headers
            .get("x-proa-dev-capability")
            .and_then(|h| h.to_str().ok())
            != Some(dev.capability.as_str())
        || headers.get(header::ORIGIN).is_some() && !same_origin(&headers, &state)
        || headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site" || v == "same-site")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    state.auth.revoke(&headers);
    let Some((cookie, _)) = state.auth.issue(dev.email.clone()) else {
        return refused(&state, &headers, Some(dev.email.clone()));
    };
    let mut response = Redirect::to("/").into_response();
    clear(&mut response, &state);
    set_cookie(&mut response, cookie);
    response
}
pub async fn gateway(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    mut request: Request,
    next: Next,
) -> Response {
    let path = uri.path();
    let public = matches!(
        path,
        "/health" | "/readyz" | "/sign-in" | "/auth/github" | "/auth/github/callback"
    ) || path.starts_with("/static/")
        || path == "/auth/dev-session" && state.auth.config.dev.is_some();
    if public || path.starts_with("/operator/v1/") || path == "/credentials/delegate" {
        next.run(request).await
    } else {
        let id = state.auth.read_cookie(request.headers(), "proa-session");
        let session = {
            let mut sessions = state.auth.sessions.lock().unwrap();
            sessions.retain(|_, s| s.expires > state.auth.now());
            id.as_ref()
                .and_then(|id| sessions.get(id))
                .map(|s| s.viewer.clone())
        };
        if let Some(viewer) = session {
            if !(state.auth.allowed)().contains(&viewer.email.to_ascii_lowercase()) {
                refused(&state, request.headers(), Some(viewer.email))
            } else {
                request.extensions_mut().insert(viewer);
                next.run(request).await
            }
        } else {
            let mut url = state.auth.config.origin.join("/sign-in").unwrap();
            url.query_pairs_mut().append_pair(
                "returnTo",
                &return_path::validate(&uri.to_string(), &state.auth.config.origin),
            );
            let target = format!("{}?{}", url.path(), url.query().unwrap());
            Redirect::temporary(&target).into_response()
        }
    }
}

pub async fn privacy(request: Request, next: Next) -> Response {
    // no-referrer can make a browser's same-origin form POST send Origin: null.
    // OAuth pages have no unsafe forms; authenticated forms retain their Origin proof.
    let oauth = request.uri().path().starts_with("/auth/") || request.uri().path() == "/sign-in";
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static(if oauth { "no-referrer" } else { "same-origin" }),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::{
            github::{Email, Provider, ProviderResult},
            Auth,
        },
        config::Config,
        routes,
    };
    use axum::{body::Body, http::Request as HttpRequest};
    use http_body_util::BodyExt;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;
    struct Mock(Vec<Email>);
    impl Provider for Mock {
        fn emails(&self, code: String, verifier: String) -> ProviderResult {
            assert_eq!(code, "code");
            assert!(!verifier.is_empty());
            let records = self.0.clone();
            Box::pin(async move { Ok(records) })
        }
    }
    fn setup() -> (AppState, Arc<Mutex<Vec<String>>>) {
        let config = Config::parse(|key| match key {
            "PROA_ENV" => Some("development".into()),
            "PROA_DEV_AUTH" => Some("true".into()),
            "PROA_DEV_AUTH_EMAIL" => Some("Operator@Example.com".into()),
            "PROA_DEV_AUTH_CAPABILITY" | "PROA_SESSION_SECRET" => Some("s".repeat(40)),
            "GITHUB_CLIENT_ID" => Some("client-id".into()),
            "GITHUB_CLIENT_SECRET" => Some("client-secret".into()),
            "PROA_AUTH_URL" => Some("http://127.0.0.1:3000".into()),
            "AB_WEB_ALLOWED_EMAILS" => Some("operator@example.com".into()),
            _ => None,
        })
        .unwrap();
        let mut auth = Auth::new(config.auth);
        let list = Arc::new(Mutex::new(vec!["operator@example.com".to_owned()]));
        let source = list.clone();
        auth.allowed = Arc::new(move || source.lock().unwrap().clone());
        auth.clock = Arc::new(|| 100);
        auth.provider = Arc::new(Mock(vec![Email {
            email: "Operator@Example.com".into(),
            verified: true,
            primary: true,
        }]));
        (
            AppState {
                auth: Arc::new(auth),
                data: None,
                writer: None,
                blobs: None,
                operator_secret: None,
            },
            list,
        )
    }
    async fn call(state: &AppState, uri: &str, cookie: &str) -> Response {
        routes::router(state.clone())
            .oneshot(
                HttpRequest::builder()
                    .uri(uri)
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    fn cookie(response: &Response, name: &str) -> String {
        response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|c| c.to_str().ok())
            .find(|s| s.starts_with(name) && !s.contains("Max-Age=0"))
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }
    async fn text(response: Response) -> String {
        String::from_utf8(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn gateway_protects_every_representation_and_unknown_paths() {
        let (state, _) = setup();
        for path in ["/", "/index.md", "/unknown?x=y"] {
            let response = call(&state, path, "").await;
            assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
            assert!(response.headers()[header::LOCATION]
                .to_str()
                .unwrap()
                .starts_with("/sign-in?returnTo="));
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(response
                .headers()
                .contains_key(header::CONTENT_SECURITY_POLICY));
        }
        for path in ["/health", "/readyz", "/sign-in"] {
            assert_eq!(call(&state, path, "").await.status(), StatusCode::OK);
        }
        let response = call(&state, "/sign-in?email=forged@example.com", "").await;
        assert!(!text(response).await.contains("forged@example.com"));
    }
    #[tokio::test]
    async fn full_oauth_flow_is_bound_single_use_and_allowlist_is_live() {
        let (state, allowed) = setup();
        let response = call(&state, "/auth/github?returnTo=%2Findex.md%3Fx%3Dy", "").await;
        let binding = cookie(&response, "proa-oauth");
        let location =
            url::Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let query: std::collections::HashMap<_, _> = location.query_pairs().into_owned().collect();
        assert_eq!(query["scope"], "user:email");
        assert_eq!(query["code_challenge_method"], "S256");
        assert!(!location.as_str().contains("client-secret"));
        let callback = format!("/auth/github/callback?state={}&code=code", query["state"]);
        let response = call(&state, &callback, &binding).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()[header::LOCATION], "/index.md?x=y");
        let session = cookie(&response, "proa-session");
        assert!(!session.contains("Operator"));
        let protected = call(&state, "/", &session).await;
        assert_eq!(protected.status(), StatusCode::OK);
        assert_eq!(protected.headers()[header::REFERRER_POLICY], "same-origin");
        assert_eq!(
            call(&state, &callback, &binding).await.status(),
            StatusCode::FORBIDDEN
        );
        // Replay revokes only a presented session, not an unrelated one.
        allowed.lock().unwrap().clear();
        let response = call(&state, "/", &session).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(text(response).await.contains("Operator@Example.com"));
        allowed.lock().unwrap().push("operator@example.com".into());
        assert_eq!(
            call(&state, "/", &session).await.status(),
            StatusCode::TEMPORARY_REDIRECT
        );
    }
    #[tokio::test]
    async fn callback_mismatch_expiry_and_missing_state_fail_closed() {
        let (state, _) = setup();
        for mode in ["binding", "expired", "missing"] {
            let response = call(&state, "/auth/github", "").await;
            let binding = cookie(&response, "proa-oauth");
            let id = state
                .auth
                .transactions
                .lock()
                .unwrap()
                .keys()
                .next()
                .unwrap()
                .clone();
            if mode == "expired" {
                state
                    .auth
                    .transactions
                    .lock()
                    .unwrap()
                    .get_mut(&id)
                    .unwrap()
                    .expires = 99;
            }
            let path = if mode == "missing" {
                "/auth/github/callback?code=code".into()
            } else {
                format!("/auth/github/callback?code=code&state={id}")
            };
            assert_eq!(
                call(&state, &path, if mode == "binding" { "" } else { &binding })
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
            assert!(state.auth.sessions.lock().unwrap().is_empty());
        }
    }
    #[tokio::test]
    async fn logout_requires_origin_and_session_token_and_revokes_copied_cookie() {
        let (state, _) = setup();
        let (session, viewer) = state.auth.issue("operator@example.com".into()).unwrap();
        for (origin, token, status) in [
            ("", viewer.csrf.as_str(), StatusCode::FORBIDDEN),
            (
                "https://evil.test",
                viewer.csrf.as_str(),
                StatusCode::FORBIDDEN,
            ),
            ("http://127.0.0.1:3000", "bad", StatusCode::FORBIDDEN),
            (
                "http://127.0.0.1:3000",
                viewer.csrf.as_str(),
                StatusCode::SEE_OTHER,
            ),
        ] {
            let response = routes::router(state.clone())
                .oneshot(
                    HttpRequest::builder()
                        .method("POST")
                        .uri("/auth/sign-out")
                        .header(header::COOKIE, session.split(';').next().unwrap())
                        .header(header::ORIGIN, origin)
                        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                        .body(Body::from(format!("csrf={token}")))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
        assert_eq!(
            call(&state, "/", &session).await.status(),
            StatusCode::TEMPORARY_REDIRECT
        );
    }
    #[tokio::test]
    async fn issuer_requires_real_peer_capability_and_same_origin() {
        let (state, allowed) = setup();
        for (peer, capability, origin, status) in [
            (None, "s".repeat(40), "", StatusCode::FORBIDDEN),
            (
                Some("192.0.2.1:1234"),
                "s".repeat(40),
                "",
                StatusCode::FORBIDDEN,
            ),
            (
                Some("127.0.0.1:1234"),
                "bad".into(),
                "",
                StatusCode::FORBIDDEN,
            ),
            (
                Some("127.0.0.1:1234"),
                "s".repeat(40),
                "https://evil.test",
                StatusCode::FORBIDDEN,
            ),
            (
                Some("127.0.0.1:1234"),
                "s".repeat(40),
                "http://127.0.0.1:3000",
                StatusCode::SEE_OTHER,
            ),
        ] {
            let mut request = HttpRequest::builder()
                .method("POST")
                .uri("/auth/dev-session")
                .header("x-proa-dev-capability", capability)
                .header("X-Forwarded-For", "127.0.0.1");
            if !origin.is_empty() {
                request = request.header(header::ORIGIN, origin);
            }
            let mut request = request.body(Body::empty()).unwrap();
            if let Some(peer) = peer {
                request
                    .extensions_mut()
                    .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
            }
            let response = routes::router(state.clone())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
        allowed.lock().unwrap().clear();
        let mut request = HttpRequest::builder()
            .method("POST")
            .uri("/auth/dev-session")
            .header("x-proa-dev-capability", "s".repeat(40))
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("127.0.0.1:1234".parse::<SocketAddr>().unwrap()));
        let response = routes::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(text(response)
            .await
            .contains("You're not in an organization yet."));
    }
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    use crate::{
        auth::{
            github::{Email, Provider, ProviderResult},
            Auth,
        },
        config::Config,
        routes,
    };
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;
    struct Refusing(bool);
    impl Provider for Refusing {
        fn emails(&self, _: String, _: String) -> ProviderResult {
            let error = self.0;
            Box::pin(async move {
                if error {
                    Err(())
                } else {
                    Ok(vec![Email {
                        email: "<attacker>@example.com".into(),
                        verified: false,
                        primary: true,
                    }])
                }
            })
        }
    }
    #[tokio::test]
    async fn failed_admission_clears_previous_session_and_escapes_provider_identity() {
        for error in [false, true] {
            let mut auth = Auth::new(Config::parse(|_| None).unwrap().auth);
            auth.allowed = Arc::new(|| vec!["operator@example.com".into()]);
            auth.provider = Arc::new(Refusing(error));
            let (cookie, _) = auth.issue("operator@example.com".into()).unwrap();
            auth.transactions.lock().unwrap().insert(
                "state".into(),
                Transaction {
                    binding: "binding".into(),
                    verifier: "verifier".into(),
                    return_to: "/".into(),
                    expires: auth.now() + 600,
                },
            );
            let cookies = format!(
                "{}; {}",
                cookie.split(';').next().unwrap(),
                auth.cookie("proa-oauth", "binding".into(), false)
                    .split(';')
                    .next()
                    .unwrap()
            );
            let state = AppState {
                auth: Arc::new(auth),
                data: None,
                writer: None,
                blobs: None,
                operator_secret: None,
            };
            let response = routes::router(state.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/auth/github/callback?state=state&code=code")
                        .header(header::COOKIE, cookies)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
            assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("form-action 'self'"));
            let body = String::from_utf8(
                response
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .to_vec(),
            )
            .unwrap();
            assert!(!body.contains("<attacker>"));
            if !error {
                assert!(body.contains("&lt;attacker&gt;"));
            }
            assert!(state.auth.sessions.lock().unwrap().is_empty());
        }
    }
}
