//! Registration-bound hosted policy; context never acts as configuration.
use crate::protocol::{error::ProtocolError, router::MachineState};
use serde_json::Value;
pub fn valid(policy: &Value) -> bool {
    let Some(object) = policy.as_object() else {
        return false;
    };
    if object.len() != 2 || policy["version"].as_f64() != Some(1.0) {
        return false;
    }
    let Some(t) = policy["tickets"].as_object() else {
        return false;
    };
    let keys = [
        "source",
        "teamKey",
        "readyState",
        "triageState",
        "claimedState",
        "doneState",
        "createState",
        "proposalState",
        "readyLabels",
    ];
    if t.keys().any(|key| !keys.contains(&key.as_str())) || policy["tickets"]["source"] != "hosted"
    {
        return false;
    }
    for key in &keys[1..8] {
        let Some(s) = t.get(*key).and_then(Value::as_str) else {
            return false;
        };
        if s.is_empty()
            || (*key != "teamKey" && s.trim_matches(crate::operator::auth::js_space).is_empty())
        {
            return false;
        }
    }
    t.get("readyLabels").is_none_or(|v| {
        v.as_array()
            .is_some_and(|a| a.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty())))
    })
}
fn names(v: &Value) -> Vec<&str> {
    [
        "triageState",
        "readyState",
        "claimedState",
        "doneState",
        "createState",
        "proposalState",
    ]
    .iter()
    .filter_map(|key| v["tickets"][key].as_str())
    .collect()
}
pub async fn get(state: &MachineState, repo: &str) -> Result<Option<Value>, ProtocolError> {
    let c = state.store.database.client().await?;
    let r=c.query_opt("SELECT p.policy FROM project_ticket_policy p JOIN LATERAL (SELECT seq,action FROM project_journal WHERE repo=$1 ORDER BY seq DESC LIMIT 1) r ON r.seq=p.registration AND r.action='added' WHERE p.repo=$1",&[&repo]).await?;
    let value = r.map(|r| r.get::<_, Value>(0));
    if value.as_ref().is_some_and(|p| !valid(p)) {
        return Err(ProtocolError::internal());
    }
    Ok(value)
}
pub async fn put(
    state: &MachineState,
    repo: &str,
    policy: &Value,
    writer: &str,
) -> Result<(), ProtocolError> {
    // The hosted service preserves pre-publication lifecycle names from the
    // legacy effective configuration before switching to explicit policy.
    let mut legacy_names = Vec::<String>::new();
    if get(state, repo).await?.is_none()
        && !state
            .store
            .get_record(crate::protocol::store::records::Scope::Repo(repo))
            .await?
            .is_null()
    {
        let reference = state
            .store
            .get_reducer_value(
                crate::protocol::store::records::Scope::Repo(repo),
                &serde_json::json!({"reducer":"effectiveConfig"}),
            )
            .await?;
        if reference["value"]["reference"].is_object() {
            let config = fallback(state, repo).await?;
            if config["tickets"]["source"] == "hosted" {
                let t = &config["tickets"];
                let triage = t["triageState"].as_str().unwrap_or("Backlog");
                for (key, default) in [
                    ("triageState", triage),
                    ("readyState", "Ready"),
                    ("claimedState", "Doing"),
                    ("doneState", "Done"),
                    ("createState", triage),
                    ("proposalState", triage),
                ] {
                    legacy_names.push(t[key].as_str().unwrap_or(default).to_owned());
                }
            }
        }
    }
    let mut c = state.store.database.client().await?;
    let tx = c.transaction().await?;
    tx.query(
        "SELECT singleton FROM project_registry_state WHERE singleton=true FOR UPDATE",
        &[],
    )
    .await?;
    let registration = tx
        .query_opt(
            "SELECT seq,action FROM project_journal WHERE repo=$1 ORDER BY seq DESC LIMIT 1",
            &[&repo],
        )
        .await?
        .filter(|r| r.get::<_, String>("action") == "added")
        .ok_or_else(|| ProtocolError::new(403, "auth", "project not registered"))?
        .get::<_, i64>("seq");
    let old = tx
        .query_opt(
            "SELECT policy FROM project_ticket_policy WHERE repo=$1 AND registration=$2",
            &[&repo, &registration],
        )
        .await?
        .map(|r| r.get::<_, Value>(0));
    if old.as_ref().is_some_and(|p| !valid(p)) {
        return Err(ProtocolError::internal());
    }
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,731926))",
        &[&repo],
    )
    .await?;
    let mut all: Vec<&str> = legacy_names.iter().map(String::as_str).collect();
    all.extend(old.as_ref().map(names).unwrap_or_default());
    all.extend(names(policy));
    for name in all {
        tx.execute(
            "INSERT INTO ab_ticket_states (repo,name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            &[&repo, &name],
        )
        .await?;
    }
    tx.execute("INSERT INTO project_ticket_policy (repo,registration,policy,writer,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (repo) DO UPDATE SET registration=EXCLUDED.registration,policy=EXCLUDED.policy,writer=EXCLUDED.writer,updated_at=EXCLUDED.updated_at WHERE project_ticket_policy.registration<>EXCLUDED.registration OR project_ticket_policy.policy<>EXCLUDED.policy",&[&repo,&registration,&policy,&writer,&state.store.now()]).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn fallback(state: &MachineState, repo: &str) -> Result<Value, ProtocolError> {
    use crate::protocol::store::records::Scope;
    use base64::Engine;
    let missing = |run: bool| {
        ProtocolError::new(
            409,
            "conflict",
            format!(
                "effective config unavailable for repository \"{repo}\"{}",
                if run {
                    ""
                } else {
                    ": no dispatcher run is recorded"
                }
            ),
        )
    };
    if state.store.get_record(Scope::Repo(repo)).await?.is_null() {
        return Err(missing(false));
    }
    let result = state
        .store
        .get_reducer_value(
            Scope::Repo(repo),
            &serde_json::json!({"reducer":"effectiveConfig"}),
        )
        .await?;
    let facts = &result["value"];
    let reference = &facts["reference"];
    let Some(kind) = reference["kind"].as_str() else {
        return Err(missing(facts.get("run").is_some()));
    };
    let rev = reference["rev"]
        .as_i64()
        .ok_or_else(ProtocolError::internal)?;
    let artifact = state
        .store
        .get_artifact(Scope::Repo(repo), kind, Some(rev))
        .await?;
    if artifact.is_null() {
        return Err(ProtocolError::new(
            409,
            "conflict",
            format!("effective config {kind}@{rev} is not retrievable"),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            artifact["contentBase64"]
                .as_str()
                .ok_or_else(ProtocolError::internal)?,
        )
        .map_err(|_| ProtocolError::internal())?;
    crate::operator::config_schema::decode(&bytes, &format!("{kind}@{rev}"))
        .map_err(super::source_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn published_policy_matches_source_schema_probes() {
        let oracle: Value =
            serde_json::from_str(include_str!("../../../fixtures/ticket-protocol.json")).unwrap();
        for case in oracle["policies"].as_array().unwrap() {
            assert_eq!(
                valid(&case["request"]),
                case.get("output").is_some(),
                "{}",
                case["request"]
            );
        }
    }
}
