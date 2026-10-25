//! Public snapshots are optional caches beside the authoritative logs. One SQL
//! statement owns existence, tail bounds and monotone replacement together.
use super::{records::Scope, Store};
use crate::protocol::error::ProtocolError;
use serde_json::{json, Value};
use tokio_postgres::error::SqlState;

pub const SNAPSHOT_BODY_MAX_BYTES: usize = 16 * 1024 * 1024;

/// The reserved namespace check deliberately precedes the name grammar check,
/// matching the TypeScript machine handler even for a malformed private name.
pub fn validate_snapshot_reducer(reducer: &str) -> Result<(), ProtocolError> {
    if reducer.starts_with("value.") {
        return Err(ProtocolError::validation(
            "reserved reducer value snapshot namespace",
        ));
    }
    let bytes = reducer.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_alphabetic()
        || !bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ProtocolError::validation(format!(
            "invalid reducer name \"{reducer}\""
        )));
    }
    Ok(())
}
fn scope_parts<'a>(scope: Scope<'a>) -> Result<(&'static str, &'a str), ProtocolError> {
    match scope {
        Scope::Build(id) => Ok(("build", id)),
        Scope::Repo(id) => Ok(("repo", id)),
        Scope::Session(_) => Err(ProtocolError::validation("invalid snapshot scope")),
    }
}
fn missing_table(error: &tokio_postgres::Error) -> bool {
    error.code() == Some(&SqlState::UNDEFINED_TABLE)
}
fn storage_error(error: tokio_postgres::Error) -> ProtocolError {
    if let Some(database) = error.as_db_error() {
        ProtocolError::new(500, "internal", database.message())
    } else {
        error.into()
    }
}
fn integer(value: &Value, key: &str) -> Result<i64, ProtocolError> {
    value[key]
        .as_i64()
        .or_else(|| {
            value[key]
                .as_f64()
                .filter(|number| number.is_finite() && number.fract() == 0.0)
                .map(|number| number as i64)
        })
        .ok_or_else(|| ProtocolError::validation("invalid reducer snapshot"))
}
impl Store {
    pub async fn get_snapshot(
        &self,
        scope: Scope<'_>,
        reducer: &str,
        version: i64,
    ) -> Result<Value, ProtocolError> {
        validate_snapshot_reducer(reducer)?;
        let (kind, key) = scope_parts(scope)?;
        let client = self.database.client().await?;
        let found = client
            .query_opt(
                "SELECT s.version,s.cursor,s.state FROM reducer_snapshots s
             WHERE s.scope_kind=$1 AND s.scope_key=$2 AND s.reducer=$3 AND s.version::bigint=$4
               AND s.cursor <= CASE WHEN $1='build'
                 THEN COALESCE((SELECT MAX(seq) FROM events WHERE build=$2),0)
                 ELSE COALESCE((SELECT MAX(seq) FROM repo_events WHERE repo=$2),0) END
               AND CASE WHEN $1='build'
                 THEN EXISTS(SELECT 1 FROM builds WHERE slug=$2)
                 ELSE EXISTS(SELECT 1 FROM repo_streams WHERE repo=$2) END",
                &[&kind, &key, &reducer, &version],
            )
            .await;
        match found {
            Ok(Some(row)) => {
                let stored = row.get::<_, Value>("state");
                // BunSQL binds the TypeScript adapter's JSON.stringify output
                // as a JSONB scalar string. Its json() helper unwraps that one
                // layer; legacy direct JSONB objects remain readable too.
                let state = match stored {
                    Value::String(text) => {
                        serde_json::from_str(&text).map_err(|_| ProtocolError::internal())?
                    }
                    other => other,
                };
                Ok(
                    json!({"version":row.get::<_,i32>("version"),"cursor":row.get::<_,i64>("cursor"),"state":state}),
                )
            }
            Ok(None) => Ok(Value::Null),
            Err(error) if missing_table(&error) => Ok(Value::Null),
            Err(error) => Err(storage_error(error)),
        }
    }
    pub async fn put_snapshot(
        &self,
        scope: Scope<'_>,
        reducer: &str,
        snapshot: &Value,
    ) -> Result<bool, ProtocolError> {
        validate_snapshot_reducer(reducer)?;
        let (kind, key) = scope_parts(scope)?;
        let version = integer(snapshot, "version")?;
        let cursor = integer(snapshot, "cursor")?;
        // Preserve the shared adapter's JSONB string envelope, including scalar
        // JSON states and escaped NULs, so both languages decode the same bytes.
        let state = Value::String(
            serde_json::to_string(snapshot.get("state").unwrap_or(&Value::Null))
                .map_err(|_| ProtocolError::internal())?,
        );
        let client = self.database.client().await?;
        let written = client.query_opt(
            "INSERT INTO reducer_snapshots(scope_kind,scope_key,reducer,version,cursor,state,updated_at)
             SELECT $1,$2,$3,$4::bigint::integer,$5::bigint,$6::jsonb,$7::timestamptz
             WHERE $5 <= CASE WHEN $1='build'
                 THEN COALESCE((SELECT MAX(seq) FROM events WHERE build=$2),0)
                 ELSE COALESCE((SELECT MAX(seq) FROM repo_events WHERE repo=$2),0) END
               AND CASE WHEN $1='build'
                 THEN EXISTS(SELECT 1 FROM builds WHERE slug=$2)
                 ELSE EXISTS(SELECT 1 FROM repo_streams WHERE repo=$2) END
             ON CONFLICT(scope_kind,scope_key,reducer) DO UPDATE SET
               version=EXCLUDED.version,cursor=EXCLUDED.cursor,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at
             WHERE EXCLUDED.version>=reducer_snapshots.version
               AND (EXCLUDED.cursor>reducer_snapshots.cursor
                 OR (EXCLUDED.cursor=reducer_snapshots.cursor AND EXCLUDED.version>reducer_snapshots.version))
             RETURNING 1",
            &[&kind,&key,&reducer,&version,&cursor,&state,&self.now()],
        ).await;
        match written {
            Ok(row) => Ok(row.is_some()),
            Err(error) if missing_table(&error) => Ok(false),
            Err(error) => Err(storage_error(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reducer_namespace_and_path_grammar_keep_distinct_refusals() {
        for name in ["a", "A", "build.v1-state_2", &"a".repeat(64)] {
            validate_snapshot_reducer(name).unwrap();
        }
        for name in ["value.build", "value.!", "value."] {
            assert_eq!(
                validate_snapshot_reducer(name).unwrap_err().error,
                "reserved reducer value snapshot namespace"
            );
        }
        for name in ["", "1bad", "a/b", "a b", "é", &"a".repeat(65)] {
            assert_eq!(
                validate_snapshot_reducer(name).unwrap_err().error,
                format!("invalid reducer name \"{name}\"")
            );
        }
    }
}
