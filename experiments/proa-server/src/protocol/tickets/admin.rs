use super::{authority::Authority, grants, policy};
use crate::protocol::{
    delegation::Principal, error::ProtocolError, router::MachineState, token::DelegationKind,
};
use axum::{
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
fn reply(status: u16, v: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(v)).into_response()
}
fn object_keys(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.keys().all(|k| keys.contains(&k.as_str())))
}
fn string(v: &Value, key: &str, required: bool) -> bool {
    match v.get(key) {
        None => !required,
        Some(Value::String(s)) => !required || !s.is_empty(),
        _ => false,
    }
}
fn refused(message: &str) -> ProtocolError {
    ProtocolError::new(403, "auth", message)
}
pub async fn route(
    state: &MachineState,
    req: Request,
    authority: &Authority,
    operation: &str,
) -> Result<Response, ProtocolError> {
    let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(|_| ProtocolError::validation("request body is not valid JSON"))?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ProtocolError::validation("request body is not valid JSON"))?;
    if operation == "policy" {
        if !object_keys(&raw, &["context", "input"])
            || !object_keys(
                &raw["context"],
                &["teamKey", "repo", "claimedState", "createState"],
            )
            || !string(&raw["context"], "teamKey", true)
            || ["repo", "claimedState", "createState"]
                .iter()
                .any(|k| !string(&raw["context"], k, false))
            || raw.get("input").is_none()
            || (!raw["input"].is_null() && !policy::valid(&raw["input"]))
        {
            return Err(ProtocolError::validation("invalid ticket policy envelope"));
        }
        if raw["context"]
            .get("repo")
            .is_some_and(|v| v.as_str() == Some(""))
        {
            return Err(ProtocolError::validation("invalid ticket policy envelope"));
        }
        // Policy intentionally does not normalize the selector in the TS handler.
        let repo = raw["context"]["repo"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| authority.repo())
            .ok_or_else(|| refused("registered project policy is required"))?;
        authority.require_project(&repo)?;
        if !crate::protocol::delegation::registered(&state.store, &repo.as_str().into()).await? {
            return Err(refused("project not registered"));
        }
        if raw["input"].is_null() {
            if matches!(authority, Authority::Ordinary(Principal::Internal { .. }))
                || matches!(authority,Authority::Ordinary(Principal::Delegated(c)) if !matches!(c.kind,DelegationKind::HarvestRunner|DelegationKind::HarvestPhase))
            {
                return Err(refused("credential cannot read ticket policy"));
            }
            return Ok(reply(
                200,
                policy::get(state, &repo).await?.unwrap_or(Value::Null),
            ));
        }
        if !authority.owner() {
            return Err(refused(
                "only project or owner authority may publish ticket policy",
            ));
        }
        policy::put(state, &repo, &raw["input"], &authority.user()).await?;
        return Ok(reply(200, json!({"ok":true})));
    }
    if !object_keys(&raw, &["action", "repo", "execution", "kind", "id"])
        || !string(&raw, "repo", true)
        || !string(&raw, "execution", true) && raw.get("execution").is_some()
        || !string(&raw, "id", false)
        || !matches!(raw["action"].as_str(), Some("issue" | "renew" | "revoke"))
        || raw
            .get("kind")
            .is_some_and(|v| !matches!(v.as_str(), Some("runner" | "phase")))
    {
        return Err(ProtocolError::validation("invalid ticket grant request"));
    }
    let repo = super::normalize_repository(raw["repo"].as_str().unwrap())
        .ok_or_else(|| ProtocolError::validation("invalid project repository"))?;
    authority.require_project(&repo)?;
    let action = raw["action"].as_str().unwrap();
    let parent = match authority {
        Authority::Grant(g) => Some(g),
        _ => None,
    };
    if action == "issue" {
        let execution = raw["execution"].as_str().filter(|s| !s.is_empty());
        let kind = raw["kind"].as_str();
        if execution.is_none()
            || kind.is_none()
            || (authority.owner() && kind != Some("runner"))
            || parent.is_some_and(|p| Some(p.execution.as_str()) != execution)
            || (!authority.owner()
                && !parent.is_some_and(|p| p.kind == "runner" && kind == Some("phase")))
        {
            return Err(refused("ticket grant issuance forbidden"));
        }
        return Ok(reply(
            201,
            grants::issue(state, &repo, execution.unwrap(), kind.unwrap(), parent).await?,
        ));
    }
    let id = raw["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| parent.map(|p| p.id.as_str()));
    if id.is_none()
        || (!authority.owner()
            && !parent.is_some_and(|p| p.kind == "runner" && Some(p.id.as_str()) == id))
    {
        return Err(refused("ticket grant administration forbidden"));
    }
    grants::administer(state, action, &repo, id.unwrap()).await?;
    Ok(reply(200, json!({"ok":true})))
}
