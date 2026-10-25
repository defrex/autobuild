use crate::config::AuthConfig;
use serde::Deserialize;
use std::{future::Future, pin::Pin, time::Duration};

#[derive(Clone, Deserialize)]
pub struct Email {
    pub email: String,
    pub verified: bool,
    pub primary: bool,
}
pub type ProviderResult = Pin<Box<dyn Future<Output = Result<Vec<Email>, ()>> + Send>>;
pub trait Provider: Send + Sync {
    fn emails(&self, code: String, verifier: String) -> ProviderResult;
}
pub struct Github {
    config: AuthConfig,
    client: reqwest::Client,
    token_url: String,
    email_url: String,
}
impl Github {
    pub fn new(config: AuthConfig) -> Self {
        Self {
            config,
            token_url: "https://github.com/login/oauth/access_token".into(),
            email_url: "https://api.github.com/user/emails".into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("proa-server")
                .build()
                .expect("HTTP client"),
        }
    }
}
async fn json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, ()> {
    let mut response = response.error_for_status().map_err(|_| ())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}
impl Provider for Github {
    fn emails(&self, code: String, verifier: String) -> ProviderResult {
        let config = self.config.clone();
        let token_url = self.token_url.clone();
        let email_url = self.email_url.clone();
        let client = self.client.clone();
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Token {
                access_token: Option<String>,
                token_type: Option<String>,
                error: Option<String>,
            }
            let token: Token = json(
                client
                    .post(&token_url)
                    .header("Accept", "application/json")
                    .form(&[
                        ("client_id", config.client_id.as_deref().ok_or(())?),
                        ("client_secret", config.client_secret.as_deref().ok_or(())?),
                        ("code", &code),
                        ("code_verifier", &verifier),
                        (
                            "redirect_uri",
                            config
                                .origin
                                .join("/auth/github/callback")
                                .map_err(|_| ())?
                                .as_str(),
                        ),
                    ])
                    .send()
                    .await
                    .map_err(|_| ())?,
            )
            .await?;
            if token.error.is_some()
                || !token
                    .token_type
                    .is_some_and(|v| v.eq_ignore_ascii_case("bearer"))
            {
                return Err(());
            }
            let token = token.access_token.filter(|s| !s.is_empty()).ok_or(())?;
            let mut emails = Vec::new();
            for page in 1..=10 {
                let records: Vec<Email> = json(
                    client
                        .get(&email_url)
                        .query(&[("per_page", 100), ("page", page)])
                        .header("Accept", "application/vnd.github+json")
                        .header("X-GitHub-Api-Version", "2022-11-28")
                        .bearer_auth(&token)
                        .send()
                        .await
                        .map_err(|_| ())?,
                )
                .await?;
                let done = records.len() < 100;
                emails.extend(records);
                if done {
                    return Ok(emails);
                }
            }
            Err(())
        })
    }
}
pub fn select(records: &[Email], allowed: &[String]) -> Option<String> {
    let mut records: Vec<_> = records
        .iter()
        .filter(|e| e.verified && allowed.contains(&e.email.to_ascii_lowercase()))
        .collect();
    records.sort_by_key(|e| (!e.primary, e.email.to_ascii_lowercase()));
    records.first().map(|e| e.email.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::Query,
        http::HeaderMap,
        routing::{get, post},
        Form, Json, Router,
    };
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    #[test]
    fn verified_allowlist_selection_is_deterministic() {
        let emails = vec![
            Email {
                email: "z@example.com".into(),
                verified: true,
                primary: true,
            },
            Email {
                email: "a@example.com".into(),
                verified: true,
                primary: false,
            },
            Email {
                email: "bad@example.com".into(),
                verified: false,
                primary: true,
            },
        ];
        assert_eq!(
            select(&emails, &["a@example.com".into(), "z@example.com".into()]).unwrap(),
            "z@example.com"
        );
        assert_eq!(
            select(&emails, &["a@example.com".into()]).unwrap(),
            "a@example.com"
        );
        assert!(select(&emails, &["bad@example.com".into()]).is_none());
        assert!(select(&[], &["a@example.com".into()]).is_none());
    }
    #[tokio::test]
    async fn adapter_uses_documented_wire_shapes_and_pagination() {
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let router = Router::new().route("/token", post(|headers: HeaderMap, Form(form): Form<HashMap<String,String>>| async move {
            assert_eq!(headers["accept"], "application/json");
            assert_eq!(form["client_id"], "id");
            assert_eq!(form["client_secret"], "secret");
            assert_eq!(form["code"], "code");
            assert_eq!(form["code_verifier"], "verifier");
            assert_eq!(form["redirect_uri"], "http://127.0.0.1:3000/auth/github/callback");
            Json(serde_json::json!({"access_token":"test-token","token_type":"bearer","scope":"user:email"}))
        })).route("/emails", get(move |headers: HeaderMap, Query(query): Query<HashMap<String,String>>| {
            let count = count.clone();
            async move {
                assert_eq!(headers["authorization"], "Bearer test-token");
                assert_eq!(headers["accept"], "application/vnd.github+json");
                assert_eq!(query["per_page"], "100");
                let n = count.fetch_add(1, Ordering::SeqCst);
                assert_eq!(query["page"], (n+1).to_string());
                Json(vec![serde_json::json!({"email":"operator@example.com","verified":true,"primary":true,"visibility":null}); if n==0 {100} else {1}])
            }
        })).route("/error", post(|| async { Json(serde_json::json!({"error":"bad_verification_code"})) }))
            .route("/malformed", post(|| async { "not-json" }))
            .route("/missing", post(|| async { Json(serde_json::json!({"token_type":"bearer"})) }))
            .route("/redirect", post(|| async { axum::response::Redirect::temporary("https://example.invalid/") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut config = crate::config::Config::parse(|_| None).unwrap().auth;
        config.client_id = Some("id".into());
        config.client_secret = Some("secret".into());
        let mut provider = Github::new(config);
        provider.token_url = format!("{origin}/token");
        provider.email_url = format!("{origin}/emails");
        assert_eq!(
            provider
                .emails("code".into(), "verifier".into())
                .await
                .unwrap()
                .len(),
            101
        );
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        for path in ["error", "malformed", "missing", "redirect"] {
            provider.token_url = format!("{origin}/{path}");
            assert!(provider
                .emails("code".into(), "verifier".into())
                .await
                .is_err());
        }
        task.abort();
    }
}
