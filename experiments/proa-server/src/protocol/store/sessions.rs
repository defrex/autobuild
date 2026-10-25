use super::{
    records::{lock, record, Scope},
    timestamp, Store,
};
use crate::protocol::{
    error::ProtocolError,
    validation::session::{validate_session_write, ValidatedSessionWrite},
};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use tokio_postgres::Transaction;

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "os_{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
fn whitespace(character: char) -> bool {
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
impl Store {
    pub async fn create_session(
        &self,
        repo: &str,
        operator: &str,
        title: Option<&str>,
    ) -> Result<Value, ProtocolError> {
        let operator = operator.trim_matches(whitespace);
        if operator.is_empty() {
            return Err(ProtocolError::new(500, "internal", "operator is required"));
        }
        if repo.is_empty() {
            return Err(ProtocolError::new(500, "internal", "repo is required"));
        }
        let payload = title
            .map(|title| json!({"title":title}))
            .unwrap_or_else(|| json!({}));
        let event = validate_session_write(&json!({"actor":{"kind":"human","user":operator},"type":"session.created","payload":payload})).map_err(|message|ProtocolError::new(422,"validation",message))?;
        let now = self.now();
        let id = new_id();
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        tx.execute("INSERT INTO sessions(id,repo,operator,title,creation_seq,created_at,updated_at) VALUES($1,$2,$3,$4,nextval('sessions_creation_seq'),$5,$5)", &[&id,&repo,&operator,&title,&now]).await?;
        insert(&tx, &id, &event, 1, now).await?;
        let value = record(&lock(&tx, Scope::Session(&id)).await?, Scope::Session(&id));
        tx.commit().await?;
        Ok(value)
    }
    pub async fn append_session(
        &self,
        id: &str,
        input: &Value,
        expected_seq: Option<i64>,
    ) -> Result<Value, ProtocolError> {
        if expected_seq.is_some_and(|seq| seq < 0) {
            return Err(ProtocolError::new(
                500,
                "internal",
                format!(
                    "expectedSeq must be a nonnegative integer, got {}",
                    expected_seq.unwrap()
                ),
            ));
        }
        // Validate before even the stale-head check, like the ordinary conditional append.
        let event = validate_session_write(input)
            .map_err(|message| ProtocolError::new(422, "validation", message))?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        lock(&tx, Scope::Session(id)).await?;
        let tail: i64 = tx
            .query_one(
                "SELECT COALESCE(MAX(seq),0) FROM session_events WHERE session=$1",
                &[&id],
            )
            .await?
            .get(0);
        if expected_seq.is_some_and(|expected| expected != tail) {
            return Ok(Value::Null);
        }
        let seq = tail
            .checked_add(1)
            .filter(|seq| *seq <= 9_007_199_254_740_991)
            .ok_or_else(ProtocolError::internal)?;
        let now = self.now();
        insert(&tx, id, &event, seq, now).await?;
        tx.execute(
            "UPDATE sessions SET updated_at=$1 WHERE id=$2",
            &[&now, &id],
        )
        .await?;
        let result = json!({"session":id,"seq":seq,"ts":timestamp(now),"actor":event.actor,"type":event.kind,"payload":event.payload});
        tx.commit().await?;
        Ok(result)
    }
}
async fn insert(
    tx: &Transaction<'_>,
    id: &str,
    event: &ValidatedSessionWrite,
    seq: i64,
    now: DateTime<Utc>,
) -> Result<(), ProtocolError> {
    tx.execute(
        "INSERT INTO session_events(session,seq,ts,actor,type,payload) VALUES($1,$2,$3,$4,$5,$6)",
        &[&id, &seq, &now, &event.actor, &event.kind, &event.payload],
    )
    .await?;
    Ok(())
}
