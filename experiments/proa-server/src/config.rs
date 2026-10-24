use anyhow::Context;
use std::net::{IpAddr, SocketAddr};

pub struct Config {
    pub address: SocketAddr,
}
impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();
        Self::parse(
            std::env::var("PROA_HOST").ok().as_deref(),
            std::env::var("PORT").ok().as_deref(),
        )
    }
    fn parse(host: Option<&str>, port: Option<&str>) -> anyhow::Result<Self> {
        let host: IpAddr = host
            .unwrap_or("127.0.0.1")
            .parse()
            .context("PROA_HOST must be an IP address")?;
        let port: u16 = port
            .unwrap_or("3000")
            .parse()
            .context("PORT must be an integer from 1 to 65535")?;
        anyhow::ensure!(port != 0, "PORT must be an integer from 1 to 65535");
        Ok(Self {
            address: SocketAddr::new(host, port),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_configuration() {
        assert_eq!(
            Config::parse(None, None).unwrap().address.to_string(),
            "127.0.0.1:3000"
        );
        assert_eq!(
            Config::parse(Some("::1"), Some("4567"))
                .unwrap()
                .address
                .to_string(),
            "[::1]:4567"
        );
        for port in ["", "abc", "0", "65536", "-1"] {
            assert!(Config::parse(None, Some(port)).is_err());
        }
        assert!(Config::parse(Some("invalid"), None).is_err());
    }
}
