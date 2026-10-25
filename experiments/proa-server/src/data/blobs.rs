//! Whole-object content-addressed I/O. Provider errors never include URLs or credentials.
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
        store_id: String,
        access: String,
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
                            .trim()
                            .strip_prefix("store_")
                            .unwrap_or(store_id.trim())
                            .to_owned(),
                        token.trim().to_owned(),
                    ),
                };
                // A store id becomes a DNS label, never an arbitrary URL.
                if token.trim().is_empty()
                    || !matches!(access.as_str(), "public" | "private")
                    || store_id.is_empty()
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
                    store_id,
                    access,
                    prefix,
                })
            }
        }
    }

    /// Upload the complete raw object before any referencing SQL metadata commits.
    /// A failed transaction may leave an orphan; never delete shared hash keys as compensation.
    pub async fn put(&self, hash: &str, bytes: &[u8]) -> Result<(), DataError> {
        match self {
            Self::S3 {
                client,
                bucket,
                prefix,
            } => {
                client
                    .put_object()
                    .bucket(bucket)
                    .key(blob_path(prefix, hash))
                    .body(aws_sdk_s3::primitives::ByteStream::from(bytes.to_vec()))
                    .send()
                    .await
                    .map_err(|_| DataError::BlobWrite)?;
                Ok(())
            }
            Self::Vercel {
                client,
                token,
                store_id,
                access,
                prefix,
                ..
            } => put_vercel(
                client,
                "https://vercel.com/api/blob/",
                token,
                store_id,
                access,
                &blob_path(prefix, hash),
                bytes,
            )
            .await
            .map(|_| ()),
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
                ..
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

/// Pinned @vercel/blob 2.8.0 whole-Buffer PUT contract. The production caller
/// fixes the API origin; only unit tests call this helper with a loopback URL.
async fn put_vercel(
    client: &reqwest::Client,
    api: &str,
    token: &str,
    store_id: &str,
    access: &str,
    pathname: &str,
    bytes: &[u8],
) -> Result<serde_json::Value, DataError> {
    if pathname.is_empty() || pathname.encode_utf16().count() > 950 || pathname.contains("//") {
        return Err(DataError::BlobWrite);
    }
    let mut url = reqwest::Url::parse(api).map_err(|_| DataError::BlobWrite)?;
    url.query_pairs_mut().append_pair("pathname", pathname);
    let request_id = format!(
        "{store_id}:{}:{:x}",
        chrono::Utc::now().timestamp_millis(),
        rand::random::<u64>()
    );
    // SDK retries network errors and only these server classifications. Explicit
    // denials (including rate_limited) bail immediately; successful invalid JSON
    // fails after the request loop, without another upload.
    for attempt in 0..=10 {
        let response = client
            .put(url.clone())
            .bearer_auth(token)
            .header("x-vercel-blob-store-id", store_id)
            .header("x-api-version", "12")
            .header("x-vercel-blob-access", access)
            .header("x-add-random-suffix", "0")
            .header("x-allow-overwrite", "1")
            .header("x-api-blob-request-id", &request_id)
            .header("x-api-blob-request-attempt", attempt.to_string())
            .body(bytes.to_vec())
            .send()
            .await;
        let retry = match response {
            Ok(response) if response.status().is_success() => {
                let value: serde_json::Value =
                    response.json().await.map_err(|_| DataError::BlobWrite)?;
                return if value.is_null() {
                    Err(DataError::BlobWrite)
                } else {
                    Ok(value)
                };
            }
            Ok(response) => {
                // Redirects must never leak bearer credentials to another origin.
                if response.status().is_redirection() {
                    return Err(DataError::BlobWrite);
                }
                let value = response.json::<serde_json::Value>().await.ok();
                vercel_retryable_error(value.as_ref())
            }
            Err(error) => !error.is_builder(),
        };
        if !retry || attempt == 10 {
            return Err(DataError::BlobWrite);
        }
        tokio::time::sleep(std::time::Duration::from_secs(1_u64 << attempt)).await;
    }
    Err(DataError::BlobWrite)
}

fn vercel_retryable_error(value: Option<&serde_json::Value>) -> bool {
    let error = value.and_then(|v| v.get("error"));
    let message = error.and_then(|v| v.get("message"));
    if let Some(message) = message.filter(|v| !v.is_null()) {
        let Some(message) = message.as_str() else {
            return false;
        };
        // Provider-owned SDK overrides these classifications even if the code
        // says unknown_error. In particular an expired token must not be retried.
        if (message.contains("contentType") && message.contains("is not allowed"))
            || (message.contains("\"pathname\"")
                && message.contains("does not match the token payload"))
            || message == "Token expired"
            || message.contains("the file length cannot be greater than")
            || (message.starts_with("OIDC is enabled for this project, but not for the")
                && message.contains("environment."))
        {
            return false;
        }
    }
    match error.and_then(|v| v.get("code")).filter(|v| !v.is_null()) {
        None => true,
        Some(code) => matches!(
            code.as_str(),
            Some("unknown_error" | "service_unavailable" | "internal_server_error")
        ),
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
            store_id: "test".into(),
            access: "private".into(),
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

/// Content-addressed operator facade over the shared provider transport.
pub struct BlobWriter {
    backend: BlobReader,
    #[cfg(test)]
    api: Option<String>,
}
impl BlobWriter {
    pub fn new(config: BlobConfig, prefix: String) -> Result<Self, DataError> {
        Ok(Self {
            backend: BlobReader::new(config, prefix)?,
            #[cfg(test)]
            api: None,
        })
    }
    pub async fn put(&self, bytes: &[u8]) -> Result<String, DataError> {
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(bytes));
        match &self.backend {
            BlobReader::Vercel {
                client,
                token,
                store_id,
                access,
                prefix,
                ..
            } => {
                let pathname = blob_path(prefix, &hash);
                let api = "https://vercel.com/api/blob/";
                #[cfg(test)]
                let api = self.api.as_deref().unwrap_or(api);
                let value =
                    put_vercel(client, api, token, store_id, access, &pathname, bytes).await?;
                if ![
                    "url",
                    "downloadUrl",
                    "pathname",
                    "contentType",
                    "contentDisposition",
                ]
                .iter()
                .all(|key| value[*key].is_string())
                    || value["pathname"] != pathname
                {
                    return Err(DataError::BlobWrite);
                }
            }
            _ => self.backend.put(&hash, bytes).await?,
        }
        Ok(hash)
    }
}

#[cfg(test)]
mod put_wire_tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::{Read, Write};

    // Read a complete request, including arbitrary NUL/non-UTF8 and zero bytes.
    fn responder(status: u16, response: &[u8]) -> (String, std::thread::JoinHandle<Value>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let api = format!("http://{}/", listener.local_addr().unwrap());
        let response = response.to_vec();
        let join = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0; 4096];
            let header_end = loop {
                let count = socket.read(&mut chunk).unwrap();
                assert_ne!(count, 0);
                raw.extend_from_slice(&chunk[..count]);
                if let Some(index) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let text = String::from_utf8(raw[..header_end].to_vec()).unwrap();
            let mut lines = text.split("\r\n");
            let mut request_line = lines.next().unwrap().split(' ');
            let method = request_line.next().unwrap();
            let target = request_line.next().unwrap();
            let mut headers = serde_json::Map::new();
            for line in lines.filter(|l| !l.is_empty()) {
                let (key, value) = line.split_once(':').unwrap();
                headers.insert(key.to_ascii_lowercase(), json!(value.trim()));
            }
            let length: usize = headers
                .get("content-length")
                .map(|v| v.as_str().unwrap().parse().unwrap())
                .unwrap_or(0);
            while raw.len() < header_end + length {
                let count = socket.read(&mut chunk).unwrap();
                assert_ne!(count, 0);
                raw.extend_from_slice(&chunk[..count]);
            }
            write!(
                socket,
                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.len()
            )
            .unwrap();
            socket.write_all(&response).unwrap();
            json!({"method":method,"target":target,"headers":headers,"body":raw[header_end..].to_vec()})
        });
        (api, join)
    }

    #[tokio::test]
    async fn vercel_put_matches_actual_pinned_sdk_requests() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-blob-provider.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let auth = if case["auth"] == "token" {
                VercelAuth::Token("vercel_blob_rw_fixture_secret".into())
            } else {
                VercelAuth::Oidc {
                    token: "  fixture-oidc  ".into(),
                    store_id: "  store_fixture  ".into(),
                }
            };
            let reader = BlobReader::new(
                BlobConfig::Vercel {
                    access: case["access"].as_str().unwrap().into(),
                    auth,
                },
                case["prefix"].as_str().unwrap().into(),
            )
            .unwrap();
            let (api, server) = responder(200, b"{}");
            let bytes = case["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect::<Vec<_>>();
            let BlobReader::Vercel {
                client,
                token,
                store_id,
                access,
                prefix,
                ..
            } = reader
            else {
                unreachable!()
            };
            put_vercel(
                &client,
                &api,
                &token,
                &store_id,
                &access,
                &blob_path(&prefix, case["hash"].as_str().unwrap()),
                &bytes,
            )
            .await
            .unwrap();
            let mut request = server.join().unwrap();
            let all_headers = request["headers"].as_object().unwrap();
            assert!(all_headers["x-api-blob-request-id"]
                .as_str()
                .unwrap()
                .starts_with("fixture:"));
            assert!(!all_headers.contains_key("x-content-length"));
            assert!(!all_headers.contains_key("content-type"));
            let selected = case["request"]["headers"]
                .as_object()
                .unwrap()
                .keys()
                .map(|key| (key.clone(), all_headers[key].clone()))
                .collect::<serde_json::Map<_, _>>();
            request["headers"] = Value::Object(selected);
            assert_eq!(request, case["request"], "{}", case["id"]);
        }
    }

    #[tokio::test]
    async fn provider_failures_and_invalid_success_are_sanitized() {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for (status, body) in [
            (
                403,
                &b"{\"error\":{\"code\":\"forbidden\",\"message\":\"secret-token\"}}"[..],
            ),
            (404, &b"{\"error\":{\"code\":\"store_not_found\"}}"[..]),
            (429, &b"{\"error\":{\"code\":\"rate_limited\"}}"[..]),
            (307, &b""[..]),
            (200, &b""[..]),
            (200, &b"not-json"[..]),
            (200, &b"null"[..]),
        ] {
            let (api, server) = responder(status, body);
            let error = put_vercel(
                &client,
                &api,
                "secret-token",
                "fixture",
                "private",
                "hash",
                &[0, 255],
            )
            .await
            .unwrap_err();
            assert_eq!(error.to_string(), "blob storage write failed");
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn vercel_path_limit_is_utf16_and_rejects_before_io() {
        let client = reqwest::Client::new();
        for pathname in ["".to_owned(), "x//y".to_owned(), "😀".repeat(476)] {
            assert!(matches!(
                put_vercel(
                    &client,
                    "not-a-url",
                    "token",
                    "fixture",
                    "public",
                    &pathname,
                    &[]
                )
                .await,
                Err(DataError::BlobWrite)
            ));
        }
    }

    #[tokio::test]
    async fn s3_put_uses_configured_bucket_key_and_raw_body() {
        for bytes in [vec![], vec![0, 255, 128, 10]] {
            let (api, server) = responder(200, b"");
            let reader = BlobReader::new(
                BlobConfig::S3 {
                    bucket: "fixture-bucket".into(),
                    region: "us-east-1".into(),
                    access_key_id: "fixture-key".into(),
                    secret_access_key: "fixture-secret".into(),
                    endpoint: Some(api),
                    session_token: Some("fixture-session".into()),
                    force_path_style: Some(true),
                },
                "//a///b/".into(),
            )
            .unwrap();
            reader.put("hash", &bytes).await.unwrap();
            let request = server.join().unwrap();
            assert_eq!(request["method"], "PUT");
            assert_eq!(request["target"], "/fixture-bucket/a/b/hash?x-id=PutObject");
            assert_eq!(request["body"], json!(bytes));
            assert_eq!(
                request["headers"]["x-amz-security-token"],
                "fixture-session"
            );
            assert!(request["headers"].get("x-amz-acl").is_none());
            assert!(request["headers"]["authorization"]
                .as_str()
                .unwrap()
                .starts_with("AWS4-HMAC-SHA256 "));
        }
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
                assert!(headers["x-api-blob-request-id"].to_str().unwrap().starts_with("storeid:"));
                assert_eq!(headers["x-api-blob-request-attempt"], "0");
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
            writer.api = Some(format!("http://{address}/"));
            let hash = writer.put(b"operator artifact\n").await.unwrap();
            assert_eq!(hash.len(), 64);
            assert!(*seen.lock().await);
            server.abort();
        }
    }
    #[tokio::test]
    async fn operator_receipt_validation_rejects_missing_fields_and_wrong_path() {
        for field in [
            "url",
            "downloadUrl",
            "pathname",
            "contentType",
            "contentDisposition",
            "wrong-path",
        ] {
            let field = field.to_owned();
            let app = Router::new().route("/", put(move |Query(query): Query<HashMap<String, String>>| {
                let field = field.clone();
                async move {
                    let mut receipt = json!({"url":"https://provider.invalid/object", "downloadUrl":"https://provider.invalid/download", "pathname":query["pathname"], "contentType":"application/octet-stream", "contentDisposition":"attachment"});
                    if field == "wrong-path" { receipt["pathname"] = json!("other"); }
                    else { receipt.as_object_mut().unwrap().remove(&field); }
                    Json(receipt)
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let api = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let mut writer = BlobWriter::new(
                BlobConfig::Vercel {
                    access: "private".into(),
                    auth: VercelAuth::Token("vercel_blob_rw_store_secret".into()),
                },
                String::new(),
            )
            .unwrap();
            writer.api = Some(api);
            assert!(matches!(
                writer.put(b"artifact").await,
                Err(DataError::BlobWrite)
            ));
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
                    "{\"error\":{\"code\":\"access_error\",\"message\":\"credential=secret-provider-body\"}}",
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
        writer.api = Some(format!("http://{address}/"));
        let error = writer.put(b"artifact").await.unwrap_err();
        assert!(!error.to_string().contains("secret"));
        server.abort();
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    use axum::{
        body::to_bytes, extract::State, http::Request, response::IntoResponse, routing::any, Router,
    };
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn retry_keeps_request_identity_body_and_increments_attempt() {
        type Requests = Arc<Mutex<Vec<Value>>>;
        async fn handler(
            State(requests): State<Requests>,
            request: Request<axum::body::Body>,
        ) -> impl IntoResponse {
            let id = request.headers()["x-api-blob-request-id"]
                .to_str()
                .unwrap()
                .to_owned();
            let attempt = request.headers()["x-api-blob-request-attempt"]
                .to_str()
                .unwrap()
                .to_owned();
            let bytes = to_bytes(request.into_body(), 1024).await.unwrap().to_vec();
            let count = {
                let mut held = requests.lock().unwrap();
                held.push(json!({"id":id,"attempt":attempt,"body":bytes}));
                held.len()
            };
            if count == 1 {
                (
                    reqwest::StatusCode::SERVICE_UNAVAILABLE,
                    "{\"error\":{\"code\":\"service_unavailable\"}}",
                )
            } else {
                (reqwest::StatusCode::OK, "{}")
            }
        }
        let requests: Requests = Arc::new(Mutex::new(vec![]));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}/", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/", any(handler))
            .with_state(requests.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            put_vercel(
                &reqwest::Client::new(),
                &api,
                "fixture-token",
                "fixture",
                "private",
                "hash",
                &[0, 255],
            ),
        )
        .await
        .unwrap();
        server.abort();
        result.unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["id"], requests[1]["id"]);
        assert_eq!(requests[0]["body"], json!([0, 255]));
        assert_eq!(requests[0]["body"], requests[1]["body"]);
        assert_eq!(requests[0]["attempt"], "0");
        assert_eq!(requests[1]["attempt"], "1");
    }

    #[test]
    fn retry_classification_matches_sdk_including_message_overrides() {
        for value in [
            json!({}),
            json!({"error":{"code":null}}),
            json!({"error":{"code":"unknown_error"}}),
            json!({"error":{"code":"internal_server_error"}}),
        ] {
            assert!(vercel_retryable_error(Some(&value)));
        }
        for value in [
            json!({"error":{"code":"rate_limited"}}),
            json!({"error":{"code":7}}),
            json!({"error":{"code":"unknown_error","message":"Token expired"}}),
            json!({"error":{"message":42}}),
        ] {
            assert!(!vercel_retryable_error(Some(&value)));
        }
    }
}
