//! Operator read wire projections. Page snapshots intentionally do not stand in
//! for the public operator API's summary objects.
use super::error::OperatorError;
use crate::data::{postgres::Scope, reader::DataReader};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
fn copy(out: &mut Value, input: &Value, key: &str) {
    if let Some(value) = input.get(key) {
        out[key] = value.clone();
    }
}
pub fn summary(record: &Value, state: &Value, now: DateTime<Utc>) -> Value {
    let mut out = crate::dashboard::tree::vocabulary(state);
    out["slug"] = record["slug"].clone();
    for key in ["ticket", "updatedAt"] {
        copy(&mut out, record, key);
    }
    out["status"] = state["status"].clone();
    let occurrence = state
        .get("currentPhase")
        .or_else(|| state.get("lastCompletedPhase"))
        .unwrap_or(&Value::Null);
    for key in ["phase", "round", "attempt"] {
        copy(&mut out, occurrence, key);
    }
    if let Some(pr) = state.get("pr") {
        let mut value = json!({"number":pr["number"],"url":pr["url"]});
        if let Some(pr_state) = state.get("prState") {
            value["state"] = pr_state.clone();
        }
        out["pr"] = value;
    }
    let lease = &record["lease"];
    let mut info = if lease.is_null() {
        json!({"health":"none"})
    } else {
        let held = lease["expiresAt"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|ts| ts > now);
        json!({"health":if held{"held"}else{"expired"},"holder":lease["holder"],"expiresAt":lease["expiresAt"]})
    };
    copy(&mut info, record, "heartbeatAt");
    out["lease"] = info;
    let mut progress =
        json!({"terminal":matches!(state["status"].as_str(),Some("done"|"aborted"))});
    if let Some(ts) = state["lastEvent"].get("ts") {
        progress["lastEventAt"] = ts.clone();
    }
    copy(&mut progress, record, "heartbeatAt");
    if let Some(expires) = lease.get("expiresAt") {
        progress["leaseExpiresAt"] = expires.clone();
    }
    out["progress"] = progress;
    if state["kind"] == "node" {
        copy(&mut out, state, "nodeRestack");
        if let Some(integration) = state.get("integration") {
            out["integrationState"] = integration.clone();
        }
        if let Some(foreign) = state["nodeRestack"]["inventory"]["foreign"].as_array() {
            let mut commits = vec![];
            for sha in foreign {
                let mut original = sha.clone();
                let mut visited = std::collections::HashSet::new();
                while let Some(next) = original
                    .as_str()
                    .and_then(|v| state["nodeRestack"]["foreignAliases"].get(v))
                {
                    if !visited.insert(original.to_string()) {
                        break;
                    }
                    original = next.clone();
                }
                commits.push(json!({"sha":sha,"originalSha":original}));
            }
            out["handPushedCommits"] = json!(commits);
        }
    }
    // Compatibility diagnostics are added only when an unknown fact is present.
    if state["compatibility"]["unknownFacts"].as_u64().unwrap_or(0) > 0 {
        out["compatibility"] = state["compatibility"].clone();
    }
    out
}
pub async fn builds(
    reader: &DataReader,
    repo: &str,
    scope: &str,
    now: DateTime<Utc>,
) -> Result<Value, OperatorError> {
    let records = reader
        .postgres()
        .builds(repo)
        .await
        .map_err(|_| OperatorError::internal())?;
    let mut result = Vec::new();
    for record in records {
        let slug = record["slug"].as_str().unwrap_or_default();
        let reduced = reader
            .build(repo, slug)
            .await
            .map_err(|_| OperatorError::internal())?;
        let state = &reduced["build"];
        let include = match scope {
            "all" => true,
            "queued" => matches!(
                state["status"].as_str(),
                Some("queued" | "running" | "collecting" | "paused" | "blocked")
            ),
            _ => matches!(
                state["status"].as_str(),
                Some("running" | "collecting" | "paused" | "blocked")
            ),
        };
        if include {
            result.push(summary(&record, state, now));
        }
    }
    result.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    Ok(json!(result))
}
pub fn artifact_revision(raw: &str) -> Result<i64, OperatorError> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(OperatorError::validation(
            "rev must be a nonnegative integer",
        ));
    }
    let parsed = raw
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| OperatorError::validation("rev must be a nonnegative integer"))?;
    Ok(parsed as i64)
}
pub async fn effective_config(reader: &DataReader, repo: &str) -> Result<Value, OperatorError> {
    let facts = reader
        .repository(repo)
        .await
        .map_err(|_| OperatorError::internal())?;
    let facts = &facts["repositoryReadFacts"];
    let reference = &facts["config"]["reference"];
    if facts["config"]["run"].is_null() || reference.is_null() {
        return Err(OperatorError::refusal(format!(
            "effective config unavailable for repository \"{repo}\"{}",
            if facts["config"]["run"].is_null() {
                ": no dispatcher run is recorded"
            } else {
                ""
            }
        ))
        .with_code("effective-config-unavailable"));
    }
    let kind = reference["kind"].as_str().unwrap_or_default();
    let rev = reference["rev"].as_i64().unwrap_or(0);
    let body = reader
        .artifact(repo, Scope::Repository, kind, Some(rev))
        .await
        .map_err(|_| OperatorError::internal())?
        .ok_or_else(|| {
            OperatorError::refusal(format!("effective config {kind}@{rev} is not retrievable"))
                .with_code("effective-config-unavailable")
        })?;
    let config: Value = serde_json::from_slice(&body).map_err(|_| {
        OperatorError::refusal(format!("effective config {kind}@{rev} is not valid JSON"))
            .with_code("effective-config-unavailable")
    })?;
    if !config["verify"]["steps"].is_array() || !config["finalize"]["steps"].is_array() {
        return Err(
            OperatorError::refusal(format!("effective config {kind}@{rev} is invalid"))
                .with_code("effective-config-unavailable"),
        );
    }
    Ok(config)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_revision_boundary() {
        for raw in ["-1", "+1", "1.0", "1e2", "", "9007199254740992"] {
            assert!(artifact_revision(raw).is_err(), "{raw}");
        }
        assert_eq!(artifact_revision("0001").unwrap(), 1);
        assert_eq!(
            artifact_revision("9007199254740991").unwrap(),
            9_007_199_254_740_991
        );
    }
    #[test]
    fn summary_uses_one_phase_occurrence_and_distinguishes_expired_lease() {
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .to_utc();
        let state = json!({"kind":"leaf","status":"running","lastCompletedPhase":{"phase":"verify:unit","attempt":3},"compatibility":{"unknownFacts":0}});
        let record = json!({"slug":"b","updatedAt":"time","lease":{"holder":"h","expiresAt":"2026-01-01T00:00:00Z"}});
        let value = summary(&record, &state, now);
        assert_eq!(value["attempt"], 3);
        assert!(value.get("round").is_none());
        assert_eq!(value["lease"]["health"], "expired");
    }
}

#[cfg(test)]
mod oracle_tests {
    use super::*;
    #[test]
    fn native_summary_matches_typescript_status_projection() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/operator-queries.json")).unwrap();
        let now = corpus["now"].as_str().unwrap().parse().unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            assert_eq!(
                summary(&case["record"], &case["state"], now),
                case["expected"],
                "{}",
                case["id"]
            );
        }
    }
}
