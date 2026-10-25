use anyhow::Context;
use std::net::{IpAddr, SocketAddr};
use url::Url;

#[derive(Clone)]
pub struct AuthConfig {
    pub origin: Url,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub secret: String,
    pub secure: bool,
    pub dev: Option<DevAuth>,
}
#[derive(Clone)]
pub struct DevAuth {
    pub email: String,
    pub capability: String,
}
pub struct Config {
    pub address: SocketAddr,
    pub auth: AuthConfig,
}
pub fn emails(value: &str) -> anyhow::Result<Vec<String>> {
    let values: Vec<_> = value
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .collect();
    anyhow::ensure!(
        !values.is_empty()
            && values.iter().all(|s| {
                let parts: Vec<_> = s.split('@').collect();
                parts.len() == 2
                    && !parts[0].is_empty()
                    && parts[1]
                        .rsplit_once('.')
                        .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
                    && !s.chars().any(|c| c.is_whitespace() || c.is_control())
            }),
        "AB_WEB_ALLOWED_EMAILS must contain email addresses"
    );
    Ok(values)
}
impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();
        Self::parse(|key| std::env::var(key).ok())
    }
    pub fn parse(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let host: IpAddr = get("PROA_HOST")
            .as_deref()
            .unwrap_or("127.0.0.1")
            .parse()
            .context("PROA_HOST must be an IP address")?;
        let port: u16 = get("PORT")
            .as_deref()
            .unwrap_or("3000")
            .parse()
            .context("invalid PORT")?;
        anyhow::ensure!(port != 0, "PORT must be nonzero");
        let address = SocketAddr::new(host, port);
        let origin_value = get("PROA_AUTH_URL");
        let origin = Url::parse(
            origin_value
                .as_deref()
                .unwrap_or(&format!("http://{address}")),
        )?;
        anyhow::ensure!(
            matches!(origin.scheme(), "http" | "https")
                && origin.host_str().is_some()
                && origin.username().is_empty()
                && origin.password().is_none()
                && origin.path() == "/"
                && origin.query().is_none()
                && origin.fragment().is_none(),
            "PROA_AUTH_URL must be an origin"
        );
        let client_id = get("GITHUB_CLIENT_ID");
        let client_secret = get("GITHUB_CLIENT_SECRET");
        let secret = get("PROA_SESSION_SECRET");
        let allowed = get("AB_WEB_ALLOWED_EMAILS");
        let dev_enabled = get("PROA_DEV_AUTH");
        anyhow::ensure!(
            dev_enabled
                .as_deref()
                .is_none_or(|s| s == "true" || s == "false"),
            "invalid PROA_DEV_AUTH"
        );
        let dev = if dev_enabled.as_deref() == Some("true") {
            anyhow::ensure!(
                host.is_loopback() && get("PROA_ENV").as_deref() == Some("development"),
                "development auth requires explicit development and loopback"
            );
            let email = get("PROA_DEV_AUTH_EMAIL")
                .context("missing development email")?
                .trim()
                .to_owned();
            anyhow::ensure!(
                emails(&email)?.len() == 1,
                "development identity must be one email"
            );
            let capability =
                get("PROA_DEV_AUTH_CAPABILITY").context("missing issuance capability")?;
            anyhow::ensure!(capability.len() >= 32, "issuance capability too short");
            Some(DevAuth { email, capability })
        } else {
            None
        };
        let real = client_id.is_some() || client_secret.is_some();
        if real {
            anyhow::ensure!(
                client_id.as_ref().is_some_and(|s| !s.is_empty())
                    && client_secret.as_ref().is_some_and(|s| !s.is_empty())
                    && origin_value.is_some()
                    && secret.is_some()
                    && allowed.is_some(),
                "incomplete GitHub auth configuration"
            );
        }
        if let Some(value) = &allowed {
            emails(value)?;
        }
        if let Some(value) = &secret {
            anyhow::ensure!(value.len() >= 32, "session secret too short");
        }
        if dev.is_some() {
            anyhow::ensure!(
                secret.is_some() && allowed.is_some(),
                "development auth needs secret and allowlist"
            );
        }
        if host.is_loopback() {
            anyhow::ensure!(
                origin
                    .host_str()
                    .and_then(|s| s.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                    == Some(host)
                    && origin.port_or_known_default() == Some(port),
                "local origin must match listener"
            );
        } else {
            anyhow::ensure!(
                real && origin.scheme() == "https",
                "non-loopback requires complete HTTPS auth"
            );
        }
        let secure = !host.is_loopback() || origin.scheme() == "https";
        Ok(Self {
            address,
            auth: AuthConfig {
                origin,
                client_id,
                client_secret,
                secret: secret.unwrap_or_else(crate::auth::random),
                secure,
                dev,
            },
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn parse(values: &[(&str, &str)]) -> anyhow::Result<Config> {
        Config::parse(|k| values.iter().find(|v| v.0 == k).map(|v| v.1.to_owned()))
    }
    #[test]
    fn configuration_fails_closed() {
        assert!(parse(&[]).is_ok());
        for host in ["0.0.0.0", "::", "192.0.2.1"] {
            assert!(parse(&[("PROA_HOST", host)]).is_err());
            assert!(parse(&[("PROA_HOST", host), ("PROA_DEV_AUTH", "true")]).is_err());
        }
        for pair in [
            ("GITHUB_CLIENT_ID", "id"),
            ("PROA_SESSION_SECRET", "short"),
            ("AB_WEB_ALLOWED_EMAILS", "bad"),
            ("PROA_DEV_AUTH", "true"),
            ("PROA_AUTH_URL", "https://evil.test/path"),
            ("PORT", "0"),
        ] {
            assert!(parse(&[pair]).is_err());
        }
        assert_eq!(
            emails(" A@Example.COM, b@example.com ").unwrap(),
            ["a@example.com", "b@example.com"]
        );
    }
    #[test]
    fn production_and_development_combinations() {
        let base = [
            ("PROA_HOST", "0.0.0.0"),
            ("PROA_AUTH_URL", "https://operator.example.com"),
            ("GITHUB_CLIENT_ID", "id"),
            ("GITHUB_CLIENT_SECRET", "secret"),
            ("PROA_SESSION_SECRET", "01234567890123456789012345678901"),
            ("AB_WEB_ALLOWED_EMAILS", "operator@example.com"),
        ];
        let production = parse(&base).unwrap();
        assert!(production.auth.secure);
        assert!(production.auth.dev.is_none());
        for remove in 1..base.len() {
            let incomplete: Vec<_> = base
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != remove)
                .map(|(_, p)| *p)
                .collect();
            assert!(parse(&incomplete).is_err());
        }
        let mut http = base.to_vec();
        http[1].1 = "http://operator.example.com";
        assert!(parse(&http).is_err());
        let mut ipv6 = base.to_vec();
        ipv6[0].1 = "::";
        assert!(parse(&ipv6).is_ok());
        let mut dev = base.to_vec();
        dev.extend([("PROA_ENV", "development"), ("PROA_DEV_AUTH", "true")]);
        assert!(parse(&dev).is_err());
        assert_eq!(
            parse(&[("PROA_HOST", "::1"), ("PORT", "4567")])
                .unwrap()
                .address
                .to_string(),
            "[::1]:4567"
        );
        assert!(parse(&[("PROA_AUTH_URL", "http://127.0.0.1:3001")]).is_err());
        assert!(parse(&[("PROA_AUTH_URL", "http://user:pass@127.0.0.1:3000")]).is_err());
        assert!(parse(&[("PROA_DEV_AUTH", "yes")]).is_err());
    }
}
