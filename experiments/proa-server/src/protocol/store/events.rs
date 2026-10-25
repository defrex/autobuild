//! The owning PostgreSQL row is the cross-language serialization boundary.
use super::{
    records::{lock, Scope},
    timestamp, Store,
};
use crate::protocol::{
    error::ProtocolError,
    validation::writes::{prepare_build_write, prepare_repository_write, validate_expected_seq},
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::{Row, Transaction};

pub(crate) fn event_record(row: &Row, scope: Scope<'_>) -> Result<Value, ProtocolError> {
    event_record_lossless(row, scope)?
        .to_serde_checked()
        .map_err(|_| ProtocolError::internal())
}
pub(crate) fn event_record_lossless(
    row: &Row,
    scope: Scope<'_>,
) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
    use crate::protocol::{
        js_postgres::{decode_json_column, json_truthy, PgValue},
        js_value::{JsJson as J, JsString as S},
    };
    let seq: i64 = row.get("seq");
    if seq > 9_007_199_254_740_991 {
        return Err(ProtocolError::internal());
    }
    let mut fields = vec![
        (S::from(scope.event_key()), J::String(S::from(scope.id()))),
        (S::from("seq"), J::Number(seq as f64)),
        (
            S::from("ts"),
            J::String(S::from(super::records::row_timestamp(row, "ts"))),
        ),
        (
            S::from("actor"),
            decode_json_column(row.get::<_, PgValue>("actor").0)?,
        ),
        (
            S::from("type"),
            J::String(S::from(row.get::<_, String>("type"))),
        ),
        (
            S::from("payload"),
            decode_json_column(row.get::<_, PgValue>("payload").0)?,
        ),
    ];
    if !matches!(scope, Scope::Session(_)) {
        if let Some(value) = row
            .get::<_, Option<PgValue>>("compatibility")
            .map(|v| v.0)
            .filter(json_truthy)
        {
            fields.push((S::from("compatibility"), decode_json_column(value)?));
        }
    }
    Ok(J::Object(fields))
}
pub(crate) async fn tail(tx: &Transaction<'_>, scope: Scope<'_>) -> Result<i64, ProtocolError> {
    Ok(tx
        .query_one(
            &format!(
                "SELECT COALESCE(MAX(seq),0) FROM {} WHERE {}=$1",
                scope.events(),
                scope.event_key()
            ),
            &[&scope.id()],
        )
        .await?
        .get(0))
}
pub(crate) async fn insert_prepared(
    tx: &Transaction<'_>,
    scope: Scope<'_>,
    event: &Value,
    seq: i64,
    now: DateTime<Utc>,
) -> Result<Value, ProtocolError> {
    let event = crate::protocol::js_json::serializable(event.clone());
    let compatibility = event.get("compatibility");
    let kind = event["type"].as_str().ok_or_else(ProtocolError::internal)?;
    if matches!(scope, Scope::Session(_)) {
        tx.execute("INSERT INTO session_events(session,seq,ts,actor,type,payload) VALUES($1,$2,$3,$4,$5,$6)", &[&scope.id(),&seq,&now,&event["actor"],&kind,&event["payload"]]).await.map_err(ProtocolError::query)?;
    } else {
        tx.execute(&format!("INSERT INTO {}({},seq,ts,actor,type,payload,compatibility) VALUES($1,$2,$3,$4,$5,$6,$7)",scope.events(),scope.event_key()),&[&scope.id(),&seq,&now,&event["actor"],&kind,&event["payload"],&compatibility]).await.map_err(ProtocolError::query)?;
    }
    tx.execute(
        &format!(
            "UPDATE {} SET updated_at=$1 WHERE {}=$2",
            scope.table(),
            scope.key()
        ),
        &[&now, &scope.id()],
    )
    .await
    .map_err(ProtocolError::query)?;
    let mut stored = json!({scope.event_key():scope.id(),"seq":seq,"ts":timestamp(now),"actor":event["actor"],"type":kind,"payload":event["payload"]});
    if let Some(compatibility) = compatibility {
        stored["compatibility"] = compatibility.clone();
    }
    Ok(stored)
}
/// Lossless producer DTOs reach PostgreSQL before any scalar projection. Direct
/// JSONB rejection therefore preserves the source's transaction/CAS ordering.
pub(crate) async fn insert_prepared_lossless(
    tx: &Transaction<'_>,
    scope: Scope<'_>,
    event: &crate::protocol::js_value::JsJson,
    seq: i64,
    now: DateTime<Utc>,
) -> Result<Value, ProtocolError> {
    use crate::protocol::{
        js_postgres::{PgJson, PgText},
        js_value::{JsJson, JsString},
    };
    let kind = event["type"]
        .as_js_string()
        .ok_or_else(ProtocolError::internal)?;
    let actor = PgJson(&event["actor"]);
    let payload = PgJson(&event["payload"]);
    if matches!(scope, Scope::Session(_)) {
        tx.execute("INSERT INTO session_events(session,seq,ts,actor,type,payload) VALUES($1,$2,$3,$4,$5,$6)", &[&scope.id(),&seq,&now,&actor,&PgText(kind),&payload]).await.map_err(ProtocolError::query)?;
    } else {
        let compatibility = event.get("compatibility").map(PgJson);
        tx.execute(&format!("INSERT INTO {}({},seq,ts,actor,type,payload,compatibility) VALUES($1,$2,$3,$4,$5,$6,$7)",scope.events(),scope.event_key()),&[&scope.id(),&seq,&now,&actor,&PgText(kind),&payload,&compatibility]).await.map_err(ProtocolError::query)?;
    }
    tx.execute(
        &format!(
            "UPDATE {} SET updated_at=$1 WHERE {}=$2",
            scope.table(),
            scope.key()
        ),
        &[&now, &scope.id()],
    )
    .await
    .map_err(ProtocolError::query)?;
    let mut stored = JsJson::Object(vec![
        (
            JsString::from(scope.event_key()),
            JsJson::String(JsString::from(scope.id())),
        ),
        (JsString::from("seq"), JsJson::Number(seq as f64)),
        (
            JsString::from("ts"),
            JsJson::String(JsString::from(timestamp(now))),
        ),
        (JsString::from("actor"), event["actor"].clone()),
        (JsString::from("type"), event["type"].clone()),
        (JsString::from("payload"), event["payload"].clone()),
    ]);
    if let Some(compatibility) = event.get("compatibility") {
        stored["compatibility"] = compatibility.clone();
    }
    // JSON.stringify owns accepted nonfinite numbers; successful direct JSONB
    // persistence establishes that no unpaired string can reach this conversion.
    crate::protocol::js_value::parse(stored.stringify().as_bytes())
        .and_then(|value| value.to_serde_checked())
        .map_err(|_| ProtocolError::internal())
}

impl Store {
    pub async fn append_event_lossless(
        &self,
        scope: Scope<'_>,
        input: &crate::protocol::js_value::JsJson,
        expected_seq: Option<&crate::protocol::js_value::JsJson>,
    ) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
        use crate::protocol::{
            js_value::JsJson,
            validation::{lossless_writes, WriteScope},
        };
        let expected = expected_seq
            .map(lossless_writes::validate_expected_seq)
            .transpose()
            .map_err(|error| ProtocolError::new_js(500, "internal", error))?;
        let kind = match scope {
            Scope::Build(_) => WriteScope::Build,
            Scope::Repo(_) => WriteScope::Repository,
            Scope::Session(_) => WriteScope::Session,
        };
        let event = lossless_writes::prepare(kind, input)
            .map_err(|error| ProtocolError::new_js(422, "validation", error))?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let current = tail(&tx, scope).await?;
        if expected.is_some_and(|expected| expected != current) {
            return Ok(JsJson::Null);
        }
        let seq = current
            .checked_add(1)
            .filter(|seq| *seq <= 9_007_199_254_740_991)
            .ok_or_else(ProtocolError::internal)?;
        let stored = insert_prepared_lossless(&tx, scope, &event, seq, self.now()).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(JsJson::from_serde(&stored))
    }

    pub async fn append_event(
        &self,
        scope: Scope<'_>,
        input: &Value,
        expected_seq: Option<&Value>,
    ) -> Result<Value, ProtocolError> {
        // Ordinary CAS validates before taking the lock or deciding a stale head.
        let expected = expected_seq
            .map(validate_expected_seq)
            .transpose()
            .map_err(|error| ProtocolError::new(500, "internal", error))?;
        let event = match scope {
            Scope::Build(_) => prepare_build_write(input),
            Scope::Repo(_) => prepare_repository_write(input),
            Scope::Session(_) => return Err(ProtocolError::validation("invalid event scope")),
        }
        .map_err(|error| ProtocolError::new(422, "validation", error))?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, scope).await?;
        let current = tail(&tx, scope).await?;
        if expected.is_some_and(|expected| expected != current) {
            return Ok(Value::Null);
        }
        let seq = current
            .checked_add(1)
            .filter(|seq| *seq <= 9_007_199_254_740_991)
            .ok_or_else(ProtocolError::internal)?;
        let stored = insert_prepared(&tx, scope, &event, seq, self.now()).await?;
        tx.commit().await.map_err(ProtocolError::query)?;
        Ok(stored)
    }
    pub async fn high_water(&self, scope: Scope<'_>) -> Result<i64, ProtocolError> {
        let client = self.database.client().await?;
        if client
            .query_opt(
                &format!("SELECT 1 FROM {} WHERE {}=$1", scope.table(), scope.key()),
                &[&scope.id()],
            )
            .await?
            .is_none()
        {
            return Err(ProtocolError::missing(scope.name(), scope.id()));
        }
        let value: i64 = client
            .query_one(
                &format!(
                    "SELECT COALESCE(MAX(seq),0) FROM {} WHERE {}=$1",
                    scope.events(),
                    scope.event_key()
                ),
                &[&scope.id()],
            )
            .await?
            .get(0);
        if value > 9_007_199_254_740_991 {
            return Err(ProtocolError::internal());
        }
        Ok(value)
    }
}

impl Store {
    /// A single statement observes the anchor and selection at one authoritative
    /// prefix, closing the first-anchor race without a process-local cache.
    pub async fn repo_state_events(&self, repo: &str) -> Result<Value, ProtocolError> {
        self.repo_state_events_lossless(repo)
            .await?
            .to_serde_checked()
            .map_err(|_| ProtocolError::internal())
    }
    pub async fn repo_state_events_lossless(
        &self,
        repo: &str,
    ) -> Result<crate::protocol::js_value::JsJson, ProtocolError> {
        static POLICY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        let policy = POLICY.get_or_init(|| {
            serde_json::from_str(include_str!("../../../fixtures/protocol-event-reads.json"))
                .expect("generated repository read policy")
        });
        let durable: Vec<&str> = policy["durable"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let latest: Vec<&str> = policy["latest"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let client = self.database.client().await?;
        if client
            .query_opt("SELECT 1 FROM repo_streams WHERE repo=$1", &[&repo])
            .await?
            .is_none()
        {
            return Err(ProtocolError::missing("repo", repo));
        }
        let rows=client.query("WITH anchor AS (SELECT MAX(seq) AS seq FROM repo_events WHERE repo=$1 AND type='dispatcher.run-started') SELECT e.* FROM repo_events e CROSS JOIN anchor a WHERE e.repo=$1 AND (e.type=ANY($2::text[]) OR (a.seq IS NOT NULL AND e.seq>=a.seq AND NOT e.type=ANY($3::text[])) OR (e.type=ANY($3::text[]) AND e.seq=(SELECT MAX(l.seq) FROM repo_events l WHERE l.repo=$1 AND l.type=e.type))) ORDER BY e.seq",&[&repo,&durable,&latest]).await?;
        Ok(crate::protocol::js_value::JsJson::Array(
            rows.iter()
                .map(|row| event_record_lossless(row, Scope::Repo(repo)))
                .collect::<Result<Vec<_>, _>>()?,
        ))
    }
}
