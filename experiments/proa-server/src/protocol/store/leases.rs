use super::{
    records::{lock, Scope},
    Store,
};
use crate::protocol::error::ProtocolError;
use chrono::{DateTime, Duration, Utc};

#[derive(Clone, Copy)]
pub enum LeaseKind {
    Execution,
    NodeWriter,
}
impl LeaseKind {
    fn columns(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Execution => ("lease_holder", "lease_expires_at", "lease_ttl_ms"),
            Self::NodeWriter => (
                "node_writer_holder",
                "node_writer_expires_at",
                "node_writer_ttl_ms",
            ),
        }
    }
}
impl Store {
    /// TS and Rust both lock the owning row before testing/changing the holder.
    /// A zero TTL is claimable but immediately expired, including for its owner.
    pub async fn claim(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &str,
        ttl_ms: i64,
    ) -> Result<bool, ProtocolError> {
        check_scope(scope, kind)?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = lock(&tx, scope).await?;
        let now = self.now();
        let (holder_col, expires_col, ttl_col) = kind.columns();
        let previous = row.get::<_, Option<String>>(holder_col);
        let expires = row.get::<_, Option<DateTime<Utc>>>(expires_col);
        if previous
            .as_deref()
            .is_some_and(|previous| !previous.is_empty() && previous != holder)
            && expires.is_some_and(|expires| expires > now)
        {
            return Ok(false);
        }
        let expires = expiry(now, ttl_ms)?;
        tx.execute(&format!("UPDATE {} SET {holder_col}=$1,{expires_col}=$2,{ttl_col}=$3,updated_at=$4 WHERE {}=$5", scope.table(), scope.key()), &[&holder, &expires, &ttl_ms, &now, &scope.id()]).await?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn heartbeat(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &str,
    ) -> Result<bool, ProtocolError> {
        check_scope(scope, kind)?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = lock(&tx, scope).await?;
        let now = self.now();
        let (holder_col, expires_col, ttl_col) = kind.columns();
        if row.get::<_, Option<String>>(holder_col).as_deref() != Some(holder)
            || row
                .get::<_, Option<DateTime<Utc>>>(expires_col)
                .is_none_or(|expires| expires <= now)
        {
            return Ok(false);
        }
        let ttl_ms = row.get::<_, Option<i64>>(ttl_col).unwrap_or(0);
        let expires = expiry(now, ttl_ms)?;
        let heartbeat = if matches!(kind, LeaseKind::Execution) {
            ",heartbeat_at=$1"
        } else {
            ""
        };
        tx.execute(
            &format!(
                "UPDATE {} SET updated_at=$1,{expires_col}=$2{heartbeat} WHERE {}=$3",
                scope.table(),
                scope.key()
            ),
            &[&now, &expires, &scope.id()],
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn release(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &str,
    ) -> Result<(), ProtocolError> {
        check_scope(scope, kind)?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = lock(&tx, scope).await?;
        let (holder_col, expires_col, ttl_col) = kind.columns();
        if row.get::<_, Option<String>>(holder_col).as_deref() == Some(holder) {
            tx.execute(&format!("UPDATE {} SET {holder_col}=NULL,{expires_col}=NULL,{ttl_col}=NULL,updated_at=$1 WHERE {}=$2", scope.table(), scope.key()), &[&self.now(), &scope.id()]).await?;
        }
        tx.commit().await?;
        Ok(())
    }
}
fn check_scope(scope: Scope<'_>, kind: LeaseKind) -> Result<(), ProtocolError> {
    if matches!(scope, Scope::Session(_))
        || (matches!(kind, LeaseKind::NodeWriter) && !matches!(scope, Scope::Build(_)))
    {
        return Err(ProtocolError::validation("invalid lease scope"));
    }
    Ok(())
}
fn expiry(now: DateTime<Utc>, ttl_ms: i64) -> Result<DateTime<Utc>, ProtocolError> {
    Duration::try_milliseconds(ttl_ms)
        .and_then(|duration| now.checked_add_signed(duration))
        .ok_or_else(|| ProtocolError::validation("invalid lease expiration"))
}
