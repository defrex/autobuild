//! Write-capable pool. Serialisation is PostgreSQL row locking, never this pool's mutex.
use super::super::error::ProtocolError;
use crate::data::postgres::{connector, PostgresReader};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{Mutex, MutexGuard};
use tokio_postgres::Client;
use tokio_postgres_rustls::MakeRustlsConnect;

pub struct Database {
    connections: Vec<Mutex<Connection>>,
    url: String,
    tls: MakeRustlsConnect,
    next: AtomicUsize,
}
pub struct Connection {
    client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl std::ops::Deref for Connection {
    type Target = Client;
    fn deref(&self) -> &Client {
        &self.client
    }
}
impl std::ops::DerefMut for Connection {
    fn deref_mut(&mut self) -> &mut Client {
        &mut self.client
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Database {
    pub async fn connect(url: &str) -> Result<Self, ProtocolError> {
        let tls = connector()?;
        let mut connections = Vec::new();
        for _ in 0..4 {
            connections.push(Mutex::new(Self::open(url, tls.clone()).await?));
        }
        Ok(Self {
            connections,
            url: url.to_owned(),
            tls,
            next: AtomicUsize::new(0),
        })
    }
    async fn open(url: &str, tls: MakeRustlsConnect) -> Result<Connection, ProtocolError> {
        let (client, connection) = tokio_postgres::connect(url, tls).await?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut connection = Connection { client, task };
        PostgresReader::preflight_client(&mut connection.client).await?;
        Ok(connection)
    }
    pub async fn client(&self) -> Result<MutexGuard<'_, Connection>, ProtocolError> {
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.connections.len();
        let mut available = None;
        for offset in 0..self.connections.len() {
            if let Ok(connection) =
                self.connections[(index + offset) % self.connections.len()].try_lock()
            {
                available = Some(connection);
                break;
            }
        }
        let mut connection = match available {
            Some(connection) => connection,
            None => self.connections[index].lock().await,
        };
        if connection.is_closed() {
            *connection = Self::open(&self.url, self.tls.clone()).await?;
        }
        Ok(connection)
    }
}
