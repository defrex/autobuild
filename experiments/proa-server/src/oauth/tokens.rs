use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use p256::{
    elliptic_curve::sec1::ToEncodedPoint,
    pkcs8::{EncodePrivateKey, LineEnding},
    SecretKey,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn digest(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
fn cipher(secret: &str) -> Aes256Gcm {
    Aes256Gcm::new(&Sha256::digest(secret.as_bytes()))
}
pub fn generate(secret: &str) -> Result<String, &'static str> {
    let key = SecretKey::random(&mut rand::rngs::OsRng);
    let pem = key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| "server_error")?;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher(secret)
        .encrypt(Nonce::from_slice(&nonce), pem.as_bytes())
        .map_err(|_| "server_error")?;
    Ok(URL_SAFE_NO_PAD.encode([nonce.as_slice(), &encrypted].concat()))
}
fn pem(encrypted: &str, secret: &str) -> Result<Vec<u8>, &'static str> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encrypted)
        .map_err(|_| "server_error")?;
    if bytes.len() < 13 {
        return Err("server_error");
    }
    cipher(secret)
        .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
        .map_err(|_| "server_error")
}
pub fn jwk(encrypted: &str, secret: &str) -> Result<Value, &'static str> {
    use p256::pkcs8::DecodePrivateKey;
    let bytes = pem(encrypted, secret)?;
    let key = SecretKey::from_pkcs8_pem(std::str::from_utf8(&bytes).map_err(|_| "server_error")?)
        .map_err(|_| "server_error")?;
    let point = key.public_key().to_encoded_point(false);
    let x = URL_SAFE_NO_PAD.encode(point.x().ok_or("server_error")?);
    let y = URL_SAFE_NO_PAD.encode(point.y().ok_or("server_error")?);
    let kid = digest(&format!("{x}.{y}"));
    Ok(json!({"kty":"EC","crv":"P-256","alg":"ES256","use":"sig","kid":kid,"x":x,"y":y}))
}
#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub exp: u64,
    pub iat: u64,
    pub jti: String,
    pub client_id: String,
    pub scope: String,
}
pub fn sign(key: &str, secret: &str, claims: &Claims) -> Result<String, &'static str> {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = jwk(key, secret)?["kid"].as_str().map(str::to_owned);
    jsonwebtoken::encode(
        &header,
        claims,
        &EncodingKey::from_ec_pem(&pem(key, secret)?).map_err(|_| "server_error")?,
    )
    .map_err(|_| "server_error")
}
pub fn validate(
    token: &str,
    key: &str,
    secret: &str,
    issuer: &str,
    resource: &str,
    now: u64,
) -> Result<Claims, &'static str> {
    let public = jwk(key, secret)?;
    let decoding = DecodingKey::from_ec_components(
        public["x"].as_str().unwrap(),
        public["y"].as_str().unwrap(),
    )
    .map_err(|_| "invalid_token")?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[resource]);
    // Clock is injected by Auth; do not use the library's wall clock.
    validation.validate_exp = false;
    let claims = jsonwebtoken::decode::<Claims>(token, &decoding, &validation)
        .map_err(|_| "invalid_token")?
        .claims;
    if claims.exp <= now || claims.iat > now {
        return Err("invalid_token");
    }
    Ok(claims)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_encryption_and_resource_binding() {
        let key = generate("secret").unwrap();
        assert!(jwk(&key, "wrong").is_err());
        assert!(jwk(&key, "secret").unwrap().get("d").is_none());
        let claims = Claims {
            iss: "https://operator.test".into(),
            aud: "https://operator.test/mcp".into(),
            sub: "ada@example.com".into(),
            exp: 200,
            iat: 100,
            jti: "grant".into(),
            client_id: "client".into(),
            scope: "openid".into(),
        };
        let token = sign(&key, "secret", &claims).unwrap();
        assert!(validate(&token, &key, "secret", &claims.iss, &claims.aud, 101).is_ok());
        assert!(validate(
            &token,
            &key,
            "secret",
            &claims.iss,
            "https://other.test/mcp",
            101
        )
        .is_err());
        assert!(validate(&token, &key, "secret", &claims.iss, &claims.aud, 200).is_err());
    }
}
