use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Document {
    pub clients: BTreeMap<String, Client>,
    pub pending: BTreeMap<String, Grant>,
    pub codes: BTreeMap<String, Grant>,
    pub refresh: BTreeMap<String, Grant>,
    pub access: BTreeMap<String, Grant>,
    pub key: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Client {
    pub id: String,
    pub name: Option<String>,
    pub redirects: Vec<String>,
    pub method: String,
    pub secret: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Grant {
    pub client: String,
    pub email: String,
    pub redirect: String,
    pub challenge: String,
    pub scope: String,
    pub resource: String,
    pub state: Option<String>,
    #[serde(default)]
    pub consent: bool,
    pub expires: u64,
}

pub fn client_name(value: &str) -> Result<String, String> {
    let value = value.trim_matches(crate::operator::auth::js_space);
    if value.is_empty() {
        return Err("client_name must not be empty".into());
    }
    if value.chars().count() > 64 {
        return Err("client_name must be at most 64 characters".into());
    }
    if let Some(c) = value.chars().find(|c| matches!(*c as u32, 0..=31 | 127..=159 | 0x200b..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069 | 0xfeff)) {
        return Err(format!("client_name must not contain control or invisible formatting characters (found U+{:04X})", c as u32));
    }
    Ok(value.into())
}
pub fn callback(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && url.host_str().is_some_and(|host| {
                    host == "localhost"
                        || host
                            .trim_matches(['[', ']'])
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|ip| ip.is_loopback())
                })))
}
pub fn verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_client_metadata() {
        assert_eq!(client_name("  client  ").unwrap(), "client");
        for name in ["", "  ", "a\u{200b}b", "a\nname", "a\u{0085}b"] {
            assert!(client_name(name).is_err());
        }
        assert!(client_name(&"a".repeat(65)).is_err());
        assert!(client_name("<script>alert(1)</script>").is_ok());
        for uri in [
            "https://claude.ai/api/mcp/auth_callback",
            "http://127.0.0.1:1234/callback",
            "http://[::1]:1234/callback",
        ] {
            assert!(callback(uri));
        }
        for uri in [
            "https://a.test/#x",
            "https://user@a.test/",
            "http://evil.test/",
            "javascript:alert(1)",
            "//evil.test/",
        ] {
            assert!(!callback(uri));
        }
        assert!(verifier(&"a".repeat(43)));
        assert!(verifier(&"a".repeat(128)));
        assert!(!verifier(&"a".repeat(129)));
        assert!(!verifier(&"+".repeat(43)));
    }
}
