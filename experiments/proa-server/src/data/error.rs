use thiserror::Error;

#[derive(Clone, Debug, Error)]
pub enum DataError {
    #[error("PostgreSQL connection failed")]
    Connection,
    #[error("PostgreSQL read failed")]
    Query,
    #[error("unsupported PostgreSQL schema: expected version {expected}, found {found}")]
    Schema { expected: i32, found: String },
    #[error("PostgreSQL schema version {version} checksum mismatch")]
    Checksum { version: i32 },
    #[error("{scope} scope does not exist in the selected project")]
    MissingScope { scope: &'static str },
    #[error("invalid {scope} event {event_type} at seq {seq}")]
    Decode {
        scope: &'static str,
        event_type: String,
        seq: i64,
    },
    #[error("blob object is missing")]
    MissingBlob,
    #[error("blob storage read failed")]
    Blob,
    #[error("blob storage write failed")]
    BlobWrite,
}
