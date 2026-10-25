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
    client: Option<Client>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl std::ops::Deref for Connection {
    type Target = Client;
    fn deref(&self) -> &Client {
        self.client.as_ref().expect("connected writer slot")
    }
}
impl std::ops::DerefMut for Connection {
    fn deref_mut(&mut self) -> &mut Client {
        self.client.as_mut().expect("connected writer slot")
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
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
    pub fn deferred(url: &str) -> Result<Self, ProtocolError> {
        Ok(Self {
            connections: (0..4)
                .map(|_| {
                    Mutex::new(Connection {
                        client: None,
                        task: None,
                    })
                })
                .collect(),
            url: url.into(),
            tls: connector()?,
            next: AtomicUsize::new(0),
        })
    }
    async fn open(url: &str, tls: MakeRustlsConnect) -> Result<Connection, ProtocolError> {
        let (client, connection) = tokio_postgres::connect(url, tls).await?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut connection = Connection {
            client: Some(client),
            task: Some(task),
        };
        PostgresReader::preflight_client(
            connection.client.as_mut().expect("connected writer slot"),
        )
        .await?;
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
        if connection.client.as_ref().is_none_or(Client::is_closed) {
            *connection = Self::open(&self.url, self.tls.clone()).await?;
        }
        Ok(connection)
    }
}
