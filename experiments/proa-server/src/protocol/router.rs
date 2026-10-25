//! The machine branch is built separately so browser origin/cookie middleware
//! can never rewrite its requests. Normal binary wiring waits for the complete
//! route/validation/delegation contract; this constructor is exercised natively.
use super::{
    auth::authenticate_project_bearer,
    delegation::{self, Principal},
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
    pub secret: Option<String>,
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
async fn authenticate(
    state: &MachineState,
    authorization: Option<&str>,
) -> Result<Option<Principal>, ProtocolError> {
    if matches!(state.authority, Authority::Open) {
        return Ok(None);
    }
    let token = super::auth::bearer_token(authorization)
        .map_err(|e| ProtocolError::new(e.status, e.kind, e.error))?;
    if token.starts_with("abp_") {
        if super::auth::parse_project_token(token).is_none() {
            return Err(ProtocolError::new(
                401,
                "auth",
                "unknown or revoked credential",
            ));
        }
        let client = state.store.database.client().await?;
        let project = authenticate_project_bearer(&client, authorization, state.store.now())
            .await
            .map_err(|e| ProtocolError::new(e.status, e.kind, e.error))?;
        return Ok(Some(Principal::Project(project)));
    }
    let scope = state.secret.as_deref().and_then(|secret| {
        super::token::verify_token(secret, token, state.store.now().timestamp_millis())
    });
    let principal = match scope {
        Some(super::token::SignedScope::Delegated(claims)) => {
            delegation::authenticate_delegated(
                &state.store,
                claims,
                state.store.now().timestamp_millis(),
            )
            .await?
        }
        Some(super::token::SignedScope::Admin { user, .. }) => Principal::Admin { user },
        Some(super::token::SignedScope::Internal {
            repo, user, via, ..
        }) => {
            if !delegation::registered(&state.store, &repo).await? {
                return Err(ProtocolError::new(403, "auth", "project not registered"));
            }
            Principal::Internal {
                repo,
                user,
                via: via.map(|value| serde_json::to_value(value).expect("plain via")),
            }
        }
        _ => {
            return Err(ProtocolError::new(
                401,
                "auth",
                super::auth::RETIRED_CREDENTIAL_MESSAGE,
            ))
        }
    };
    Ok(Some(principal))
}
async fn authorize(
    state: &MachineState,
    authorization: Option<&str>,
    path: &[String],
    method: &str,
    raw_path: &str,
) -> Result<Option<Principal>, ProtocolError> {
    let principal = authenticate(state, authorization).await?;
    if let Some(principal) = &principal {
        principal.require_machine_access()?;
        if path.len() == 1
            && path[0] == "builds"
            && method != "GET"
            && matches!(principal, Principal::Delegated(_))
        {
            return Err(ProtocolError::new(
                403,
                "auth",
                "delegated credential cannot create builds",
            ));
        }
        let scope = match path.first().map(String::as_str) {
            Some("builds") if path.len() > 1 => Some(Scope::Build(&path[1])),
            Some("repos") if path.len() > 1 => Some(Scope::Repo(&path[1])),
            Some("sessions") if path.len() > 1 => Some(Scope::Session(&path[1])),
            _ => None,
        };
        delegation::authorize_resource(&state.store, principal, scope, method).await?;
        if let Some(scope) = scope {
            delegation::mutation_needs_body(principal, scope, method, path, raw_path)?;
        }
    }
    Ok(principal)
}
fn enforce_via(principal: Option<&Principal>, actor: Option<&Value>) -> Result<(), ProtocolError> {
    if let (Some(principal), Some(actor)) = (principal, actor) {
        delegation::enforce_via(principal, actor)?;
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
    if !parts
        .first()
        .is_some_and(|segment| MACHINE_NAMESPACES.contains(segment))
    {
        return Err(ProtocolError::new(
            404,
            "not-found",
            format!("no route: {method} {path}"),
        ));
    }
    let version = super::wire::header_text(req.headers(), "x-autobuild-version");
    let protocol = super::wire::header_text(req.headers(), "x-autobuild-protocol-version");
    if let Some(error) = identity::current_identity_error(version.as_deref(), protocol.as_deref()) {
        return Err(ProtocolError::new(409, "conflict", error));
    }
    let authorization = super::wire::header_text(req.headers(), "authorization");
    if parts.first() == Some(&"credentials") {
        if parts == ["credentials", "delegate"] && method == "POST" {
            let secret = state
                .secret
                .as_deref()
                .filter(|s| !s.is_empty())
                .filter(|_| matches!(state.authority, Authority::Project))
                .ok_or_else(|| {
                    ProtocolError::new(404, "not-found", "credential issuance unavailable")
                })?;
            let principal = authenticate(&state, authorization.as_deref())
                .await?
                .ok_or_else(ProtocolError::internal)?;
            let bytes = to_bytes(req.into_body(), usize::MAX)
                .await
                .map_err(|_| ProtocolError::validation("invalid JSON"))?;
            let raw = super::js_json::parse_js_json(&bytes)
                .map_err(|_| ProtocolError::validation("invalid JSON"))?;
            let target = super::token::parse_target(&raw)
                .ok_or_else(|| ProtocolError::validation("invalid delegation target"))?;
            let target = serde_json::to_value(target).expect("plain delegation target");
            let claims = delegation::issue_claims(
                &state.store,
                &principal,
                &target,
                state.store.now().timestamp_millis(),
            )
            .await?;
            let claims = super::token::parse_delegation_claims(&claims)
                .ok_or_else(ProtocolError::internal)?;
            return Ok(reply(
                200,
                json!({"token":super::token::mint_delegated_token(secret,&claims)}),
            ));
        }
        return Err(ProtocolError::new(
            404,
            "not-found",
            format!("no route: {method} {path}"),
        ));
    }
    if parts == ["sessions"] || parts == ["streams"] {
        return Err(ProtocolError::new(
            404,
            "not-found",
            format!("no route: {method} {path}"),
        ));
    }
    let principal = if parts.first() == Some(&"streams") {
        let value = authenticate(&state, authorization.as_deref()).await?;
        if let Some(principal) = &value {
            principal.require_machine_access()?;
        }
        value
    } else {
        authorize(&state, authorization.as_deref(), &segments, &method, &path).await?
    };
    if parts.first() == Some(&"streams") && parts.len() >= 2 {
        let record = state.store.get_stream(parts[1]).await?;
        if record.is_null() {
            return Err(unavailable());
        }
        let stream_scope = super::store::streams::record_scope(&record)?;
        if let Some(principal) = principal.as_ref() {
            if let Err(error) =
                delegation::authorize_resource(&state.store, principal, Some(stream_scope), &method)
                    .await
            {
                return Err(if error.status == StatusCode::FORBIDDEN {
                    unavailable()
                } else {
                    error
                });
            }
        }
        let req = mutation_request(&state, principal.as_ref(), stream_scope, &segments, req)
            .await
            .map_err(|error| {
                if error.status == StatusCode::FORBIDDEN {
                    unavailable()
                } else {
                    error
                }
            })?;
        return stream_route(&state, req, stream_scope, &parts[1..]).await;
    }
    let scope = match parts.as_slice() {
        ["builds", id, ..] => Some(Scope::Build(id)),
        ["repos", id, ..] => Some(Scope::Repo(id)),
        ["sessions", id, ..] => Some(Scope::Session(id)),
        _ => None,
    };
    let req = if let Some(scope) = scope {
        mutation_request(&state, principal.as_ref(), scope, &segments, req).await?
    } else {
        req
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
                .list_builds(principal.as_ref().and_then(Principal::repo))
                .await?,
        ));
    }
    if method == "POST" && parts == ["repos"] {
        let value = body(req, "ensureRepo").await?;
        let repo = value["repo"].as_str().unwrap();
        if let Some(principal) = principal {
            principal.require_project(repo)?;
        }
        return Ok(reply(200, state.store.ensure_repo(repo).await?));
    }
    if method == "POST" && parts == ["builds"] {
        let mut value = body(req, "newBuild").await?;
        if let Some(principal) = principal.filter(|p| !matches!(p, Principal::Admin { .. })) {
            principal.require_project(value["repo"].as_str().unwrap())?;
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
    if parts.len() >= 5 && parts[0] == "repos" && parts[2] == "tickets" && parts[4] == "assets" {
        return asset_route(&state, req, parts[1], parts[3], &parts[5..]).await;
    }
    if method == "GET"
        && parts.len() == 3
        && parts[0] == "repos"
        && parts[2] == "ticket-asset-limits"
    {
        return Ok(reply(200, asset_limits(&state)));
    }
    if method == "GET"
        && parts.len() >= 3
        && parts[0] == "builds"
        && parts[2] == "ticket-assets"
        && (parts.len() == 3 || (parts.len() == 4 && parts[3] == "file"))
    {
        let (kind, name) = asset_identity(req.uri().query())?;
        let path = if parts.len() == 4 {
            Some(
                super::wire::parameter(req.uri().query(), "path")
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| {
                        ProtocolError::validation("query parameter \"path\" is required")
                    })?,
            )
        } else {
            None
        };
        let rev = super::wire::int_parameter(req.uri().query(), "rev")?;
        let asset = state
            .store
            .get_pinned_ticket_asset(parts[1], &kind, &name, rev)
            .await?;
        return asset_read_reply(&state, asset, &kind, &name, path.as_deref());
    }
    if let Some(scope @ (Scope::Build(_) | Scope::Repo(_))) = scope {
        if parts.len() == 3 && parts[2] == "reducer-values" {
            if method != "POST" {
                return Err(ProtocolError::new(
                    404,
                    "not-found",
                    format!("no route: {method} reducer-values"),
                ));
            }
            let bytes = to_bytes(req.into_body(), 4096).await.map_err(|error| {
                use std::error::Error;
                if error
                    .source()
                    .is_some_and(|e| e.is::<http_body_util::LengthLimitError>())
                {
                    ProtocolError::new(413, "validation", "reducer request exceeds 4 KiB")
                } else {
                    ProtocolError::validation("request body is not valid JSON")
                }
            })?;
            let input = super::reducer_values::parse_reducer_request(&bytes)?;
            let mut result = state.store.get_reducer_value(scope, &input).await?;
            let catalog = result.as_object_mut().unwrap().remove("catalogIdentity");
            let mut response = reply(200, result);
            if let Some(catalog) = catalog.and_then(|v| v.as_str().map(str::to_owned)) {
                response.headers_mut().insert(
                    "x-autobuild-catalog-identity",
                    catalog.parse().map_err(|_| ProtocolError::internal())?,
                );
            }
            return Ok(response);
        }
    }
    if parts.len() == 3 && parts[0] == "repos" && parts[2] == "build-digests" {
        if method != "GET" {
            return Err(ProtocolError::new(
                404,
                "not-found",
                format!("no route: {method} /repos/:repo/build-digests"),
            ));
        }
        let supports_audit =
            identity::client_supports_integration_audit_pending(version.as_deref());
        let mut digests = state.store.repo_build_digests(parts[1]).await?;
        if !supports_audit {
            for digest in digests.as_array_mut().unwrap() {
                digest
                    .as_object_mut()
                    .unwrap()
                    .remove("integrationAuditPending");
            }
        }
        let mut response = reply(200, digests);
        response.headers_mut().insert(
            "x-autobuild-catalog-identity",
            identity::ServiceIdentity::current()
                .catalog_identity
                .parse()
                .map_err(|_| ProtocolError::internal())?,
        );
        return Ok(response);
    }
    if let Some(scope) = scope {
        if parts.get(2) == Some(&"streams") {
            if matches!(scope, Scope::Repo(_))
                && !(method == "POST" && parts.len() == 3)
                && state.store.get_record(scope).await?.is_null()
            {
                return Err(ProtocolError::missing("repo", scope.id()));
            }
            return stream_route(&state, req, scope, &parts[3..]).await;
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

async fn stream_route(
    state: &MachineState,
    req: Request,
    scope: Scope<'_>,
    rest: &[&str],
) -> Result<Response, ProtocolError> {
    let method = req.method().as_str().to_owned();
    let no_route = || {
        ProtocolError::new(
            404,
            "not-found",
            format!(
                "no route: {method} streams{}",
                if rest.is_empty() {
                    String::new()
                } else {
                    format!("/{}", rest.join("/"))
                }
            ),
        )
    };
    if rest.is_empty() {
        return match method.as_str() {
            "POST" => {
                let input = body(req, "createStream").await?;
                Ok(reply(
                    201,
                    state
                        .store
                        .create_stream(scope, input["label"].as_str().unwrap())
                        .await?,
                ))
            }
            "GET" => Ok(reply(200, state.store.list_streams(scope).await?)),
            _ => Err(no_route()),
        };
    }
    if rest.len() > 2 {
        return Err(no_route());
    }
    let id = rest[0];
    let record = state.store.get_stream(id).await?;
    if record.is_null() {
        return Err(unavailable());
    }
    let owning = super::store::streams::record_scope(&record)?;
    if owning.name() != scope.name() || owning.id() != scope.id() {
        return Err(unavailable());
    }
    if rest.len() == 1 {
        return if method == "GET" {
            Ok(reply(200, record))
        } else {
            Err(no_route())
        };
    }
    match (method.as_str(), rest[1]) {
        ("POST", "chunks") => {
            let input = body(req, "appendStream").await?;
            Ok(reply(
                201,
                state.store.append_stream_parts(id, &input["parts"]).await?,
            ))
        }
        ("GET", "chunks") => {
            let since = super::wire::int_parameter(req.uri().query(), "since")?.unwrap_or(0);
            let wait = super::wire::wait_parameter(req.uri().query())?;
            Ok(reply(200, state.store.read_stream(id, since, wait).await?))
        }
        ("POST", "close") => {
            let input = body(req, "closeStream").await?;
            Ok(reply(
                200,
                state
                    .store
                    .close_stream(id, input["outcome"].as_str().unwrap())
                    .await?,
            ))
        }
        _ => Err(no_route()),
    }
}

fn asset_limits(state: &MachineState) -> Value {
    use super::store::assets::{MAX_BYTES, MAX_ENTRIES};
    let bytes = state
        .store
        .asset_max_request_bytes
        .map(|max| {
            max.saturating_sub(1024 + MAX_ENTRIES * (256 + 64))
                .saturating_mul(3)
                / 4
        })
        .unwrap_or(MAX_BYTES)
        .min(MAX_BYTES);
    let mut value = json!({"maxBytes":bytes,"maxEntries":MAX_ENTRIES});
    if let Some(max) = state.store.asset_max_request_bytes {
        value["maxRequestBytes"] = max.into();
    }
    value
}
fn asset_identity(query: Option<&str>) -> Result<(String, String), ProtocolError> {
    let kind = super::wire::parameter(query, "kind").filter(|s| !s.is_empty());
    let name = super::wire::parameter(query, "name").filter(|s| !s.is_empty());
    match (kind, name) {
        (Some(kind), Some(name)) => Ok((kind, name)),
        _ => Err(ProtocolError::validation(
            "query parameters \"kind\" and \"name\" are required",
        )),
    }
}
fn check_asset_response(
    state: &MachineState,
    value: &Value,
    describe: &str,
) -> Result<(), ProtocolError> {
    if let Some(max) = state.store.asset_max_request_bytes {
        let bytes = serde_json::to_vec(&super::js_json::serializable(value.clone()))
            .map_err(|_| ProtocolError::internal())?
            .len();
        if bytes > max {
            return Err(ProtocolError::new(413,"validation",format!("ticket asset {describe} is {bytes} bytes encoded, over this deployment's {max}-byte response ceiling; it can only be fetched from a store with a higher ceiling")));
        }
    }
    Ok(())
}
fn asset_json(
    state: &MachineState,
    status: u16,
    value: Value,
    describe: &str,
) -> Result<Response, ProtocolError> {
    check_asset_response(state, &value, describe)?;
    Ok(reply(status, value))
}
fn asset_read_reply(
    state: &MachineState,
    asset: Value,
    kind: &str,
    name: &str,
    path: Option<&str>,
) -> Result<Response, ProtocolError> {
    if asset.is_null() {
        return Ok(reply(200, Value::Null));
    }
    if let Some(path) = path {
        let entry = asset["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|e| e["path"] == path && e["type"] == "file")
            .ok_or_else(|| {
                ProtocolError::new(
                    404,
                    "not-found",
                    format!("ticket asset {kind}/{name} has no file \"{path}\""),
                )
            })?;
        let encoded = entry["contentBase64"]
            .as_str()
            .ok_or_else(ProtocolError::internal)?;
        use base64::Engine;
        let size = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| ProtocolError::internal())?
            .len();
        return asset_json(
            state,
            200,
            json!({"contentBase64":encoded}),
            &format!("file \"{path}\" of {kind}/{name} ({size} bytes)"),
        );
    }
    asset_json(
        state,
        200,
        asset["meta"].clone(),
        &format!("{kind}/{name} manifest"),
    )
}
async fn asset_route(
    state: &MachineState,
    req: Request,
    repo: &str,
    ticket: &str,
    rest: &[&str],
) -> Result<Response, ProtocolError> {
    let method = req.method().as_str().to_owned();
    match (method.as_str(), rest) {
        ("POST", []) => {
            let bytes = to_bytes(req.into_body(), usize::MAX)
                .await
                .map_err(|_| ProtocolError::validation("request body is not valid JSON"))?;
            let limits = asset_limits(state);
            if let Some(max) = state.store.asset_max_request_bytes {
                if bytes.len() > max {
                    return Err(ProtocolError::new(413,"validation",format!("ticket asset exceeds this store's {}-byte limit (deployment request ceiling {max} bytes): request is {} bytes",limits["maxBytes"],bytes.len())));
                }
            }
            let raw = super::js_json::parse_js_json(&bytes)
                .map_err(|_| ProtocolError::validation("request body is not valid JSON"))?;
            let input = super::validation::validate_request("putTicketAsset", &raw)
                .map_err(|m| ProtocolError::validation(format!("invalid request body: {m}")))?;
            let (manifest, _, size) = super::store::assets::prepare_asset_with_limits(
                &input,
                limits["maxBytes"].as_u64().unwrap() as usize,
                limits["maxEntries"].as_u64().unwrap() as usize,
            )?;
            let kind = input["kind"].as_str().unwrap();
            let name = input["name"].as_str().unwrap();
            let worst = json!({"repo":repo,"ticketId":ticket,"kind":kind,"name":name,"revision":999_999_999,"layout":input["layout"],"size":size,"entries":manifest,"createdAt":"2026-01-01T00:00:00.000Z"});
            check_asset_response(state, &worst, &format!("{kind}/{name} manifest"))?;
            let meta = state.store.put_ticket_asset(repo, ticket, &input).await?;
            asset_json(state, 201, meta, &format!("{kind}/{name} manifest"))
        }
        ("GET", []) | ("GET", ["file"]) => {
            let (kind, name) = asset_identity(req.uri().query())?;
            let path = if rest.is_empty() {
                None
            } else {
                Some(
                    super::wire::parameter(req.uri().query(), "path")
                        .filter(|p| !p.is_empty())
                        .ok_or_else(|| {
                            ProtocolError::validation("query parameter \"path\" is required")
                        })?,
                )
            };
            let rev = super::wire::int_parameter(req.uri().query(), "rev")?;
            asset_read_reply(
                state,
                state
                    .store
                    .get_ticket_asset(repo, ticket, &kind, &name, rev)
                    .await?,
                &kind,
                &name,
                path.as_deref(),
            )
        }
        ("GET", ["list"]) => {
            let revisions =
                super::wire::parameter(req.uri().query(), "revisions").as_deref() == Some("1");
            let values = state
                .store
                .list_ticket_assets(repo, ticket, revisions)
                .await?;
            asset_json(state, 200, values, &format!("list for ticket \"{ticket}\""))
        }
        ("POST", ["remove"]) => {
            let input = body(req, "removeTicketAsset").await?;
            let kind = input["kind"].as_str().unwrap();
            let name = input["name"].as_str().unwrap();
            let live = state
                .store
                .get_ticket_asset(repo, ticket, kind, name, None)
                .await?;
            if !live.is_null() {
                check_asset_response(state, &live["meta"], &format!("{kind}/{name} manifest"))?;
            }
            Ok(reply(
                200,
                state
                    .store
                    .remove_ticket_asset(repo, ticket, kind, name)
                    .await?,
            ))
        }
        _ => Err(ProtocolError::new(
            404,
            "not-found",
            format!(
                "no route: {method} /repos/:repo/tickets/:id/assets/{}",
                rest.join("/")
            ),
        )),
    }
}

async fn mutation_request(
    state: &MachineState,
    principal: Option<&Principal>,
    scope: Scope<'_>,
    path: &[String],
    req: Request,
) -> Result<Request, ProtocolError> {
    let Some(principal) = principal else {
        return Ok(req);
    };
    let method = req.method().as_str().to_owned();
    let raw_path = req.uri().path().to_owned();
    if !delegation::mutation_needs_body(principal, scope, &method, path, &raw_path)? {
        return Ok(req);
    }
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, usize::MAX)
        .await
        .map_err(|_| ProtocolError::new(500, "internal", "request body read failed"))?;
    let raw = delegation::parse_authority_body(&bytes)?;
    delegation::authorize_mutation(
        &state.store,
        principal,
        scope,
        &method,
        path,
        &raw_path,
        &raw,
    )
    .await?;
    Ok(Request::from_parts(parts, axum::body::Body::from(bytes)))
}

pub const MACHINE_NAMESPACES: &[&str] = &["builds", "repos", "sessions", "streams", "credentials"];
/// Browser and machine services keep separate middleware. Preserve the full URI
/// when forwarding; nesting would strip the first resource segment.
pub fn is_machine_path(path: &str) -> bool {
    let first = path.split('/').find(|s| !s.is_empty()).unwrap_or("");
    let decoded = percent_encoding::percent_decode_str(first).decode_utf8_lossy();
    decoded == "health" || MACHINE_NAMESPACES.contains(&decoded.as_ref())
}
pub fn unavailable_router() -> Router {
    Router::new().fallback(unavailable_handle)
}
async fn unavailable_handle(req: Request) -> Response {
    let result = unavailable_dispatch(req);
    match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}
fn unavailable_dispatch(req: Request) -> Result<Response, ProtocolError> {
    let path = req.uri().path();
    let parts = path_segments(path)?;
    let method = req.method().as_str();
    if method == "GET" && parts == ["health"] {
        return Ok(Json(identity::health_body()).into_response());
    }
    if parts
        .first()
        .is_some_and(|s| MACHINE_NAMESPACES.contains(&s.as_str()))
    {
        let version = super::wire::header_text(req.headers(), "x-autobuild-version");
        let protocol = super::wire::header_text(req.headers(), "x-autobuild-protocol-version");
        if let Some(error) =
            identity::current_identity_error(version.as_deref(), protocol.as_deref())
        {
            return Err(ProtocolError::new(409, "conflict", error));
        }
        if parts == ["credentials", "delegate"] && method == "POST" {
            return Err(ProtocolError::new(
                404,
                "not-found",
                "credential issuance unavailable",
            ));
        }
        return Err(ProtocolError::new(
            503,
            "internal",
            "store backend unavailable",
        ));
    }
    Err(ProtocolError::new(
        404,
        "not-found",
        format!("no route: {method} {path}"),
    ))
}
