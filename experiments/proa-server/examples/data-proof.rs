//! JSON-lines test bridge for the TypeScript writer integration driver.
use proa_server::data::{config::DataConfig, postgres::Scope, reader::DataReader};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        !std::env::args().any(|arg| arg == "--fail-for-cleanup"),
        "intentional Rust cleanup proof failure"
    );
    let reader =
        DataReader::connect(DataConfig::from_env().map_err(anyhow::Error::msg)?.unwrap()).await?;
    println!("{}", json!({"ready": true}));
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let repo = command["repo"].as_str().unwrap_or("");
        let id = command["id"].as_str().unwrap_or("");
        let result = match command["op"].as_str().unwrap() {
            "build" => reader.build(repo, id).await,
            "concurrent" => {
                let (a, b) = tokio::join!(reader.build(repo, id), reader.build(repo, id));
                match (a, b) {
                    (Ok(a), Ok(b)) => Ok(json!([a, b])),
                    (Err(e), _) | (_, Err(e)) => Err(e),
                }
            }
            "repository" => reader.repository(repo).await,
            "session" => reader.session(repo, id).await,
            "projects" => reader.postgres().projects().await.map(|v| json!(v)),
            "builds" => reader.postgres().builds(repo).await.map(|v| json!(v)),
            "sessions" => reader.postgres().sessions(repo).await.map(|v| json!(v)),
            "project" => reader.project_builds(repo).await.map(|v| json!(v)),
            "counts" => Ok(json!(reader.query_counts().await)),
            "clear" => {
                reader.clear_cache().await;
                Ok(Value::Null)
            }
            "artifact" => {
                let scope = match command["scope"].as_str().unwrap() {
                    "build" => Scope::Build(id),
                    "repository" => Scope::Repository,
                    "session" => Scope::Session(id),
                    _ => panic!("unknown scope"),
                };
                reader
                    .artifact(
                        repo,
                        scope,
                        command["kind"].as_str().unwrap(),
                        command["revision"].as_i64(),
                    )
                    .await
                    .map(|v| json!(v))
            }
            _ => panic!("unknown operation"),
        };
        let reply = match result {
            Ok(value) => json!({"value": value}),
            Err(error) => json!({"error": error.to_string()}),
        };
        println!("{reply}");
        io::stdout().flush()?;
    }
    Ok(())
}
