//! Test-only JSON-lines ticket bridge. This is never registered as a server route.
use chrono::{DateTime, Utc};
use proa_server::{
    data::writer::PostgresWriter,
    operator::{
        error::OperatorError,
        tickets::{TicketMutation, TicketPolicy, TicketService},
    },
};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == "--http") {
        let config = proa_server::config::Config::parse(|_| None)?;
        let state = proa_server::app::AppState::from_env(config.auth).await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        println!(
            "{}",
            json!({"ready":true,"origin":format!("http://{}",listener.local_addr()?)})
        );
        io::stdout().flush()?;
        axum::serve(
            listener,
            proa_server::operator::http::router().with_state(state),
        )
        .await?;
        return Ok(());
    }

    let writer = PostgresWriter::connect(&std::env::var("AB_POSTGRES_URL")?).await?;
    println!("{}", json!({"ready":true}));
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let result = execute(&TicketService { writer: &writer }, &command).await;
        println!(
            "{}",
            match result {
                Ok(value) => json!({"value":value}),
                Err(error) => json!({"status":error.status,"body":error}),
            }
        );
        io::stdout().flush()?;
    }
    Ok(())
}
async fn execute(service: &TicketService<'_>, c: &Value) -> Result<Value, OperatorError> {
    if c["op"] == "parse" {
        return proa_server::operator::ticket_http::body(
            &serde_json::to_vec(&c["body"]).unwrap(),
            c["operation"].as_str().unwrap(),
        );
    }
    let repo = c["repo"].as_str().unwrap();
    if c["op"] == "policy" {
        let p = service.policy(repo, c.get("config")).await?;
        return Ok(
            json!({"teamKey":p.team_key,"triage":p.triage,"ready":p.ready,"doing":p.doing,"done":p.done,"create":p.create,"proposal":p.proposal}),
        );
    }
    let policy = TicketPolicy::from_config(&c["config"])?;
    if c["op"] == "target" {
        let reader = proa_server::data::reader::DataReader::connect(
            proa_server::data::config::DataConfig::from_env()
                .map_err(|_| OperatorError::internal())?
                .ok_or_else(OperatorError::internal)?,
        )
        .await
        .map_err(|_| OperatorError::internal())?;
        let now = c["now"].as_str().unwrap().parse().unwrap();
        return proa_server::operator::ticket_target::update(
            service,
            &reader,
            repo,
            &policy,
            c["id"].as_str().unwrap(),
            &c["patch"],
            c["expectedRevision"].as_str(),
            now,
            &c["config"],
        )
        .await;
    }

    let id = c["id"].as_str().unwrap_or_default();
    let now: DateTime<Utc> = c["now"]
        .as_str()
        .unwrap_or("2026-09-02T00:00:00.000Z")
        .parse()
        .unwrap();
    let ids = c["ids"]
        .as_array()
        .map(|v| {
            v.iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    match c["op"].as_str().unwrap() {
        "get" => service.get(repo, &policy, id).await,
        "list" => {
            service
                .list(
                    repo,
                    &policy,
                    c["state"].as_str(),
                    c.get("labels").map(|_| ids.as_slice()),
                )
                .await
        }
        "states" => service.states(repo, &policy).await,
        "state" => {
            service
                .add_state(
                    repo,
                    &policy,
                    c["name"].as_str().unwrap(),
                    c["about"].as_str(),
                )
                .await
        }
        "create" => service.create(repo, &policy, &c["draft"], now).await,
        "dependencies" => service.dependencies(repo, &policy, &ids).await,
        operation => {
            let mutation = match operation {
                "update" => TicketMutation::Update(&c["patch"]),
                "move" => TicketMutation::Move(c["state"].as_str().unwrap()),
                "block" | "unblock" => TicketMutation::Block {
                    ids: &ids,
                    remove: operation == "unblock",
                },
                _ => return Err(OperatorError::validation("unknown ticket proof operation")),
            };
            service
                .mutate(
                    repo,
                    &policy,
                    id,
                    mutation,
                    c["expectedRevision"].as_str(),
                    now,
                )
                .await
        }
    }
}
