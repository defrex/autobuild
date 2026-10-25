//! Write-capable pool. Serialisation is PostgreSQL row locking, never this pool's mutex.
use super::super::error::ProtocolError;
use crate::data::postgres::{connector, PostgresReader};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, MutexGuard};
use tokio_postgres::Client;
use tokio_postgres_rustls::MakeRustlsConnect;

pub struct Database {
    connections: Vec<Mutex<Connection>>,
    url: String,
    tls: MakeRustlsConnect,
    next: AtomicUsize,
    ticket_writer: Arc<crate::data::writer::PostgresWriter>,
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
            ticket_writer: Arc::new(
                crate::data::writer::PostgresWriter::deferred(url)
                    .map_err(|_| ProtocolError::internal())?,
            ),
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
            ticket_writer: Arc::new(
                crate::data::writer::PostgresWriter::deferred(url)
                    .map_err(|_| ProtocolError::internal())?,
            ),
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
    /// Ticket persistence shares the database and schema preflight, but retains
    /// its separate transaction API and never borrows browser authority. One
    /// writer lives with this database: request boundaries do not reload roots,
    /// discard its connection or repeat successful schema preflight.
    pub(crate) fn ticket_writer(
        &self,
    ) -> Result<Arc<crate::data::writer::PostgresWriter>, ProtocolError> {
        Ok(Arc::clone(&self.ticket_writer))
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

#[cfg(test)]
mod ticket_writer_tests {
    use super::*;
    #[test]
    fn requests_share_the_database_owned_ticket_writer() {
        let database = Database::deferred("postgres://localhost/not-opened").unwrap();
        let first = database.ticket_writer().unwrap();
        let second = database.ticket_writer().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        drop(first);
        assert!(Arc::ptr_eq(&second, &database.ticket_writer().unwrap()));
    }
}
