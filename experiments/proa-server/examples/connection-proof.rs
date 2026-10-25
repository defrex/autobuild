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
    if text("op") == "http" {
        use proa_server::protocol::{
            router::{Authority, MachineState},
            store::Store,
        };
        use std::sync::Arc;
        let state = MachineState {
            store: Arc::new(
                Store::deferred(
                    &std::env::var("AB_POSTGRES_URL").unwrap(),
                    Arc::new(move || now),
                )
                .unwrap(),
            ),
            authority: Authority::Project,
            secret: None,
        };
        let mut builder = axum::http::Request::builder()
            .method(text("method"))
            .uri(text("path"));
        if let Some(token) = c["token"].as_str() {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if let Some(content_type) = c["contentType"].as_str() {
            builder = builder.header("content-type", content_type);
        }
        let request = builder
            .body(axum::body::Body::from(
                c["body"].as_str().unwrap_or_default().to_owned(),
            ))
            .unwrap();
        let response = if proa_server::connection::http::is_machine_path(text("path")) {
            proa_server::connection::http::credential(&state, request).await
        } else if text("path").starts_with("/connect/v1/browser/") {
            proa_server::connection::http::browser(&state, request, text("actor")).await
        } else {
            proa_server::connection::http::public(&state, request, "https://connect.example").await
        };
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        return Ok(
            json!({"status":status,"body":serde_json::from_slice::<Value>(&bytes).unwrap()}),
        );
    }
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
