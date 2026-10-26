//! Store-backed read tools not represented by a standalone HTTP route.
use super::{error::OperatorError, tickets::TicketService};
use crate::{
    dashboard::{cells::compare, tree},
    data::{postgres::Scope, reader::DataReader, writer::PostgresWriter},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub async fn ticket_tree(
    reader: &DataReader,
    writer: &PostgresWriter,
    repo: &str,
) -> Result<Value, OperatorError> {
    let service = TicketService { writer };
    let policy = super::ticket_http::policy(&service, reader, repo).await?;
    let root = policy
        .base_branch
        .as_deref()
        .ok_or_else(OperatorError::internal)?;
    let states = service.states(repo, &policy).await?;
    let mut tickets = HashMap::<String, Value>::new();
    for state in states.as_array().into_iter().flatten() {
        let listing = service
            .list(repo, &policy, state["name"].as_str(), None)
            .await?;
        for ticket in listing["tickets"].as_array().into_iter().flatten() {
            let id = ticket["ref"]["id"]
                .as_str()
                .ok_or_else(OperatorError::internal)?
                .to_owned();
            tickets.insert(id, ticket.clone());
        }
    }
    let mut ids: Vec<String> = tickets.keys().cloned().collect();
    ids.sort_by(|a, b| compare(a, b));
    let mut children = HashMap::<String, Vec<String>>::new();
    let mut roots = vec![];
    for id in &ids {
        let mut seen = HashSet::from([id.clone()]);
        let mut next = tickets[id]["target"].as_str();
        while let Some(target) = next {
            if !seen.insert(target.to_owned()) {
                return Err(OperatorError::internal());
            }
            let parent = tickets
                .get(target)
                .filter(|v| v["kind"] == "node")
                .ok_or_else(OperatorError::internal)?;
            next = parent["target"].as_str();
        }
        if let Some(target) = tickets[id]["target"].as_str() {
            children
                .entry(target.to_owned())
                .or_default()
                .push(id.clone());
        } else {
            roots.push(id.clone());
        }
    }
    fn entry(
        id: &str,
        tickets: &HashMap<String, Value>,
        children: &HashMap<String, Vec<String>>,
    ) -> Value {
        let nested: Vec<Value> = children
            .get(id)
            .into_iter()
            .flatten()
            .map(|id| entry(id, tickets, children))
            .collect();
        json!({"ticket":tickets[id],"children":nested})
    }
    Ok(
        json!({"root":root,"children":roots.iter().map(|id|entry(id,&tickets,&children)).collect::<Vec<_>>(),"diagnostics":[]}),
    )
}

pub async fn landings(reader: &DataReader, repo: &str) -> Result<Value, OperatorError> {
    let records = reader
        .postgres()
        .builds(repo)
        .await
        .map_err(|_| OperatorError::internal())?;
    let mut output = vec![];
    for record in records {
        let slug = record["slug"]
            .as_str()
            .ok_or_else(OperatorError::internal)?;
        let (reduced, facts, _) = reader
            .build_display(repo, slug)
            .await
            .map_err(|_| OperatorError::internal())?;
        let state = &reduced["build"];
        if matches!(state["status"].as_str(), Some("done" | "aborted")) {
            continue;
        }
        let mut steps = Value::Null;
        if !state["landing"]["decision"].is_null() {
            if let Some(bytes) = reader
                .artifact(
                    repo,
                    Scope::Build(slug),
                    state["verify"]["configPin"]["artifact"]["kind"]
                        .as_str()
                        .unwrap_or("build-runner-effective-config"),
                    state["verify"]["configPin"]["artifact"]["rev"].as_i64(),
                )
                .await
                .map_err(|_| OperatorError::internal())?
            {
                let config = super::config_schema::decode(&bytes, "build-runner-effective-config")
                    .map_err(|_| OperatorError::internal())?;
                steps = config["verify"]["steps"].clone();
                if !steps.is_array() {
                    return Err(OperatorError::internal());
                }
            }
        }
        let mut projected = tree::project(&record, state, &facts["restack"], &steps);
        if projected["consent"] == true {
            if steps.is_null() {
                projected["verification"]
                    .as_object_mut()
                    .unwrap()
                    .remove("expectedSteps");
            }
            projected["slug"] = json!(slug);
            output.push(projected);
        }
    }
    output.sort_by(|a, b| compare(a["slug"].as_str().unwrap(), b["slug"].as_str().unwrap()));
    Ok(json!(output))
}
