//! Repository API views. Liveness comes from mutable leases plus correlated facts.
use super::{
    error::OperatorError,
    query::ReadBuild,
    read_harvest::{array, copy, epoch, number},
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
pub fn warnings(status: &Value) -> Vec<Value> {
    array(&status["forgeReadinessFailures"])
        .iter()
        .map(|f| {
            json!(format!(
                "Forge {}: {} {}",
                f["check"].as_str().unwrap_or_default(),
                f["detail"].as_str().unwrap_or_default(),
                f["remediation"].as_str().unwrap_or_default()
            ))
        })
        .collect()
}
fn run_view(id: &str, record: &Value, events: &[Value], now: DateTime<Utc>) -> Value {
    let start = events
        .iter()
        .find(|e| e["type"] == "dispatcher.run-started" && e["payload"]["run"] == id);
    let stop = events
        .iter()
        .rev()
        .find(|e| e["type"] == "dispatcher.run-stopped" && e["payload"]["run"] == id);
    let tick = events.iter().rev().find(|e| {
        matches!(
            e["type"].as_str(),
            Some("dispatcher.tick-completed" | "dispatcher.tick-failed")
        ) && e["payload"]["run"] == id
    });
    let runtime = events.iter().rev().find(|e| {
        e["type"] == "dispatcher.runtime-recorded"
            && e["payload"]["run"] == id
            && start.is_some_and(|s| s["seq"] == e["payload"]["startedSeq"])
    });
    let finished = &record["tick"]["finished"];
    let sample = finished["run"] == id
        && tick.is_none_or(|e| finished["completedAt"].as_str() >= e["ts"].as_str());
    let last_at = if sample {
        finished.get("completedAt")
    } else {
        tick.and_then(|e| e.get("ts"))
    };
    let heartbeat = if record["lease"]["holder"] == id
        && start.is_some_and(|s| record["heartbeatAt"].as_str() >= s["ts"].as_str())
    {
        record.get("heartbeatAt")
    } else {
        None
    };
    let last_tick = if sample {
        if finished["outcome"] == "completed" {
            json!({"outcome":"completed","counters":finished["counters"]})
        } else {
            let mut v = json!({"outcome":"failed","error":finished["error"]});
            copy(&mut v, finished, "forgeRequests");
            v
        }
    } else if let Some(tick) = tick {
        if tick["type"] == "dispatcher.tick-completed" {
            json!({"outcome":"completed","counters":tick["payload"]["counters"]})
        } else {
            json!({"outcome":"failed","error":tick["payload"]["error"]})
        }
    } else {
        Value::Null
    };
    let age = |value: Option<&Value>| {
        value
            .and_then(epoch)
            .map(|at| json!((now.timestamp_millis() - at).max(0)))
            .unwrap_or(Value::Null)
    };
    json!({"runtime":runtime.map(|e|e["payload"]["runtime"].clone()),"run":id,"pid":start.map(|e|e["payload"]["pid"].clone()),"host":start.and_then(|e|e["payload"].get("host")).cloned(),"startedAt":start.map(|e|e["ts"].clone()),"heartbeatAt":heartbeat,"heartbeatAgeMs":age(heartbeat),"leaseExpiresAt":if record["lease"]["holder"]==id{record["lease"]["expiresAt"].clone()}else{Value::Null},"lastTickAt":last_at,"lastTickAgeMs":age(last_at),"lastTick":last_tick,"stoppedAt":stop.map(|e|e["ts"].clone()),"stop":stop.map(|e|e["payload"].clone())})
}
pub fn liveness(record: &Value, events: &[Value], now: DateTime<Utc>) -> Value {
    let latest = events
        .iter()
        .rev()
        .find(|e| e["type"] == "dispatcher.run-started");
    let stopped = events
        .iter()
        .rev()
        .find(|e| e["type"] == "dispatcher.run-stopped");
    let owner = record["lease"]["holder"]
        .as_str()
        .map(|id| run_view(id, record, events, now));
    let held = owner.as_ref().is_some_and(|o| o["stop"].is_null())
        && epoch(&record["lease"]["expiresAt"]).is_some_and(|t| t > now.timestamp_millis());
    json!({"state":if held{"held"}else if owner.as_ref().is_some_and(|o|o["stop"].is_null()){"lost"}else if stopped.is_some(){"stopped"}else{"absent"},"holder":if held{owner.clone()}else{None},"expiredHolder":if !held&&owner.as_ref().is_some_and(|o|o["stop"].is_null()){owner}else{None},"latestRun":latest.map(|e|run_view(e["payload"]["run"].as_str().unwrap_or_default(),record,events,now)),"latestStoppedRun":stopped.map(|e|run_view(e["payload"]["run"].as_str().unwrap_or_default(),record,events,now))})
}
fn identity(
    reference: &Value,
    facts: &Value,
    destination: &str,
) -> Result<(String, String), OperatorError> {
    let dest = if destination == "database" {
        "hosted"
    } else {
        destination
    };
    let mut source = reference["source"].as_str().unwrap_or_default().to_owned();
    if source == "database" && dest == "hosted" {
        source = "hosted".into();
    }
    let mut id = reference["id"].as_str().unwrap_or_default().to_owned();
    let mut seen = HashSet::new();
    while source != dest {
        if !seen.insert((source.clone(), id.clone())) {
            return Err(OperatorError::internal());
        }
        let m = array(&facts["ticketMigrations"]["migrations"])
            .iter()
            .find(|m| {
                m["from"] == source && m["from"] != m["to"] && m["mapping"].get(&id).is_some()
            })
            .ok_or_else(OperatorError::internal)?;
        id = m["mapping"][&id]
            .as_str()
            .ok_or_else(OperatorError::internal)?
            .to_owned();
        source = m["to"].as_str().unwrap_or_default().into();
    }
    Ok((source, id))
}
fn allocated(b: &ReadBuild, now: DateTime<Utc>) -> bool {
    !b.display["api"]["workspace"].is_null()
        || !b.display["api"]["provisionMarker"].is_null()
        || epoch(&b.record["lease"]["expiresAt"]).is_some_and(|t| t > now.timestamp_millis())
}
fn occupies(b: &ReadBuild, now: DateTime<Utc>) -> bool {
    if matches!(b.state["status"].as_str(), Some("done" | "aborted")) {
        return false;
    }
    b.state["kind"] != "node"
        || !b.state["nodeRestack"]["conflict"].is_null()
        || (crate::dashboard::tree::integration_current(&b.state)
            && !crate::dashboard::tree::integration_failed(&b.state)
            && !crate::dashboard::tree::cycle_verified(&b.state)
            && allocated(b, now))
}
fn descendant(
    build: &ReadBuild,
    node: &str,
    builds: &HashMap<&str, &ReadBuild>,
    facts: &Value,
    source: &str,
) -> Result<bool, OperatorError> {
    let mut visited = HashSet::from([build.record["slug"].as_str().unwrap_or_default()]);
    let mut target = &build.state["target"];
    while !target.is_null() {
        let slug = target["build"].as_str().unwrap_or_default();
        if !visited.insert(slug) {
            return Ok(false);
        }
        let Some(parent) = builds.get(slug) else {
            return Ok(false);
        };
        if parent.state["kind"] != "node"
            || parent.record["repo"] != build.record["repo"]
            || parent.record["ticket"].is_null()
            || identity(&parent.record["ticket"], facts, source)?
                != identity(&target["ticket"], facts, source)?
        {
            return Ok(false);
        }
        if slug == node {
            return Ok(true);
        }
        target = &parent.state["target"];
    }
    Ok(false)
}
pub fn capacity(
    builds: &[ReadBuild],
    config: &Value,
    facts: &Value,
    now: DateTime<Utc>,
) -> Result<Value, OperatorError> {
    let configured = number(&config["capacity"]);
    let occupied = builds.iter().filter(|b| occupies(b, now)).count() as i64;
    let mut borrowers = BTreeSet::new();
    let indexed = builds
        .iter()
        .map(|b| (b.record["slug"].as_str().unwrap_or_default(), b))
        .collect::<HashMap<_, _>>();
    for b in builds {
        if b.state["kind"] != "node" || !occupies(b, now) || !allocated(b, now) {
            continue;
        }
        let slug = b.record["slug"].as_str().unwrap_or_default();
        let mut other = 0;
        let mut excluded = 0;
        for child in builds {
            if child.record["slug"] == slug || !occupies(child, now) {
                continue;
            }
            if matches!(child.state["status"].as_str(), Some("blocked" | "paused"))
                && descendant(
                    child,
                    slug,
                    &indexed,
                    facts,
                    config["tickets"]["source"].as_str().unwrap_or_default(),
                )?
            {
                excluded += 1;
            } else {
                other += 1;
            }
        }
        if occupied > configured && excluded > 0 && other < configured {
            borrowers.insert(slug);
        }
    }
    Ok(
        json!({"configured":configured,"occupied":occupied,"effective":if borrowers.is_empty(){configured}else{configured.max(occupied)},"borrowingNodes":borrowers}),
    )
}
pub fn handoffs(facts: &Value) -> (Vec<Value>, HashSet<String>) {
    let mut runs = facts["upgrades"]["runs"]
        .as_object()
        .map(|o| {
            o.values()
                .filter(|r| !r["handoff"].is_null() && r["completed"].is_null())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    runs.sort_by(|a, b| {
        number(&a["handoff"]["seq"])
            .cmp(&number(&b["handoff"]["seq"]))
            .then(
                a["handoff"]["payload"]["run"]
                    .as_str()
                    .cmp(&b["handoff"]["payload"]["run"].as_str()),
            )
    });
    let mut draining = HashSet::new();
    let out=runs.iter().map(|r|{let p=&r["handoff"]["payload"];let mode=p["mode"].as_str().unwrap_or("cutover");if mode=="drain"{if let Some(o)=r["outstanding"].as_object(){draining.extend(o.keys().cloned());}}let mut v=json!({"run":p["run"],"correlation":p["correlation"],"from":p["from"],"to":p["to"],"mode":mode});copy(&mut v,p,"successor");copy(&mut v,r,"deadline");v}).collect();
    (out, draining)
}
pub fn rollback(facts: &Value) -> Option<Value> {
    let u = &facts["upgrades"];
    let lineage = u["authoritativeRun"]
        .as_str()
        .and_then(|r| u["lineages"][r].as_str())?;
    let hold = &u["holds"][lineage];
    if hold.is_null() {
        return None;
    }
    let mut v = json!({"ts":hold["ts"]});
    for key in ["correlation", "lineage", "failed", "restored"] {
        copy(&mut v, &hold["payload"], key);
    }
    Some(v)
}
pub fn status(repo: &str, facts: &Value, dispatcher: Value) -> Value {
    let mut out = json!({"repo":repo,"operator":{"registrations":[]},"upgrades":facts["upgrades"],"dispatcher":dispatcher,"intake":facts["settings"]["intake"],"paused":facts["settings"]["paused"],"defaultAutoMerge":facts["settings"]["defaultAutoMerge"]});
    let d = &out["dispatcher"];
    let run = [&d["holder"], &d["expiredHolder"], &d["latestRun"]]
        .into_iter()
        .find(|r| !r.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(lineage) = run["run"]
        .as_str()
        .and_then(|r| facts["upgrades"]["lineages"][r].as_str())
    {
        if let Some(hold) = facts["upgrades"]["holds"].get(lineage) {
            out["rollbackHold"] = hold.clone();
        }
    }
    let tick = &run["lastTick"];
    let counts = if tick["outcome"] == "completed" {
        &tick["counters"]["forgeRequests"]
    } else {
        &tick["forgeRequests"]
    };
    if !counts.is_null() {
        out["forgeRequests"] = counts.clone();
        if let Some(hotspot) = array(&counts["builds"]).iter().find(|b| {
            number(&b["requests"]) >= 2
                && number(&b["requests"]) * 2
                    > number(&counts["total"]) - number(&counts["unattributed"])
        }) {
            out["forgeRequestHotspot"] = hotspot["build"].clone();
        }
    }
    let warnings = warnings(&facts["status"]);
    if !warnings.is_empty() {
        out["warningLines"] = json!(warnings);
    }
    for (from, to) in [
        ("forgeHealth", "forgeDegradation"),
        ("health", "ticketSourceDegradation"),
    ] {
        if let Some(v) = facts.get(from) {
            out[to] = v.clone();
        }
    }
    out["sandboxes"]=json!(array(&facts["sandboxes"]).iter().filter(|s|s["state"]!="released").map(|s|json!({"operator":s["operator"],"environmentId":s["environmentId"],"provider":s["provider"],"state":if s["state"]=="stopped"{"stopped"}else{"live"},"lastEvidenceAt":s["lastEvidenceTs"]})).collect::<Vec<_>>());
    out["publications"]=json!(array(&facts["publications"]).iter().rev().map(|e|{let p=&e["payload"];let mut v=json!({"operator":p["operator"],"branch":p["branch"],"sha":p["sha"],"prNumber":p["pr"]["number"],"prUrl":p["pr"]["url"],"at":e["ts"]});copy(&mut v,p,"session");v}).collect::<Vec<_>>());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_status_matches_actual_typescript_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/api-read-corpus.json")).unwrap();
        let now = corpus["now"].as_str().unwrap().parse().unwrap();
        let mut count = 0;
        for f in array(&corpus["fixtures"]) {
            if f["scenario"]["path"] != "status" || f["status"] != 200 {
                continue;
            }
            let mut acc =
                crate::data::reducers::Accumulator::new(crate::data::reducers::Scope::Repository);
            let events = array(&f["seed"]["repository"]["events"]);
            acc.advance(events).unwrap();
            let facts = acc.finish()["repositoryReadFacts"].clone();
            let d = liveness(&f["seed"]["repository"]["record"], events, now);
            let mut actual = status("api-read/repository", &facts, d.clone());
            if d["state"] == "held" && facts["status"]["run"] == d["holder"]["run"] {
                let artifact = &f["seed"]["repository"]["artifacts"][0];
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(artifact["base64"].as_str().unwrap())
                    .unwrap();
                let config: Value = serde_json::from_slice(&bytes).unwrap();
                let mut builds = Vec::new();
                for b in array(&f["seed"]["builds"]) {
                    let mut accumulator = crate::data::reducers::Accumulator::new(
                        crate::data::reducers::Scope::Build,
                    );
                    accumulator.advance(array(&b["events"])).unwrap();
                    let mut api = crate::data::api_facts::ApiFacts::default();
                    api.advance(array(&b["events"]));
                    builds.push(ReadBuild {
                        record: b["record"].clone(),
                        state: accumulator.finish()["build"].clone(),
                        display: json!({"api":api.finish()}),
                    });
                }
                actual["capacity"] = capacity(&builds, &config, &facts, now).unwrap();
            }
            assert_eq!(actual, f["body"], "{}", f["scenario"]["id"]);
            count += 1;
        }
        assert!(count >= 7);
    }
}
