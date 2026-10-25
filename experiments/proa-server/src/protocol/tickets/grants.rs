//! Independent ticket-only credentials. Never enters BuildStore Principal.
use crate::protocol::{error::ProtocolError, router::MachineState};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_postgres::Row;
#[derive(Clone)]
pub struct Grant {
    pub id: String,
    pub repo: String,
    pub execution: String,
    pub kind: String,
    pub parent: Option<String>,
    pub expires: DateTime<Utc>,
}
impl Grant {
    pub fn value(&self) -> Value {
        json!({"id":self.id,"repo":self.repo,"execution":self.execution,"kind":self.kind,"parent":self.parent,"expiresAt":self.expires.to_rfc3339_opts(SecondsFormat::Millis,true)})
    }
}
fn row(r: Row) -> Grant {
    Grant {
        id: r.get("id"),
        repo: r.get("repo"),
        execution: r.get("execution"),
        kind: r.get("kind"),
        parent: r.get("parent"),
        expires: r.get("expires_at"),
    }
}
fn random(n: usize) -> String {
    let mut bytes = vec![0; n];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub async fn authenticate(state: &MachineState, token: &str) -> Result<Grant, ProtocolError> {
    let client = state.store.database.client().await?;
    let now = state.store.now();
    let digest = format!("{:x}", Sha256::digest(token.as_bytes()));
    let r=client.query_opt("SELECT g.* FROM ticket_grants g JOIN LATERAL (SELECT seq,action FROM project_journal WHERE repo=g.repo ORDER BY seq DESC LIMIT 1) r ON r.seq=g.registration AND r.action='added' WHERE g.digest=$1 AND g.revoked_at IS NULL AND g.expires_at>$2 AND (g.parent IS NULL OR EXISTS (SELECT 1 FROM ticket_grants p WHERE p.id=g.parent AND p.revoked_at IS NULL AND p.expires_at>$2 AND p.registration=g.registration))",&[&digest,&now]).await?;
    r.map(row)
        .ok_or_else(|| ProtocolError::new(401, "auth", "ticket grant expired or revoked"))
}
pub async fn issue(
    state: &MachineState,
    repo: &str,
    execution: &str,
    kind: &str,
    parent: Option<&Grant>,
) -> Result<Value, ProtocolError> {
    let id = random(16);
    let token = format!("abt_{}", random(32));
    let digest = format!("{:x}", Sha256::digest(token.as_bytes()));
    let now = state.store.now();
    let expires = (now + Duration::minutes(5)).min(
        parent
            .map(|p| p.expires)
            .unwrap_or(now + Duration::minutes(5)),
    );
    let parent = parent.map(|p| p.id.as_str());
    let client = state.store.database.client().await?;
    let r=client.query_opt("INSERT INTO ticket_grants (id,digest,repo,registration,execution,kind,parent,expires_at) SELECT $1,$2,$3,r.seq,$4,$5,$6,$7 FROM (SELECT seq,action FROM project_journal WHERE repo=$3 ORDER BY seq DESC LIMIT 1) r WHERE r.action='added' AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM ticket_grants p WHERE p.id=$6 AND p.registration=r.seq AND p.revoked_at IS NULL AND p.expires_at>$8)) RETURNING id",&[&id,&digest,&repo,&execution,&kind,&parent,&expires,&now]).await?;
    if r.is_none() {
        return Err(ProtocolError::new(
            500,
            "internal",
            "project or parent grant is no longer active",
        ));
    }
    Ok(
        json!({"token":token,"grant":Grant{id,repo:repo.into(),execution:execution.into(),kind:kind.into(),parent:parent.map(str::to_owned),expires}.value()}),
    )
}
pub async fn administer(
    state: &MachineState,
    action: &str,
    repo: &str,
    id: &str,
) -> Result<(), ProtocolError> {
    let client = state.store.database.client().await?;
    let now = state.store.now();
    if action == "renew" {
        let expires = now + Duration::minutes(5);
        client.execute("WITH renewed AS (UPDATE ticket_grants SET expires_at=$1 WHERE id=$2 AND repo=$3 AND kind='runner' AND revoked_at IS NULL AND expires_at>$4 RETURNING id,expires_at) UPDATE ticket_grants SET expires_at=renewed.expires_at FROM renewed WHERE ticket_grants.parent=renewed.id AND ticket_grants.revoked_at IS NULL",&[&expires,&id,&repo,&now]).await?;
    } else {
        client.execute("UPDATE ticket_grants SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2 AND repo=$3",&[&now,&id,&repo]).await?;
    }
    Ok(())
}
