use super::tools;
use crate::{app::AppState, oauth};
use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

fn response(value: Value, status: u16) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(value)).into_response()
}
fn error(status: u16, code: i32, message: &str, id: Value) -> Response {
    response(
        json!({"jsonrpc":"2.0","error":{"code":code,"message":message},"id":id}),
        status,
    )
}
pub async fn handle(state: AppState, request: Request) -> Response {
    if request.method() == "OPTIONS" {
        let mut r = StatusCode::NO_CONTENT.into_response();
        for (k, v) in [
            ("access-control-allow-origin", "*"),
            ("access-control-allow-methods", "GET, POST, DELETE, OPTIONS"),
            (
                "access-control-allow-headers",
                "Content-Type, Authorization, Mcp-Session-Id",
            ),
            ("access-control-max-age", "86400"),
        ] {
            r.headers_mut().insert(k, v.parse().unwrap());
        }
        return r;
    }
    let (email, client) = match oauth::http::admit(&state, request.headers()).await {
        Ok(p) => p,
        Err(403) => return error(403, -32000, "this identity is not allowed", Value::Null),
        Err(_) => {
            let challenge = format!(
                "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\"",
                oauth::http::origin(&state)
            );
            let mut r = response(
                json!({"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized: Authentication required","www-authenticate":challenge},"id":null}),
                401,
            );
            r.headers_mut()
                .insert("www-authenticate", challenge.parse().unwrap());
            r.headers_mut().insert(
                "access-control-expose-headers",
                "WWW-Authenticate".parse().unwrap(),
            );
            return r;
        }
    };
    // A supplied browser Origin is checked independently of bearer admission.
    if !oauth::http::same_origin(&state, request.headers(), false) {
        return error(403, -32000, "Invalid origin", Value::Null);
    }
    if let Some(version) = request
        .headers()
        .get("mcp-protocol-version")
        .and_then(|v| v.to_str().ok())
    {
        if ![
            "2025-11-25",
            "2025-06-18",
            "2025-03-26",
            "2024-11-05",
            "2024-10-07",
        ]
        .contains(&version)
        {
            return error(400,-32000,&format!("Bad Request: Unsupported protocol version: {version} (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"),Value::Null);
        }
    }
    match request.method().as_str() {
        "DELETE" => return StatusCode::OK.into_response(),
        "GET" => {
            if !request
                .headers()
                .get("accept")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|s| s.contains("text/event-stream"))
            {
                return error(
                    406,
                    -32000,
                    "Not Acceptable: Client must accept text/event-stream",
                    Value::Null,
                );
            }
            let stream = std::future::pending::<Result<bytes::Bytes, std::io::Error>>();
            // Keep the standalone SSE stream open without state or session IDs.
            let body = Body::from_stream(futures_stream(stream));
            let mut response = body.into_response();
            response
                .headers_mut()
                .insert("content-type", "text/event-stream".parse().unwrap());
            response
                .headers_mut()
                .insert("cache-control", "no-cache".parse().unwrap());
            return response;
        }
        "POST" => {}
        _ => {
            let mut r = error(405, -32000, "Method not allowed.", Value::Null);
            r.headers_mut()
                .insert("allow", "GET, POST, DELETE".parse().unwrap());
            return r;
        }
    }
    let accept = request
        .headers()
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return error(
            406,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
            Value::Null,
        );
    }
    if !request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"))
    {
        return error(
            415,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
            Value::Null,
        );
    }
    let bytes = match to_bytes(request.into_body(), 4 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return error(400, -32700, "Parse error: Invalid JSON", Value::Null),
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return error(400, -32700, "Parse error: Invalid JSON", Value::Null),
    };
    if value["jsonrpc"] != "2.0"
        || !value["method"].is_string()
        || value
            .get("id")
            .is_some_and(|id| !id.is_string() && !id.is_number())
    {
        return error(
            400,
            -32700,
            "Parse error: Invalid JSON-RPC message",
            Value::Null,
        );
    }
    let Some(id) = value.get("id") else {
        return StatusCode::ACCEPTED.into_response();
    };
    let method = value["method"].as_str().unwrap();
    if let Some(schema) = tools::corpus()["protocolSchemas"].get(method) {
        if let Err(e) =
            crate::operator::request_schema::parse_schema("mcp-request", schema, Some(&value))
        {
            return error(
                200,
                -32603,
                e.error
                    .strip_prefix("invalid request body: ")
                    .unwrap_or(&e.error),
                id.clone(),
            );
        }
    }
    let result = match method {
        "initialize" => {
            let mut result = tools::corpus()["observations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|o| o["request"]["label"] == "initialize")
                .unwrap()["body"]["result"]
                .clone();
            let requested = value["params"]["protocolVersion"].as_str().unwrap_or("");
            result["protocolVersion"] = json!(if [
                "2024-10-07",
                "2024-11-05",
                "2025-03-26",
                "2025-06-18",
                "2025-11-25"
            ]
            .contains(&requested)
            {
                requested
            } else {
                "2025-11-25"
            });
            result
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools":tools::corpus()["tools"]}),
        "tools/call" => {
            let name = value["params"]["name"].as_str().unwrap_or("");
            let descriptor = tools::corpus()["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name);
            if descriptor.is_some() {
                let args = value["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                let parsed = if name == "repositories.list" {
                    Ok(json!({}))
                } else {
                    crate::operator::request_schema::parse_schema(
                        name,
                        &tools::corpus()["validationSchemas"][name],
                        Some(&args),
                    )
                };
                match parsed {
                    Ok(args) => tools::call(&state, &email, &client, name, args).await,
                    Err(error) => {
                        let prefix = "invalid request body: ".to_owned();
                        let issues: Vec<Value> = error
                            .error
                            .strip_prefix(&prefix)
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or_default();
                        let message = issues
                            .iter()
                            .map(|i| {
                                let mut path = String::new();
                                for (index, part) in
                                    i["path"].as_array().into_iter().flatten().enumerate()
                                {
                                    if let Some(n) = part.as_u64() {
                                        path.push_str(&format!("[{n}]"));
                                    } else {
                                        if index > 0 {
                                            path.push('.');
                                        }
                                        path.push_str(part.as_str().unwrap_or(""));
                                    }
                                }
                                let message = i["message"].as_str().unwrap_or("Invalid input");
                                if path.is_empty() {
                                    message.to_owned()
                                } else {
                                    format!("{message} at {path}")
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        json!({"content":[{"type":"text","text":format!("MCP error -32602: Input validation error: Invalid arguments for tool {name}: {message}")}],"isError":true})
                    }
                }
            } else {
                json!({"content":[{"type":"text","text":format!("MCP error -32602: Tool {name} not found")}],"isError":true})
            }
        }
        _ => return error(200, -32601, "Method not found", id.clone()),
    };
    response(json!({"result":result,"jsonrpc":"2.0","id":id}), 200)
}
fn futures_stream<
    F: std::future::Future<Output = Result<bytes::Bytes, std::io::Error>> + Send + 'static,
>(
    future: F,
) -> impl futures_core::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send {
    futures_util::stream::once(future)
}
