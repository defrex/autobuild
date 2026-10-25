pub mod github;
pub mod return_path;
use crate::config::{emails, AuthConfig};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cookie::{Cookie, CookieJar, Key, SameSite};
use rand::RngCore;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
#[derive(Clone)]
pub struct Viewer {
    pub email: String,
    pub csrf: String,
}
pub struct Session {
    pub viewer: Viewer,
    pub expires: u64,
}
pub struct Transaction {
    pub binding: String,
    pub verifier: String,
    pub return_to: String,
    pub expires: u64,
}
pub type Allowlist = Arc<dyn Fn() -> Vec<String> + Send + Sync>;
pub struct Auth {
    pub config: AuthConfig,
    pub provider: Arc<dyn github::Provider>,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub transactions: Mutex<HashMap<String, Transaction>>,
    pub allowed: Allowlist,
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    key: Key,
}
impl Auth {
    pub fn new(config: AuthConfig) -> Self {
        let provider = Arc::new(github::Github::new(config.clone()));
        Self {
            key: Key::derive_from(config.secret.as_bytes()),
            config,
            provider,
            sessions: Mutex::new(HashMap::new()),
            transactions: Mutex::new(HashMap::new()),
            allowed: Arc::new(|| {
                std::env::var("AB_WEB_ALLOWED_EMAILS")
                    .ok()
                    .and_then(|s| emails(&s).ok())
                    .unwrap_or_default()
            }),
            clock: Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            }),
        }
    }
    pub fn now(&self) -> u64 {
        (self.clock)()
    }
    pub fn cookie(&self, name: &'static str, value: String, clear: bool) -> String {
        let mut jar = CookieJar::new();
        let mut cookie = Cookie::build((name, value))
            .path("/")
            .http_only(true)
            .same_site(SameSite::Lax)
            .secure(self.config.secure)
            .max_age(cookie::time::Duration::seconds(if clear {
                0
            } else if name == "proa-session" {
                28800
            } else {
                600
            }))
            .build();
        if clear {
            cookie.make_removal();
        }
        jar.signed_mut(&self.key).add(cookie);
        jar.delta().next().unwrap().to_string()
    }
    pub fn read_cookie(&self, headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
        let mut jar = CookieJar::new();
        for line in headers.get_all(axum::http::header::COOKIE) {
            for value in line.to_str().ok()?.split(';') {
                if let Ok(cookie) = Cookie::parse(value.trim().to_owned()) {
                    jar.add_original(cookie);
                }
            }
        }
        jar.signed(&self.key)
            .get(name)
            .map(|c| c.value().to_owned())
    }
    pub fn revoke(&self, headers: &axum::http::HeaderMap) {
        if let Some(id) = self.read_cookie(headers, "proa-session") {
            self.sessions.lock().unwrap().remove(&id);
        }
    }
    pub fn issue(&self, email: String) -> Option<(String, Viewer)> {
        if !(self.allowed)().contains(&email.to_ascii_lowercase()) {
            return None;
        }
        let now = self.now();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, s| s.expires > now);
        if sessions.len() >= 4096 {
            return None;
        }
        let viewer = Viewer {
            email,
            csrf: random(),
        };
        let id = random();
        sessions.insert(
            id.clone(),
            Session {
                viewer: viewer.clone(),
                expires: now + 28800,
            },
        );
        Some((self.cookie("proa-session", id, false), viewer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookie_integrity_expiry_capacity_and_revocation() {
        let mut auth = Auth::new(crate::config::Config::parse(|_| None).unwrap().auth);
        auth.clock = Arc::new(|| 100);
        auth.allowed = Arc::new(|| vec!["operator@example.com".into()]);
        let (cookie, _) = auth.issue("Operator@example.com".into()).unwrap();
        assert!(
            cookie.contains("HttpOnly")
                && cookie.contains("SameSite=Lax")
                && cookie.contains("Path=/")
        );
        assert!(!cookie.contains("Operator") && !cookie.contains("Secure"));
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("cookie", cookie.split(';').next().unwrap().parse().unwrap());
        let id = auth.read_cookie(&headers, "proa-session").unwrap();
        headers.insert("cookie", format!("proa-session={}x", id).parse().unwrap());
        assert!(auth.read_cookie(&headers, "proa-session").is_none());
        for n in 0..4095 {
            auth.sessions.lock().unwrap().insert(
                n.to_string(),
                Session {
                    viewer: Viewer {
                        email: "operator@example.com".into(),
                        csrf: random(),
                    },
                    expires: 101,
                },
            );
        }
        assert!(auth.issue("operator@example.com".into()).is_none());
        auth.clock = Arc::new(|| 101);
        assert!(auth.issue("operator@example.com".into()).is_some());
        assert_eq!(auth.sessions.lock().unwrap().len(), 2);
        auth.clock = Arc::new(|| 28901);
        assert!(auth.issue("operator@example.com".into()).is_some());
        assert_eq!(auth.sessions.lock().unwrap().len(), 1);
        auth.config.secure = true;
        assert!(auth
            .cookie("proa-session", random(), false)
            .contains("Secure"));
        assert!(auth.issue("unlisted@example.com".into()).is_none());
    }
}
