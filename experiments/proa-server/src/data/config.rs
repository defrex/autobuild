//! Environment contract shared with the TypeScript PostgreSQL adapter.
//! Secrets deliberately have no Debug implementation.
use std::collections::HashMap;

pub struct DataConfig {
    pub database_url: String,
    pub blobs: BlobConfig,
    pub prefix: String,
}

#[derive(Clone)]
pub enum BlobConfig {
    S3 {
        bucket: String,
        region: String,
        access_key_id: String,
        secret_access_key: String,
        endpoint: Option<String>,
        session_token: Option<String>,
        force_path_style: Option<bool>,
    },
    Vercel {
        access: String,
        auth: VercelAuth,
    },
}

#[derive(Clone)]
pub enum VercelAuth {
    Token(String),
    Oidc { token: String, store_id: String },
}

impl DataConfig {
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::parse(&std::env::vars().collect())
    }

    pub fn parse(env: &HashMap<String, String>) -> Result<Option<Self>, String> {
        let optional = |name: &str| {
            env.get(name)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let required = |name: &str| {
            optional(name).ok_or_else(|| format!("{name} is required and must be nonblank"))
        };
        let database_url = optional("AB_POSTGRES_URL").or_else(|| optional("DATABASE_URL"));
        let Some(database_url) = database_url else {
            if env.keys().any(|name| {
                (name.starts_with("AB_BLOB_")
                    || name.starts_with("AB_S3_")
                    || name.starts_with("AB_VERCEL_BLOB_")
                    || matches!(
                        name.as_str(),
                        "BLOB_READ_WRITE_TOKEN" | "VERCEL_OIDC_TOKEN" | "BLOB_STORE_ID"
                    ))
                    && optional(name).is_some()
            }) {
                return Err(
                    "AB_POSTGRES_URL or DATABASE_URL is required and must be nonblank".into(),
                );
            }
            return Ok(None);
        };
        let prefix = optional("AB_BLOB_PREFIX")
            .unwrap_or_default()
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        let blobs = match required("AB_BLOB_BACKEND")?.as_str() {
            "s3" => BlobConfig::S3 {
                bucket: required("AB_S3_BUCKET")?,
                region: required("AB_S3_REGION")?,
                access_key_id: required("AB_S3_ACCESS_KEY_ID")?,
                secret_access_key: required("AB_S3_SECRET_ACCESS_KEY")?,
                endpoint: optional("AB_S3_ENDPOINT"),
                session_token: optional("AB_S3_SESSION_TOKEN"),
                force_path_style: match optional("AB_S3_FORCE_PATH_STYLE").as_deref() {
                    None => None,
                    Some("true") => Some(true),
                    Some("false") => Some(false),
                    _ => return Err("AB_S3_FORCE_PATH_STYLE must be \"true\" or \"false\"".into()),
                },
            },
            "vercel" => {
                let access = required("AB_VERCEL_BLOB_ACCESS")?;
                if access != "public" && access != "private" {
                    return Err("AB_VERCEL_BLOB_ACCESS must be \"public\" or \"private\"".into());
                }
                let auth = if let Some(token) = optional("BLOB_READ_WRITE_TOKEN") {
                    VercelAuth::Token(token)
                } else if let (Some(token), Some(store_id)) =
                    (optional("VERCEL_OIDC_TOKEN"), optional("BLOB_STORE_ID"))
                {
                    VercelAuth::Oidc { token, store_id }
                } else {
                    return Err("Vercel Blob requires BLOB_READ_WRITE_TOKEN or both VERCEL_OIDC_TOKEN and BLOB_STORE_ID".into());
                };
                BlobConfig::Vercel { access, auth }
            }
            _ => return Err("AB_BLOB_BACKEND must be \"s3\" or \"vercel\"".into()),
        };
        Ok(Some(Self {
            database_url,
            blobs,
            prefix,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn offline_and_partial_configuration() {
        assert!(DataConfig::parse(&environment(&[])).unwrap().is_none());
        assert!(DataConfig::parse(&environment(&[("AB_BLOB_BACKEND", "s3")])).is_err());
        assert!(DataConfig::parse(&environment(&[("DATABASE_URL", "postgres://db")])).is_err());
        assert!(DataConfig::parse(&environment(&[("AB_S3_BUCKET", "bucket")])).is_err());
    }

    #[test]
    fn s3_configuration_and_credential_free_errors() {
        let mut env = environment(&[
            ("AB_POSTGRES_URL", "postgres://user:secret@db/name"),
            ("AB_BLOB_BACKEND", "s3"),
            ("AB_S3_BUCKET", "bucket"),
            ("AB_S3_REGION", "region"),
            ("AB_S3_ACCESS_KEY_ID", "access"),
            ("AB_S3_SECRET_ACCESS_KEY", "secret"),
            ("AB_S3_ENDPOINT", "https://objects.example.test"),
            ("AB_S3_SESSION_TOKEN", "temporary-secret"),
            ("AB_S3_FORCE_PATH_STYLE", "true"),
        ]);
        let parsed = DataConfig::parse(&env).unwrap().unwrap();
        match parsed.blobs {
            BlobConfig::S3 {
                force_path_style,
                session_token,
                endpoint,
                ..
            } => {
                assert_eq!(force_path_style, Some(true));
                assert_eq!(session_token.as_deref(), Some("temporary-secret"));
                assert_eq!(endpoint.as_deref(), Some("https://objects.example.test"));
            }
            _ => panic!("expected S3 configuration"),
        }
        env.insert("AB_S3_FORCE_PATH_STYLE".into(), "invalid-secret".into());
        let error = DataConfig::parse(&env).err().unwrap();
        assert_eq!(
            error,
            "AB_S3_FORCE_PATH_STYLE must be \"true\" or \"false\""
        );
        assert!(!error.contains("secret"));
    }

    #[test]
    fn precedence_auth_and_normalized_prefix() {
        let mut env = environment(&[
            ("AB_POSTGRES_URL", "  "),
            ("DATABASE_URL", " postgres://fallback "),
            ("AB_BLOB_BACKEND", "vercel"),
            ("AB_VERCEL_BLOB_ACCESS", "private"),
            ("BLOB_READ_WRITE_TOKEN", " secret "),
            ("AB_BLOB_PREFIX", "//a///b/"),
        ]);
        let parsed = DataConfig::parse(&env).unwrap().unwrap();
        assert_eq!(parsed.database_url, "postgres://fallback");
        assert_eq!(parsed.prefix, "a/b");
        assert!(matches!(
            parsed.blobs,
            BlobConfig::Vercel {
                auth: VercelAuth::Token(_),
                ..
            }
        ));
        env.insert("AB_POSTGRES_URL".into(), "postgres://explicit".into());
        assert_eq!(
            DataConfig::parse(&env).unwrap().unwrap().database_url,
            "postgres://explicit"
        );
        env.remove("BLOB_READ_WRITE_TOKEN");
        assert!(DataConfig::parse(&env).is_err());
        env.insert("VERCEL_OIDC_TOKEN".into(), "oidc".into());
        env.insert("BLOB_STORE_ID".into(), "store".into());
        assert!(matches!(
            DataConfig::parse(&env).unwrap().unwrap().blobs,
            BlobConfig::Vercel {
                auth: VercelAuth::Oidc { .. },
                ..
            }
        ));
    }
}
