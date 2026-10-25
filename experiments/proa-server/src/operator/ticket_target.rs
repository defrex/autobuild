//! Claimed node retarget reservations, ported from kernel/node-parent.ts. The
//! dispatcher alone accepts the effective parent after provider readback.
use super::{
    error::OperatorError,
    tickets::{migrated_hosted_id, TicketMutation, TicketPolicy, TicketService},
};
use crate::data::{reader::DataReader, writer::PostgresWriter};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::BTreeSet;
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn refusal(message: impl Into<String>) -> OperatorError {
    OperatorError::refusal(message).with_code("refusal")
}
fn storage(_: impl std::fmt::Display) -> OperatorError {
    OperatorError::internal()
}
fn internal() -> OperatorError {
    OperatorError::new(500, "internal", "operator API is unavailable")
}
pub fn node_parent_busy(state: &Value) -> Option<&'static str> {
    if matches!(state["status"].as_str(), Some("aborted" | "done"))
        || matches!(state["prState"].as_str(), Some("merged" | "closed"))
    {
        return Some("node is no longer open");
    }
    if state["pendingCommands"]
        .as_array()
        .is_some_and(|a| a.iter().any(|c| c["command"] == "abort"))
    {
        return Some("node is closing");
    }
    if !state["integration"]["intent"].is_null() && state["integration"]["landing"].is_null() {
        return Some("node is landing");
    }
    if state["nodeRestack"]["active"]["operation"] == "landing" {
        return Some("node has a reserved child landing");
    }
    None
}
async fn migrations(reader: &DataReader, repo: &str) -> Result<Value, OperatorError> {
    match reader.repository(repo).await {
        Ok(facts) => Ok(facts["repositoryReadFacts"]["ticketMigrations"]["migrations"].clone()),
        Err(crate::data::error::DataError::MissingScope {
            scope: "repository",
        }) => Ok(json!([])),
        Err(error) => Err(storage(error)),
    }
}

async fn newest(
    service: &TicketService<'_>,
    reader: &DataReader,
    repo: &str,
    policy: &TicketPolicy,
    ticket: &Value,
) -> Result<Option<Value>, OperatorError> {
    let records = reader.postgres().builds(repo).await.map_err(storage)?;
    if records.is_empty() {
        return Ok(None);
    }
    let migrations = migrations(reader, repo).await?;
    let mut matches = Vec::new();
    for record in records {
        let Some(id) = migrated_hosted_id(&record["ticket"], &migrations) else {
            continue;
        };
        let found = id == text(&ticket["ref"], "id")
            || service
                .get(repo, policy, &id)
                .await
                .ok()
                .is_some_and(|t| t["ref"]["id"] == ticket["ref"]["id"]);
        if found {
            matches.push(record);
        }
    }
    matches.sort_by(|a, b| {
        text(b, "createdAt")
            .cmp(text(a, "createdAt"))
            .then(text(b, "slug").cmp(text(a, "slug")))
    });
    if matches.len() > 1 && matches[0]["createdAt"] == matches[1]["createdAt"] {
        return Err(refusal(format!(
            "ticket {} has ambiguous build generations",
            text(&ticket["ref"], "id")
        )));
    }
    Ok(matches.into_iter().next())
}
async fn validate_tree(
    service: &TicketService<'_>,
    repo: &str,
    policy: &TicketPolicy,
    ticket: &Value,
    patch: &Value,
) -> Result<Option<String>, OperatorError> {
    // validateTicketTree is outside the TicketOperationError wrapper in the TS
    // target-change path: a tree-validation exception maps to generic HTTP 500.
    if patch["kind"] == "work" && ticket["kind"] == "node" {
        let connection = service.writer.client().await.map_err(storage)?;
        if connection.client.query_opt("SELECT child.id FROM ab_tickets child JOIN ab_tickets parent ON parent.repo=child.repo AND parent.id=child.target_id WHERE child.repo=$1 AND parent.readable_id=$2 LIMIT 1",&[&repo,&text(&ticket["ref"],"id")]).await.map_err(storage)?.is_some(){return Err(internal());}
    }
    if patch["target"].is_null() {
        return Ok(None);
    }
    let mut next = patch["target"].as_str().map(str::to_owned);
    let mut canonical = None;
    let mut seen = BTreeSet::from([text(&ticket["ref"], "id").to_owned()]);
    while let Some(id) = next {
        let node = service.get(repo, policy, &id).await.map_err(|error| {
            eprintln!("target lookup {id}: {error}");
            internal()
        })?;
        if node["kind"] != "node" || !seen.insert(text(&node["ref"], "id").to_owned()) {
            eprintln!(
                "invalid node {} seen {:?} ticket {} patch {}",
                node, seen, ticket, patch
            );
            return Err(internal());
        }
        if canonical.is_none() {
            canonical = Some(text(&node["ref"], "id").to_owned());
        }
        next = node["target"].as_str().map(str::to_owned);
    }
    Ok(canonical)
}
async fn claim(
    writer: &PostgresWriter,
    repo: &str,
    slug: &str,
    holder: &str,
    now: DateTime<Utc>,
) -> Result<bool, OperatorError> {
    let mut c = writer.client().await.map_err(storage)?;
    let tx = c.client.transaction().await.map_err(storage)?;
    let row=tx.query_opt("SELECT node_writer_holder,node_writer_expires_at FROM builds WHERE slug=$1 AND repo=$2 FOR UPDATE",&[&slug,&repo]).await.map_err(storage)?.ok_or_else(OperatorError::internal)?;
    if row
        .get::<_, Option<String>>("node_writer_holder")
        .is_some_and(|h| h != holder)
        && row
            .get::<_, Option<DateTime<Utc>>>("node_writer_expires_at")
            .is_some_and(|expiry| expiry > now)
    {
        return Ok(false);
    }
    let expires = now + chrono::Duration::milliseconds(60_000);
    let ttl = 60_000i64;
    tx.execute("UPDATE builds SET node_writer_holder=$2,node_writer_expires_at=$3,node_writer_ttl_ms=$4,updated_at=$5 WHERE slug=$1",&[&slug,&holder,&expires,&ttl,&now]).await.map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(true)
}
async fn release(
    writer: &PostgresWriter,
    repo: &str,
    slug: &str,
    holder: &str,
    now: DateTime<Utc>,
) -> Result<(), OperatorError> {
    let mut c = writer.client().await.map_err(storage)?;
    let tx = c.client.transaction().await.map_err(storage)?;
    tx.query_one(
        "SELECT slug FROM builds WHERE slug=$1 AND repo=$2 FOR UPDATE",
        &[&slug, &repo],
    )
    .await
    .map_err(storage)?;
    tx.execute("UPDATE builds SET node_writer_holder=NULL,node_writer_expires_at=NULL,node_writer_ttl_ms=NULL,updated_at=$3 WHERE slug=$1 AND node_writer_holder=$2",&[&slug,&holder,&now]).await.map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(())
}
async fn walk(
    reader: &DataReader,
    repo: &str,
    slug: &str,
    path: BTreeSet<String>,
    visited: &mut BTreeSet<String>,
) -> Result<(), OperatorError> {
    if path.contains(slug) {
        return Err(refusal(
            "parent change would create an effective or pending cycle",
        ));
    }
    if visited.contains(slug) {
        return Ok(());
    }
    let state = reader.build(repo, slug).await.map_err(storage)?;
    let state = &state["build"];
    let mut next_path = path;
    next_path.insert(slug.to_owned());
    let mut edges = BTreeSet::new();
    for edge in [
        &state["target"]["build"],
        &state["nodeRestack"]["parentRequest"]["next"]["target"]["build"],
    ] {
        if let Some(edge) = edge.as_str() {
            edges.insert(edge);
        }
    }
    for edge in edges {
        Box::pin(walk(reader, repo, edge, next_path.clone(), visited)).await?;
    }
    visited.insert(slug.to_owned());
    Ok(())
}
// Keep the explicit resource, authority and storage inputs visible at this boundary.
#[allow(clippy::too_many_arguments)]
async fn validate_parent(
    service: &TicketService<'_>,
    reader: &DataReader,
    repo: &str,
    policy: &TicketPolicy,
    record: &Value,
    ticket: &Value,
    desired: Option<&str>,
    config: &Value,
) -> Result<Value, OperatorError> {
    if newest(service, reader, repo, policy, ticket)
        .await?
        .as_ref()
        .map(|r| &r["slug"])
        != Some(&record["slug"])
    {
        return Err(refusal("source node generation changed"));
    }
    let state = reader
        .build(repo, text(record, "slug"))
        .await
        .map_err(storage)?;
    let state = &state["build"];
    if let Some(reason) = node_parent_busy(state) {
        return Err(refusal(reason));
    }
    if state["nodeOpened"].is_null() {
        return Err(refusal("node is not yet open"));
    }
    if !matches!(config["forge"].as_str(), Some("github" | "local-git")) {
        return Err(refusal(
            "forge does not support node PR retargeting; upgrade the plugin",
        ));
    }
    validate_tree(service, repo, policy, ticket, &json!({"target":desired})).await?;
    let mut parent = json!({"target":null,"branch":config["baseBranch"]});
    if let Some(id) = desired {
        let target_ticket = service.get(repo, policy, id).await?;
        let target = newest(service, reader, repo, policy, &target_ticket)
            .await?
            .ok_or_else(|| refusal(format!("target node {id} is not yet claimed")))?;
        let destination = reader
            .build(repo, text(&target, "slug"))
            .await
            .map_err(storage)?;
        let destination = &destination["build"];
        let busy = node_parent_busy(destination);
        if busy.is_some()
            || destination["kind"] != "node"
            || destination["nodeOpened"].is_null()
            || target["branch"].is_null()
        {
            return Err(refusal(format!(
                "target node {id}: {}",
                busy.unwrap_or("is not an open node")
            )));
        }
        parent = json!({"target":{"ticket":target_ticket["ref"],"build":target["slug"]},"branch":target["branch"]});
    }
    if let Some(slug) = parent["target"]["build"].as_str() {
        walk(
            reader,
            repo,
            slug,
            BTreeSet::from([text(record, "slug").to_owned()]),
            &mut BTreeSet::new(),
        )
        .await?;
    }
    Ok(parent)
}
/// The caller resolves effective config before entry, matching mutateOperatorTicket.
// Keep the explicit resource, authority and storage inputs visible at this boundary.
#[allow(clippy::too_many_arguments)]
pub async fn update(
    service: &TicketService<'_>,
    reader: &DataReader,
    repo: &str,
    policy: &TicketPolicy,
    id: &str,
    patch: &Value,
    expected: Option<&str>,
    now: DateTime<Utc>,
    config: &Value,
) -> Result<Value, OperatorError> {
    let ticket = service.get(repo, policy, id).await?;
    if let Some(expected) = expected {
        if ticket["revision"] != expected {
            return Err(OperatorError::new(
                409,
                "conflict",
                format!(
                    "ticket \"{}\" changed: expected revision {expected}, current revision {}",
                    text(&ticket["ref"], "id"),
                    text(&ticket, "revision")
                ),
            ));
        }
    }
    let desired = validate_tree(service, repo, policy, &ticket, patch).await?;
    let record = newest(service, reader, repo, policy, &ticket).await?;
    let mut canonical = patch.clone();
    canonical["target"] = json!(desired);
    let Some(record) = record else {
        return service
            .mutate(
                repo,
                policy,
                id,
                TicketMutation::Update(&canonical),
                expected,
                now,
            )
            .await;
    };
    let mut state = reader
        .build(repo, text(&record, "slug"))
        .await
        .map_err(storage)?["build"]
        .clone();
    let active = !matches!(state["status"].as_str(), Some("done" | "aborted"));
    let frozen = if state["target"].is_null() {
        None
    } else {
        Some(
            migrated_hosted_id(&state["target"]["ticket"], &migrations(reader, repo).await?)
                .ok_or_else(internal)?,
        )
    };
    let effective = match frozen {
        None => None,
        Some(id) => Some(
            service
                .get(repo, policy, &id)
                .await
                .ok()
                .map(|t| text(&t["ref"], "id").to_owned())
                .unwrap_or(id),
        ),
    };
    if state["kind"] != "node" {
        if active && desired != effective {
            return Err(refusal(
                "changing a claimed work ticket target requires abort and re-dispatch",
            ));
        }
        return service
            .mutate(
                repo,
                policy,
                id,
                TicketMutation::Update(&canonical),
                expected,
                now,
            )
            .await;
    }
    if desired == effective
        && state["nodeRestack"]["parentRequest"].is_null()
        && state["nodeRestack"]["parentChange"].is_null()
    {
        return service
            .mutate(
                repo,
                policy,
                id,
                TicketMutation::Update(&canonical),
                expected,
                now,
            )
            .await;
    }
    let holder = format!("parent-{}", ticket_uuid());
    let slug = text(&record, "slug");
    if !claim(service.writer, repo, slug, &holder, now).await? {
        return Err(refusal("node writer is busy; retry target change"));
    }
    let result=async {
        state=reader.build(repo,slug).await.map_err(storage)?["build"].clone();
        if ["parentRequest","parentChange","active"].iter().any(|k|!state["nodeRestack"][*k].is_null())||state["sessions"]["open"].as_array().is_some_and(|a|!a.is_empty()){return Err(refusal("node has a pending operation; retry after it settles"));}
        let next=validate_parent(service,reader,repo,policy,&record,&ticket,desired.as_deref(),config).await?;
        let request=json!({"id":holder,"old":{"target":state.get("target").unwrap_or(&Value::Null),"branch":state["baseBranch"]},"next":next,"revision":ticket["revision"]});
        let write=json!({"actor":{"kind":"dispatcher"},"type":"node.parent-requested","payload":request});
        if service.writer.append_build_if_current(repo,slug,state["lastSeq"].as_i64().unwrap_or(0),&write,now).await.map_err(storage)?.is_none(){return Err(refusal("node changed while reserving parent change; retry"));}
        let result=service.mutate(repo,policy,id,TicketMutation::Update(&canonical),expected,now).await;
        if let Err(error)=&result{if error.kind=="conflict" {
            let write=json!({"actor":{"kind":"dispatcher"},"type":"node.parent-cancelled","payload":{"id":holder,"reason":error.error}});
            service.writer.append_build(repo,slug,&write,now).await.map_err(storage)?;
        }}
        result
    }.await;
    let released = release(service.writer, repo, slug, &holder, now).await;
    released?;
    result
}
fn ticket_uuid() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let h = b.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_precedence_matches_node_parent() {
        assert_eq!(
            node_parent_busy(&json!({"status":"done","pendingCommands":[{"command":"abort"}]})),
            Some("node is no longer open")
        );
        assert_eq!(
            node_parent_busy(
                &json!({"status":"collecting","pendingCommands":[{"command":"abort"}]})
            ),
            Some("node is closing")
        );
        assert_eq!(
            node_parent_busy(&json!({"integration":{"intent":{},"landing":{}}})),
            None
        );
    }
}
