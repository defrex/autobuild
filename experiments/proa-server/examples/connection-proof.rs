//! Test-only persistence bridge; never mounted by the application.
use proa_server::{
    connection::{ConnectionError, ConnectionService},
    data::writer::PostgresWriter,
};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let writer = PostgresWriter::connect(&std::env::var("AB_POSTGRES_URL")?).await?;
    println!("{}", json!({"ready":true}));
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let result = execute(&ConnectionService { writer: &writer }, &command).await;
        println!(
            "{}",
            match result {
                Ok(value) => json!({"value":value}),
                Err(error) => json!({"status":error.status,"error":error.message}),
            }
        );
        io::stdout().flush()?;
    }
    Ok(())
}
async fn execute(service: &ConnectionService<'_>, c: &Value) -> Result<Value, ConnectionError> {
    let now = c["now"].as_str().unwrap().parse().unwrap();
    let text = |key: &str| c[key].as_str().unwrap_or_default();
    Ok(match text("op") {
        "start" => serde_json::to_value(
            service
                .start(text("repo"), text("credentialId"), text("digest"), now)
                .await?,
        )
        .unwrap(),
        "poll" | "cancel" => serde_json::to_value(
            service
                .poll(text("id"), text("capability"), text("op") == "cancel", now)
                .await?,
        )
        .unwrap(),
        "lookup" => {
            serde_json::to_value(service.lookup(text("code"), text("actor"), now).await?).unwrap()
        }
        "decide" => serde_json::to_value(
            service
                .decide(
                    text("code"),
                    text("actor"),
                    c["approve"].as_bool().unwrap(),
                    now,
                )
                .await?,
        )
        .unwrap(),
        _ => panic!("unknown test command"),
    })
}
