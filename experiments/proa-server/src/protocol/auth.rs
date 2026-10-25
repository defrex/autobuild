//! Project credentials read the shared tables on every request. Authentication
//! never trusts a browser session or a process-local credential cache.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio_postgres::{Client, Row};

pub const LAST_USE_INTERVAL_MS: i64 = 60_000;
pub const RETIRED_CREDENTIAL_MESSAGE: &str = "credential format changed; obtain a project credential from the owner using ab-hosted-store credentials issue REPOSITORY --user IDENTITY";

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{error}")]
pub struct AuthError {
    pub status: u16,
    pub kind: &'static str,
    pub error: String,
}
impl AuthError {
    pub fn auth(status: u16, error: &str) -> Self {
        Self {
            status,
            kind: "auth",
            error: error.to_owned(),
        }
    }
    fn backend() -> Self {
        Self {
            status: 500,
            kind: "internal",
            error: "credential storage failed".into(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum CredentialPurpose {
    #[serde(rename = "project-owner")]
    ProjectOwner,
    #[serde(rename = "dispatcher")]
    Dispatcher,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMetadata {
    pub id: String,
    pub repo: String,
    pub created_at: String,
    pub created_by: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
    pub expires_at: Option<String>,
    pub purpose: CredentialPurpose,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectPrincipal {
    pub kind: &'static str,
    pub repo: String,
    pub user: String,
    pub credential: CredentialMetadata,
}
impl ProjectPrincipal {
    pub fn require_project(&self, repo: &str) -> Result<(), AuthError> {
        if self.repo != repo {
            return Err(AuthError::auth(403, "wrong project"));
        }
        Ok(())
    }
}

pub struct ProjectToken<'a> {
    pub id: &'a str,
    // Private and intentionally no Debug: raw secrets must not enter diagnostics.
    secret: &'a str,
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
/// TypeScript's exact `abp_1_<32 lower hex>_<64 lower hex>` grammar.
pub fn parse_project_token(token: &str) -> Option<ProjectToken<'_>> {
    let token = token.strip_prefix("abp_1_")?;
    let (id, secret) = token.split_once('_')?;
    (lower_hex(id, 32) && lower_hex(secret, 64)).then_some(ProjectToken { id, secret })
}
/// SHA-256 hashes the UTF-8 hex secret string, not its decoded bytes.
pub fn project_secret_digest(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}
fn digest_matches(secret: &str, digest: &str) -> bool {
    if !lower_hex(digest, 64) {
        return false;
    }
    let mut expected = [0u8; 32];
    for (output, pair) in expected
        .iter_mut()
        .zip(digest.as_bytes().as_chunks::<2>().0)
    {
        fn digit(byte: u8) -> u8 {
            if byte <= b'9' {
                byte - b'0'
            } else {
                byte - b'a' + 10
            }
        }
        *output = digit(pair[0]) * 16 + digit(pair[1]);
    }
    bool::from(
        Sha256::digest(secret.as_bytes())
            .as_slice()
            .ct_eq(&expected),
    )
}
fn js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
/// Matches `/^Bearer\s+(.+)$/i`; malformed schemes are missing credentials,
/// while a bearer token with an obsolete grammar gets the retired diagnostic.
pub fn bearer_token(authorization: Option<&str>) -> Result<&str, AuthError> {
    let missing = || AuthError::auth(401, "missing bearer credential");
    let header = authorization.ok_or_else(missing)?;
    let scheme = header.get(..6).ok_or_else(missing)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(missing());
    }
    let rest = &header[6..];
    if !rest.starts_with(js_whitespace) {
        return Err(missing());
    }
    let token = rest.trim_start_matches(js_whitespace);
    if token.is_empty() || token.contains(['\r', '\n', '\u{2028}', '\u{2029}']) {
        return Err(missing());
    }
    Ok(token)
}
fn stamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
struct Credential {
    metadata: CredentialMetadata,
    digest: String,
    expires_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
}
fn credential(row: &Row) -> Result<Credential, AuthError> {
    let get_error = |_| AuthError::backend();
    let purpose: String = row.try_get("purpose").map_err(get_error)?;
    let purpose = match purpose.as_str() {
        "project-owner" => CredentialPurpose::ProjectOwner,
        "dispatcher" => CredentialPurpose::Dispatcher,
        _ => return Err(AuthError::backend()),
    };
    let expires_at: Option<DateTime<Utc>> = row.try_get("expires_at").map_err(get_error)?;
    let last_used_at: Option<DateTime<Utc>> = row.try_get("last_used_at").map_err(get_error)?;
    let revoked_at: Option<DateTime<Utc>> = row.try_get("revoked_at").map_err(get_error)?;
    Ok(Credential {
        metadata: CredentialMetadata {
            id: row.try_get("id").map_err(get_error)?,
            repo: row.try_get("repo").map_err(get_error)?,
            created_at: stamp(row.try_get("created_at").map_err(get_error)?),
            created_by: row.try_get("created_by").map_err(get_error)?,
            last_used_at: last_used_at.map(stamp),
            revoked_at: revoked_at.map(stamp),
            expires_at: expires_at.map(stamp),
            purpose,
        },
        digest: row.try_get("digest").map_err(get_error)?,
        expires_at,
        last_used_at,
    })
}

/// Caller supplies a schema-preflighted connection. Every invocation re-reads
/// credential status and latest registration action; removal never becomes a
/// cached successful authorization. No raw token is persisted.
pub async fn authenticate_project_credential(
    client: &Client,
    token: &str,
    now: DateTime<Utc>,
) -> Result<Option<CredentialMetadata>, AuthError> {
    // The TypeScript clock and Date decoder observe millisecond precision.
    let now =
        DateTime::from_timestamp_millis(now.timestamp_millis()).ok_or_else(AuthError::backend)?;
    let Some(parts) = parse_project_token(token) else {
        return Ok(None);
    };
    let row = client.query_opt(
        "SELECT c.*, (SELECT action FROM project_journal WHERE repo = c.repo ORDER BY seq DESC LIMIT 1) AS project_action FROM project_credentials c WHERE id = $1",
        &[&parts.id],
    ).await.map_err(|_| AuthError::backend())?;
    let Some(row) = row else {
        return Ok(None);
    };
    let found = credential(&row)?;
    if !digest_matches(parts.secret, &found.digest)
        || found.metadata.revoked_at.is_some()
        || found
            .expires_at
            .is_some_and(|expiry| expiry.timestamp_millis() <= now.timestamp_millis())
    {
        return Ok(None);
    }
    if row
        .try_get::<_, Option<String>>("project_action")
        .map_err(|_| AuthError::backend())?
        .as_deref()
        != Some("added")
    {
        return Err(AuthError::auth(403, "project not registered"));
    }
    let cutoff = now - chrono::Duration::milliseconds(LAST_USE_INTERVAL_MS);
    if found
        .last_used_at
        .is_some_and(|last| last.timestamp_millis() > cutoff.timestamp_millis())
    {
        return Ok(Some(found.metadata));
    }
    // Like TypeScript, the guarded update rechecks after the row lock. A
    // revocation racing this authentication may win without changing its result;
    // the next request always reads the authoritative revocation.
    let updated = client.query_opt(
        "UPDATE project_credentials SET last_used_at = $1 WHERE id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $1) AND (last_used_at IS NULL OR last_used_at <= $3) RETURNING *",
        &[&now, &parts.id, &cutoff],
    ).await.map_err(|_| AuthError::backend())?;
    Ok(Some(match updated {
        Some(row) => credential(&row)?.metadata,
        None => found.metadata,
    }))
}
/// Project-token branch only. The full router must dispatch signed delegation
/// tokens separately before returning the retired-format diagnostic.
pub async fn authenticate_project_bearer(
    client: &Client,
    authorization: Option<&str>,
    now: DateTime<Utc>,
) -> Result<ProjectPrincipal, AuthError> {
    let token = bearer_token(authorization)?;
    if !token.starts_with("abp_") {
        return Err(AuthError::auth(401, RETIRED_CREDENTIAL_MESSAGE));
    }
    let credential = authenticate_project_credential(client, token, now)
        .await?
        .ok_or_else(|| AuthError::auth(401, "unknown or revoked credential"))?;
    Ok(ProjectPrincipal {
        kind: "project",
        repo: credential.repo.clone(),
        user: credential.created_by.clone(),
        credential,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_grammar_is_exact_and_digest_hashes_text() {
        let token = format!("abp_1_{}_{}", "a".repeat(32), "f".repeat(64));
        assert!(parse_project_token(&token).is_some());
        for invalid in [
            token.to_uppercase(),
            format!("{token}_"),
            format!(" {token}"),
            token.replacen("abp_1_", "abp_2_", 1),
            token.replacen('a', "A", 1),
            token[..token.len() - 1].into(),
        ] {
            assert!(parse_project_token(&invalid).is_none());
        }
        assert_eq!(
            project_secret_digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(digest_matches("abc", &project_secret_digest("abc")));
        assert!(!digest_matches("abd", &project_secret_digest("abc")));
        assert!(!digest_matches("abc", "not-a-digest"));
    }
    #[test]
    fn bearer_grammar_and_diagnostics() {
        assert_eq!(
            bearer_token(Some("bEaReR\t  abp_token")).unwrap(),
            "abp_token"
        );
        assert_eq!(bearer_token(Some("Bearer opaque ")).unwrap(), "opaque ");
        for header in [
            None,
            Some(""),
            Some("Basic abc"),
            Some("Bearer"),
            Some("Bearer "),
            Some("Bearer a\nb"),
        ] {
            let error = bearer_token(header).unwrap_err();
            assert_eq!(error.status, 401);
            assert_eq!(error.error, "missing bearer credential");
        }
    }
    #[test]
    fn metadata_uses_required_null_fields_and_camel_case() {
        let meta = CredentialMetadata {
            id: "a".into(),
            repo: "repo".into(),
            created_at: "time".into(),
            created_by: "owner".into(),
            last_used_at: None,
            revoked_at: None,
            expires_at: None,
            purpose: CredentialPurpose::Dispatcher,
        };
        assert_eq!(
            serde_json::to_value(meta).unwrap(),
            serde_json::json!({"id":"a", "repo":"repo", "createdAt":"time", "createdBy":"owner", "lastUsedAt":null, "revokedAt":null, "expiresAt":null, "purpose":"dispatcher"})
        );
    }
}
