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
    let digests = if scope == "all" {
        None
    } else {
        Some(
            reader
                .postgres()
                .api_build_digests(repo)
                .await
                .map_err(storage)?,
        )
    };
    let mut result = Vec::new();
    for record in records {
        if let Some(digests) = &digests {
            let digest = digests
                .iter()
                .find(|d| d["slug"] == record["slug"])
                .ok_or_else(OperatorError::internal)?;
            if digest.get("terminal").is_some() {
                continue;
            }
        }
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
    let facts = repository_facts(reader, repo).await?;
    let reference = &facts["status"]["effectiveConfig"];
    if reference.is_null() {
        return Err(unavailable(format!(
            "effective config unavailable for repository \"{repo}\"{}",
            if facts["config"]["run"].is_null() {
                ": no dispatcher run is recorded"
            } else {
                ""
            }
        )));
    }
    let kind = reference["kind"].as_str().unwrap_or_default();
    let rev = reference["rev"].as_i64().unwrap_or(0);
    let bytes = reader
        .artifact(repo, Scope::Repository, kind, Some(rev))
        .await
        .map_err(storage)?
        .ok_or_else(|| unavailable(format!("effective config {kind}@{rev} is not retrievable")))?;
    decode_config(&bytes, &format!("{kind}@{rev}"))
}
fn decode_config(bytes: &[u8], label: &str) -> Result<Value, OperatorError> {
    super::config_schema::decode(bytes, label)
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

/// Lifecycle and display facts are read from one locked suffix fold.
pub struct ReadBuild {
    pub record: Value,
    pub state: Value,
    pub display: Value,
}
fn storage(_: impl std::fmt::Display) -> OperatorError {
    OperatorError::internal()
}
fn unavailable(message: impl Into<String>) -> OperatorError {
    OperatorError::new(409, "conflict", message).with_code("effective-config-unavailable")
}
pub async fn repository_facts(reader: &DataReader, repo: &str) -> Result<Value, OperatorError> {
    match reader.repository(repo).await {
        Ok(facts) => Ok(facts["repositoryReadFacts"].clone()),
        Err(crate::data::error::DataError::MissingScope {
            scope: "repository",
        }) => Ok(
            crate::data::reducers::Accumulator::new(crate::data::reducers::Scope::Repository)
                .finish()["repositoryReadFacts"]
                .clone(),
        ),
        Err(error) => Err(storage(error)),
    }
}
async fn read_build(
    reader: &DataReader,
    record: Value,
    repo: &str,
) -> Result<ReadBuild, OperatorError> {
    let (state, display, _) = reader
        .build_display(repo, record["slug"].as_str().unwrap_or_default())
        .await
        .map_err(storage)?;
    Ok(ReadBuild {
        record,
        state: state["build"].clone(),
        display,
    })
}
async fn read_builds(
    reader: &DataReader,
    repo: &str,
    skip_done: bool,
    skip_aborted: bool,
) -> Result<(Vec<Value>, Vec<ReadBuild>, Vec<Value>), OperatorError> {
    let records = reader.postgres().builds(repo).await.map_err(storage)?;
    let digests = reader
        .postgres()
        .api_build_digests(repo)
        .await
        .map_err(storage)?;
    let mut builds = vec![];
    for record in &records {
        let digest = digests
            .iter()
            .find(|d| d["slug"] == record["slug"])
            .ok_or_else(OperatorError::internal)?;
        if (skip_done && digest["terminal"] == "done")
            || (skip_aborted && digest["terminal"] == "aborted")
        {
            continue;
        }
        builds.push(read_build(reader, record.clone(), repo).await?);
    }
    Ok((records, builds, digests))
}
async fn row(
    reader: &DataReader,
    repo: &str,
    build: &ReadBuild,
    live: &Value,
    pinned: bool,
) -> Result<Option<Value>, OperatorError> {
    let mut pipeline = None;
    let mut metadata = None;
    if pinned && crate::dashboard::model::effective_status(&build.state) != "done" {
        if let Ok(Some(meta)) = reader
            .postgres()
            .artifact(
                repo,
                Scope::Build(build.record["slug"].as_str().unwrap_or_default()),
                "build-runner-effective-config",
                None,
            )
            .await
        {
            if let Ok(Some(bytes)) = reader
                .artifact(
                    repo,
                    Scope::Build(build.record["slug"].as_str().unwrap_or_default()),
                    "build-runner-effective-config",
                    meta["revision"].as_i64(),
                )
                .await
            {
                if let Ok(config) = decode_config(
                    &bytes,
                    &format!("build-runner-effective-config@{}", meta["revision"]),
                ) {
                    let mut composed = live.clone();
                    for key in ["verify", "finalize", "commands", "workspace"] {
                        if let Some(value) = config.get(key) {
                            composed[key] = value.clone();
                        }
                    }
                    pipeline = Some(composed);
                }
                metadata = Some(meta["metadata"].clone());
            }
        }
    }
    let mut value = crate::dashboard::model::project(
        &build.record,
        &build.state,
        crate::dashboard::model::ProjectionFacts {
            dashboard: &build.display["dashboard"],
            restack: &build.display["restack"],
            deferral: &build.display["deferral"],
        },
        live,
        None,
        pipeline.as_ref(),
    );
    if let (Some(row), Some(meta)) = (&mut value, metadata) {
        if meta["revision"].is_number() {
            row["effectiveConfigRev"] = meta["revision"].clone();
        }
        if matches!(
            meta["pipelineSource"]["ref"].as_str(),
            Some("branch-head" | "base" | "legacy-fallback" | "worktree-dirty")
        ) {
            row["pipelineSource"] = json!({"ref":meta["pipelineSource"]["ref"]});
            if meta["pipelineSource"]["commit"].is_string() {
                row["pipelineSource"]["commit"] = meta["pipelineSource"]["commit"].clone();
            }
        }
    }
    Ok(value)
}
pub async fn get(
    reader: &DataReader,
    repo: &str,
    slug: &str,
    now: DateTime<Utc>,
) -> Result<Value, OperatorError> {
    let record = reader
        .postgres()
        .build_record(repo, slug)
        .await
        .map_err(storage)?;
    let Some(record) = record else {
        let exists = reader
            .postgres()
            .build_exists(repo, slug)
            .await
            .map_err(storage)?;
        return Err(OperatorError::not_found(if exists {
            format!("unknown build \"{slug}\"")
        } else {
            format!("no build \"{slug}\" in this store")
        })
        .with_code("not-found"));
    };
    let build = read_build(reader, record, repo).await?;
    let config = effective_config(reader, repo).await?;
    let facts = repository_facts(reader, repo).await?;
    let mut projected = row(reader, repo, &build, &config, true).await?;
    if let Some(projected) = &mut projected {
        let (_, draining) = super::read_repository::handoffs(&facts);
        if draining.contains(slug) {
            projected["draining"] = json!(true);
        }
        if !projected["integrationDetail"].is_null() {
            let (records, builds, _) = read_builds(reader, repo, true, false).await?;
            let mut rows = vec![projected.clone()];
            for child in &builds {
                if child.record["slug"] != slug {
                    if let Some(row) = row(reader, repo, child, &config, false).await? {
                        rows.push(row);
                    }
                }
            }
            crate::dashboard::integration::enrich(&mut rows, &records);
            *projected = rows.remove(0);
        }
    }
    Ok(json!({"detail":super::read_detail::detail(&build,now),"dashboardRow":projected}))
}
pub async fn dashboard(
    reader: &DataReader,
    repo: &str,
    now: DateTime<Utc>,
) -> Result<Value, OperatorError> {
    let config = effective_config(reader, repo).await?;
    let facts = repository_facts(reader, repo).await?;
    let (records, builds, digests) = read_builds(reader, repo, true, false).await?;
    let mut rows = vec![];
    let (handoffs, draining) = super::read_repository::handoffs(&facts);
    for build in &builds {
        if let Some(mut value) = row(reader, repo, build, &config, true).await? {
            if draining.contains(build.record["slug"].as_str().unwrap_or_default()) {
                value["draining"] = json!(true);
            }
            rows.push(value);
        }
    }
    crate::dashboard::integration::enrich(&mut rows, &records);
    rows.sort_by(|a, b| a["slug"].as_str().cmp(&b["slug"].as_str()));
    let capacity = super::read_repository::capacity(&builds, &config, &facts, now)?;
    let claimed = super::read_harvest::array(&facts["harvest"]["claimed"]);
    let mut observations = 0;
    for digest in &digests {
        for o in super::read_harvest::array(&digest["observations"]) {
            if !claimed
                .iter()
                .any(|c| c["build"] == digest["slug"] && c["seq"] == o["seq"])
            {
                observations += 1;
            }
        }
    }
    let status = &facts["status"];
    let settings = &facts["settings"];
    let mut model = json!({"repo":repo,"queued":status["queued"].as_i64().unwrap_or(0),"active":{"current":capacity["occupied"],"limit":capacity["effective"]},"capacity":capacity,"observations":{"current":observations,"limit":config["policy"]["harvestThreshold"]},"drained":settings["intake"]!=true,"repositoryPaused":settings["paused"],"defaultAutoMerge":settings["defaultAutoMerge"],"harvestPaused":facts["harvest"]["paused"],"builds":rows});
    if !handoffs.is_empty() {
        model["handoffs"] = json!(handoffs);
    }
    if let Some(rollback) = super::read_repository::rollback(&facts) {
        model["rollback"] = rollback;
    }
    if let Some(harvest) = super::read_harvest::dashboard(&facts) {
        model["harvest"] = harvest;
    }
    if let Some(upgrade) = status.get("availableUpgrade") {
        model["availableUpgrade"] = upgrade.clone();
    }
    let mut warnings = super::read_harvest::array(&status["roleWarnings"]).to_vec();
    warnings.extend(super::read_repository::warnings(status));
    if let Some(notice) = status.get("warningNotice") {
        warnings.push(notice.clone());
    }
    if !warnings.is_empty() {
        model["warningLines"] = json!(warnings);
    }
    Ok(
        json!({"generatedAt":now.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"settingsHeader":{"intake":model["drained"]!=true,"repositoryPaused":model["repositoryPaused"],"defaultAutoMerge":model["defaultAutoMerge"],"harvestPaused":model["harvestPaused"]},"model":model}),
    )
}
pub async fn status(
    reader: &DataReader,
    repo: &str,
    now: DateTime<Utc>,
) -> Result<Value, OperatorError> {
    let facts = repository_facts(reader, repo).await?;
    let record = reader
        .postgres()
        .repository_record(repo)
        .await
        .map_err(storage)?
        .unwrap_or(Value::Null);
    let mut runs = std::collections::BTreeSet::new();
    for value in [
        &facts["latestRun"],
        &facts["latestStoppedRun"],
        &record["lease"]["holder"],
    ] {
        if let Some(run) = value.as_str() {
            runs.insert(run.to_owned());
        }
    }
    let events = reader
        .postgres()
        .dispatcher_events(repo, &runs.into_iter().collect::<Vec<_>>())
        .await
        .map_err(storage)?;
    let dispatcher = super::read_repository::liveness(&record, &events, now);
    let mut out = super::read_repository::status(repo, &facts, dispatcher.clone());
    if dispatcher["state"] == "held"
        && !facts["status"]["effectiveConfig"].is_null()
        && facts["status"]["run"] == dispatcher["holder"]["run"]
    {
        let reference = &facts["status"]["effectiveConfig"];
        if let Some(bytes) = reader
            .artifact(
                repo,
                Scope::Repository,
                reference["kind"].as_str().unwrap_or_default(),
                reference["rev"].as_i64(),
            )
            .await
            .map_err(storage)?
        {
            let config = decode_config(
                &bytes,
                &format!(
                    "{}@{}",
                    reference["kind"].as_str().unwrap_or_default(),
                    reference["rev"]
                ),
            )
            .map_err(storage)?;
            let (_, builds, _) = read_builds(reader, repo, true, true).await?;
            out["capacity"] = super::read_repository::capacity(&builds, &config, &facts, now)?;
        }
    }
    Ok(out)
}
pub async fn harvest(reader: &DataReader, repo: &str) -> Result<Value, OperatorError> {
    Ok(super::read_harvest::status(
        repo,
        &repository_facts(reader, repo).await?,
    ))
}
