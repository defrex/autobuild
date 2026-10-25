//! Environment contract shared with the TypeScript PostgreSQL adapter.
//! Secrets deliberately have no Debug implementation.
use std::collections::HashMap;

#[derive(Clone)]
pub struct DataConfig {
    pub database_url: String,
    pub blobs: BlobConfig,
    pub prefix: String,
    pub artifact_retention_max_revisions: Option<usize>,
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
                .map(|value| {
                    crate::protocol::js_value::JsString::from(value.as_str())
                        .trim_js()
                        .to_scalar()
                        .expect("trimming scalar input preserves Unicode scalars")
                })
                .filter(|value| !value.is_empty())
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
                    || name == "AB_ARTIFACT_RETENTION_MAX_REVISIONS"
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
        let backend = required("AB_BLOB_BACKEND")?;
        let artifact_retention_max_revisions = optional("AB_ARTIFACT_RETENTION_MAX_REVISIONS")
            .map(|value| positive_int(&value))
            .transpose()?;
        let blobs = match backend.as_str() {
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
            artifact_retention_max_revisions,
        }))
    }
}

/// The source positiveInt helper uses Number, not parseInt or a decimal-only
/// integer parser. Beyond usize's range every realizable revision is retained;
/// saturating preserves that decision instead of rejecting valid JS integers.
fn positive_int(value: &str) -> Result<usize, String> {
    let number = if let Some((radix, digits)) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .map(|v| (16, v))
        .or_else(|| {
            value
                .strip_prefix("0o")
                .or_else(|| value.strip_prefix("0O"))
                .map(|v| (8, v))
        })
        .or_else(|| {
            value
                .strip_prefix("0b")
                .or_else(|| value.strip_prefix("0B"))
                .map(|v| (2, v))
        }) {
        if digits.is_empty() {
            None
        } else {
            // Round the entire integer once, as Number does. Accumulating
            // into f64 can double-round a radix value within usize's range.
            let exact = digits.chars().try_fold(0u128, |n, d| {
                n.checked_mul(u128::from(radix))?
                    .checked_add(u128::from(d.to_digit(radix)?))
            });
            exact.map(|n| n as f64).or_else(|| {
                digits.chars().try_fold(0.0, |n, d| {
                    d.to_digit(radix)
                        .map(|d| n * f64::from(radix) + f64::from(d))
                })
            })
        }
    } else {
        // Rust additionally accepts spellings such as inf; JavaScript accepts
        // only this decimal grammar (Infinity is not a positive integer).
        let decimal =
            regex::Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
                .expect("constant numeric grammar");
        decimal
            .is_match(value)
            .then(|| value.parse::<f64>().ok())
            .flatten()
    };
    match number {
        Some(number) if number.is_finite() && number.fract() == 0.0 && number >= 1.0 => {
            Ok(number as usize)
        }
        _ => Err(format!(
            "AB_ARTIFACT_RETENTION_MAX_REVISIONS must be a positive integer, got {value}"
        )),
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
    fn retention_override_matches_js_positive_integer_coercion() {
        let mut env = environment(&[
            (
                "AB_POSTGRES_URL",
                "postgres://unused@127.0.0.1:9/unreachable",
            ),
            ("AB_BLOB_BACKEND", "vercel"),
            ("AB_VERCEL_BLOB_ACCESS", "private"),
            ("BLOB_READ_WRITE_TOKEN", "unused"),
        ]);
        assert_eq!(
            DataConfig::parse(&env)
                .unwrap()
                .unwrap()
                .artifact_retention_max_revisions,
            None
        );
        for blank in ["", " ", "\u{feff}\u{2029}"] {
            env.insert("AB_ARTIFACT_RETENTION_MAX_REVISIONS".into(), blank.into());
            assert_eq!(
                DataConfig::parse(&env)
                    .unwrap()
                    .unwrap()
                    .artifact_retention_max_revisions,
                None
            );
        }
        for (raw, expected) in [
            ("500", 500),
            ("1", 1),
            ("2.0", 2),
            ("+2", 2),
            ("1e2", 100),
            (".1e1", 1),
            ("0x10", 16),
            ("0x94d2b8fda02f34a6", 10_723_837_062_176_258_048usize),
            ("0O10", 8),
            ("0b10", 2),
            ("\u{feff} 3 \u{2029}", 3),
            ("0.99999999999999999", 1),
            ("1e30", usize::MAX),
        ] {
            env.insert("AB_ARTIFACT_RETENTION_MAX_REVISIONS".into(), raw.into());
            assert_eq!(
                DataConfig::parse(&env)
                    .unwrap()
                    .unwrap()
                    .artifact_retention_max_revisions,
                Some(expected),
                "{raw:?}"
            );
        }
        for raw in [
            "0", "-0", "-1", "1.5", "NaN", "Infinity", "inf", "1e400", "1e-400", "0x", "+0x1",
            "1_0", "1 0", "\u{85}1",
        ] {
            env.insert("AB_ARTIFACT_RETENTION_MAX_REVISIONS".into(), raw.into());
            assert_eq!(
                DataConfig::parse(&env).err().unwrap(),
                format!(
                    "AB_ARTIFACT_RETENTION_MAX_REVISIONS must be a positive integer, got {raw}"
                )
            );
        }
        assert!(DataConfig::parse(&environment(&[(
            "AB_ARTIFACT_RETENTION_MAX_REVISIONS",
            "2"
        )]))
        .is_err());
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
