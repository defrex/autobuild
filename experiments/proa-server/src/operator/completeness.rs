//! Native live node membership observation. Publication samples tickets and
//! durable claims again; a historical ready cycle cannot authorize stale work.
use super::{
    control::{array, ControlService},
    error::OperatorError,
    tickets::{TicketPolicy, TicketService},
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
/// Strict counterpart of currentTicketRef, including the database/hosted alias
/// and source-aware diagnostics. Uncovered live claims must never alias IDs.
pub fn current_ref(
    reference: &Value,
    migrations: &Value,
    destination: &str,
    build: &str,
) -> Result<Value, String> {
    // proa-perf-ok(scope): This formats an API diagnostic; browser rendering escapes it.
    let output_destination = destination;
    let original_source = text(reference, "source");
    let original_id = text(reference, "id");
    let mut source =
        if original_source == "database" && matches!(destination, "database" | "hosted") {
            "hosted".to_owned()
        } else {
            original_source.to_owned()
        };
    let destination = if destination == "database" {
        "hosted"
    } else {
        destination
    };
    let mut id = original_id.to_owned();
    let mut visited = BTreeSet::new();
    while source != destination {
        if !visited.insert((source.clone(), id.clone())) {
            return Err(format!("ticket migration cycle at {source}:{id}"));
        }
        let routes = array(migrations)
            .iter()
            .filter(|m| text(m, "from") == source && m["from"] != m["to"])
            .collect::<Vec<_>>();
        let Some(route) = routes.iter().find(|m| m["mapping"].get(&id).is_some()) else {
            return Err(format!("build {build} ticket {original_source}:{original_id}: {}; record continuity with ab ticket migration record <export-dir>",if routes.is_empty(){"configured ticket source differs from the frozen node source"}else{"recorded migration does not cover id"}));
        };
        id = route["mapping"][&id]
            .as_str()
            .ok_or_else(|| "invalid ticket migration".to_owned())?
            .to_owned();
        source = text(route, "to").to_owned();
    }
    let mut result = reference.clone();
    result["source"] = json!(output_destination);
    result["id"] = json!(id);
    Ok(result)
}
#[derive(Clone)]
pub struct ClaimedBuild {
    pub record: Value,
    pub state: Value,
}
#[allow(clippy::too_many_arguments)]
fn put(
    display: &mut BTreeMap<(String, String), Value>,
    previous: &Value,
    contributions: &BTreeSet<String>,
    source: &str,
    id: &str,
    title: Option<&str>,
    contribution: Option<&str>,
    fresh: bool,
) {
    let key = (source.to_owned(), id.to_owned());
    let old = display.get(&key).or_else(|| {
        array(previous)
            .iter()
            .find(|v| text(v, "source") == source && text(v, "id") == id)
    });
    let mut item = old
        .cloned()
        .unwrap_or_else(|| json!({"source":source,"id":id}));
    let title = if fresh {
        title
    } else {
        old.and_then(|v| v["title"].as_str()).or(title)
    };
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        item["title"] = json!(title);
    }
    if let Some(contribution) = contribution {
        let mut builds = array(&item["builds"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        builds.insert(contribution.into());
        builds.retain(|b| contributions.contains(b));
        item["builds"] = json!(builds.into_iter().collect::<Vec<_>>());
    }
    display.insert(key, item);
}
fn project_inner(
    record: &Value,
    state: &Value,
    listing: &Value,
    builds: &[ClaimedBuild],
    migrations: &Value,
    progress: &mut Value,
) -> Result<Value, String> {
    if record["ticket"].is_null() {
        return Err("ticket source cannot establish exhaustive integration completeness".into());
    }
    let slug = text(record, "slug");
    let source = "database";
    let node_ref = current_ref(&record["ticket"], migrations, source, slug)?;
    progress["membershipSource"] = json!(source);
    progress["diagnostics"] = listing["diagnostics"].clone();
    let current = |record: &Value| {
        if record["ticket"].is_null() {
            Ok(None)
        } else {
            current_ref(&record["ticket"], migrations, source, text(record, "slug")).map(Some)
        }
    };
    let previous = &state["integration"]["observation"];
    let mut children = BTreeSet::<String>::new();
    let mut contributions = array(&previous["contributions"])
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let mut diagnostics = array(&listing["diagnostics"])
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for ticket in array(&listing["tickets"]) {
        if ticket["target"] == node_ref["id"] && ticket["resolved"] != true {
            children.insert(text(&ticket["ref"], "id").into());
        }
    }
    progress["openChildren"] = json!(children.iter().cloned().collect::<Vec<_>>());
    for child in builds {
        if child.state["target"]["build"] == slug
            && !matches!(child.state["status"].as_str(), Some("done" | "aborted"))
        {
            children.insert(
                current(&child.record)?
                    .map(|r| text(&r, "id").to_owned())
                    .unwrap_or_else(|| text(&child.record, "slug").into()),
            );
        }
        if ["parentRequest", "parentChange"].iter().any(|name| {
            let movement = &child.state["nodeRestack"][*name];
            !movement.is_null()
                && (movement["old"]["target"]["build"] == slug
                    || movement["next"]["target"]["build"] == slug)
        }) {
            children.insert(
                current(&child.record)?
                    .map(|r| text(&r, "id").to_owned())
                    .unwrap_or_else(|| text(&child.record, "slug").into()),
            );
        }
        if child.state["target"]["build"] == slug && child.state["prState"] == "merged" {
            contributions.insert(text(&child.record, "slug").into());
        }
        progress["openChildren"] = json!(children.iter().cloned().collect::<Vec<_>>());
        progress["contributions"] = json!(contributions.iter().cloned().collect::<Vec<_>>());
    }
    contributions.extend(
        array(&state["nodeRestack"]["inventory"]["contributions"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    progress["contributions"] = json!(contributions.iter().cloned().collect::<Vec<_>>());
    let mut display = BTreeMap::new();
    for contribution in &contributions {
        let record = builds
            .iter()
            .find(|b| text(&b.record, "slug") == contribution)
            .map(|b| &b.record);
        let identity = record.map(current).transpose()?.flatten();
        put(
            &mut display,
            &previous["children"],
            &contributions,
            identity
                .as_ref()
                .map(|v| text(v, "source"))
                .unwrap_or(source),
            identity
                .as_ref()
                .map(|v| text(v, "id"))
                .unwrap_or(contribution),
            record.and_then(|r| r["ticket"]["title"].as_str()),
            Some(contribution),
            false,
        );
    }
    for child in builds {
        let related = child.record["ticket"]["source"] == source
            || child.state["target"]["build"] == slug
            || contributions.contains(text(&child.record, "slug"));
        if related {
            let identity = current(&child.record)?;
            let id = identity
                .as_ref()
                .map(|v| text(v, "id"))
                .unwrap_or_else(|| text(&child.record, "slug"));
            if children.contains(id) {
                put(
                    &mut display,
                    &previous["children"],
                    &contributions,
                    identity
                        .as_ref()
                        .map(|v| text(v, "source"))
                        .unwrap_or(source),
                    id,
                    child.record["ticket"]["title"].as_str(),
                    None,
                    false,
                );
            }
        }
    }
    for child in builds {
        if child.record["ticket"].is_null()
            || child.state["target"]["build"] != slug
            || matches!(child.state["status"].as_str(), Some("done" | "aborted"))
        {
            continue;
        }
        let identity = current(&child.record)?.expect("ticket exists");
        if identity["source"] == child.record["ticket"]["source"]
            && identity["id"] == child.record["ticket"]["id"]
            && node_ref["source"] == record["ticket"]["source"]
            && node_ref["id"] == record["ticket"]["id"]
        {
            continue;
        }
        if let Some(entry) = display.get_mut(&(
            text(&identity, "source").into(),
            text(&identity, "id").into(),
        )) {
            let mut claims = array(&entry["claims"])
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            claims.insert(text(&child.record, "slug").into());
            entry["claims"] = json!(claims.into_iter().collect::<Vec<_>>());
        }
    }
    for ticket in array(&listing["tickets"]) {
        let key = (
            text(&ticket["ref"], "source").into(),
            text(&ticket["ref"], "id").into(),
        );
        if (ticket["ref"]["source"] == source && children.contains(text(&ticket["ref"], "id")))
            || display.contains_key(&key)
        {
            put(
                &mut display,
                &previous["children"],
                &contributions,
                text(&ticket["ref"], "source"),
                text(&ticket["ref"], "id"),
                ticket["title"].as_str(),
                None,
                true,
            );
        }
    }
    for id in &children {
        put(
            &mut display,
            &previous["children"],
            &contributions,
            source,
            id,
            None,
            None,
            false,
        );
    }
    if !diagnostics.is_empty() {
        for child in array(&previous["children"]) {
            display
                .entry((text(child, "source").into(), text(child, "id").into()))
                .or_insert_with(|| child.clone());
        }
    }
    let mut display = display.into_values().collect::<Vec<_>>();
    display.sort_by(|a, b| {
        crate::dashboard::cells::compare(text(a, "source"), text(b, "source"))
            .then_with(|| crate::dashboard::cells::compare(text(a, "id"), text(b, "id")))
    });
    diagnostics.sort();
    Ok(
        json!({"membershipSource":source,"openChildren":children.into_iter().collect::<Vec<_>>(),"diagnostics":diagnostics,"contributions":contributions.into_iter().collect::<Vec<_>>(),"children":display}),
    )
}
/// Preserve a failed observation's surviving prefix exactly as the TypeScript
/// try/catch does, including known contributions and source membership.
pub fn project(
    record: &Value,
    state: &Value,
    listing: &Value,
    builds: &[ClaimedBuild],
    migrations: &Value,
) -> Result<Value, String> {
    let previous = &state["integration"]["observation"];
    let mut progress = json!({"openChildren":[],"diagnostics":[],"contributions":previous["contributions"].as_array().cloned().unwrap_or_default()});
    for key in ["membershipSource", "children"] {
        if let Some(value) = previous.get(key) {
            progress[key] = value.clone();
        }
    }
    match project_inner(record, state, listing, builds, migrations, &mut progress) {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut diagnostics = array(&progress["diagnostics"])
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            diagnostics.push(error);
            diagnostics.sort();
            progress["diagnostics"] = json!(diagnostics);
            Ok(progress)
        }
    }
}
impl ControlService<'_> {
    pub async fn ticket_policy(&self, repo: &str) -> Result<Option<TicketPolicy>, OperatorError> {
        let service = TicketService {
            writer: self.writer,
        };
        match service.policy(repo, None).await {
            Ok(policy) => Ok(Some(policy)),
            Err(error) if error.error == "Repository effective configuration unavailable" => {
                match super::query::effective_config(self.reader, repo).await {
                    Ok(config) if config["tickets"]["source"] == "hosted" => {
                        service.policy(repo, Some(&config)).await.map(Some)
                    }
                    Ok(_) => Ok(None),
                    Err(error) if error.code.as_deref() == Some("effective-config-unavailable") => {
                        Ok(None)
                    }
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }
    pub async fn observe_completeness(
        &self,
        repo: &str,
        slug: &str,
        policy: &TicketPolicy,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        let record = self.require_build(repo, slug).await?;
        let state = self.state(repo, slug).await?;
        let previous = &state["integration"]["observation"];
        let observed: Result<Value,String> = async {
            // Match integrationObservationInputs: enumerate the source first,
            // then durable build claims, then migration evidence.
            let tickets = {
                let connection = self.writer.client().await.map_err(|error|error.to_string())?;
                let rows = connection.client.query(
                    "SELECT t.readable_id,t.title,t.state,p.readable_id AS target FROM ab_tickets t LEFT JOIN ab_tickets p ON p.repo=t.repo AND p.id=t.target_id WHERE t.repo=$1 ORDER BY t.created_at,t.id", &[&repo]
                ).await.map_err(|error|crate::data::writer::WriteError::database(error).to_string())?;
                rows.iter().map(|row| {
                    let id:String=row.get("readable_id");
                    let title:String=row.get("title");
                    let mut ticket=json!({"ref":{"source":"database","id":id},"title":title,"resolved":row.get::<_,String>("state")==policy.done});
                    if let Some(target)=row.get::<_,Option<String>>("target"){ticket["target"]=json!(target);}
                    ticket
                }).collect::<Vec<_>>()
            };
            let mut builds = Vec::new();
            for record in self.reader.postgres().builds(repo).await.map_err(|error|error.to_string())? {
                let state=self.state(repo,text(&record,"slug")).await.map_err(|error|error.to_string())?;
                builds.push(ClaimedBuild{record,state});
            }
            let repository=self.reader.repository(repo).await.map_err(|error|error.to_string())?;
            project(&record,&state,&json!({"tickets":tickets,"diagnostics":[]}),&builds,&repository["repositoryReadFacts"]["ticketMigrations"]["migrations"])
        }.await;
        let observation = match observed {
            Ok(value) => value,
            Err(message) => {
                let mut value = json!({"openChildren":[],"diagnostics":[message],"contributions":previous["contributions"].as_array().cloned().unwrap_or_default()});
                for name in ["membershipSource", "children"] {
                    if let Some(old) = previous.get(name) {
                        value[name] = old.clone();
                    }
                }
                value
            }
        };
        if observation != *previous {
            self.append(
                repo,
                slug,
                &json!({"kind":"dispatcher"}),
                "integration.observed",
                observation.clone(),
                now,
            )
            .await?;
        }
        Ok(observation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_node_observations_match_typescript_including_failure_prefixes() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/advanced-control-corpus.json"))
                .unwrap();
        let mut checked = 0;
        for fixture in corpus["fixtures"].as_array().unwrap() {
            let id = text(fixture, "id");
            if !id.starts_with("node-land-") {
                continue;
            }
            let seed = &fixture["seed"]["builds"];
            let builds = array(seed)
                .iter()
                .map(|b| ClaimedBuild {
                    record: b["record"].clone(),
                    state: b["state"].clone(),
                })
                .collect::<Vec<_>>();
            let actual = project(
                &builds[0].record,
                &builds[0].state,
                &json!({"tickets":fixture["tickets"],"diagnostics":[]}),
                &builds,
                &json!([]),
            )
            .unwrap();
            let expected = array(&fixture["after"]["builds"][0]["events"])
                .iter()
                .find(|e| e["type"] == "integration.observed")
                .unwrap();
            assert_eq!(actual, expected["payload"], "{id}");
            checked += 1;
        }
        assert_eq!(checked, 6);
    }
    #[test]
    fn live_claims_need_source_continuity_and_preserve_destination_namespace() {
        let reference = json!({"source":"file","id":"old","title":"Frozen"});
        assert!(current_ref(&reference, &json!([]), "database", "build")
            .unwrap_err()
            .contains("configured ticket source differs"));
        let migration = json!([{"from":"file","to":"hosted","mapping":{"old":"ENG-1"}}]);
        assert_eq!(
            current_ref(&reference, &migration, "database", "build").unwrap(),
            json!({"source":"database","id":"ENG-1","title":"Frozen"})
        );
        assert_eq!(
            current_ref(
                &json!({"source":"database","id":"ENG-1"}),
                &json!([]),
                "hosted",
                "build"
            )
            .unwrap()["source"],
            "hosted"
        );
    }
}
