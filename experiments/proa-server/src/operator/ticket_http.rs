//! Bearer ticket transport. Policy and persistence stay in the shared service.
use super::{
    auth::Principal,
    error::OperatorError,
    tickets::{TicketMutation, TicketPolicy, TicketService},
};
use crate::data::{reader::DataReader, writer::PostgresWriter};
use axum::http::{Method, Uri};
use serde_json::Value;

pub fn body(bytes: &[u8], operation: &str) -> Result<Value, OperatorError> {
    let schema = match operation {
        "create" => "ticketCreateRequestSchema",
        "update" => "ticketUpdateRequestSchema",
        "move" => "ticketMoveRequestSchema",
        "block" | "unblock" => "ticketBlockerRequestSchema",
        "state" => "ticketStateCreateRequestSchema",
        _ => return Err(OperatorError::internal()),
    };
    super::request_schema::parse(schema, bytes)
}

pub(crate) async fn policy(
    service: &TicketService<'_>,
    reader: &DataReader,
    repo: &str,
) -> Result<TicketPolicy, OperatorError> {
    match service.policy(repo, None).await {
        Ok(policy) => Ok(policy),
        Err(error) if error.error == "Repository effective configuration unavailable" => {
            let config = super::query::effective_config(reader, repo).await?;
            service.policy(repo, Some(&config)).await
        }
        Err(error) => Err(error),
    }
}
// Keep the explicit resource, authority and storage inputs visible at this boundary.
#[allow(clippy::too_many_arguments)]
pub async fn handle(
    method: &Method,
    segments: &[&str],
    repo: &str,
    principal: &Principal,
    reader: &DataReader,
    writer: &PostgresWriter,
    bytes: &[u8],
    uri: &Uri,
) -> Option<Result<(u16, Value), OperatorError>> {
    if segments.first() != Some(&"tickets") {
        return None;
    }
    Some(
        execute(
            method, segments, repo, principal, reader, writer, bytes, uri,
        )
        .await,
    )
}
// Keep the explicit resource, authority and storage inputs visible at this boundary.
#[allow(clippy::too_many_arguments)]
async fn execute(
    method: &Method,
    segments: &[&str],
    repo: &str,
    principal: &Principal,
    reader: &DataReader,
    writer: &PostgresWriter,
    bytes: &[u8],
    uri: &Uri,
) -> Result<(u16, Value), OperatorError> {
    principal.require_project(repo)?;
    principal.require_operator()?;
    let service = TicketService { writer };
    let policy = policy(&service, reader, repo).await?;
    match (method.as_str(), segments) {
        ("GET", ["tickets", "states"]) => Ok((200, service.states(repo, &policy).await?)),
        ("POST", ["tickets", "states"]) => {
            let request = body(bytes, "state")?;
            Ok((
                201,
                service
                    .add_state(
                        repo,
                        &policy,
                        request["name"].as_str().unwrap(),
                        request["about"].as_str(),
                    )
                    .await?,
            ))
        }
        ("GET", ["tickets"]) => {
            let query = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
                .collect::<Vec<_>>();
            let state = query
                .iter()
                .find(|(key, _)| key == "state")
                .map(|(_, value)| value.as_ref());
            let labels = query
                .iter()
                .filter(|(key, _)| key == "label")
                .map(|(_, value)| value.to_string())
                .collect::<Vec<_>>();
            let has_labels = query.iter().any(|(key, _)| key == "label");
            Ok((
                200,
                service
                    .list(
                        repo,
                        &policy,
                        state,
                        has_labels.then_some(labels.as_slice()),
                    )
                    .await?,
            ))
        }
        ("GET", ["tickets", id]) => Ok((200, service.detail(reader, repo, &policy, id).await?)),
        ("POST", ["tickets"]) => {
            let request = body(bytes, "create")?;
            let ticket = service
                .create(repo, &policy, &request, chrono::Utc::now())
                .await?;
            Ok((201, service.decorate(reader, repo, &policy, ticket).await?))
        }
        ("PATCH", ["tickets", id]) => {
            let mut request = body(bytes, "update")?;
            service.get(repo, &policy, id).await?;
            let expected = request.as_object_mut().unwrap().remove("expectedRevision");
            let now = chrono::Utc::now();
            let ticket = if request.get("target").is_some() {
                let config = super::query::effective_config(reader, repo).await?;
                super::ticket_target::update(
                    &service,
                    reader,
                    repo,
                    &policy,
                    id,
                    &request,
                    expected.as_ref().and_then(Value::as_str),
                    now,
                    &config,
                )
                .await?
            } else {
                service
                    .mutate(
                        repo,
                        &policy,
                        id,
                        TicketMutation::Update(&request),
                        expected.as_ref().and_then(Value::as_str),
                        now,
                    )
                    .await?
            };
            Ok((200, service.decorate(reader, repo, &policy, ticket).await?))
        }
        ("POST", ["tickets", id, operation])
            if matches!(*operation, "move" | "block" | "unblock") =>
        {
            let request = body(bytes, operation)?;
            service.get(repo, &policy, id).await?;
            let ids = request["blockerIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_str().unwrap().to_owned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mutation = if *operation == "move" {
                TicketMutation::Move(request["state"].as_str().unwrap())
            } else {
                TicketMutation::Block {
                    ids: &ids,
                    remove: *operation == "unblock",
                }
            };
            let ticket = service
                .mutate(
                    repo,
                    &policy,
                    id,
                    mutation,
                    request["expectedRevision"].as_str(),
                    chrono::Utc::now(),
                )
                .await?;
            Ok((200, service.decorate(reader, repo, &policy, ticket).await?))
        }
        _ => Err(OperatorError::not_found("operator route not found")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_body_keeps_null_target_and_preserves_prose_bytes() {
        let value = body(
            br#"{"title":"  Title  ","body":"\n prose\n","target":null}"#,
            "create",
        )
        .unwrap();
        assert_eq!(value["body"], "\n prose\n");
        assert_eq!(value["target"], Value::Null);
        assert_eq!(
            body(br#"{"target":"  ENG-1  "}"#, "update").unwrap()["target"],
            "ENG-1"
        );
        assert!(body(br#"{"expectedRevision":" "}"#, "update")
            .unwrap_err()
            .error
            .contains("expectedRevision must be nonblank"));
        assert!(body(br#"{"blockerIds":[]}"#, "block")
            .unwrap_err()
            .error
            .contains("Too small: expected array to have >=1 items"));
        assert!(body(br#"{"title":"ok","body":"x","extra":true}"#, "create")
            .unwrap_err()
            .error
            .contains("Unrecognized key: \\\"extra\\\""));
    }
}
