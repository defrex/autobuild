use super::{
    records::{lock, Scope},
    Store,
};
use crate::protocol::{error::ProtocolError, js_postgres::PgText, js_value::JsString};
use chrono::{DateTime, Utc};

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
    pub async fn claim(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &str,
        ttl_ms: i64,
    ) -> Result<bool, ProtocolError> {
        self.claim_lossless(scope, kind, &JsString::from(holder), ttl_ms)
            .await
    }
    pub async fn heartbeat(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &str,
    ) -> Result<bool, ProtocolError> {
        self.heartbeat_lossless(scope, kind, &JsString::from(holder))
            .await
    }
    pub async fn release(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &str,
    ) -> Result<(), ProtocolError> {
        self.release_lossless(scope, kind, &JsString::from(holder))
            .await
    }

    /// TS and Rust both lock the owning row before testing/changing the holder.
    /// A zero TTL is claimable but immediately expired, including for its owner.
    pub async fn claim_lossless(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &JsString,
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
            .is_some_and(|previous| !previous.is_empty() && !holder.eq_str(previous))
            && expires.is_some_and(|expires| expires > now)
        {
            return Ok(false);
        }
        let expires = expiry(now, ttl_ms)?;
        tx.execute(&format!("UPDATE {} SET {holder_col}=$1,{expires_col}=$2::text::timestamptz,{ttl_col}=$3,updated_at=$4 WHERE {}=$5", scope.table(), scope.key()), &[&PgText(holder), &expires, &ttl_ms, &now, &scope.id()]).await.map_err(ProtocolError::query)?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn heartbeat_lossless(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &JsString,
    ) -> Result<bool, ProtocolError> {
        check_scope(scope, kind)?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = lock(&tx, scope).await?;
        let now = self.now();
        let (holder_col, expires_col, ttl_col) = kind.columns();
        if row
            .get::<_, Option<String>>(holder_col)
            .as_deref()
            .is_none_or(|previous| !holder.eq_str(previous))
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
                "UPDATE {} SET updated_at=$1,{expires_col}=$2::text::timestamptz{heartbeat} WHERE {}=$3",
                scope.table(),
                scope.key()
            ),
            &[&now, &expires, &scope.id()],
        )
        .await
        .map_err(ProtocolError::query)?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn release_lossless(
        &self,
        scope: Scope<'_>,
        kind: LeaseKind,
        holder: &JsString,
    ) -> Result<(), ProtocolError> {
        check_scope(scope, kind)?;
        let mut client = self.database.client().await?;
        let tx = client.transaction().await?;
        let row = lock(&tx, scope).await?;
        let (holder_col, expires_col, ttl_col) = kind.columns();
        if matches!(kind, LeaseKind::NodeWriter) {
            // The source node-writer release compares through SQL TEXT binding,
            // unlike execution/repository release's prior JavaScript equality.
            tx.execute(&format!("UPDATE {} SET {holder_col}=NULL,{expires_col}=NULL,{ttl_col}=NULL,updated_at=$1 WHERE {}=$2 AND {holder_col}=$3",scope.table(),scope.key()),&[&self.now(),&scope.id(),&PgText(holder)]).await.map_err(ProtocolError::query)?;
        } else if row
            .get::<_, Option<String>>(holder_col)
            .as_deref()
            .is_some_and(|previous| holder.eq_str(previous))
        {
            tx.execute(&format!("UPDATE {} SET {holder_col}=NULL,{expires_col}=NULL,{ttl_col}=NULL,updated_at=$1 WHERE {}=$2", scope.table(), scope.key()), &[&self.now(), &scope.id()]).await.map_err(ProtocolError::query)?;
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
fn expiry(now: DateTime<Utc>, ttl_ms: i64) -> Result<String, ProtocolError> {
    crate::protocol::js_date::iso_from_millis(now.timestamp_millis() as f64 + ttl_ms as f64)
}
