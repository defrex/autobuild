//! Retrieval only. Provider errors never include URLs or credentials.
use super::config::{BlobConfig, VercelAuth};
use super::error::DataError;
use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::{BehaviorVersion, Region},
    Client,
};

pub enum BlobReader {
    S3 {
        client: Client,
        bucket: String,
        prefix: String,
    },
    Vercel {
        client: reqwest::Client,
        origin: String,
        token: String,
        prefix: String,
    },
}

pub fn blob_path(prefix: &str, hash: &str) -> String {
    let prefix = prefix
        .split('/')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if prefix.is_empty() {
        hash.into()
    } else {
        format!("{prefix}/{hash}")
    }
}

impl BlobReader {
    pub fn new(config: BlobConfig, prefix: String) -> Result<Self, DataError> {
        match config {
            BlobConfig::S3 {
                bucket,
                region,
                access_key_id,
                secret_access_key,
                endpoint,
                session_token,
                force_path_style,
            } => {
                let mut builder = aws_sdk_s3::Config::builder()
                    .behavior_version(BehaviorVersion::latest())
                    .region(Region::new(region))
                    .credentials_provider(Credentials::new(
                        access_key_id,
                        secret_access_key,
                        session_token,
                        None,
                        "autobuild-config",
                    ))
                    .force_path_style(force_path_style.unwrap_or(false));
                if let Some(endpoint) = endpoint {
                    let url = reqwest::Url::parse(&endpoint).map_err(|_| DataError::Blob)?;
                    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                        return Err(DataError::Blob);
                    }
                    builder = builder.endpoint_url(endpoint);
                }
                Ok(Self::S3 {
                    client: Client::from_conf(builder.build()),
                    bucket,
                    prefix,
                })
            }
            BlobConfig::Vercel { access, auth } => {
                let (store_id, token) = match auth {
                    VercelAuth::Token(token) => {
                        (token.split('_').nth(3).unwrap_or("").to_owned(), token)
                    }
                    VercelAuth::Oidc { token, store_id } => (
                        store_id
                            .strip_prefix("store_")
                            .unwrap_or(&store_id)
                            .to_owned(),
                        token,
                    ),
                };
                // A store id becomes a DNS label, never an arbitrary URL.
                if store_id.is_empty()
                    || !store_id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
                {
                    return Err(DataError::Blob);
                }
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(30))
                    .build()
                    .map_err(|_| DataError::Blob)?;
                Ok(Self::Vercel {
                    client,
                    origin: format!("https://{store_id}.{access}.blob.vercel-storage.com"),
                    token,
                    prefix,
                })
            }
        }
    }

    pub async fn get(&self, hash: &str) -> Result<Vec<u8>, DataError> {
        match self {
            Self::S3 {
                client,
                bucket,
                prefix,
            } => {
                let result = client
                    .get_object()
                    .bucket(bucket)
                    .key(blob_path(prefix, hash))
                    .send()
                    .await
                    .map_err(|error| {
                        if error.as_service_error().is_some_and(|e| e.is_no_such_key())
                            || error
                                .raw_response()
                                .is_some_and(|r| r.status().as_u16() == 404)
                        {
                            DataError::MissingBlob
                        } else {
                            DataError::Blob
                        }
                    })?;
                Ok(result
                    .body
                    .collect()
                    .await
                    .map_err(|_| DataError::Blob)?
                    .into_bytes()
                    .to_vec())
            }
            Self::Vercel {
                client,
                origin,
                token,
                prefix,
            } => {
                let mut url = reqwest::Url::parse(origin).map_err(|_| DataError::Blob)?;
                // URL's path encoder preserves slash separators and escapes non-URL bytes.
                url.set_path(&blob_path(prefix, hash));
                let response = client
                    .get(url)
                    .bearer_auth(token)
                    .send()
                    .await
                    .map_err(|_| DataError::Blob)?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Err(DataError::MissingBlob);
                }
                if !response.status().is_success() {
                    return Err(DataError::Blob);
                }
                Ok(response
                    .bytes()
                    .await
                    .map_err(|_| DataError::Blob)?
                    .to_vec())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefix_matches_typescript() {
        assert_eq!(blob_path("//a///b/", "hash"), "a/b/hash");
        assert_eq!(blob_path("/", "hash"), "hash");
    }
    #[test]
    fn invalid_s3_endpoint_fails_before_startup() {
        let config = BlobConfig::S3 {
            bucket: "bucket".into(),
            region: "region".into(),
            access_key_id: "test".into(),
            secret_access_key: "test".into(),
            endpoint: Some("invalid endpoint".into()),
            session_token: None,
            force_path_style: None,
        };
        assert!(matches!(
            BlobReader::new(config, String::new()),
            Err(DataError::Blob)
        ));
    }
    #[test]
    fn vercel_get_auth_matches_pinned_sdk() {
        for access in ["public", "private"] {
            for auth in [
                VercelAuth::Token("vercel_blob_rw_abc_secret".into()),
                VercelAuth::Oidc {
                    token: "oidc".into(),
                    store_id: "store_abc".into(),
                },
            ] {
                let reader = BlobReader::new(
                    BlobConfig::Vercel {
                        access: access.into(),
                        auth,
                    },
                    "prefix".into(),
                )
                .unwrap();
                match reader {
                    BlobReader::Vercel { origin, .. } => assert_eq!(
                        origin,
                        format!("https://abc.{access}.blob.vercel-storage.com")
                    ),
                    _ => unreachable!(),
                }
            }
        }
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use std::io::{Read, Write};
    async fn get_response(status: u16, body: Vec<u8>) -> (Result<Vec<u8>, DataError>, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            let length = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]).into_owned();
            write!(
                socket,
                "HTTP/1.1 {status} Status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
            request
        });
        let reader = BlobReader::Vercel {
            client: reqwest::Client::new(),
            origin: format!("http://{address}"),
            token: "test-bearer".into(),
            prefix: "//test///prefix/".into(),
        };
        let value = reader.get("hash").await;
        (value, server.join().unwrap())
    }
    #[tokio::test]
    async fn signed_get_and_binary_body_match_sdk() {
        let bytes = vec![0, 255, 128, 10];
        let (result, request) = get_response(200, bytes.clone()).await;
        assert_eq!(result.unwrap(), bytes);
        assert!(request.starts_with("GET /test/prefix/hash HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-bearer\r\n"));
        assert!(!request.to_ascii_lowercase().contains("x-api-version"));
    }
    #[tokio::test]
    async fn missing_is_distinct_from_denied() {
        assert!(matches!(
            get_response(404, vec![]).await.0,
            Err(DataError::MissingBlob)
        ));
        assert!(matches!(
            get_response(403, vec![]).await.0,
            Err(DataError::Blob)
        ));
    }
}

/// Content-addressed upload adapter. SQL publication happens only after a
/// complete provider success; errors omit provider bodies and credentials.
pub struct BlobWriter {
    backend: BlobReader,
    vercel: Option<(String, String, String)>,
}
impl BlobWriter {
    pub fn new(config: BlobConfig, prefix: String) -> Result<Self, DataError> {
        let vercel = match &config {
            BlobConfig::Vercel { access, auth } => {
                let store = match auth {
                    VercelAuth::Token(token) => token.split('_').nth(3).unwrap_or("").to_owned(),
                    VercelAuth::Oidc { store_id, .. } => store_id
                        .strip_prefix("store_")
                        .unwrap_or(store_id)
                        .to_owned(),
                };
                Some((
                    access.clone(),
                    store,
                    "https://blob.vercel-storage.com".to_owned(),
                ))
            }
            _ => None,
        };
        Ok(Self {
            backend: BlobReader::new(config, prefix)?,
            vercel,
        })
    }
    pub async fn put(&self, bytes: &[u8]) -> Result<String, DataError> {
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(bytes));
        match &self.backend {
            BlobReader::S3 {
                client,
                bucket,
                prefix,
            } => {
                client
                    .put_object()
                    .bucket(bucket)
                    .key(blob_path(prefix, &hash))
                    .body(aws_sdk_s3::primitives::ByteStream::from(bytes.to_vec()))
                    .send()
                    .await
                    .map_err(|_| DataError::Blob)?;
            }
            BlobReader::Vercel {
                client,
                token,
                prefix,
                ..
            } => {
                let (access, store, origin) = self.vercel.as_ref().ok_or(DataError::Blob)?;
                let mut url = reqwest::Url::parse(origin).map_err(|_| DataError::Blob)?;
                url.set_path("/");
                url.query_pairs_mut()
                    .append_pair("pathname", &blob_path(prefix, &hash));
                let response = client
                    .put(url)
                    .bearer_auth(token)
                    .header("x-api-version", "12")
                    .header("x-vercel-blob-store-id", store)
                    .header("x-vercel-blob-access", access)
                    .header("x-add-random-suffix", "0")
                    .header("x-allow-overwrite", "1")
                    .body(bytes.to_vec())
                    .send()
                    .await
                    .map_err(|_| DataError::Blob)?;
                if !response.status().is_success() {
                    return Err(DataError::Blob);
                }
                let value: serde_json::Value =
                    response.json().await.map_err(|_| DataError::Blob)?;
                if ![
                    "url",
                    "downloadUrl",
                    "pathname",
                    "contentType",
                    "contentDisposition",
                ]
                .iter()
                .all(|key| value[*key].is_string())
                {
                    return Err(DataError::Blob);
                }
                if value["pathname"] != blob_path(prefix, &hash) {
                    return Err(DataError::Blob);
                }
            }
        }
        Ok(hash)
    }
}

#[cfg(test)]
mod upload_tests {
    use super::*;
    use axum::{
        body::Bytes,
        extract::{Query, State},
        http::HeaderMap,
        routing::put,
        Json, Router,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;
    #[tokio::test]
    async fn vercel_upload_contract_covers_token_and_oidc_without_download_origin() {
        for oidc in [false, true] {
            let token = if oidc {
                "test-oidc-secret"
            } else {
                "vercel_blob_rw_storeid_secret"
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let seen = Arc::new(tokio::sync::Mutex::new(false));
            let handler_seen = seen.clone();
            let router=Router::new().route("/",put(move |State(seen):State<Arc<tokio::sync::Mutex<bool>>>,Query(query):Query<HashMap<String,String>>,headers:HeaderMap,body:Bytes|async move{
                assert_eq!(headers["authorization"],format!("Bearer {token}"));
                assert_eq!(headers["x-api-version"],"12");
                assert_eq!(headers["x-vercel-blob-store-id"],"storeid");
                assert_eq!(headers["x-vercel-blob-access"],"private");
                assert_eq!(headers["x-add-random-suffix"],"0");
                assert_eq!(headers["x-allow-overwrite"],"1");
                assert_eq!(body.as_ref(),b"operator artifact\n");
                assert_eq!(query.len(),1);
                assert!(query["pathname"].starts_with("audit/prefix/"));
                *seen.lock().await=true;
                Json(json!({"url":"https://provider.invalid/object","downloadUrl":"https://provider.invalid/object?download=1","pathname":query["pathname"],"contentType":"application/octet-stream","contentDisposition":"attachment"}))
            })).with_state(handler_seen);
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let auth = if oidc {
                VercelAuth::Oidc {
                    token: token.into(),
                    store_id: "store_storeid".into(),
                }
            } else {
                VercelAuth::Token(token.into())
            };
            let mut writer = BlobWriter::new(
                BlobConfig::Vercel {
                    access: "private".into(),
                    auth,
                },
                "//audit///prefix/".into(),
            )
            .unwrap();
            writer.vercel.as_mut().unwrap().2 = format!("http://{address}");
            let hash = writer.put(b"operator artifact\n").await.unwrap();
            assert_eq!(hash.len(), 64);
            assert!(*seen.lock().await);
            server.abort();
        }
    }
    #[tokio::test]
    async fn failed_upload_cannot_return_a_publishable_hash_and_hides_provider_text() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            "/",
            put(|| async {
                (
                    axum::http::StatusCode::FORBIDDEN,
                    "credential=secret-provider-body",
                )
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut writer = BlobWriter::new(
            BlobConfig::Vercel {
                access: "private".into(),
                auth: VercelAuth::Token("vercel_blob_rw_store_secret".into()),
            },
            String::new(),
        )
        .unwrap();
        writer.vercel.as_mut().unwrap().2 = format!("http://{address}");
        let error = writer.put(b"artifact").await.unwrap_err();
        assert!(!error.to_string().contains("secret"));
        server.abort();
    }
}
