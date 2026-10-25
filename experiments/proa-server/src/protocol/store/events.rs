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
    let seq: i64 = row.get("seq");
    if seq > 9_007_199_254_740_991 {
        return Err(ProtocolError::internal());
    }
    let mut event = json!({scope.event_key():scope.id(),"seq":seq,"ts":super::records::row_timestamp(row,"ts"),"actor":row.get::<_,crate::protocol::js_json::JsValue>("actor").0,"type":row.get::<_,String>("type"),"payload":row.get::<_,crate::protocol::js_json::JsValue>("payload").0});
    if !matches!(scope, Scope::Session(_)) {
        if let Some(compatibility) = row
            .get::<_, Option<crate::protocol::js_json::JsValue>>("compatibility")
            .map(|value| value.0)
        {
            event["compatibility"] = compatibility;
        }
    }
    Ok(event)
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
impl Store {
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
        Ok(rows
            .iter()
            .map(|row| event_record(row, Scope::Repo(repo)))
            .collect::<Result<Vec<_>, _>>()?
            .into())
    }
}
