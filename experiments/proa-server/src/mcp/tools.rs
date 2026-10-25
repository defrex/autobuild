use crate::{
    app::AppState,
    operator::protocol,
    protocol::{js_value::JsJson, token::mint_js_token},
};
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tower::ServiceExt;

pub fn corpus() -> &'static Value {
    static CORPUS: OnceLock<Value> = OnceLock::new();
    CORPUS.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/mcp-corpus.json"))
            .expect("generated MCP corpus")
    })
}
pub fn text(value: Value, error: bool) -> Value {
    let mut result =
        json!({"content":[{"type":"text","text":serde_json::to_string(&value).unwrap()}]});
    if error {
        result["isError"] = json!(true);
    }
    result
}
fn unavailable() -> Value {
    text(
        json!({"kind":"internal","error":"operator tool is unavailable"}),
        true,
    )
}
pub async fn call(
    state: &AppState,
    email: &str,
    client: &str,
    name: &str,
    mut input: Value,
) -> Value {
    let Some(reader) = state.data.as_deref() else {
        return if name == "repositories.list" {
            text(
                json!({"kind":"internal","error":"project registry is unavailable"}),
                true,
            )
        } else {
            unavailable()
        };
    };
    let projects = match reader.postgres().projects().await {
        Ok(p) => p,
        Err(_) => {
            return if name == "repositories.list" {
                text(
                    json!({"kind":"internal","error":"project registry is unavailable"}),
                    true,
                )
            } else {
                unavailable()
            }
        }
    };
    if name == "repositories.list" {
        return text(
            json!({"repositories":projects.iter().map(|p|p["repo"].clone()).collect::<Vec<_>>()}),
            false,
        );
    }
    let Some(repo) = input["repo"].as_str().map(str::to_owned) else {
        return unavailable();
    };
    if !projects.iter().any(|p| p["repo"] == repo) {
        return text(
            json!({"kind":"validation","error":format!("repository \"{repo}\" is not served by this deployment; call repositories.list for the served identities")}),
            true,
        );
    }
    if name == "builds.events" {
        if let Some(wait) = input["waitSeconds"].as_f64() {
            input["waitSeconds"] = json!(wait.min(240.0));
        }
    }
    let Some(secret) = state.operator_secret.as_deref() else {
        return unavailable();
    };
    let claims = json!({"version":1,"internalOperator":{"user":email,"repo":repo},"via":{"kind":"mcp","client":client},"exp":state.auth.now()*1000+30000});
    let Ok(scope) = JsJson::parse(serde_json::to_string(&claims).unwrap().as_bytes()) else {
        return unavailable();
    };
    let token = mint_js_token(secret, &scope);
    let path: String = url::form_urlencoded::byte_serialize(repo.as_bytes()).collect();
    let request = Request::builder()
        .method("POST")
        .uri(format!("/operator/v1/repos/{path}/tools/{name}"))
        .header("authorization", format!("Bearer {token}"))
        .header(protocol::VERSION_HEADER, protocol::service_version())
        .header(protocol::PROTOCOL_HEADER, protocol::PROTOCOL_VERSION)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&input).unwrap()))
        .unwrap();
    let response = crate::operator::http::router()
        .with_state(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let failed = !response.status().is_success();
    let Ok(bytes) = to_bytes(response.into_body(), usize::MAX).await else {
        return unavailable();
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(body) => text(body, failed),
        Err(_) => unavailable(),
    }
}
