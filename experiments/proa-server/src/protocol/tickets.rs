//! TicketSource machine transport, distinct from operator ticket presentation.
use super::{
    delegation::{self, Principal},
    error::ProtocolError,
    identity::{release_version, ReleaseVersion},
    router::MachineState,
    token::DelegationKind,
};
use crate::operator::{
    error::OperatorError,
    tickets::{machine::MachineWriteError, TicketMutation, TicketService},
};
use axum::{
    body::to_bytes,
    extract::Request,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;

mod schema;

pub const OPERATIONS: [&str; 13] = [
    "states",
    "list-ready",
    "get",
    "dependency-states",
    "add-state",
    "claim",
    "comment",
    "transition",
    "create",
    "update",
    "add-blocker",
    "remove-blocker",
    "mutate-if-revision",
];
pub const READ_OPERATIONS: [&str; 4] = ["states", "list-ready", "get", "dependency-states"];

/// The caller has identified the release and authenticated the bearer, but has
/// not applied BuildStore authority: ticket delegates have different rights.
pub async fn dispatch(
    state: &MachineState,
    req: Request,
    principal: Option<Principal>,
    parts: &[&str],
) -> Result<Response, ProtocolError> {
    let operation = parts.get(1).copied().unwrap_or("");
    if req.method() != "POST" || parts.len() != 2 || !OPERATIONS.contains(&operation) {
        return Err(ProtocolError::new(
            404,
            "not-found",
            format!("no route: {} {}", req.method(), req.uri().path()),
        ));
    }
    let principal = match principal {
        Some(principal) => Some(principal),
        None => {
            let authorization = super::wire::header_text(req.headers(), "authorization");
            super::router::authenticate(state, authorization.as_deref()).await?
        }
    }
    .ok_or_else(|| ProtocolError::new(401, "auth", "missing bearer credential"))?;
    authorize_operation(&principal, operation)?;
    let projection = TicketProjection::from_headers(req.headers())?;
    let bytes = to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(|_| ProtocolError::validation("request body is not valid JSON"))?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ProtocolError::validation("request body is not valid JSON"))?;
    schema::validate(operation, &raw)?;
    if operation == "create"
        && matches!(principal, Principal::Delegated(_))
        && raw["input"]["options"].get("requestedId").is_some()
    {
        return Err(ProtocolError::new(
            403,
            "auth",
            "only project or owner authority may request a ticket id",
        ));
    }
    let repo = repository(&principal, raw["context"]["repo"].as_str())?;
    principal.require_project(&repo)?;
    if !delegation::registered(&state.store, &repo.as_str().into()).await? {
        return Err(ProtocolError::new(403, "auth", "project not registered"));
    }
    let writer = state.store.database.ticket_writer()?;
    let service = TicketService { writer: &writer };
    // A context is never accepted as policy. Published policy is registration
    // bound; the legacy effective-config fallback is a later checkpoint.
    let policy = service.policy(&repo, None).await.map_err(source_error)?;
    let input = &raw["input"];
    let value = match operation {
        "states" => service.states(&repo, &policy).await.map_err(source_error)?,
        "get" => projection.project(
            service
                .machine_get(&repo, &policy, input["id"].as_str().unwrap())
                .await
                .map_err(source_error)?,
        ),
        "list-ready" => {
            let labels = input["labels"].as_array().map(|items| {
                items
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            });
            let mut listing = service
                .machine_list(&repo, &policy, input["state"].as_str(), labels.as_deref())
                .await
                .map_err(source_error)?;
            for ticket in listing["tickets"].as_array_mut().unwrap() {
                *ticket = projection.project(ticket.take());
            }
            listing
        }
        "dependency-states" => {
            let ids = input["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            service
                .dependencies(&repo, &policy, &ids)
                .await
                .map_err(source_error)?
        }
        "add-state" => service
            .add_state(
                &repo,
                &policy,
                input["name"].as_str().unwrap(),
                input["about"].as_str(),
            )
            .await
            .map_err(source_error)?,
        "claim" => {
            serde_json::json!({"claimed":service.machine_claim(&repo,&policy,input["id"].as_str().unwrap(),state.store.now()).await.map_err(source_error)?})
        }
        "comment" => {
            service
                .machine_comment(
                    &repo,
                    input["id"].as_str().unwrap(),
                    input["body"].as_str().unwrap(),
                    state.store.now(),
                )
                .await
                .map_err(source_error)?;
            serde_json::json!({"ok":true})
        }
        "create" => {
            let value = service
                .machine_create(
                    &repo,
                    &policy,
                    &input["draft"],
                    &input["options"],
                    state.store.now(),
                )
                .await
                .map_err(source_error)?;
            return Ok((StatusCode::CREATED, Json(projection.project(value))).into_response());
        }
        "update" | "transition" | "add-blocker" | "remove-blocker" | "mutate-if-revision" => {
            let guarded = operation == "mutate-if-revision";
            let mutation = if guarded { &input["mutation"] } else { input };
            let kind = if guarded {
                mutation["kind"].as_str().unwrap()
            } else {
                operation
            };
            let ids = if kind == "blockers" {
                mutation["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            } else {
                vec![mutation["blockerId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()]
            };
            let write = match kind {
                "update" => TicketMutation::Update(&mutation["patch"]),
                "transition" => TicketMutation::Move(mutation["state"].as_str().unwrap()),
                "blockers" | "add-blocker" | "remove-blocker" => TicketMutation::Block {
                    ids: &ids,
                    remove: kind == "remove-blocker" || mutation["operation"] == "unblock",
                },
                _ => unreachable!("validated mutation"),
            };
            match service.machine_mutate(&repo,&policy,input["id"].as_str().unwrap(),write,if guarded {input["expectedRevision"].as_str()} else {None},state.store.now()).await {
                Ok(())=>(),
                Err(MachineWriteError::Source(error))=>return Err(source_error(error)),
                Err(MachineWriteError::Revision {id,expected,current})=>return Ok((StatusCode::CONFLICT,Json(serde_json::json!({"kind":"conflict","error":format!("ticket \"{id}\" changed: expected revision {expected}, current revision {current}"),"id":id,"expectedRevision":expected,"currentRevision":current}))).into_response()),
            }
            serde_json::json!({"ok":true})
        }
        _ => unreachable!("known operation checked"),
    };
    Ok((StatusCode::OK, Json(value)).into_response())
}

fn authorize_operation(principal: &Principal, operation: &str) -> Result<(), ProtocolError> {
    principal.require_machine_access()?;
    if let Principal::Delegated(claims) = principal {
        let read = READ_OPERATIONS.contains(&operation);
        if !((read
            && matches!(
                claims.kind,
                DelegationKind::HarvestRunner | DelegationKind::HarvestPhase
            ))
            || (operation == "create" && claims.kind == DelegationKind::HarvestRunner))
        {
            return Err(ProtocolError::new(
                403,
                "auth",
                format!(
                    "delegated {} credential cannot perform ticket operation {operation}",
                    claims.kind.as_str(),
                ),
            ));
        }
    }
    Ok(())
}

fn source_error(error: OperatorError) -> ProtocolError {
    let message = error.error;
    if [
        "database ticket source: invalid state name",
        "database ticket source: a state purpose",
        "database ticket source: state ",
        "database ticket source: unknown state",
        "database ticket source: ambiguous state",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
        || message == "kind must be work or node"
        || message == "target must not be blank"
        || message.starts_with("target ")
            && (message.ends_with("is not a node") || message.ends_with("would create a cycle"))
        || message.starts_with("cannot demote node: ticket ")
    {
        return ProtocolError::validation(message);
    }
    if error.kind == "conflict" || error.code.as_deref() == Some("external-ticket-source") {
        return ProtocolError::new(409, "conflict", message);
    }
    let lower = message.to_lowercase();
    if lower.contains("unknown ticket")
        || lower.contains("unknown issue")
        || lower.contains("not found")
    {
        return ProtocolError::new(404, "not-found", message);
    }
    if error.kind == "internal" {
        return ProtocolError::internal();
    }
    ProtocolError::new(500, "internal", message)
}

fn repository(principal: &Principal, selected: Option<&str>) -> Result<String, ProtocolError> {
    if let Some(selected) = selected {
        return normalize_repository(selected).ok_or_else(|| {
            ProtocolError::validation("context.repo must name a normalized repository origin")
        });
    }
    principal
        .repo()
        .and_then(|repo| repo.to_scalar().ok())
        .ok_or_else(|| {
            ProtocolError::new(
                403,
                "auth",
                "owner ticket requests require context.repo naming a registered project",
            )
        })
}

/// Mirrors the repository identity admitted by the connection/registry contract.
/// HTTP userinfo is refused; SSH's transport username is not an identity.
pub fn normalize_repository(raw: &str) -> Option<String> {
    let value = raw.trim_matches(crate::operator::auth::js_space);
    if value.is_empty()
        || value
            .chars()
            .any(|c| crate::operator::auth::js_space(c) || "\\?#".contains(c))
    {
        return None;
    }
    let candidate = if value.contains("://") {
        value.to_owned()
    } else {
        // scp syntax deliberately excludes absolute remote paths and drives.
        let (host, path) = value.split_once(':')?;
        if path.starts_with('/')
            || host.len() == 1 && host.as_bytes()[0].is_ascii_alphabetic()
            || host.contains('/')
            || path.contains('@') && !host.contains('@')
        {
            return None;
        }
        let host = host.rsplit_once('@').map(|(_, host)| host).unwrap_or(host);
        format!("https://{host}/{path}")
    };
    let url = url::Url::parse(&candidate).ok()?;
    if !url.password().unwrap_or_default().is_empty()
        || !url.username().is_empty() && !matches!(url.scheme(), "ssh" | "git+ssh")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let scheme = match url.scheme() {
        "ssh" | "git" | "git+ssh" | "https" => "https",
        _ => return None,
    };
    let host = url.host_str()?;
    let mut path = url.path().to_owned();
    if path.to_ascii_lowercase().ends_with(".git/") {
        path.truncate(path.len() - 5);
    } else if path.to_ascii_lowercase().ends_with(".git") {
        path.truncate(path.len() - 4);
    }
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "/" || path.contains(['%', '\\']) {
        return None;
    }
    let authority = if let Some(port) = url.port() {
        format!("{host}:{port}")
    } else {
        host.to_owned()
    };
    Some(format!("{scheme}://{authority}{path}"))
}

#[derive(Clone, Copy)]
struct TicketProjection {
    version: ReleaseVersion,
    tree: bool,
    revisions: bool,
    comments: bool,
}
impl TicketProjection {
    fn from_headers(headers: &HeaderMap) -> Result<Self, ProtocolError> {
        let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
        let version = release_version(value("x-autobuild-version"))
            .ok_or_else(|| ProtocolError::validation("invalid client version"))?;
        Ok(Self {
            version,
            tree: value("x-autobuild-ticket-tree") == Some("1"),
            revisions: value("x-autobuild-ticket-revisions") == Some("1"),
            comments: value("x-autobuild-ticket-comments") == Some("1"),
        })
    }
    fn project(self, mut value: Value) -> Value {
        if let Some(object) = value.as_object_mut() {
            if !self.tree {
                object.shift_remove("kind");
                object.shift_remove("target");
            }
            if !self.revisions {
                object.shift_remove("revision");
            }
            if !self.comments {
                object.shift_remove("comments");
            }
            if self.version.major == 0 && self.version.minor <= 10 {
                object.shift_remove("resolved");
                object.shift_remove("blockersResolved");
            }
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn capability_flags_are_independent_and_unknown_values_do_not_opt_in() {
        let ticket = json!({"kind":"node","target":"ENG-1","revision":"3","comments":[],"resolved":false,"title":"x"});
        for mask in 0..8 {
            let mut headers = HeaderMap::new();
            headers.insert("x-autobuild-version", "1.0.1".parse().unwrap());
            for (bit, name) in [(1, "tree"), (2, "revisions"), (4, "comments")] {
                headers.insert(
                    format!("x-autobuild-ticket-{name}")
                        .parse::<axum::http::HeaderName>()
                        .unwrap(),
                    if mask & bit != 0 { "1" } else { "unknown" }
                        .parse()
                        .unwrap(),
                );
            }
            let out = TicketProjection::from_headers(&headers)
                .unwrap()
                .project(ticket.clone());
            assert_eq!(out.get("kind").is_some(), mask & 1 != 0);
            assert_eq!(out.get("target").is_some(), mask & 1 != 0);
            assert_eq!(out.get("revision").is_some(), mask & 2 != 0);
            assert_eq!(out.get("comments").is_some(), mask & 4 != 0);
            assert!(out.get("resolved").is_some());
        }
        let projection = TicketProjection {
            version: ReleaseVersion {
                major: 0,
                minor: 10,
                patch: 0,
            },
            tree: true,
            revisions: true,
            comments: true,
        };
        assert!(projection.project(ticket).get("resolved").is_none());
        assert_eq!(projection.project(Value::Null), Value::Null);
    }
    #[test]
    fn repository_identity_refuses_credentials_and_normalizes_transport() {
        for value in [
            "https://github.com/Owner/Repo.git",
            "git@github.com:Owner/Repo.git",
            "ssh://git@github.com/Owner/Repo.git",
        ] {
            assert_eq!(
                normalize_repository(value).as_deref(),
                Some("https://github.com/Owner/Repo")
            );
        }
        for value in [
            "owner/repo",
            "https://user@github.com/o/r",
            "git:pass@host:o/r",
            "https://host/",
            "https://host/o/r?q=x",
            "https://host/o%20r",
        ] {
            assert!(normalize_repository(value).is_none(), "{value}");
        }
    }
}
