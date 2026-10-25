//! One experiment-owned row serializes grant transitions across processes.
//! The transaction commits code consumption and token issuance together.
use super::types::Document;
use crate::data::writer::{PostgresWriter, WriteError};

pub async fn update<T>(
    writer: &PostgresWriter,
    f: impl FnOnce(&mut Document) -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    let mut connection = writer.client().await.map_err(unavailable)?;
    let tx = connection
        .client
        .transaction()
        .await
        .map_err(|_| "temporarily_unavailable")?;
    let row = tx
        .query_one(
            "SELECT version,document FROM proa_oauth.state WHERE singleton=true FOR UPDATE",
            &[],
        )
        .await
        .map_err(|_| "temporarily_unavailable")?;
    if row.get::<_, i32>(0) != 1 {
        return Err("temporarily_unavailable");
    }
    let mut document: Document =
        serde_json::from_value(row.get(1)).map_err(|_| "temporarily_unavailable")?;
    let result = f(&mut document)?;
    if document.pending.len()
        + document.codes.len()
        + document.access.len()
        + document.refresh.len()
        > 50000
    {
        return Err("temporarily_unavailable");
    }
    let value = serde_json::to_value(document).map_err(|_| "temporarily_unavailable")?;
    tx.execute(
        "UPDATE proa_oauth.state SET document=$1 WHERE singleton=true",
        &[&value],
    )
    .await
    .map_err(|_| "temporarily_unavailable")?;
    tx.commit().await.map_err(|_| "temporarily_unavailable")?;
    Ok(result)
}
fn unavailable(_: WriteError) -> &'static str {
    "temporarily_unavailable"
}
