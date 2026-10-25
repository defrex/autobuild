//! Experiment-only JSON-lines bridge. The private pipe carries fixture tokens;
//! do not persist its stdout as evidence. This is never mounted in the server.
use chrono::{DateTime, Utc};
use proa_server::protocol::{
    auth::{authenticate_project_bearer, authenticate_project_credential, project_secret_digest},
    store::postgres::Database,
};
use rand::RngCore;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn required<'a>(command: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    command[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing credential proof field: {key}"))
}
fn now(command: &Value) -> anyhow::Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(required(command, "now")?)?.to_utc())
}
fn random_hex<const LENGTH: usize>() -> String {
    let mut bytes = [0u8; LENGTH];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
async fn handle(database: &Database, command: &Value) -> anyhow::Result<Value> {
    let client = database.client().await?;
    match required(command, "op")? {
        "authenticate" => match authenticate_project_credential(
            &client,
            required(command, "token")?,
            now(command)?,
        )
        .await
        {
            Ok(value) => Ok(json!({"value": value})),
            Err(error) => {
                Ok(json!({"status": error.status, "kind": error.kind, "error": error.error}))
            }
        },
        "bearer" => match authenticate_project_bearer(
            &client,
            command["authorization"].as_str(),
            now(command)?,
        )
        .await
        {
            Ok(value) => Ok(json!({"value": value})),
            Err(error) => {
                Ok(json!({"status": error.status, "kind": error.kind, "error": error.error}))
            }
        },
        "issue" => {
            let repo = required(command, "repo")?;
            let user = required(command, "user")?.trim();
            anyhow::ensure!(!user.is_empty(), "credential creator must be nonblank");
            let now = now(command)?;
            let expires_at = command["expiresAt"]
                .as_str()
                .map(DateTime::parse_from_rfc3339)
                .transpose()?
                .map(|date| date.to_utc());
            anyhow::ensure!(
                expires_at.is_none_or(|expiry| expiry > now),
                "credential expiry must be in the future"
            );
            let purpose = command["purpose"].as_str().unwrap_or("project-owner");
            anyhow::ensure!(
                matches!(purpose, "project-owner" | "dispatcher"),
                "invalid credential purpose"
            );
            let registered = client
                .query_opt(
                    "SELECT action FROM project_journal WHERE repo = $1 ORDER BY seq DESC LIMIT 1",
                    &[&repo],
                )
                .await?;
            anyhow::ensure!(
                registered.is_some_and(|row| row.get::<_, String>(0) == "added"),
                "project not registered"
            );
            let id = random_hex::<16>();
            let secret = random_hex::<32>();
            let digest = project_secret_digest(&secret);
            client.execute(
                "INSERT INTO project_credentials (id, digest, repo, created_at, created_by, purpose, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                &[&id, &digest, &repo, &now, &user, &purpose, &expires_at],
            ).await?;
            Ok(json!({"token": format!("abp_1_{id}_{secret}"), "id": id, "repo": repo}))
        }
        _ => anyhow::bail!("unknown credential proof operation"),
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let database_url = std::env::var("AB_POSTGRES_URL")?;
    let url = url::Url::parse(&database_url)?;
    anyhow::ensure!(
        matches!(url.scheme(), "postgres" | "postgresql")
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && url.path().starts_with("/proa_protocol_")
            && !url
                .query_pairs()
                .any(|(key, _)| matches!(key.as_ref(), "host" | "hostaddr" | "service")),
        "credential proof requires an isolated loopback protocol database"
    );
    let database = Database::connect(&database_url).await?;
    println!("{}", json!({"ready": true}));
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let result = handle(&database, &command).await?;
        println!("{result}");
        io::stdout().flush()?;
    }
    Ok(())
}
