//! The documented HTTP registry face. Every mutator delegates to the same
//! native service as its typed HTTP route; no arbitrary store append is exposed.
use super::{
    auth::Principal, control::ControlService, error::OperatorError, request_schema, ticket_http,
};
use crate::{app::AppState, data::postgres::Scope};
use axum::http::{Method, Uri};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

pub struct Registry<'a> {
    pub state: &'a AppState,
    pub repo: &'a str,
    pub principal: &'a Principal,
    pub now: DateTime<Utc>,
}
impl Registry<'_> {
    pub async fn call(&self, name: &str, bytes: &[u8]) -> Result<Value, OperatorError> {
        let input = request_schema::decode_json(bytes)
            .map_err(|_| OperatorError::validation("request body is not valid JSON"))?;
        if !input.is_object() {
            return Err(OperatorError::validation(
                "tool input must be a JSON object",
            ));
        }
        if input["repo"] != self.repo {
            return Err(OperatorError::validation(format!(
                "body repo must match the path repository \"{}\"",
                self.repo
            )));
        }
        if !request_schema::tool_known(name) {
            return Err(OperatorError::not_found(format!("unknown tool \"{name}\"")));
        }
        let input = request_schema::parse_tool(name, &input)?;
        self.execute(name, input).await.map_err(|mut error| {
            if error.kind == "internal" {
                error.error = "operator tool is unavailable".into();
            }
            error
        })
    }
    async fn execute(&self, name: &str, mut input: Value) -> Result<Value, OperatorError> {
        let reader = self
            .state
            .data
            .as_deref()
            .ok_or_else(OperatorError::internal)?;
        let writer = self
            .state
            .writer
            .as_deref()
            .ok_or_else(OperatorError::internal)?;
        let service = ControlService {
            reader,
            writer,
            blobs: self.state.blobs.as_deref(),
        };
        let repo = self.repo;
        let slug = input["slug"].as_str().unwrap_or_default().to_owned();
        let actor = self.principal.actor();
        match name {
            "builds.list" => {
                super::query::builds(reader, repo, input["scope"].as_str().unwrap(), self.now).await
            }
            "builds.get" => super::query::get(reader, repo, &slug, self.now).await,
            "repository.status" => super::query::status(reader, repo, self.now).await,
            "harvest.status" => super::query::harvest(reader, repo).await,
            "builds.events" => {
                service.require_build(repo, &slug).await?;
                let cursor = input["cursor"].as_i64().unwrap();
                let wait = input["waitSeconds"].as_u64().unwrap();
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait);
                loop {
                    let events = reader
                        .postgres()
                        .events(repo, Scope::Build(&slug), cursor)
                        .await
                        .map_err(|_| OperatorError::internal())?;
                    if !events.is_empty() || tokio::time::Instant::now() >= deadline {
                        let cursor = events
                            .last()
                            .and_then(|e| e["seq"].as_i64())
                            .unwrap_or(cursor);
                        return Ok(json!({"events":events,"cursor":cursor}));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
            "builds.artifact" => {
                service.require_build(repo, &slug).await?;
                let kind = input["kind"].as_str().unwrap();
                let rev = input["rev"].as_i64();
                let scope = Scope::Build(&slug);
                let missing = || {
                    OperatorError::not_found(format!(
                        "artifact {kind}{} not found",
                        rev.map(|r| format!("@{r}")).unwrap_or_default()
                    ))
                };
                let meta = reader
                    .postgres()
                    .artifact(repo, scope, kind, rev)
                    .await
                    .map_err(|_| OperatorError::internal())?
                    .ok_or_else(missing)?;
                let bytes = reader
                    .artifact(repo, scope, kind, meta["revision"].as_i64())
                    .await
                    .map_err(|_| OperatorError::internal())?
                    .ok_or_else(missing)?;
                Ok(
                    json!({"meta":{"kind":meta["kind"],"revision":meta["revision"],"blobRef":meta["blobRef"],"createdAt":meta["createdAt"]},"contentBase64":STANDARD.encode(bytes)}),
                )
            }
            "builds.control" => {
                service
                    .control(
                        repo,
                        &slug,
                        &actor,
                        input["action"].as_str().unwrap(),
                        self.now,
                    )
                    .await
            }
            "builds.restack" => service.restack(repo, &slug, &actor, self.now).await,
            "builds.answer" => {
                input.as_object_mut().unwrap().remove("repo");
                input.as_object_mut().unwrap().remove("slug");
                service.answer(repo, &slug, &actor, &input, self.now).await
            }
            "repository.settings" => {
                service
                    .setting(repo, &actor, input["enabled"].as_bool(), self.now)
                    .await
            }
            "repository.bulk_control" => {
                service
                    .bulk(repo, &actor, input["action"].as_str().unwrap(), self.now)
                    .await
            }
            "harvest.control" => {
                service
                    .harvest(repo, &actor, input["run"].as_str(), self.now)
                    .await
            }
            "notes.read" => {
                let Some(meta) = reader
                    .postgres()
                    .artifact(repo, Scope::Repository, "operator-notes", None)
                    .await
                    .map_err(|e| match e {
                        crate::data::error::DataError::MissingScope { .. } => {
                            OperatorError::not_found("no repository notes")
                        }
                        _ => OperatorError::internal(),
                    })
                    .or_else(|e| {
                        if e.kind == "not-found" {
                            Ok(None)
                        } else {
                            Err(e)
                        }
                    })?
                else {
                    return Ok(json!({"document":"","revision":null,"metadata":null}));
                };
                let bytes = reader
                    .artifact(
                        repo,
                        Scope::Repository,
                        "operator-notes",
                        meta["revision"].as_i64(),
                    )
                    .await
                    .map_err(|_| OperatorError::internal())?
                    .ok_or_else(OperatorError::internal)?;
                let document = String::from_utf8_lossy(&bytes);
                Ok(
                    json!({"document":document.strip_prefix('\u{feff}').unwrap_or(&document),"revision":meta["revision"],"metadata":meta["metadata"]}),
                )
            }
            "notes.write" => {
                writer
                    .ensure_repo(repo, self.now)
                    .await
                    .map_err(|_| OperatorError::internal())?;
                let mut metadata = json!({"user":self.principal.user()});
                if let Some(via) = self.principal.via() {
                    metadata["via"] = via.clone();
                }
                let blobs = self
                    .state
                    .blobs
                    .as_deref()
                    .ok_or_else(OperatorError::internal)?;
                let meta = writer
                    .put_repo_artifact(
                        blobs,
                        repo,
                        "operator-notes",
                        input["document"].as_str().unwrap().as_bytes(),
                        &metadata,
                        self.now,
                    )
                    .await
                    .map_err(|_| OperatorError::internal())?;
                Ok(
                    json!({"revision":meta["revision"],"blobRef":meta["blobRef"],"createdAt":meta["createdAt"]}),
                )
            }
            "tickets.tree" => super::registry_views::ticket_tree(reader, writer, repo).await,
            "landings.list" => super::registry_views::landings(reader, repo).await,
            name if name.starts_with("tickets.") => {
                let id = input["id"].as_str().unwrap_or_default().to_owned();
                let (method, segments) = match name {
                    "tickets.states" => (Method::GET, vec!["tickets", "states"]),
                    "tickets.state.create" => (Method::POST, vec!["tickets", "states"]),
                    "tickets.list" => (Method::GET, vec!["tickets"]),
                    "tickets.get" => (Method::GET, vec!["tickets", id.as_str()]),
                    "tickets.create" => (Method::POST, vec!["tickets"]),
                    "tickets.update" => (Method::PATCH, vec!["tickets", id.as_str()]),
                    "tickets.move" => (Method::POST, vec!["tickets", id.as_str(), "move"]),
                    "tickets.block" => (Method::POST, vec!["tickets", id.as_str(), "block"]),
                    "tickets.unblock" => (Method::POST, vec!["tickets", id.as_str(), "unblock"]),
                    _ => return Err(OperatorError::internal()),
                };
                let mut url = url::Url::parse("http://registry.invalid/").unwrap();
                if name == "tickets.list" {
                    if let Some(state) = input["state"].as_str() {
                        url.query_pairs_mut().append_pair("state", state);
                    }
                    for label in input["labels"].as_array().into_iter().flatten() {
                        url.query_pairs_mut()
                            .append_pair("label", label.as_str().unwrap());
                    }
                }
                let uri: Uri = format!(
                    "/{}{}",
                    segments.join("/"),
                    url.query().map(|q| format!("?{q}")).unwrap_or_default()
                )
                .parse()
                .map_err(|_| OperatorError::internal())?;
                input.as_object_mut().unwrap().remove("repo");
                input.as_object_mut().unwrap().remove("id");
                let bytes = serde_json::to_vec(&input).unwrap();
                ticket_http::handle(
                    &method,
                    &segments,
                    repo,
                    self.principal,
                    reader,
                    writer,
                    &bytes,
                    &uri,
                )
                .await
                .ok_or_else(OperatorError::internal)?
                .map(|(_, v)| v)
            }
            _ => Err(OperatorError::internal()),
        }
    }
}
