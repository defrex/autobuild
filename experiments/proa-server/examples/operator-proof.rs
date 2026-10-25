//! Test-only JSON-lines bridge. Production routes never expose raw event append.
mod operator_state;
use chrono::{DateTime, Utc};
use proa_server::{
    data::{config::DataConfig, reader::DataReader, writer::PostgresWriter},
    operator::sessions::{Mutation, SessionService},
};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = DataConfig::from_env().map_err(anyhow::Error::msg)?.unwrap();
    let writer = PostgresWriter::connect(&config.database_url).await?;
    let competing = PostgresWriter::connect(&config.database_url).await?;
    let reader = DataReader::connect(config).await?;
    let auth = proa_server::config::Config::parse(|_| None)?.auth;
    let app = operator_state::from_env(auth).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let router = proa_server::operator::http::router_with_clock(std::sync::Arc::new(|| {
        "2026-09-02T00:00:00.000Z".parse().unwrap()
    }))
    .merge(proa_server::operator::delegation::router_with_clock(
        std::sync::Arc::new(|| "2026-09-02T00:00:00.000Z".parse().unwrap()),
    ))
    .with_state(app);
    let http = tokio::spawn(async move { axum::serve(listener, router).await });
    println!("{}", json!({"ready": true}));
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let reply = if command["op"] == "http-address" {
            json!({"value":format!("http://{address}")})
        } else {
            execute(&command, &writer, &competing, &reader).await
        };
        println!("{reply}");
        io::stdout().flush()?;
    }
    http.abort();
    Ok(())
}

async fn execute(
    command: &Value,
    writer: &PostgresWriter,
    competing: &PostgresWriter,
    reader: &DataReader,
) -> Value {
    let repo = command["repo"].as_str().unwrap_or_default();
    let id = command["id"].as_str().unwrap_or_default();
    let user = command["user"].as_str().unwrap_or("operator@example.com");
    let now: DateTime<Utc> = command["now"]
        .as_str()
        .unwrap_or("2026-09-02T00:00:00.000Z")
        .parse()
        .unwrap();
    let service = SessionService { reader, writer };
    let operation = command["op"].as_str().unwrap_or_default();
    if operation.starts_with("service-") {
        let globs: Vec<String> = command["globs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let result = match operation {
            "service-get" => service.get(repo, id).await,
            "service-list" => service.list(repo).await.map(|value| json!(value)),
            "service-create" => {
                service
                    .create(repo, user, command["title"].as_str(), None, now)
                    .await
            }
            _ => {
                let mutation = match operation {
                    "service-message" => Mutation::Message(command["text"].as_str().unwrap_or("")),
                    "service-wake" => Mutation::Wake(&globs),
                    "service-approval" => Mutation::Approval {
                        turn: command["turn"].as_str().unwrap_or(""),
                        tool_call_id: command["toolCallId"].as_str().unwrap_or(""),
                        decision: command["decision"].as_str().unwrap_or(""),
                    },
                    "service-archive" => Mutation::Archive,
                    _ => return json!({"error":"unknown test bridge service operation"}),
                };
                service.mutate(repo, id, user, mutation, now).await
            }
        };
        return match result {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"status":error.status,"body":error}),
        };
    }
    let write = &command["write"];
    let result = match operation {
        "create" => {
            writer
                .create_session(repo, user, command["title"].as_str(), now)
                .await
        }
        "append-session" => writer.append_session(repo, id, write, now).await,
        "append-build" => writer.append_build(repo, id, write, now).await,
        "append-repo" => writer.append_repo(repo, write, now).await,
        "cas-session" => writer
            .append_session_if_current(repo, id, command["expected"].as_i64().unwrap(), write, now)
            .await
            .map(|value| json!(value)),
        "cas-build" => writer
            .append_build_if_current(repo, id, command["expected"].as_i64().unwrap(), write, now)
            .await
            .map(|value| json!(value)),
        "race-session" => {
            let expected = command["expected"].as_i64().unwrap();
            let (first, second) = tokio::join!(
                writer.append_session_if_current(repo, id, expected, write, now),
                competing.append_session_if_current(repo, id, expected, write, now)
            );
            match (first, second) {
                (Ok(first), Ok(second)) => Ok(json!([first, second])),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        _ => return json!({"error":"unknown test bridge operation"}),
    };
    match result {
        Ok(value) => json!({"value": value}),
        Err(error) => json!({"error": error.to_string()}),
    }
}
