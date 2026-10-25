//! The machine branch is built separately so browser origin/cookie middleware
//! can never rewrite its requests. Normal binary wiring waits for the complete
//! route/validation/delegation contract; this constructor is exercised natively.
use super::{
    auth::{authenticate_project_bearer, ProjectPrincipal},
    error::ProtocolError,
    identity,
    store::{leases::LeaseKind, records::Scope, Store},
};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Copy)]
pub enum Authority {
    Project,
    Open,
}
#[derive(Clone)]
pub struct MachineState {
    pub store: Arc<Store>,
    pub authority: Authority,
}
pub fn router(state: MachineState) -> Router {
    Router::new().fallback(handle).with_state(state)
}
async fn handle(State(state): State<MachineState>, req: Request) -> Response {
    match dispatch(state, req).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}
fn unavailable() -> ProtocolError {
    ProtocolError::new(
        404,
        "not-found",
        "resource unavailable: unknown resource or wrong project",
    )
}
fn reply(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).expect("static status"),
        Json(super::js_json::serializable(value)),
    )
        .into_response()
}
fn path_segments(path: &str) -> Result<Vec<String>, ProtocolError> {
    path.split('/')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let bytes = part.as_bytes();
            for (i, byte) in bytes.iter().enumerate() {
                if *byte == b'%'
                    && (i + 2 >= bytes.len()
                        || !bytes[i + 1].is_ascii_hexdigit()
                        || !bytes[i + 2].is_ascii_hexdigit())
                {
                    return Err(ProtocolError::validation(format!("malformed path: {path}")));
                }
            }
            percent_encoding::percent_decode_str(part)
                .decode_utf8()
                .map(|part| part.into_owned())
                .map_err(|_| ProtocolError::validation(format!("malformed path: {path}")))
        })
        .collect()
}
async fn authorize(
    state: &MachineState,
    authorization: Option<&str>,
    path: &[String],
) -> Result<Option<ProjectPrincipal>, ProtocolError> {
    if matches!(state.authority, Authority::Open) {
        return Ok(None);
    }
    let token = super::auth::bearer_token(authorization)
        .map_err(|e| ProtocolError::new(e.status, e.kind, e.error))?;
    if !token.starts_with("abp_") {
        return Err(ProtocolError::new(
            401,
            "auth",
            super::auth::RETIRED_CREDENTIAL_MESSAGE,
        ));
    }
    if super::auth::parse_project_token(token).is_none() {
        return Err(ProtocolError::new(
            401,
            "auth",
            "unknown or revoked credential",
        ));
    }
    let client = state.store.database.client().await?;
    let principal = authenticate_project_bearer(&client, authorization, state.store.now())
        .await
        .map_err(|error| ProtocolError::new(error.status, error.kind, error.error))?;
    // Release the connection before indirect ownership reads acquire a slot.
    drop(client);
    if path.len() > 1 {
        let owning_repo = match path[0].as_str() {
            "repos" => Some(path[1].clone()),
            "builds" => state.store.get_record(Scope::Build(&path[1])).await?["repo"]
                .as_str()
                .map(str::to_owned),
            "sessions" => state.store.get_record(Scope::Session(&path[1])).await?["repo"]
                .as_str()
                .map(str::to_owned),
            _ => None,
        };
        if matches!(path[0].as_str(), "builds" | "sessions")
            && owning_repo.as_deref() != Some(principal.repo.as_str())
        {
            return Err(unavailable());
        }
        if let Some(repo) = owning_repo {
            principal
                .require_project(&repo)
                .map_err(|e| ProtocolError::new(e.status, e.kind, e.error))?;
        }
    }
    Ok(Some(principal))
}
fn enforce_via(
    principal: Option<&ProjectPrincipal>,
    actor: Option<&Value>,
) -> Result<(), ProtocolError> {
    if principal.is_some()
        && actor.is_some_and(|actor| actor["kind"] == "human" && actor.get("via").is_some())
    {
        return Err(ProtocolError::new(
            403,
            "auth",
            "token carries no via; it may not write delegated events",
        ));
    }
    Ok(())
}
async fn body(req: Request, schema: &str) -> Result<Value, ProtocolError> {
    body_with_limit(req, schema, None).await
}
async fn body_with_limit(
    req: Request,
    schema: &str,
    ceiling: Option<(usize, &str)>,
) -> Result<Value, ProtocolError> {
    let bytes = to_bytes(
        req.into_body(),
        ceiling.map(|(limit, _)| limit).unwrap_or(usize::MAX),
    )
    .await
    .map_err(|error| {
        use std::error::Error;
        if error
            .source()
            .is_some_and(|cause| cause.is::<http_body_util::LengthLimitError>())
        {
            if let Some((_, message)) = ceiling {
                return ProtocolError::new(413, "validation", message);
            }
        }
        ProtocolError::validation("request body is not valid JSON")
    })?;
    let raw: Value = super::js_json::parse_js_json(&bytes)
        .map_err(|_| ProtocolError::validation("request body is not valid JSON"))?;
    super::validation::validate_request(schema, &raw)
        .map_err(|message| ProtocolError::validation(format!("invalid request body: {message}")))
}
async fn dispatch(state: MachineState, req: Request) -> Result<Response, ProtocolError> {
    let path = req.uri().path().to_owned();
    let segments = path_segments(&path)?;
    let method = req.method().as_str().to_owned();
    let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
    if method == "GET" && parts == ["health"] {
        return Ok(Json(identity::health_body()).into_response());
    }
    if !matches!(
        parts.first(),
        Some(&"repos" | &"builds" | &"sessions" | &"streams" | &"credentials")
    ) {
        return Err(ProtocolError::new(
            404,
            "not-found",
            format!("no route: {method} {path}"),
        ));
    }
    if let Some(error) = identity::current_identity_error(
        req.headers()
            .get("x-autobuild-version")
            .and_then(|h| h.to_str().ok()),
        req.headers()
            .get("x-autobuild-protocol-version")
            .and_then(|h| h.to_str().ok()),
    ) {
        return Err(ProtocolError::new(409, "conflict", error));
    }
    if parts.first() == Some(&"credentials") {
        return Err(ProtocolError::new(
            404,
            "not-found",
            if parts == ["credentials", "delegate"] && method == "POST" {
                "credential issuance unavailable".to_owned()
            } else {
                format!("no route: {method} {path}")
            },
        ));
    }
    if parts == ["sessions"] || parts == ["streams"] {
        return Err(ProtocolError::new(
            404,
            "not-found",
            format!("no route: {method} {path}"),
        ));
    }
    let authorization = req
        .headers()
        .get("authorization")
        .and_then(|header| header.to_str().ok())
        .map(str::to_owned);
    let principal = authorize(&state, authorization.as_deref(), &segments).await?;
    let scope = match parts.as_slice() {
        ["builds", id, ..] => Some(Scope::Build(id)),
        ["repos", id, ..] => Some(Scope::Repo(id)),
        ["sessions", id, ..] => Some(Scope::Session(id)),
        _ => None,
    };
    if let Some(scope @ Scope::Build(_)) = scope {
        if state.store.get_record(scope).await?.is_null() {
            return Err(ProtocolError::missing("build", scope.id()));
        }
    }
    if method == "GET" && parts == ["builds"] {
        return Ok(reply(
            200,
            state
                .store
                .list_builds(principal.as_ref().map(|p| p.repo.as_str()))
                .await?,
        ));
    }
    if method == "POST" && parts == ["repos"] {
        let value = body(req, "ensureRepo").await?;
        let repo = value["repo"].as_str().unwrap();
        if let Some(principal) = principal {
            principal
                .require_project(repo)
                .map_err(|e| ProtocolError::new(e.status, e.kind, e.error))?;
        }
        return Ok(reply(200, state.store.ensure_repo(repo).await?));
    }
    if method == "POST" && parts == ["builds"] {
        let mut value = body(req, "newBuild").await?;
        if let Some(principal) = principal {
            principal
                .require_project(value["repo"].as_str().unwrap())
                .map_err(|e| ProtocolError::new(e.status, e.kind, e.error))?;
            let prefix = String::from_utf16_lossy(
                &value["slug"]
                    .as_str()
                    .unwrap()
                    .encode_utf16()
                    .take(60)
                    .collect::<Vec<_>>(),
            );
            for _ in 0..10 {
                use rand::RngCore;
                let mut suffix = [0u8; 12];
                rand::thread_rng().fill_bytes(&mut suffix);
                let suffix: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
                value["slug"] = format!("{prefix}-{suffix}").into();
                value["branch"] = format!("ab/{}", value["slug"].as_str().unwrap()).into();
                match state.store.create_build(&value).await {
                    Ok(record) => return Ok(reply(201, record)),
                    Err(error)
                        if error.status == StatusCode::CONFLICT
                            && error.error.contains("already exists") =>
                    {
                        continue
                    }
                    Err(error) => return Err(error),
                }
            }
            return Err(ProtocolError::new(
                500,
                "internal",
                "build identity allocation failed",
            ));
        }
        let slug = value["slug"].as_str().unwrap();
        if !state.store.get_record(Scope::Build(slug)).await?.is_null() {
            return Err(ProtocolError::new(
                409,
                "conflict",
                format!("build \"{slug}\" already exists"),
            ));
        }
        return Ok(reply(201, state.store.create_build(&value).await?));
    }
    if parts.len() == 3 && parts[0] == "repos" && parts[2] == "sessions" && method == "POST" {
        let value = body(req, "newSession").await?;
        if value["repo"] != parts[1] {
            return Err(ProtocolError::new(403, "auth", "wrong project"));
        }
        return Ok(reply(
            201,
            state
                .store
                .create_session(
                    parts[1],
                    value["operator"].as_str().unwrap(),
                    value.get("title").and_then(Value::as_str),
                )
                .await?,
        ));
    }
    if parts.len() == 3 && parts[0] == "repos" && parts[2] == "operator-presence" {
        return match method.as_str() {
            "GET" => Ok(reply(
                200,
                state.store.list_operator_presence(parts[1]).await?,
            )),
            "POST" => {
                let value = body(req, "operatorPresence").await?;
                Ok(reply(
                    200,
                    state
                        .store
                        .upsert_operator_presence(parts[1], &value)
                        .await?,
                ))
            }
            _ => Err(ProtocolError::new(
                404,
                "not-found",
                "unknown operator presence route",
            )),
        };
    }
    if method == "POST" && parts.len() == 4 && parts[0] == "repos" && parts[2] == "tick" {
        let repo = parts[1];
        if parts[3] == "begin" {
            let value = body(req, "leaseHolder").await?;
            return Ok(reply(
                200,
                state
                    .store
                    .begin_repo_tick(repo, value["holder"].as_str().unwrap())
                    .await?,
            ));
        }
        if parts[3] == "finish" {
            let value = body(req, "finishRepoTick").await?;
            let events = value["events"].as_array().unwrap();
            for event in events {
                enforce_via(principal.as_ref(), event.get("actor"))?;
            }
            return Ok(reply(
                200,
                state
                    .store
                    .finish_repo_tick(
                        repo,
                        value["holder"].as_str().unwrap(),
                        &value["completion"],
                        events,
                    )
                    .await?,
            ));
        }
    }
    if let Some(scope) = scope {
        if parts.len() >= 3 && matches!(parts[2], "artifacts" | "artifact-list" | "deposits") {
            if parts.len() == 3 && parts[2] == "artifacts" {
                if method == "POST" {
                    let value = body(req, "putArtifact").await?;
                    return Ok(reply(201, state.store.put_artifact(scope, &value).await?));
                }
                if method == "GET" {
                    let kind = super::wire::parameter(req.uri().query(), "kind")
                        .filter(|k| !k.is_empty())
                        .ok_or_else(|| {
                            ProtocolError::validation("query parameter \"kind\" is required")
                        })?;
                    let rev = super::wire::int_parameter(req.uri().query(), "rev")?;
                    return Ok(reply(
                        200,
                        state.store.get_artifact(scope, &kind, rev).await?,
                    ));
                }
            }
            if method == "GET" && parts.len() == 3 && parts[2] == "artifact-list" {
                let kind = super::wire::parameter(req.uri().query(), "kind");
                return Ok(reply(
                    200,
                    state.store.list_artifacts(scope, kind.as_deref()).await?,
                ));
            }
            if method == "POST"
                && parts[2] == "deposits"
                && (parts.len() == 3
                    || (parts.len() == 4
                        && parts[3] == "conditional"
                        && matches!(scope, Scope::Build(_))))
            {
                let value = body(req, "deposits").await?;
                let expected = if matches!(scope, Scope::Build(_)) {
                    value.get("expectedSeq")
                } else {
                    None
                };
                if matches!(scope, Scope::Build(_)) {
                    if parts.len() == 4 && expected.is_none() {
                        return Err(ProtocolError::validation(
                            "conditional deposits require expectedSeq",
                        ));
                    }
                    if parts.len() == 3 && expected.is_some() {
                        return Err(ProtocolError::validation(
                            "use deposits/conditional for expectedSeq",
                        ));
                    }
                }
                if !matches!(scope, Scope::Session(_)) {
                    enforce_via(principal.as_ref(), value["event"].get("actor"))?;
                }
                let result = state.store.deposit(scope, &value, expected).await?;
                return Ok(reply(if result.is_null() { 200 } else { 201 }, result));
            }
        }
        if parts.len() == 4
            && parts[2] == "snapshots"
            && matches!(scope, Scope::Build(_) | Scope::Repo(_))
            && !parts[3].contains('/')
        {
            if matches!(scope, Scope::Repo(_)) && state.store.get_record(scope).await?.is_null() {
                return Err(ProtocolError::missing("repo", scope.id()));
            }
            super::store::snapshots::validate_snapshot_reducer(parts[3])?;
            return match method.as_str() {
                "GET" => {
                    let version = super::wire::int_parameter(req.uri().query(), "version")?
                        .filter(|v| *v >= 1)
                        .ok_or_else(|| {
                            ProtocolError::validation("query parameter \"version\" is required")
                        })?;
                    Ok(reply(
                        200,
                        state.store.get_snapshot(scope, parts[3], version).await?,
                    ))
                }
                "PUT" => {
                    let value = body_with_limit(
                        req,
                        "snapshotPut",
                        Some((
                            super::store::snapshots::SNAPSHOT_BODY_MAX_BYTES,
                            "snapshot body is over the 16 MiB ceiling",
                        )),
                    )
                    .await?;
                    Ok(reply(
                        200,
                        json!({"written":state.store.put_snapshot(scope,parts[3],&value).await?}),
                    ))
                }
                _ => Err(ProtocolError::new(
                    404,
                    "not-found",
                    format!("no route: {method} snapshots/{}", parts[3]),
                )),
            };
        }
        if method == "GET" && parts.len() == 3 && parts[2] == "events" {
            let since = super::wire::int_parameter(req.uri().query(), "since")?.unwrap_or(0);
            let wait = super::wire::wait_parameter(req.uri().query())?;
            return Ok(reply(
                200,
                state.store.read_events_held(scope, since, wait).await?,
            ));
        }
        if method == "POST"
            && parts.get(2) == Some(&"events")
            && (parts.len() == 3
                || (parts.len() == 4
                    && parts[3] == "conditional"
                    && matches!(scope, Scope::Build(_) | Scope::Session(_))))
        {
            let conditional = parts.len() == 4;
            let value = body(
                req,
                if conditional {
                    "conditionalEvent"
                } else {
                    "eventWrite"
                },
            )
            .await?;
            let input = if conditional { &value["event"] } else { &value };
            let event = if matches!(scope, Scope::Session(_)) {
                let expected = if conditional {
                    Some(
                        value["expectedSeq"]
                            .as_i64()
                            .or_else(|| value["expectedSeq"].as_f64().map(|n| n as i64))
                            .ok_or_else(ProtocolError::internal)?,
                    )
                } else {
                    None
                };
                state
                    .store
                    .append_session(scope.id(), input, expected)
                    .await?
            } else {
                enforce_via(principal.as_ref(), input.get("actor"))?;
                state
                    .store
                    .append_event(
                        scope,
                        input,
                        if conditional {
                            Some(&value["expectedSeq"])
                        } else {
                            None
                        },
                    )
                    .await?
            };
            return Ok(reply(if event.is_null() { 200 } else { 201 }, event));
        }
        if method == "GET" && parts.len() == 3 && parts[0] == "repos" && parts[2] == "high-water" {
            return Ok(reply(
                200,
                json!({"seq":state.store.high_water(scope).await?}),
            ));
        }
        if parts.len() == 2 && method == "GET" {
            let record = state.store.get_record(scope).await?;
            if record.is_null() && !matches!(scope, Scope::Session(_)) {
                return Err(ProtocolError::missing(scope.name(), scope.id()));
            }
            return Ok(reply(200, record));
        }
        if method == "GET" && parts.len() == 3 && parts[0] == "repos" && parts[2] == "state-events"
        {
            return Ok(reply(200, state.store.repo_state_events(scope.id()).await?));
        }
        if method == "GET" && parts.len() == 3 && parts[0] == "repos" {
            match parts[2] {
                "change-position" => {
                    return Ok(reply(
                        200,
                        json!({"position":state.store.change_position(scope.id()).await?}),
                    ))
                }
                "builds" => {
                    return Ok(reply(200, state.store.list_builds(Some(scope.id())).await?))
                }
                "sessions" => return Ok(reply(200, state.store.list_sessions(scope.id()).await?)),
                _ => {}
            }
        }
        if method == "POST"
            && parts.len() == 4
            && matches!(parts[0], "builds" | "repos")
            && (parts[2] == "lease" || (parts[2] == "node-writer" && parts[0] == "builds"))
        {
            let kind = if parts[2] == "node-writer" {
                LeaseKind::NodeWriter
            } else {
                LeaseKind::Execution
            };
            let action = parts[3];
            if matches!(action, "claim" | "heartbeat" | "release") {
                let value = body(
                    req,
                    if action == "claim" {
                        "leaseClaim"
                    } else {
                        "leaseHolder"
                    },
                )
                .await?;
                let holder = value["holder"].as_str().unwrap();
                let ok = match action {
                    "claim" => {
                        state
                            .store
                            .claim(
                                scope,
                                kind,
                                holder,
                                value["ttlMs"]
                                    .as_i64()
                                    .or_else(|| value["ttlMs"].as_f64().map(|value| value as i64))
                                    .ok_or_else(|| {
                                        ProtocolError::validation("invalid lease expiration")
                                    })?,
                            )
                            .await?
                    }
                    "heartbeat" => state.store.heartbeat(scope, kind, holder).await?,
                    _ => {
                        state.store.release(scope, kind, holder).await?;
                        true
                    }
                };
                return Ok(reply(200, json!({"ok":ok})));
            }
        }
    }
    if let Some(scope @ Scope::Repo(_)) = scope {
        if parts.get(2) != Some(&"sessions") && state.store.get_record(scope).await?.is_null() {
            return Err(ProtocolError::missing("repo", scope.id()));
        }
    }
    let missing_path = if parts.len() > 2 {
        match parts[0] {
            "builds" => format!("/builds/:slug/{}", parts[2..].join("/")),
            "repos" => format!("/repos/:repo/{}", parts[2..].join("/")),
            "sessions" => format!("/sessions/:id/{}", parts[2..].join("/")),
            _ => path,
        }
    } else {
        path
    };
    Err(ProtocolError::new(
        404,
        "not-found",
        format!("no route: {method} {missing_path}"),
    ))
}
