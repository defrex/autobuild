//! Public OAuth boundary; never routed through browser-cookie or machine admission.
use super::{
    store, tokens,
    types::{self, Client, Grant},
};
use crate::{app::AppState, auth::Viewer};
use axum::{
    body::to_bytes,
    extract::Request,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use subtle::ConstantTimeEq;

pub fn is_public_path(path: &str) -> bool {
    matches!(
        path,
        "/.well-known/oauth-protected-resource"
            | "/.well-known/oauth-authorization-server"
            | "/api/auth/.well-known/oauth-protected-resource"
            | "/api/auth/.well-known/oauth-authorization-server"
            | "/api/auth/jwks"
            | "/api/auth/mcp/register"
            | "/api/auth/mcp/authorize"
            | "/api/auth/mcp/token"
            | "/api/auth/oauth2/consent"
            | "/oauth/resume"
    )
}
pub fn response(value: Value, status: u16) -> Response {
    let mut response = (StatusCode::from_u16(status).unwrap(), Json(value)).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("pragma", "no-cache".parse().unwrap());
    response
}
pub fn error(code: &str) -> Response {
    response(
        json!({"error":code}),
        if code == "temporarily_unavailable" {
            503
        } else {
            400
        },
    )
}
pub fn viewer(state: &AppState, headers: &HeaderMap) -> Option<Viewer> {
    let id = state.auth.read_cookie(headers, "proa-session")?;
    state
        .auth
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .filter(|s| {
            s.expires > state.auth.now()
                && (state.auth.allowed)().contains(&s.viewer.email.to_ascii_lowercase())
        })
        .map(|s| s.viewer.clone())
}
fn redirect(target: &str) -> Response {
    let mut response = response(Value::Null, 302);
    if let Ok(value) = target.parse() {
        response.headers_mut().insert("location", value);
    }
    response
}
pub fn origin(state: &AppState) -> String {
    state.auth.config.origin.origin().ascii_serialization()
}
pub fn same_origin(state: &AppState, headers: &HeaderMap, required: bool) -> bool {
    match headers.get("origin") {
        Some(value) => value.to_str().is_ok_and(|s| s == origin(state)),
        None => !required,
    }
}
fn callback(grant: &Grant, code: Option<&str>) -> String {
    let mut url = url::Url::parse(&grant.redirect).unwrap();
    if let Some(code) = code {
        url.query_pairs_mut().append_pair("code", code);
    } else {
        url.query_pairs_mut().append_pair("error", "access_denied");
    }
    if let Some(state) = &grant.state {
        url.query_pairs_mut().append_pair("state", state);
    }
    url.to_string()
}
fn issue_code(
    state: &AppState,
    document: &mut types::Document,
    mut grant: Grant,
    now: u64,
) -> String {
    let code = (state.auth.oauth_random)();
    grant.expires = now + 600;
    let uri = callback(&grant, Some(&code));
    document.codes.insert(tokens::digest(&code), grant);
    uri
}
fn params(bytes: &[u8]) -> Result<BTreeMap<String, String>, &'static str> {
    let mut result = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(bytes) {
        if result.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err("invalid_request");
        }
    }
    Ok(result)
}
fn field<'a>(input: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str, &'static str> {
    input.get(key).map(String::as_str).ok_or("invalid_request")
}

pub async fn handle(state: AppState, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").as_bytes().to_vec();
    let headers = request.headers().clone();
    let base = origin(&state);
    if method == "GET" && path.ends_with("/.well-known/oauth-protected-resource") {
        return response(
            json!({"resource":state.auth.config.mcp_resource.as_str(),"authorization_servers":[base],"bearer_methods_supported":["header"],"scopes_supported":["openid","profile","email","offline_access"]}),
            200,
        );
    }
    if method == "GET" && path.ends_with("/.well-known/oauth-authorization-server") {
        return response(
            json!({"issuer":base,"authorization_endpoint":format!("{base}/api/auth/mcp/authorize"),"token_endpoint":format!("{base}/api/auth/mcp/token"),"registration_endpoint":format!("{base}/api/auth/mcp/register"),"jwks_uri":format!("{base}/api/auth/jwks"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_basic","client_secret_post"],"scopes_supported":["openid","profile","email","offline_access"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["ES256"]}),
            200,
        );
    }
    let Some(writer) = state.writer.as_deref() else {
        return error("temporarily_unavailable");
    };
    if method == "GET" && path == "/api/auth/jwks" {
        return match store::update(writer, |d| {
            if d.key.is_none() {
                d.key = Some(tokens::generate(&state.auth.config.secret)?);
            }
            Ok(json!({"keys":[tokens::jwk(d.key.as_deref().unwrap(),&state.auth.config.secret)?]}))
        })
        .await
        {
            Ok(value) => response(value, 200),
            Err(e) => error(e),
        };
    }
    if method == "GET" && (path == "/api/auth/mcp/authorize" || path == "/oauth/resume") {
        let parsed = match params(&query) {
            Ok(p) => p,
            Err(e) => return error(e),
        };
        return match authorize(&state, parsed, &headers, path == "/oauth/resume").await {
            Ok(r) => r,
            Err(e) => error(e),
        };
    }
    if method != "POST" {
        return response(json!({"error":"method_not_allowed"}), 405);
    }
    if !same_origin(&state, &headers, false) {
        return response(json!({"error":"invalid_origin"}), 403);
    }
    let bytes = match to_bytes(request.into_body(), 65536).await {
        Ok(b) => b,
        Err(_) => return error("invalid_request"),
    };
    let result = match path.as_str() {
        "/api/auth/mcp/register" => match serde_json::from_slice(&bytes) {
            Ok(value) => register(&state, value).await,
            Err(_) => Err("invalid_client_metadata"),
        },
        "/api/auth/mcp/token" => {
            if !headers
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|v| v.starts_with("application/x-www-form-urlencoded"))
            {
                return error("invalid_request");
            }
            match params(&bytes) {
                Ok(mut p) => {
                    // This marker belongs to the HTTP adapter, never to form input.
                    p.remove("_basic");
                    if let Some(basic) = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.strip_prefix("Basic "))
                    {
                        use base64::Engine;
                        let decoded = base64::engine::general_purpose::STANDARD
                            .decode(basic)
                            .ok()
                            .and_then(|v| String::from_utf8(v).ok());
                        let Some((id, secret)) = decoded.as_deref().and_then(|v| v.split_once(':'))
                        else {
                            return error("invalid_client");
                        };
                        p.insert("client_id".into(), id.into());
                        p.insert("client_secret".into(), secret.into());
                        p.insert("_basic".into(), "true".into());
                    }
                    exchange(&state, p).await
                }
                Err(e) => Err(e),
            }
        }
        "/api/auth/oauth2/consent" => {
            let Some(user) = viewer(&state, &headers) else {
                return response(json!({"error":"unauthorized"}), 401);
            };
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => {
                    let Some(accept) = value["accept"].as_bool() else {
                        return error("invalid_request");
                    };
                    let Some(code) = value["consent_code"].as_str() else {
                        return error("invalid_request");
                    };
                    decide(&state, &user, code, accept)
                        .await
                        .map(|uri| json!({"redirectURI":uri}))
                }
                Err(_) => Err("invalid_request"),
            }
        }
        _ => Err("invalid_request"),
    };
    match result {
        Ok(value) => response(value, 200),
        Err(e) => error(e),
    }
}
async fn register(state: &AppState, value: Value) -> Result<Value, &'static str> {
    let redirects = value["redirect_uris"]
        .as_array()
        .ok_or("invalid_redirect_uri")?;
    if redirects.is_empty() || redirects.len() > 16 {
        return Err("invalid_redirect_uri");
    }
    let redirects: Vec<String> = redirects
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| s.len() <= 2048 && types::callback(s))
                .map(str::to_owned)
                .ok_or("invalid_redirect_uri")
        })
        .collect::<Result<_, _>>()?;
    let name = match value.get("client_name") {
        None => None,
        Some(Value::String(s)) => Some({
            types::client_name(s).map_err(|_| "invalid_client_metadata")?;
            s.clone()
        }),
        _ => return Err("invalid_client_metadata"),
    };
    if value
        .get("token_endpoint_auth_method")
        .is_some_and(|v| !v.is_string())
    {
        return Err("invalid_client_metadata");
    }
    let method = value["token_endpoint_auth_method"]
        .as_str()
        .unwrap_or("client_secret_basic");
    if !["none", "client_secret_basic", "client_secret_post"].contains(&method) {
        return Err("invalid_client_metadata");
    }
    if value
        .get("response_types")
        .is_some_and(|v| v != &json!(["code"]))
        || value.get("grant_types").is_some_and(|v| {
            !v.as_array().is_some_and(|a| {
                !a.is_empty()
                    && a.iter()
                        .all(|g| g == "authorization_code" || g == "refresh_token")
            })
        })
    {
        return Err("invalid_client_metadata");
    }
    let id = (state.auth.oauth_random)();
    let secret = (method != "none").then(|| (state.auth.oauth_random)());
    let client = Client {
        id: id.clone(),
        name: name.clone(),
        redirects: redirects.clone(),
        method: method.into(),
        secret: secret.as_deref().map(tokens::digest),
    };
    store::update(
        state.writer.as_deref().ok_or("temporarily_unavailable")?,
        |d| {
            if d.clients.len() >= 10000 {
                return Err("temporarily_unavailable");
            }
            d.clients.insert(id.clone(), client);
            Ok(())
        },
    )
    .await?;
    let mut result = json!({"client_id":id,"client_id_issued_at":state.auth.now(),"redirect_uris":redirects,"token_endpoint_auth_method":method,"grant_types":["authorization_code","refresh_token"],"response_types":["code"]});
    if let Some(name) = name {
        result["client_name"] = json!(name);
    }
    if let Some(secret) = secret {
        result["client_secret"] = json!(secret);
        result["client_secret_expires_at"] = json!(0);
    }
    Ok(result)
}
async fn authorize(
    state: &AppState,
    p: BTreeMap<String, String>,
    headers: &HeaderMap,
    resume: bool,
) -> Result<Response, &'static str> {
    let user = viewer(state, headers);
    let now = state.auth.now();
    store::update(
        state.writer.as_deref().ok_or("temporarily_unavailable")?,
        |d| {
            d.pending.retain(|_, g| g.expires > now);
            d.codes.retain(|_, g| g.expires > now);
            d.refresh.retain(|_, g| g.expires > now);
            d.access.retain(|_, g| g.expires > now);
            let (mut grant, prompt) = if resume {
                let key = tokens::digest(field(&p, "request")?);
                let grant = d
                    .pending
                    .remove(&key)
                    .filter(|g| g.email.is_empty())
                    .ok_or("invalid_request")?;
                {
                    let prompt = grant.consent;
                    (grant, prompt)
                }
            } else {
                if field(&p, "response_type")? != "code"
                    || field(&p, "code_challenge_method")? != "S256"
                {
                    return Err("invalid_request");
                }
                let client = d
                    .clients
                    .get(field(&p, "client_id")?)
                    .ok_or("invalid_client")?;
                let redirect = field(&p, "redirect_uri")?;
                if !client.redirects.iter().any(|s| s == redirect) {
                    return Err("invalid_redirect_uri");
                }
                let challenge = field(&p, "code_challenge")?;
                if challenge.len() != 43
                    || !challenge
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                {
                    return Err("invalid_request");
                }
                let resource = p
                    .get("resource")
                    .map(String::as_str)
                    .unwrap_or(state.auth.config.mcp_resource.as_str());
                if resource != state.auth.config.mcp_resource.as_str() {
                    return Err("invalid_target");
                }
                let scope = p.get("scope").map(String::as_str).unwrap_or("openid");
                if !scope
                    .split_whitespace()
                    .all(|s| ["openid", "profile", "email", "offline_access"].contains(&s))
                {
                    return Err("invalid_scope");
                }
                (
                    Grant {
                        client: client.id.clone(),
                        email: String::new(),
                        redirect: redirect.into(),
                        challenge: challenge.into(),
                        scope: scope.into(),
                        resource: resource.into(),
                        state: p.get("state").cloned(),
                        consent: p
                            .get("prompt")
                            .is_some_and(|s| s.split_whitespace().any(|s| s == "consent")),
                        expires: now + 600,
                    },
                    p.get("prompt")
                        .is_some_and(|s| s.split_whitespace().any(|s| s == "consent")),
                )
            };
            let Some(user) = &user else {
                let continuation = (state.auth.oauth_random)();
                d.pending.insert(tokens::digest(&continuation), grant);
                let path = format!("/oauth/resume?request={continuation}");
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("returnTo", &path)
                    .finish();
                return Ok(redirect(&format!("/sign-in?{query}")));
            };
            grant.email = user.email.to_ascii_lowercase();
            if !prompt {
                return Ok(redirect(&issue_code(state, d, grant, now)));
            }
            let code = (state.auth.oauth_random)();
            d.pending.insert(tokens::digest(&code), grant);
            Ok(redirect(&format!("/oauth/consent?consent_code={code}")))
        },
    )
    .await
}
pub async fn pending(
    state: &AppState,
    code: &str,
    user: &Viewer,
) -> Result<(Grant, Client), &'static str> {
    store::update(
        state.writer.as_deref().ok_or("temporarily_unavailable")?,
        |d| {
            let grant = d
                .pending
                .get(&tokens::digest(code))
                .filter(|g| {
                    g.expires > state.auth.now() && g.email == user.email.to_ascii_lowercase()
                })
                .ok_or("invalid_request")?;
            let client = d.clients.get(&grant.client).ok_or("invalid_client")?;
            Ok((grant.clone(), client.clone()))
        },
    )
    .await
}
pub async fn decide(
    state: &AppState,
    user: &Viewer,
    code: &str,
    accept: bool,
) -> Result<String, &'static str> {
    if !(state.auth.allowed)().contains(&user.email.to_ascii_lowercase()) {
        return Err("access_denied");
    }
    store::update(
        state.writer.as_deref().ok_or("temporarily_unavailable")?,
        |d| {
            let key = tokens::digest(code);
            let grant = d
                .pending
                .get(&key)
                .filter(|g| {
                    g.expires > state.auth.now() && g.email == user.email.to_ascii_lowercase()
                })
                .ok_or("invalid_request")?
                .clone();
            d.pending.remove(&key);
            Ok(if accept {
                issue_code(state, d, grant, state.auth.now())
            } else {
                callback(&grant, None)
            })
        },
    )
    .await
}
async fn exchange(state: &AppState, p: BTreeMap<String, String>) -> Result<Value, &'static str> {
    let now = state.auth.now();
    store::update(state.writer.as_deref().ok_or("temporarily_unavailable")?, |d| {
        let client = d.clients.get(field(&p,"client_id")?).ok_or("invalid_client")?;
        if client.method != "none" {
            if (client.method == "client_secret_basic") != p.contains_key("_basic") { return Err("invalid_client"); }
            let supplied = tokens::digest(field(&p,"client_secret")?);
            if !bool::from(supplied.as_bytes().ct_eq(client.secret.as_deref().unwrap_or("").as_bytes())) { return Err("invalid_client"); }
        }
        let refresh = field(&p,"grant_type")? == "refresh_token";
        if !refresh && field(&p,"grant_type")? != "authorization_code" { return Err("unsupported_grant_type"); }
        let key = tokens::digest(field(&p,if refresh {"refresh_token"} else {"code"})?);
        let mut grant = (if refresh {&d.refresh} else {&d.codes}).get(&key).filter(|g|g.expires>now && g.client==client.id).ok_or("invalid_grant")?.clone();
        if p.get("resource").is_some_and(|r|r != &grant.resource) || grant.resource != state.auth.config.mcp_resource.as_str() { return Err("invalid_target"); }
        if !(state.auth.allowed)().contains(&grant.email) { return Err("access_denied"); }
        if !refresh {
            let verifier = field(&p,"code_verifier")?;
            if field(&p,"redirect_uri")? != grant.redirect || !types::verifier(verifier) || !bool::from(tokens::digest(verifier).as_bytes().ct_eq(grant.challenge.as_bytes())) { return Err("invalid_grant"); }
        } else if let Some(scope) = p.get("scope") {
            if !scope.split_whitespace().all(|s|grant.scope.split_whitespace().any(|v|v==s)) { return Err("invalid_scope"); }
            grant.scope = scope.clone();
        }
        if d.key.is_none() { d.key = Some(tokens::generate(&state.auth.config.secret)?); }
        let signing = d.key.as_deref().unwrap();
        let claims = tokens::Claims {iss:origin(state),aud:grant.resource.clone(),sub:grant.email.clone(),exp:now+3600,iat:now,jti:(state.auth.oauth_random)(),client_id:grant.client.clone(),scope:grant.scope.clone()};
        let access = tokens::sign(signing,&state.auth.config.secret,&claims)?;
        let refresh_token = (state.auth.oauth_random)();
        let mut result = json!({"access_token":access,"token_type":"Bearer","expires_in":3600,"refresh_token":refresh_token,"scope":grant.scope});
        if grant.scope.split_whitespace().any(|s|s=="openid") {
            let id_claims = tokens::Claims {aud:grant.client.clone(),jti:(state.auth.oauth_random)(),..claims};
            result["id_token"] = json!(tokens::sign(signing,&state.auth.config.secret,&id_claims)?);
        }
        if refresh { d.refresh.remove(&key); } else { d.codes.remove(&key); }
        grant.expires=now+3600; d.access.insert(tokens::digest(&access),grant.clone());
        grant.expires=now+30*86400; d.refresh.insert(tokens::digest(&refresh_token),grant);
        Ok(result)
    }).await
}

pub async fn admit(state: &AppState, headers: &HeaderMap) -> Result<(String, String), u16> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(401u16)?;
    store::update(state.writer.as_deref().ok_or(401u16)?, |d| {
        let key = d.key.as_deref().ok_or("invalid_token")?;
        let claims = tokens::validate(
            token,
            key,
            &state.auth.config.secret,
            &origin(state),
            state.auth.config.mcp_resource.as_str(),
            state.auth.now(),
        )?;
        let grant = d
            .access
            .get(&tokens::digest(token))
            .filter(|g| {
                g.expires > state.auth.now()
                    && g.email == claims.sub
                    && g.client == claims.client_id
                    && g.resource == claims.aud
            })
            .ok_or("invalid_token")?;
        if !(state.auth.allowed)().contains(&grant.email) {
            return Err("access_denied");
        }
        let client = d.clients.get(&grant.client).ok_or("invalid_token")?;
        Ok((
            grant.email.clone(),
            client.name.clone().unwrap_or_else(|| client.id.clone()),
        ))
    })
    .await
    .map_err(|e| if e == "access_denied" { 403 } else { 401 })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> AppState {
        AppState {
            auth: std::sync::Arc::new(crate::auth::Auth::new(
                crate::config::Config::parse(|_| None).unwrap().auth,
            )),
            data: None,
            machine: None,
            writer: None,
            blobs: None,
            operator_secret: None,
        }
    }
    #[tokio::test]
    async fn discovery_is_public_and_unconfigured_token_storage_fails_closed() {
        let response = handle(
            state(),
            Request::builder()
                .uri("/.well-known/oauth-authorization-server")
                .header("host", "attacker.test")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), 200);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert_eq!(body["issuer"], "http://127.0.0.1:3000");
        let response = handle(
            state(),
            Request::builder()
                .method("POST")
                .uri("/api/auth/mcp/token")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), 503);
        assert!(response.headers().get("location").is_none());
    }
    #[test]
    fn browser_origin_is_independent_of_oauth_bearer_and_duplicate_parameters_fail() {
        let state = state();
        let mut headers = HeaderMap::new();
        assert!(same_origin(&state, &headers, false));
        assert!(!same_origin(&state, &headers, true));
        headers.insert("origin", "https://attacker.test".parse().unwrap());
        assert!(!same_origin(&state, &headers, false));
        headers.insert("origin", "http://127.0.0.1:3000".parse().unwrap());
        assert!(same_origin(&state, &headers, true));
        assert!(params(b"client_id=a&client_id=b").is_err());
        assert!(viewer(&state, &headers).is_none());
    }
}
