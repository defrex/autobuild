//! Native hosted ticket persistence. All graph writers take the project counter
//! lock before ticket rows; revision checks and blocker batches share a transaction.
use super::error::OperatorError;
use crate::data::writer::PostgresWriter;
use chrono::{DateTime, SecondsFormat, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use tokio_postgres::{Row, Transaction};
pub mod machine;

fn storage(_: impl std::fmt::Display) -> OperatorError {
    OperatorError::internal()
}
fn refusal(message: impl Into<String>) -> OperatorError {
    OperatorError::refusal(message).with_code("refusal")
}
fn text<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap_or_default()
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn missing(id: &str) -> OperatorError {
    OperatorError::not_found(format!(
        "no ticket \"{id}\" in the configured database ticket source — ticket ids are source-local"
    ))
    .with_code("not-found")
}

#[derive(Clone, Debug)]
pub struct TicketPolicy {
    pub team_key: String,
    pub triage: String,
    pub ready: String,
    pub doing: String,
    pub done: String,
    pub create: String,
    pub proposal: String,
    pub base_branch: Option<String>,
}
impl TicketPolicy {
    pub fn from_config(config: &Value) -> Result<Self, OperatorError> {
        let t = &config["tickets"];
        if t["source"] != "hosted" {
            return Err(refusal("ticket operator backend is not configured"));
        }
        let state = |key: &str, fallback: &str| t[key].as_str().unwrap_or(fallback).to_owned();
        let triage = state("triageState", "triage");
        let result = Self {
            team_key: state("teamKey", ""),
            ready: state("readyState", "ready"),
            doing: state("claimedState", "doing"),
            done: state("doneState", "done"),
            create: state("createState", &triage),
            proposal: state("proposalState", &triage),
            triage,
            base_branch: config["baseBranch"].as_str().map(str::to_owned),
        };
        if result
            .configured()
            .iter()
            .any(|name| name.trim().is_empty())
        {
            return Err(OperatorError::internal());
        }
        Ok(result)
    }
    fn configured(&self) -> Vec<&str> {
        vec![
            &self.triage,
            &self.ready,
            &self.doing,
            &self.done,
            &self.create,
            &self.proposal,
        ]
    }
    fn lifecycle(&self) -> [&str; 4] {
        [&self.triage, &self.ready, &self.doing, &self.done]
    }
}

pub struct TicketService<'a> {
    pub writer: &'a PostgresWriter,
}

async fn seed(
    tx: &Transaction<'_>,
    repo: &str,
    policy: &TicketPolicy,
) -> Result<(), OperatorError> {
    tx.query_one(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 731926))",
        &[&repo],
    )
    .await
    .map_err(storage)?;
    let mut seen = BTreeSet::new();
    for name in policy.configured() {
        if seen.insert(name) {
            tx.execute(
                "INSERT INTO ab_ticket_states (repo,name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
                &[&repo, &name],
            )
            .await
            .map_err(storage)?;
        }
    }
    Ok(())
}
async fn state_infos(
    tx: &Transaction<'_>,
    repo: &str,
    policy: &TicketPolicy,
) -> Result<Vec<Value>, OperatorError> {
    seed(tx, repo, policy).await?;
    let rows = tx.query("SELECT s.name,s.about,count(t.id)::integer AS tickets FROM ab_ticket_states s LEFT JOIN ab_tickets t ON t.repo=s.repo AND t.state=s.name WHERE s.repo=$1 GROUP BY s.name,s.about", &[&repo]).await.map_err(storage)?;
    let mut states = rows
        .iter()
        .map(|r| {
            let mut value =
                json!({"name":r.get::<_,String>("name"),"tickets":r.get::<_,i32>("tickets")});
            if let Some(about) = r.get::<_, Option<String>>("about") {
                value["about"] = json!(about);
            }
            value
        })
        .collect::<Vec<_>>();
    let order = policy.lifecycle();
    states.sort_by(|a, b| {
        let a = text(a, "name");
        let b = text(b, "name");
        order
            .iter()
            .position(|v| *v == a)
            .unwrap_or(4)
            .cmp(&order.iter().position(|v| *v == b).unwrap_or(4))
            .then(a.cmp(b))
    });
    Ok(states)
}
pub fn resolve_state(name: &str, states: &[String]) -> Result<String, OperatorError> {
    if states.iter().any(|s| s == name) {
        return Ok(name.to_owned());
    }
    let matches = states
        .iter()
        .filter(|s| s.to_lowercase() == name.to_lowercase())
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [found] => Ok((*found).clone()),
        [] => Err(refusal(format!(
            "database ticket source: unknown state \"{name}\" — this tracker's states are {}",
            states.join(", ")
        ))),
        _ => Err(refusal(format!(
            "database ticket source: ambiguous state \"{name}\" — it matches the states {}",
            matches
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}
async fn state(
    tx: &Transaction<'_>,
    repo: &str,
    policy: &TicketPolicy,
    name: &str,
) -> Result<String, OperatorError> {
    let states = state_infos(tx, repo, policy)
        .await?
        .iter()
        .map(|v| text(v, "name").to_owned())
        .collect::<Vec<_>>();
    resolve_state(name, &states)
}
async fn lookup(
    tx: &Transaction<'_>,
    repo: &str,
    id: &str,
    lock: bool,
) -> Result<Option<Row>, OperatorError> {
    tx.query_opt(if lock { "SELECT *,revision::text AS revision_text FROM ab_tickets WHERE repo=$1 AND (id=$2 OR lower(readable_id)=lower($2)) FOR UPDATE" } else { "SELECT *,revision::text AS revision_text FROM ab_tickets WHERE repo=$1 AND (id=$2 OR lower(readable_id)=lower($2))" }, &[&repo,&id]).await.map_err(storage)
}
async fn require(
    tx: &Transaction<'_>,
    repo: &str,
    id: &str,
    operation: &str,
    lock: bool,
) -> Result<Row, OperatorError> {
    lookup(tx, repo, id, lock).await?.ok_or_else(|| {
        refusal(format!(
            "database ticket source: {operation} on unknown ticket \"{id}\""
        ))
    })
}
async fn blockers(
    tx: &Transaction<'_>,
    repo: &str,
    id: &str,
) -> Result<Vec<String>, OperatorError> {
    Ok(tx.query("SELECT t.readable_id FROM ab_ticket_blockers b JOIN ab_tickets t ON t.repo=b.repo AND t.id=b.blocker_id WHERE b.repo=$1 AND b.ticket_id=$2 ORDER BY t.readable_id",&[&repo,&id]).await.map_err(storage)?.iter().map(|r|r.get(0)).collect())
}
async fn record(
    tx: &Transaction<'_>,
    repo: &str,
    policy: &TicketPolicy,
    row: &Row,
    comments: bool,
) -> Result<Value, OperatorError> {
    let id: String = row.get("id");
    let title: String = row.get("title");
    let ticket_state: String = row.get("state");
    let mut out = json!({"ref":{"source":"database","id":row.get::<_,String>("readable_id"),"title":title},"revision":row.get::<_,String>("revision_text"),"kind":row.get::<_,String>("kind"),"title":title,"body":row.get::<_,String>("body"),"state":ticket_state,"resolved":ticket_state==policy.done,"labels":row.get::<_,Vec<String>>("labels")});
    if let Some(key) = row.get::<_, Option<String>>("creation_key") {
        out["creationKey"] = json!(key);
    }
    if let Some(target) = row.get::<_, Option<String>>("target_id") {
        out["target"] = json!(require(tx, repo, &target, "target", false)
            .await?
            .get::<_, String>("readable_id"));
    }
    let blocked_by = blockers(tx, repo, &id).await?;
    if !blocked_by.is_empty() {
        out["blockedBy"] = json!(blocked_by);
    }
    if comments {
        let rows=tx.query("SELECT body,created_at FROM ab_ticket_comments WHERE repo=$1 AND ticket_id=$2 ORDER BY created_at ASC,seq ASC",&[&repo,&id]).await.map_err(storage)?;
        out["comments"] = json!(rows
            .iter()
            .map(
                |r| json!({"body":r.get::<_,String>("body"),"createdAt":stamp(r.get("created_at"))})
            )
            .collect::<Vec<_>>());
    }
    Ok(out)
}
async fn graph_lock(tx: &Transaction<'_>, repo: &str) -> Result<(), OperatorError> {
    tx.execute(
        "INSERT INTO ab_ticket_counters (repo,last_number) VALUES ($1,0) ON CONFLICT DO NOTHING",
        &[&repo],
    )
    .await
    .map_err(storage)?;
    tx.query_one(
        "SELECT last_number FROM ab_ticket_counters WHERE repo=$1 FOR UPDATE",
        &[&repo],
    )
    .await
    .map_err(storage)?;
    Ok(())
}
async fn tree(
    tx: &Transaction<'_>,
    repo: &str,
    row: Option<&Row>,
    patch: &Value,
) -> Result<Option<String>, OperatorError> {
    if let Some(kind) = patch.get("kind") {
        if kind != "work" && kind != "node" {
            return Err(refusal("kind must be work or node"));
        }
    }
    if patch["target"]
        .as_str()
        .is_some_and(|s| s.trim().is_empty())
    {
        return Err(refusal("target must not be blank"));
    }
    if let Some(row) = row {
        if row.get::<_, String>("kind") == "node" && patch["kind"] == "work" {
            let id: String = row.get("id");
            if let Some(child) = tx
                .query_opt(
                    "SELECT readable_id FROM ab_tickets WHERE repo=$1 AND target_id=$2 LIMIT 1",
                    &[&repo, &id],
                )
                .await
                .map_err(storage)?
            {
                return Err(refusal(format!(
                    "cannot demote node: ticket {} targets it",
                    child.get::<_, String>(0)
                )));
            }
        }
    }
    let Some(target) = patch.get("target") else {
        return Ok(row.and_then(|r| r.get("target_id")));
    };
    if target.is_null() {
        return Ok(None);
    }
    let mut next = Some(
        target
            .as_str()
            .ok_or_else(|| refusal("target must be a string or null"))?
            .to_owned(),
    );
    let mut seen = BTreeSet::new();
    if let Some(row) = row {
        seen.insert(row.get::<_, String>("id"));
    }
    let mut target = None;
    while let Some(id) = next {
        let ancestor = require(tx, repo, &id, "target", false).await?;
        if ancestor.get::<_, String>("kind") != "node" {
            return Err(refusal(format!("target {id} is not a node")));
        }
        let key: String = ancestor.get("id");
        if !seen.insert(key.clone()) {
            return Err(refusal(format!("target {id} would create a cycle")));
        }
        if target.is_none() {
            target = Some(key);
        }
        next = ancestor.get("target_id");
    }
    Ok(target)
}
fn uuid() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = b.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "ticket-{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
fn label_set(labels: &[String]) -> BTreeSet<&str> {
    labels.iter().map(String::as_str).collect()
}
fn check_revision(id: &str, current: &str, expected: Option<&str>) -> Result<(), OperatorError> {
    if let Some(expected) = expected {
        if expected.trim().is_empty() {
            return Err(refusal("expected revision must be nonblank"));
        }
        if expected != current {
            return Err(OperatorError::new(
                409,
                "conflict",
                format!(
                "ticket \"{id}\" changed: expected revision {expected}, current revision {current}"
            ),
            ));
        }
    }
    Ok(())
}
pub enum TicketMutation<'a> {
    Update(&'a Value),
    Move(&'a str),
    Block { ids: &'a [String], remove: bool },
}

impl TicketService<'_> {
    async fn client(
        &self,
    ) -> Result<tokio::sync::MappedMutexGuard<'_, crate::data::writer::Connection>, OperatorError>
    {
        let connection = self.writer.client().await.map_err(storage)?;
        // Ticket tables have an independently versioned schema marker.
        let rows = connection
            .client
            .query(
                "SELECT version,checksum FROM ab_ticket_schema_migrations WHERE singleton=true",
                &[],
            )
            .await
            .map_err(storage)?;
        if rows.len() != 1
            || rows[0].get::<_, i32>("version") != 6
            || rows[0].get::<_, String>("checksum")
                != "713b937bc056188487767eac8e434980cf0068d5567e928a43feebab07db80d1"
        {
            return Err(OperatorError::internal());
        }
        Ok(connection)
    }

    /// Published policy is scoped to the latest registration; callers can supply
    /// an effective config only when no published policy exists.
    pub async fn policy(
        &self,
        repo: &str,
        fallback: Option<&Value>,
    ) -> Result<TicketPolicy, OperatorError> {
        let connection = self.client().await?;
        let row=connection.client.query_opt("SELECT p.policy FROM project_ticket_policy p JOIN LATERAL (SELECT seq,action FROM project_journal WHERE repo=$1 ORDER BY seq DESC LIMIT 1) r ON r.seq=p.registration AND r.action='added' WHERE p.repo=$1",&[&repo]).await.map_err(storage)?;
        if let Some(row) = row {
            let policy: Value = row.get(0);
            return TicketPolicy::from_config(&policy);
        }
        fallback
            .map(|config| {
                if config["tickets"]["source"] != "hosted" {
                    return Err(OperatorError::new(409, "conflict", format!("Tickets for project \"{repo}\" live in its own \"{}\" ticket source, accessed directly by its dispatcher.", text(&config["tickets"], "source"))).with_code("external-ticket-source"));
                }
                let mut legacy = config.clone();
                for (key, value) in [
                    ("triageState", "Backlog"),
                    ("claimedState", "Doing"),
                    ("doneState", "Done"),
                ] {
                    if legacy["tickets"].get(key).is_none() {
                        legacy["tickets"][key] = json!(value);
                    }
                }
                TicketPolicy::from_config(&legacy)
            })
            .unwrap_or_else(|| {
                Err(OperatorError::new(
                    409,
                    "conflict",
                    "Repository effective configuration unavailable",
                ))
            })
    }
    pub async fn states(&self, repo: &str, policy: &TicketPolicy) -> Result<Value, OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        let value = json!(state_infos(&tx, repo, policy).await?);
        tx.commit().await.map_err(storage)?;
        Ok(value)
    }
    pub async fn add_state(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        name: &str,
        about: Option<&str>,
    ) -> Result<Value, OperatorError> {
        validate_state_name(name)?;
        let about = about.map(str::trim);
        if about.is_some_and(|v| v.is_empty() || v.contains(['\r', '\n'])) {
            return Err(refusal(
                "database ticket source: a state purpose must be one nonblank line",
            ));
        }
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        let states = state_infos(&tx, repo, policy).await?;
        if let Some(clash) = states
            .iter()
            .find(|v| text(v, "name").to_lowercase() == name.to_lowercase())
        {
            return Err(refusal(format!("database ticket source: state \"{name}\" already exists as \"{}\"; state names are compared case-insensitively",text(clash,"name"))));
        }
        tx.execute(
            "INSERT INTO ab_ticket_states (repo,name,about) VALUES ($1,$2,$3)",
            &[&repo, &name, &about],
        )
        .await
        .map_err(storage)?;
        tx.commit().await.map_err(storage)?;
        let mut value = json!({"state":{"name":name,"tickets":0},"created":true});
        if let Some(about) = about {
            value["state"]["about"] = json!(about);
        }
        Ok(value)
    }
    pub async fn list(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        selected_state: Option<&str>,
        labels: Option<&[String]>,
    ) -> Result<Value, OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        let states = state_infos(&tx, repo, policy).await?;
        let selected_state = selected_state.unwrap_or(&policy.triage);
        let actual = resolve_state(
            selected_state,
            &states
                .iter()
                .map(|s| text(s, "name").to_owned())
                .collect::<Vec<_>>(),
        )
        .map_err(|_| OperatorError::internal())?;
        let filter = labels.unwrap_or(&[]).to_vec();
        let rows=tx.query("SELECT *,revision::text AS revision_text FROM ab_tickets WHERE repo=$1 AND state=$2 AND labels @> $3::text[] ORDER BY created_at,id",&[&repo,&actual,&filter]).await.map_err(storage)?;
        let mut tickets = Vec::new();
        for row in rows {
            tickets.push(record(&tx, repo, policy, &row, false).await?);
        }
        let mut criteria = json!({"state":selected_state});
        if let Some(labels) = labels {
            criteria["labels"] = json!(labels);
        }
        tx.commit().await.map_err(storage)?;
        Ok(
            json!({"states":states.iter().map(|s|s["name"].clone()).collect::<Vec<_>>(),"tickets":tickets,"diagnostics":[],"criteria":criteria,"triageState":policy.triage,"readyState":policy.ready}),
        )
    }
    pub async fn get(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        id: &str,
    ) -> Result<Value, OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        seed(&tx, repo, policy).await?;
        let row = lookup(&tx, repo, id, false)
            .await?
            .ok_or_else(|| missing(id))?;
        let ticket = record(&tx, repo, policy, &row, true).await?;
        tx.commit().await.map_err(storage)?;
        Ok(ticket)
    }
    /// Machine get follows TicketSource's nullable boundary; operator get keeps
    /// its source-local not-found diagnostic.
    pub async fn machine_get(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        id: &str,
    ) -> Result<Value, OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        seed(&tx, repo, policy).await?;
        let ticket = match lookup(&tx, repo, id, false).await? {
            Some(row) => record(&tx, repo, policy, &row, true).await?,
            None => Value::Null,
        };
        tx.commit().await.map_err(storage)?;
        Ok(ticket)
    }
    /// Machine listReady with absent state lists every state. Operator list
    /// deliberately retains its triage default and presentation envelope.
    pub async fn machine_list(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        selected_state: Option<&str>,
        labels: Option<&[String]>,
    ) -> Result<Value, OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        seed(&tx, repo, policy).await?;
        let selected = match selected_state {
            Some(name) => Some(state(&tx, repo, policy, name).await?),
            None => None,
        };
        let filter = labels.unwrap_or(&[]).to_vec();
        let rows = tx.query("SELECT *,revision::text AS revision_text FROM ab_tickets WHERE repo=$1 AND ($2::text IS NULL OR state=$2) AND labels @> $3::text[] ORDER BY created_at,id", &[&repo, &selected, &filter]).await.map_err(storage)?;
        let mut tickets = Vec::new();
        for row in rows {
            tickets.push(record(&tx, repo, policy, &row, false).await?);
        }
        tx.commit().await.map_err(storage)?;
        Ok(json!({"tickets": tickets, "diagnostics": []}))
    }
    pub async fn dependencies(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        ids: &[String],
    ) -> Result<Value, OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        let mut out = Vec::new();
        for id in ids {
            out.push(match lookup(&tx,repo,id,false).await? {
            None=>json!({"id":id,"exists":false,"resolved":false,"blockedBy":[]}),
            Some(row)=>json!({"id":id,"exists":true,"resolved":row.get::<_,String>("state")==policy.done,"blockedBy":blockers(&tx,repo,&row.get::<_,String>("id")).await?}),
        });
        }
        tx.commit().await.map_err(storage)?;
        Ok(json!(out))
    }
    pub async fn create(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        draft: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        // The operator's common operation wrapper validates blocker existence
        // before entering source create (including title/tree/state validation).
        {
            let mut connection = self.client().await?;
            let tx = connection.client.transaction().await.map_err(storage)?;
            known_blockers(&tx, repo, &strings(&draft["blockedBy"])).await?;
            tx.commit().await.map_err(storage)?;
        }
        if text(draft, "title").trim().is_empty() {
            return Err(refusal("database ticket create: title must be nonblank"));
        }
        if text(draft, "body").trim().is_empty() {
            return Err(refusal("database ticket create: body must be nonblank"));
        }
        if policy.team_key.trim().is_empty() {
            return Err(refusal("ticket teamKey must be nonblank"));
        }
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        graph_lock(&tx, repo).await?;
        let target = tree(&tx, repo, None, draft).await?;
        let actual_state = state(
            &tx,
            repo,
            policy,
            draft["state"].as_str().unwrap_or(&policy.create),
        )
        .await?;
        let ids = known_blockers(&tx, repo, &strings(&draft["blockedBy"])).await?;
        let high:i64=tx.query_one("SELECT GREATEST((SELECT last_number FROM ab_ticket_counters WHERE repo=$1),COALESCE(MAX(ticket_number),0)) AS high FROM ab_tickets WHERE repo=$1",&[&repo]).await.map_err(storage)?.get(0);
        let number = high
            .checked_add(1)
            .ok_or_else(|| refusal("ticket numbers exhausted"))?;
        tx.execute(
            "UPDATE ab_ticket_counters SET last_number=$2 WHERE repo=$1",
            &[&repo, &number],
        )
        .await
        .map_err(storage)?;
        let id = uuid();
        let readable = format!("{}-{number}", policy.team_key);
        let labels = strings(&draft["labels"]);
        let kind = draft["kind"].as_str().unwrap_or("work");
        let row=tx.query_one("INSERT INTO ab_tickets (repo,id,readable_id,ticket_number,title,body,state,labels,created_at,updated_at,kind,target_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) RETURNING *,revision::text AS revision_text",&[&repo,&id,&readable,&number,&text(draft,"title"),&text(draft,"body"),&actual_state,&labels,&now,&kind,&target]).await.map_err(storage)?;
        for blocker in ids {
            tx.execute("INSERT INTO ab_ticket_blockers (repo,ticket_id,blocker_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",&[&repo,&id,&blocker]).await.map_err(storage)?;
        }
        let ticket = record(&tx, repo, policy, &row, false).await?;
        tx.commit().await.map_err(storage)?;
        Ok(ticket)
    }
    pub async fn mutate(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        id: &str,
        mutation: TicketMutation<'_>,
        expected: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        // changeBlockers validates the entire input before entering the source
        // mutation (and therefore before its revision check).
        if let TicketMutation::Block { ids, remove } = &mutation {
            let mut connection = self.client().await?;
            let tx = connection.client.transaction().await.map_err(storage)?;
            lookup(&tx, repo, id, false)
                .await?
                .ok_or_else(|| missing(id))?;
            known_blockers(&tx, repo, ids).await?;
            if !remove && ids.iter().any(|blocker| blocker == id) {
                return Err(refusal(format!(
                    "ticket \"{id}\" in the configured database ticket source cannot block itself"
                )));
            }
            tx.commit().await.map_err(storage)?;
        }
        // Unguarded operator blocker edits intentionally retain the source's
        // per-id commit/revision boundaries after validating the complete batch.
        if let TicketMutation::Block { ids, remove } = &mutation {
            if expected.is_none() && ids.len() > 1 {
                {
                    let mut connection = self.client().await?;
                    let tx = connection.client.transaction().await.map_err(storage)?;
                    let row = lookup(&tx, repo, id, false)
                        .await?
                        .ok_or_else(|| missing(id))?;
                    let keys = known_blockers(&tx, repo, ids).await?;
                    if !remove && keys.contains(&row.get::<_, String>("id")) {
                        return Err(refusal(format!("ticket \"{id}\" in the configured database ticket source cannot block itself")));
                    }
                    tx.commit().await.map_err(storage)?;
                }
                let mut ticket = self.get(repo, policy, id).await?;
                let mut seen = BTreeSet::new();
                for blocker in *ids {
                    if !seen.insert(blocker) {
                        continue;
                    }
                    let one = [blocker.clone()];
                    ticket = Box::pin(self.mutate(
                        repo,
                        policy,
                        id,
                        TicketMutation::Block {
                            ids: &one,
                            remove: *remove,
                        },
                        None,
                        now,
                    ))
                    .await?;
                }
                return Ok(ticket);
            }
        }
        if let TicketMutation::Update(patch) = &mutation {
            validate_patch(patch)?;
        }
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        if matches!(&mutation,TicketMutation::Update(p) if p.get("kind").is_some()||p.get("target").is_some())
        {
            graph_lock(&tx, repo).await?;
        }
        let next_state = match &mutation {
            TicketMutation::Move(name) => Some(state(&tx, repo, policy, name).await?),
            _ => None,
        };
        let row = lookup(&tx, repo, id, true)
            .await?
            .ok_or_else(|| missing(id))?;
        let storage_id: String = row.get("id");
        check_revision(id, &row.get::<_, String>("revision_text"), expected)?;
        let mut changed = false;
        match mutation {
            TicketMutation::Update(patch) => {
                let target = tree(&tx, repo, Some(&row), patch).await?;
                let kind = patch["kind"].as_str().unwrap_or(" ");
                let old_kind: String = row.get("kind");
                let kind = if kind == " " { &old_kind } else { kind };
                let old_title: String = row.get("title");
                let title = patch["title"].as_str().unwrap_or(&old_title);
                let old_body: String = row.get("body");
                let body = patch["body"].as_str().unwrap_or(&old_body);
                let old_labels: Vec<String> = row.get("labels");
                let labels = patch
                    .get("labels")
                    .map(strings)
                    .unwrap_or_else(|| old_labels.clone());
                changed = kind != old_kind
                    || target != row.get::<_, Option<String>>("target_id")
                    || title != old_title
                    || body != old_body
                    || label_set(&labels) != label_set(&old_labels);
                if changed {
                    tx.execute("UPDATE ab_tickets SET kind=$3,target_id=$4,title=$5,body=$6,labels=$7 WHERE repo=$1 AND id=$2",&[&repo,&storage_id,&kind,&target,&title,&body,&labels]).await.map_err(storage)?;
                }
            }
            TicketMutation::Move(_) => {
                let next = next_state.unwrap();
                changed = row.get::<_, String>("state") != next;
                if changed {
                    tx.execute(
                        "UPDATE ab_tickets SET state=$3 WHERE repo=$1 AND id=$2",
                        &[&repo, &storage_id, &next],
                    )
                    .await
                    .map_err(storage)?;
                }
            }
            TicketMutation::Block { ids, remove } => {
                let keys = known_blockers(&tx, repo, ids).await?;
                if !remove && keys.contains(&storage_id) {
                    return Err(refusal(format!("ticket \"{id}\" in the configured database ticket source cannot block itself")));
                }
                for key in keys {
                    let count = if remove {
                        tx.execute("DELETE FROM ab_ticket_blockers WHERE repo=$1 AND ticket_id=$2 AND blocker_id=$3",&[&repo,&storage_id,&key]).await.map_err(storage)?
                    } else {
                        tx.execute("INSERT INTO ab_ticket_blockers (repo,ticket_id,blocker_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",&[&repo,&storage_id,&key]).await.map_err(storage)?
                    };
                    changed |= count > 0;
                }
            }
        }
        if changed {
            tx.execute(
                "UPDATE ab_tickets SET revision=revision+1,updated_at=$3 WHERE repo=$1 AND id=$2",
                &[&repo, &storage_id, &now],
            )
            .await
            .map_err(storage)?;
        }
        let row = require(&tx, repo, &storage_id, "read after mutation", false).await?;
        let ticket = record(&tx, repo, policy, &row, true).await?;
        tx.commit().await.map_err(storage)?;
        Ok(ticket)
    }
}
async fn known_blockers(
    tx: &Transaction<'_>,
    repo: &str,
    ids: &[String],
) -> Result<Vec<String>, OperatorError> {
    let mut keys = Vec::new();
    let mut unknown = Vec::new();
    let mut seen = BTreeSet::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        match lookup(tx, repo, id, false).await? {
            Some(row) => {
                let key: String = row.get("id");
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            None => unknown.push(format!("\"{id}\"")),
        }
    }
    if !unknown.is_empty() {
        return Err(OperatorError::not_found(format!(
            "no ticket {} in the configured database ticket source — blocker ids are source-local",
            unknown.join(", ")
        ))
        .with_code("not-found"));
    }
    Ok(keys)
}
pub fn validate_state_name(name: &str) -> Result<(), OperatorError> {
    let valid = (1..=40).contains(&name.len())
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(refusal(format!("database ticket source: invalid state name \"{name}\" — a state name is one to forty characters of lowercase letters, digits, and hyphens, starting with a letter")))
    }
}
pub fn validate_patch(patch: &Value) -> Result<(), OperatorError> {
    let Some(object) = patch.as_object() else {
        return Err(refusal(
            "invalid ticket update — Invalid input: expected object, received null",
        ));
    };
    let fields = ["kind", "target", "title", "body", "labels"];
    let unknown = object
        .keys()
        .filter(|key| !fields.contains(&key.as_str()))
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(refusal(format!(
            "invalid ticket update — Unrecognized key{}: {}",
            if unknown.len() == 1 { "" } else { "s" },
            unknown.join(", ")
        ))
        .with_code("refusal"));
    }
    if object.is_empty() {
        return Err(refusal("invalid ticket update — update must name at least one of title, body, labels, kind, or target"));
    }
    let mut issues = Vec::new();
    for key in ["target", "title", "body"] {
        if let Some(value) = object.get(key) {
            if key == "target" && value.is_null() {
                continue;
            }
            if !value.is_string() {
                issues.push(format!(
                    "{key}: Invalid input: expected string, received {}",
                    if value.is_null() {
                        "null"
                    } else {
                        "non-string"
                    }
                ));
            } else if value
                .as_str()
                .unwrap()
                .trim_matches(super::auth::js_space)
                .is_empty()
            {
                issues.push(format!("{key}: {key} must not be blank"));
            }
        }
    }
    if !issues.is_empty() {
        return Err(refusal(format!(
            "invalid ticket update — {}",
            issues.join("; ")
        )));
    }
    if let Some(kind) = object.get("kind") {
        if kind != "node" && kind != "work" {
            return Err(refusal(
                "invalid ticket update — kind: Invalid option: expected one of \"work\"|\"node\"",
            ));
        }
    }
    if let Some(labels) = object.get("labels") {
        if !labels
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string))
        {
            return Err(refusal(
                "invalid ticket update — labels: Invalid input: expected array of strings",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lifecycle_uses_published_policy_without_build_defaults() {
        let policy=TicketPolicy::from_config(&json!({"version":1,"tickets":{"source":"hosted","teamKey":"ENG","triageState":"Draft","readyState":"Ready","claimedState":"Working","doneState":"Done","createState":"Draft","proposalState":"Proposal"}})).unwrap();
        assert_eq!(policy.triage, "Draft");
        assert_eq!(policy.doing, "Working");
        assert_eq!(policy.proposal, "Proposal");
        assert_eq!(
            resolve_state("ready", &["Draft".into(), "Ready".into()]).unwrap(),
            "Ready"
        );
    }
    #[test]
    fn strict_update_preserves_bytes_and_rejects_empty_or_unknown_fields() {
        assert!(validate_patch(&json!({"body":"\n text  \n","labels":[]})).is_ok());
        assert!(validate_patch(&json!({"body":"  "}))
            .unwrap_err()
            .error
            .contains("body must not be blank"));
        assert!(validate_patch(&json!({"title":"ok","future":true})).is_err());
        assert!(validate_patch(&json!({})).is_err());
        assert!(validate_patch(&json!({"target":null})).is_ok());
    }
    #[test]
    fn state_names_and_revisions_match_hosted_contract() {
        assert!(validate_state_name("in-progress").is_ok());
        assert!(validate_state_name("In Progress").is_err());
        assert!(validate_state_name("").is_err());
        assert!(check_revision("ENG-1", "4", Some("4")).is_ok());
        assert_eq!(
            check_revision("ENG-1", "4", Some("3")).unwrap_err().error,
            "ticket \"ENG-1\" changed: expected revision 3, current revision 4"
        );
        assert_eq!(
            label_set(&["a".into(), "a".into(), "b".into()]),
            label_set(&["b".into(), "a".into()])
        );
    }
}

/// Resolve historical sources only through recorded migrations. Source-local ids
/// alone never associate a foreign provider's build with a hosted ticket.
pub fn migrated_hosted_id(reference: &Value, migrations: &Value) -> Option<String> {
    let mut source = text(reference, "source").to_owned();
    let mut id = text(reference, "id").to_owned();
    if source == "database" {
        source = "hosted".into();
    }
    let mut seen = BTreeSet::new();
    while source != "hosted" {
        if !seen.insert((source.clone(), id.clone())) {
            return None;
        }
        let route = migrations.as_array()?.iter().find(|m| {
            text(m, "from") == source && m["from"] != m["to"] && m["mapping"].get(&id).is_some()
        })?;
        id = route["mapping"][&id].as_str()?.to_owned();
        source = text(route, "to").to_owned();
    }
    Some(id)
}
fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
impl TicketService<'_> {
    pub async fn detail(
        &self,
        reader: &crate::data::reader::DataReader,
        repo: &str,
        policy: &TicketPolicy,
        id: &str,
    ) -> Result<Value, OperatorError> {
        let ticket = self.get(repo, policy, id).await?;
        self.decorate(reader, repo, policy, ticket).await
    }
    pub async fn decorate(
        &self,
        reader: &crate::data::reader::DataReader,
        repo: &str,
        policy: &TicketPolicy,
        ticket: Value,
    ) -> Result<Value, OperatorError> {
        let blockers = self
            .dependencies(repo, policy, &strings(&ticket["blockedBy"]))
            .await?;
        let records = reader.postgres().builds(repo).await.map_err(storage)?;
        let mut matches = Vec::new();
        if !records.is_empty() {
            let facts = match reader.repository(repo).await {
                Ok(facts) => facts,
                Err(crate::data::error::DataError::MissingScope {
                    scope: "repository",
                }) => json!({"repositoryReadFacts":{"ticketMigrations":{"migrations":[]}}}),
                Err(error) => return Err(storage(error)),
            };
            let migrations = &facts["repositoryReadFacts"]["ticketMigrations"]["migrations"];
            for record in records {
                let Some(id) = migrated_hosted_id(&record["ticket"], migrations) else {
                    continue;
                };
                if id != ticket["ref"]["id"].as_str().unwrap_or("") {
                    continue;
                }
                let state = reader
                    .build(repo, text(&record, "slug"))
                    .await
                    .map_err(storage)?;
                let active =
                    state["build"]["status"] != "done" && state["build"]["status"] != "aborted";
                matches.push((active, record, state["build"]["status"].clone()));
            }
        }
        matches.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(text(&b.1, "updatedAt").cmp(text(&a.1, "updatedAt")))
        });
        let build=matches.first().map(|(_,record,status)|json!({"slug":record["slug"],"status":status,"updatedAt":record["updatedAt"],"link":format!("#build-{}",encode_component(text(record,"slug")))})).unwrap_or(Value::Null);
        Ok(json!({"ticket":ticket,"blockers":blockers,"build":build}))
    }
}

#[cfg(test)]
mod association_tests {
    use super::*;
    #[test]
    fn source_association_requires_covered_continuity() {
        let migrations = json!([{"from":"file","to":"hosted","mapping":{"file-1":"ENG-10"}}]);
        assert_eq!(
            migrated_hosted_id(&json!({"source":"database","id":"ENG-10"}), &migrations),
            Some("ENG-10".into())
        );
        assert_eq!(
            migrated_hosted_id(&json!({"source":"file","id":"file-1"}), &migrations),
            Some("ENG-10".into())
        );
        assert_eq!(
            migrated_hosted_id(&json!({"source":"linear","id":"ENG-10"}), &migrations),
            None
        );
        assert_eq!(
            migrated_hosted_id(&json!({"source":"file","id":"file-2"}), &migrations),
            None
        );
        assert_eq!(encode_component("a/b c"), "a%2Fb%20c");
    }
}
