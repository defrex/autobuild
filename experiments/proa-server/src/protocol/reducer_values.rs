//! Named values are replayed from one coherent authoritative prefix. Public or
//! private snapshots are never consulted, so corrupt caches cannot authorize or
//! alter answers. Cache optimization remains separate from observable values.
#[path = "reducer_read_facts.rs"]
mod read_facts;
use super::{
    error::ProtocolError,
    identity::ServiceIdentity,
    js_json::{parse_js_json, serializable},
    store::{events::event_record, records::Scope, Store},
    validation::validate_schema,
};
use crate::data::{
    events,
    reducers::{self, build::BuildAcc, repository::RepositoryAcc},
};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio_postgres::IsolationLevel;
pub(super) fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/protocol-reducer-catalog.json"))
            .expect("generated reducer catalog")
    })
}
pub const REDUCER_REQUEST_MAX_BYTES: usize = 4096;
/// The value API exposes JavaScript SyntaxError text (other wire bodies use a
/// different rejection contract). Parse before resolving the executable catalog.
pub fn parse_reducer_request(bytes: &[u8]) -> Result<Value, ProtocolError> {
    if bytes.len() > REDUCER_REQUEST_MAX_BYTES {
        return Err(ProtocolError::new(
            413,
            "validation",
            "reducer request exceeds 4 KiB",
        ));
    }
    parse_js_json(bytes).map_err(|e| json_parse_error(bytes, &e))
}

/// Bun JSON.parse diagnostic shared by persisted JSON envelopes and requests.
/// This function neither decodes HTTP text nor imposes a request byte ceiling.
pub(crate) fn json_parse_error(bytes: &[u8], e: &serde_json::Error) -> ProtocolError {
    let text = String::from_utf8_lossy(bytes);
    let raw = text.trim();
    let message = e.to_string();
    let offset = e.column().saturating_sub(1).min(text.len());
    let array_comma = text.as_bytes().get(offset) == Some(&b']')
        && text.as_bytes()[..offset]
            .iter()
            .rev()
            .find(|c| !c.is_ascii_whitespace())
            == Some(&b',');
    let detail = if raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .ends_with(",]")
        || array_comma
    {
        "Unexpected comma at the end of array expression".to_string()
    } else if message.starts_with("invalid escape") || message.starts_with("invalid unicode") {
        let start = text
            .get(..offset.min(text.len()))
            .and_then(|prefix| prefix.rfind('\\'));
        if let Some(start) = start {
            let tail = &text[start..];
            if tail.starts_with("\\u") {
                format!(
                    "\"{}\" is not a valid unicode escape",
                    tail.chars().take(6).collect::<String>()
                )
            } else {
                format!(
                    "Invalid escape character {}",
                    tail.chars().nth(1).unwrap_or(' ')
                )
            }
        } else {
            "Unable to parse JSON string".into()
        }
    } else if message.starts_with("EOF while parsing an object") {
        "Expected '}'".to_string()
    } else if message.starts_with("EOF while parsing a string") {
        "Unterminated string".to_string()
    } else if message.starts_with("EOF") {
        "Unexpected EOF".to_string()
    } else if message.starts_with("expected `,` or `}`") {
        "Expected '}'".to_string()
    } else if message.starts_with("expected `:`") {
        "Expected ':' before value in object property definition".to_string()
    } else if message.starts_with("trailing comma")
        && (raw.ends_with(']') || text.as_bytes().get(e.column().saturating_sub(1)) == Some(&b']'))
    {
        "Unexpected comma at the end of array expression".to_string()
    } else if message.starts_with("key must be a string") || message.starts_with("trailing comma") {
        if raw.contains(',') {
            "Property name must be a string literal".to_string()
        } else {
            "Expected '}'".to_string()
        }
    } else if message.starts_with("trailing characters") {
        "Unable to parse JSON string".to_string()
    } else {
        let col = e.column().saturating_sub(1).min(text.len());
        let bytes = text.as_bytes();
        let mut start = col;
        while start > 0 && bytes[start - 1].is_ascii_alphabetic() {
            start -= 1
        }
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_alphabetic() {
            end += 1
        }
        if end > start {
            format!("Unexpected identifier \"{}\"", &text[start..end])
        } else if let Some(c) = text.get(col..).and_then(|s| s.chars().next()) {
            format!("Unexpected token '{c}'")
        } else {
            "Unable to parse JSON string".to_string()
        }
    };
    error(format!("SyntaxError: JSON Parse error: {detail}"))
}

fn error(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(400, "validation", message)
}
#[derive(Debug)]
pub struct ResolvedReducer {
    pub name: String,
    pub args: Value,
    pub version: i64,
}
fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
fn type_issue(expected: &str, value: &Value) -> Value {
    let mut issue = json!({"expected":expected,"code":"invalid_type"});
    if expected == "number" && value.is_number() && value.as_f64().is_none() {
        issue["received"] = json!("Infinity");
    }
    issue["path"] = json!([]);
    issue["message"] = json!(format!(
        "Invalid input: expected {expected}, received {}",
        received(value)
    ));
    issue
}
// A parsed JSON tree is JSON-safe unless exponent overflow produced Infinity.
// z.json is a lazy six-branch union; reproduce its nested diagnostic exactly.
fn json_issue(value: &Value, path: Vec<Value>) -> Option<Value> {
    let valid = match value {
        Value::Number(n) => n.as_f64().is_some(),
        Value::Array(a) => a.iter().all(|v| json_issue(v, vec![]).is_none()),
        Value::Object(o) => o
            .iter()
            .filter(|(key, _)| *key != "__proto__")
            .all(|(_, v)| json_issue(v, vec![]).is_none()),
        _ => true,
    };
    if valid {
        return None;
    }
    let mut branches: Vec<Vec<Value>> = ["string", "number", "boolean", "null"]
        .iter()
        .map(|kind| vec![type_issue(kind, value)])
        .collect();
    branches.push(if let Some(a) = value.as_array() {
        a.iter()
            .enumerate()
            .filter_map(|(i, v)| json_issue(v, vec![json!(i)]))
            .collect()
    } else {
        vec![type_issue("array", value)]
    });
    branches.push(if let Some(o) = value.as_object() {
        o.iter()
            .filter(|(key, _)| *key != "__proto__")
            .filter_map(|(k, v)| json_issue(v, vec![json!(k)]))
            .collect()
    } else {
        vec![type_issue("record", value)]
    });
    Some(json!({"code":"invalid_union","errors":branches,"path":path,"message":"Invalid input"}))
}
pub fn resolve(scope: Scope<'_>, input: &Value) -> Result<ResolvedReducer, ProtocolError> {
    let schema = &catalog()["request"];
    let parsed = validate_schema(schema, input);
    let mut issues = match &parsed {
        Ok(_) => vec![],
        Err(message) => parse_js_json(message.as_bytes())
            .expect("schema issues")
            .as_array()
            .unwrap()
            .clone(),
    };
    if let Some(args) = input.get("args").and_then(Value::as_object) {
        let more: Vec<_> = args
            .iter()
            .filter(|(key, _)| *key != "__proto__")
            .filter_map(|(key, v)| json_issue(v, vec![json!("args"), json!(key)]))
            .collect();
        let at = issues
            .iter()
            .position(|issue| issue["code"] == "unrecognized_keys" && issue["path"] == json!([]))
            .unwrap_or(issues.len());
        issues.splice(at..at, more);
    }
    if !issues.is_empty() {
        return Err(error(serde_json::to_string_pretty(&issues).unwrap()));
    }
    let parsed = parsed.expect("request has no issues");
    let name = parsed["reducer"].as_str().unwrap();
    let entry = catalog()["catalog"]
        .get(name)
        .ok_or_else(|| error(format!("Error: unknown reducer \"{name}\"")))?;
    if let Some(reason) = entry["excluded"].as_str() {
        return Err(error(format!(
            "Error: excluded reducer \"{name}\": {reason}"
        )));
    }
    let expected = if matches!(scope, Scope::Repo(_)) {
        "repo"
    } else {
        "build"
    };
    if entry["scope"] != expected {
        return Err(error(format!("Error: wrong scope for reducer \"{name}\"")));
    }
    let args =
        validate_schema(&entry["args"], parsed.get("args").unwrap_or(&json!({}))).map_err(error)?;
    Ok(ResolvedReducer {
        name: name.into(),
        args,
        version: entry["version"].as_i64().unwrap(),
    })
}
fn remove(value: &mut Value, key: &str) {
    value.as_object_mut().unwrap().remove(key);
}
fn pick(value: &Value, keys: &[&str]) -> Value {
    let mut out = json!({});
    for key in keys {
        if let Some(v) = value.get(key) {
            out[key] = v.clone()
        }
    }
    out
}
fn copy(out: &mut Value, input: &Value, key: &str) {
    if let Some(v) = input.get(key) {
        out[key] = v.clone()
    } else {
        remove(out, key)
    }
}
fn seq(event: &Value) -> i64 {
    event["seq"].as_i64().unwrap_or(0)
}
fn known(scope: Scope<'_>, kind: &str) -> bool {
    static SCHEMAS: OnceLock<Value> = OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("../../fixtures/event-schemas.json")).unwrap()
    });
    schemas[if matches!(scope, Scope::Repo(_)) {
        "repository"
    } else {
        "build"
    }]
    .get(kind)
    .is_some()
}
fn initial_compatibility() -> Value {
    json!({"unknownFacts":0,"decisiveFacts":0,"lastSeq":0,"decisiveBoundary":0,"types":[],"writerVersions":[],"legacyVersionUnavailable":false,"decisiveTypes":[],"decisiveWriterVersions":[],"decisiveLegacyVersionUnavailable":false})
}
fn unique(state: &mut Value, key: &str, value: &Value) {
    let a = state[key].as_array_mut().unwrap();
    if !a.contains(value) {
        a.push(value.clone())
    }
}
fn compatibility(unknown: &[Value]) -> Result<Value, ProtocolError> {
    let mut state = initial_compatibility();
    for event in unknown {
        state["unknownFacts"] = json!(state["unknownFacts"].as_i64().unwrap() + 1);
        state["lastSeq"] = json!(state["lastSeq"].as_i64().unwrap().max(seq(event)));
        unique(&mut state, "types", &event["type"]);
        if let Some(metadata) = event.get("compatibility") {
            validate_schema(&catalog()["compatibilitySchema"], metadata)
                .map_err(|message| ProtocolError::new(500, "internal", message))?;
            unique(&mut state, "writerVersions", &metadata["writerVersion"])
        } else {
            state["legacyVersionUnavailable"] = json!(true)
        }
        if event["compatibility"]["classification"] != "advisory" {
            state["decisiveFacts"] = json!(state["decisiveFacts"].as_i64().unwrap() + 1);
            state["decisiveBoundary"] = event["seq"].clone();
            unique(&mut state, "decisiveTypes", &event["type"]);
            if let Some(metadata) = event.get("compatibility") {
                unique(
                    &mut state,
                    "decisiveWriterVersions",
                    &metadata["writerVersion"],
                )
            } else {
                state["decisiveLegacyVersionUnavailable"] = json!(true)
            }
        }
    }
    Ok(state)
}
fn projected(scope: Scope<'_>, raw: &[Value]) -> Result<(Vec<Value>, Vec<Value>), ProtocolError> {
    let mut decoded = Vec::new();
    let mut unknown = Vec::new();
    for event in raw {
        if !known(scope, event["type"].as_str().unwrap_or("")) {
            unknown.push(event.clone());
            continue;
        }
        decoded.push(events::decode(
            if matches!(scope, Scope::Repo(_)) {
                reducers::Scope::Repository
            } else {
                reducers::Scope::Build
            },
            event,
        )?)
    }
    Ok((decoded, unknown))
}

pub(super) fn validate_node(name: &str, events: &[Value]) -> Result<(), ProtocolError> {
    let mut node = false;
    let selected: Vec<_> = events
        .iter()
        .filter_map(|event| {
            if event["type"] == "build.created" {
                node = event["payload"]["kind"] == "node"
            }
            let kind = event["type"].as_str().unwrap_or("");
            (kind.starts_with("node.") || (node && kind == "target.moved")).then_some(event.clone())
        })
        .collect();
    crate::protocol::restack_values::reduce_node(&selected)
        .map(|_| ())
        .map_err(|mut error| {
            if name != "buildStreamSeed" && error.error == "The object can not be cloned." {
                error.error = "reducer finished value is not plain JSON".into()
            }
            error
        })
}
pub fn reduce(
    scope: Scope<'_>,
    resolved: &ResolvedReducer,
    raw: &[Value],
) -> Result<Value, ProtocolError> {
    let (events, unknown) = projected(scope, raw)?;
    let name = resolved.name.as_str();
    if matches!(name, "build" | "buildReadFacts") {
        validate_node(name, &events)?;
    }
    if ["terminalGuard", "buildStreamSeed", "buildReadFacts"].contains(&name) {
        return read_facts::value(name, scope, resolved, raw, &events, &unknown);
    }
    if matches!(name, "nodeRestack" | "leafRestack") {
        return crate::protocol::restack_values::reduce(name, &events);
    }
    if name == "build" {
        let mut acc = BuildAcc::default();
        for event in &events {
            acc.fold(event)?
        }
        let mut result = acc.finish();
        result["compatibility"] = compatibility(&unknown)?;
        result["lastSeq"] = json!(result["lastSeq"]
            .as_i64()
            .unwrap_or(0)
            .max(result["compatibility"]["lastSeq"].as_i64().unwrap()));
        return Ok(result);
    }
    let field = match name {
        "repositoryReadFacts" => Some(""),
        "ticketMigrations" => Some("ticketMigrations"),
        "dispatchUpgrade" => Some("upgrades"),
        "repositoryAttention" => Some("attention"),
        "harvest" => Some("harvest"),
        "dispatchSettings" => Some("settings"),
        "forgeHealthValue" => Some("forgeHealth"),
        "effectiveConfig" => Some("config"),
        "sandboxStates" => Some("sandboxes"),
        "openHarvestExecutions" => Some("openHarvest"),
        "autoMergeDefault" => Some("autoMerge"),
        _ => None,
    };
    if let Some(field) = field {
        let mut acc = RepositoryAcc::default();
        for event in &events {
            let original = raw.iter().find(|raw| raw["seq"] == event["seq"]).unwrap();
            if field.is_empty() || name == "harvest" {
                acc.fold(event, original)?;
            } else if name == "ticketMigrations" || event["type"] != "tickets.migration-recorded" {
                acc.fold_without_harvest(event, original)?;
            }
        }
        let mut facts = acc.finish()["repositoryReadFacts"].clone();
        if field.is_empty() {
            facts["compatibility"] = compatibility(&unknown)?;
            return Ok(facts);
        }
        if name == "forgeHealthValue" {
            return Ok(facts
                .get(field)
                .map(|v| json!({"value":v}))
                .unwrap_or_else(|| json!({})));
        }
        return Ok(facts[field].clone());
    }
    if name == "dispatchStatus" {
        return Ok(RepositoryAcc::status_for_events(
            resolved.args["run"].as_str().unwrap(),
            &events,
        ));
    }
    if name == "dispatcherRunFacts" || name == "openTick" {
        let mut state = json!({});
        for event in &events {
            if event["payload"]["run"] != resolved.args["run"] {
                continue;
            }
            let kind = event["type"].as_str().unwrap();
            match kind {
                "dispatcher.run-started" => {
                    if state.get("start").is_none() {
                        state["start"] = event.clone()
                    }
                    state["latestStart"] = event.clone()
                }
                "dispatcher.runtime-recorded" => state["runtime"] = event.clone(),
                "dispatcher.run-stopped" => state["stop"] = event.clone(),
                "dispatcher.stop-requested" => {
                    if state.get("stopRequest").is_none() {
                        state["stopRequest"] = event.clone()
                    }
                }
                "dispatcher.tick-started"
                | "dispatcher.tick-completed"
                | "dispatcher.tick-failed" => {
                    state["boundary"] = event["type"].clone();
                    if kind != "dispatcher.tick-started" {
                        state["tick"] = event.clone()
                    }
                    if kind == "dispatcher.tick-completed" {
                        state["completed"] = event.clone()
                    }
                }
                _ => {}
            }
        }
        return Ok(if name == "openTick" {
            json!(state["boundary"] == "dispatcher.tick-started")
        } else {
            state
        });
    }
    if [
        "currentPrAttachments",
        "pendingPrAttachmentReclaims",
        "summaryRequests",
        "executionNoProgress",
        "currentDeferralObservation",
        "dispatchFailureBudget",
        "phaseFailures",
        "dashboardFacts",
    ]
    .contains(&name)
    {
        return Ok(extras(name, &events, &resolved.args));
    }
    simple(name, &events, &unknown)
}
fn simple(name: &str, events: &[Value], unknown: &[Value]) -> Result<Value, ProtocolError> {
    let mut state = json!({});
    let mut open = Value::Null;
    let mut outcome = json!("none");
    let mut boundary = 0;
    let mut failures = Vec::new();
    let mut raised = Vec::new();
    let mut pins = Vec::new();
    for event in events {
        let p = &event["payload"];
        let kind = event["type"].as_str().unwrap();
        match name {
            "baseBranchValue" => {
                if kind == "build.created" && state.get("value").is_none() {
                    copy(&mut state, p, "baseBranch");
                    if let Some(v) = state.as_object_mut().unwrap().remove("baseBranch") {
                        state["value"] = v
                    }
                }
                if kind == "node.parent-accepted" {
                    state["value"] = p["next"]["branch"].clone()
                }
            }
            "recordedBaseShaValue" => {
                if kind == "workspace.provisioned" {
                    state["value"] = p["base"]["sha"].clone()
                }
            }
            "publishedBranchHeadValue" => {
                let next = match kind {
                    "implement.completed" => p["commits"].get("head"),
                    "restack.rewritten" => p
                        .get("observedHead")
                        .filter(|v| !v.is_null())
                        .or_else(|| p.get("headSha")),
                    "restack.completed" => p.get("headSha"),
                    "reconcile.rewritten" => p
                        .get("observedHead")
                        .filter(|v| !v.is_null())
                        .or_else(|| p.get("headSha")),
                    "reconcile.completed" => p.get("headSha").or_else(|| p.get("mergeCommit")),
                    "finalize.step-completed" if p["ok"] == true => p.get("headSha"),
                    _ => None,
                };
                if let Some(v) = next {
                    state["value"] = v.clone()
                }
            }
            "verifyDiffBaseValue" => match kind {
                "workspace.provisioned" if state.get("provisioned").is_none() => {
                    state["provisioned"] = p["base"]["sha"].clone()
                }
                "restack.completed" => state["promoted"] = p["targetBase"].clone(),
                "reconcile.started" => state["pending"] = p["baseSha"].clone(),
                "reconcile.completed" => {
                    if let Some(v) = state.as_object_mut().unwrap().remove("pending") {
                        state["promoted"] = v
                    }
                }
                _ => {}
            },
            "openBuildWorkspace" | "openWorkspace" => match kind {
                "workspace.provisioned" => {
                    open = if name == "openBuildWorkspace" {
                        p.clone()
                    } else {
                        json!({"ref":p["ref"],"path":p.get("path").unwrap_or(&p["ref"]),"branch":p["branch"]})
                    }
                }
                "workspace.released" => open = Value::Null,
                _ => {}
            },
            "openExecution" | "lastExecutionOutcome" => match kind {
                "execution.started" => {
                    open = pick(
                        p,
                        &[
                            "instance",
                            "workspaceRef",
                            "provider",
                            "environmentId",
                            "sessionId",
                            "commandId",
                        ],
                    );
                    outcome = json!("open")
                }
                "execution.ended" if !open.is_null() && open["instance"] == p["instance"] => {
                    if outcome == "open" {
                        outcome = p["outcome"].clone()
                    }
                    if name == "openExecution" {
                        open = Value::Null
                    }
                }
                _ => {}
            },
            "setupStreak" => match kind {
                "runner.attached" => boundary = seq(event),
                "escalation.raised" if p["phase"] == "setup" && p["source"] == "policy" => {
                    raised.push(p["id"].clone())
                }
                "escalation.answered" if raised.contains(&p["id"]) => boundary = seq(event),
                "runner.setup-failed" => failures.push(seq(event)),
                _ => {}
            },
            "infrastructureFailureReset" => match kind {
                "escalation.raised" if p["policyCause"] == "infrastructure-failure-limit" => {
                    raised.push(p["id"].clone())
                }
                "execution.ended" => boundary = seq(event),
                "escalation.answered"
                    if p["resolution"] == "retry" && raised.contains(&p["id"]) =>
                {
                    boundary = seq(event)
                }
                _ => {}
            },
            "pinnedAssets" => {
                if matches!(kind, "build.created" | "spec.revised") {
                    if let Some(assets) = p.get("assets") {
                        pins.push(assets.clone())
                    }
                }
            }
            _ => {}
        }
    }
    match name {
        "baseBranchValue" | "recordedBaseShaValue" | "publishedBranchHeadValue" => Ok(state),
        "verifyDiffBaseValue" => Ok(state
            .get("provisioned")
            .map(|v| json!({"value":state.get("promoted").unwrap_or(v)}))
            .unwrap_or_else(|| json!({}))),
        "openBuildWorkspace" | "openWorkspace" | "openExecution" => Ok(open),
        "lastExecutionOutcome" => Ok(outcome),
        "setupStreak" => Ok(json!(failures
            .iter()
            .filter(|seq| **seq > boundary)
            .count())),
        "infrastructureFailureReset" => Ok(json!(boundary)),
        "pinnedAssets" => Ok(json!({"pins":pins})),
        "buildDelegation" => Ok(delegation(events, false)),
        "harvestDelegation" => Ok(delegation(events, true)),
        "buildDigest" => digest(events, unknown),
        _ => Err(ProtocolError::new(
            500,
            "internal",
            format!("native reducer \"{name}\" not implemented"),
        )),
    }
}
fn extras(name: &str, events: &[Value], args: &Value) -> Value {
    if name == "phaseFailures" {
        let mut raised = serde_json::Map::new();
        let mut value = json!({"count":0});
        for event in events {
            let p = &event["payload"];
            match event["type"].as_str().unwrap() {
                "phase.deferral-escalated" => {
                    let mut raise = pick(p, &["phase", "round"]);
                    raise["source"] = json!("policy");
                    raise["deferral"] = json!("own-build-read");
                    raised.insert(p["id"].as_str().unwrap().into(), raise);
                }
                "escalation.raised" => {
                    raised.insert(
                        p["id"].as_str().unwrap().into(),
                        pick(p, &["phase", "source", "round", "policyCause"]),
                    );
                }
                "escalation.answered" => {
                    if let Some(raise) = raised.get(p["id"].as_str().unwrap()) {
                        let resets = raise["deferral"] != "own-build-read"
                            && raise["phase"] == args["phase"]
                            && if raise["source"] != "policy" || raise.get("policyCause").is_none()
                            {
                                raise
                                    .get("round")
                                    .is_none_or(|round| round == &args["round"])
                            } else {
                                match catalog()["phaseFailureResets"]
                                    [raise["policyCause"].as_str().unwrap()]
                                .as_str()
                                {
                                    Some("matching-round") => raise["round"] == args["round"],
                                    Some("all-phase-rounds") => true,
                                    _ => false,
                                }
                            };
                        if resets {
                            value = json!({"count":0})
                        }
                    }
                }
                "phase.failed" if p["phase"] == args["phase"] && p["round"] == args["round"] => {
                    value["count"] = json!(value["count"].as_i64().unwrap() + 1);
                    for (from, to) in [
                        ("error", "lastError"),
                        ("willRetry", "lastWillRetry"),
                        ("providerAttempts", "lastProviderAttempts"),
                    ] {
                        if let Some(v) = p.get(from) {
                            value[to] = v.clone()
                        } else {
                            remove(&mut value, to)
                        }
                    }
                }
                _ => {}
            }
        }
        return value;
    }
    if name == "dashboardFacts" {
        return dashboard_facts(events);
    }
    let mut selected = serde_json::Map::new();
    let mut restart = 0;
    let mut hosted = Vec::new();
    let mut reclaimed = serde_json::Map::new();
    let mut requests = Vec::new();
    let mut settled = Vec::new();
    let mut ledger: Vec<Value> = Vec::new();
    let mut active = Value::Null;
    let mut count = 0;
    let mut open: Vec<Value> = Vec::new();
    let mut latest = Value::Null;
    let mut failures = Vec::new();
    let mut aborted = false;
    for event in events {
        let t = event["type"].as_str().unwrap();
        let p = &event["payload"];
        match name {
            "currentPrAttachments" => {
                if t == "spec.revised" {
                    restart = restart.max(seq(event))
                } else if t == "pr-attachment.designated" {
                    let key = p["artifact"]["kind"].as_str().unwrap();
                    if selected
                        .get(key)
                        .is_none_or(|previous| seq(event) > seq(previous))
                    {
                        selected.insert(key.into(), event.clone());
                    }
                }
            }
            "pendingPrAttachmentReclaims" => {
                if t == "pr-attachment.hosted" {
                    hosted.push(event.clone())
                } else if t == "pr-attachment.reclaimed" {
                    let key = p["hostedSeq"].to_string();
                    if reclaimed
                        .get(&key)
                        .is_none_or(|previous| seq(event) > previous.as_i64().unwrap())
                    {
                        reclaimed.insert(key, event["seq"].clone());
                    }
                }
            }
            "summaryRequests" => {
                if t == "pr-summary.requested" {
                    requests.push(event.clone())
                } else if t == "pr-summary.settled" {
                    settled.push(p["request"].clone())
                }
            }
            "currentDeferralObservation" => {
                let entry = if t == "observation.recorded"
                    && p["refs"].as_array().is_some_and(|refs| {
                        refs.iter().any(|r| {
                            r.as_str()
                                .is_some_and(|r| r.starts_with("auto-merge-gate:pr:"))
                        })
                    }) {
                    Some(json!({"t":"observation","event":event}))
                } else if t == "finalize.completed" {
                    Some(json!({"t":"finalized","seq":event["seq"],"headSha":p["pr"]["headSha"]}))
                } else if matches!(t, "pr.merged" | "pr.closed") {
                    Some(json!({"t":"terminal","seq":event["seq"]}))
                } else if t == "reconcile.completed" {
                    Some(json!({"t":"reconciled","seq":event["seq"]}))
                } else {
                    None
                };
                if let Some(entry) = entry {
                    ledger.push(entry)
                } else if let Some(last) = ledger.last_mut().filter(|last| last["t"] == "barrier") {
                    last["seq"] = json!(last["seq"].as_i64().unwrap().max(seq(event)))
                } else {
                    ledger.push(json!({"t":"barrier","seq":event["seq"]}))
                }
            }
            "executionNoProgress" => {
                if t == "execution.started" {
                    if !active.is_null() {
                        count = 0
                    }
                    active = json!({"instance":p["instance"],"seq":event["seq"],"eligible":true})
                } else if t == "execution.ended" {
                    if active.is_null() || active["instance"] != p["instance"] {
                        continue;
                    }
                    count = if p["outcome"] == "completed"
                        && p["exitCode"] == 0
                        && active["eligible"] == true
                    {
                        count + 1
                    } else {
                        0
                    };
                    latest = json!({"instance":p["instance"],"seq":event["seq"]});
                    active = Value::Null;
                } else if t == "escalation.raised"
                    && p["source"] == "policy"
                    && p["policyCause"] == "execution-no-progress"
                {
                    if !open.contains(&p["id"]) {
                        open.push(p["id"].clone())
                    }
                } else if t == "escalation.answered" {
                    if !open.contains(&p["id"]) {
                        continue;
                    }
                    open.retain(|id| id != &p["id"]);
                    count = 0;
                    active = Value::Null;
                } else if catalog()["executionProgress"][t] != "bookkeeping" {
                    count = 0;
                    if !active.is_null() {
                        active["eligible"] = json!(false)
                    }
                }
            }
            "dispatchFailureBudget" => {
                if t == "runner.attached" {
                    failures.clear()
                } else if t == "escalation.raised"
                    && p["source"] == "policy"
                    && p["policyCause"] == "dispatch-failure-limit"
                {
                    if !open.contains(&p["id"]) {
                        open.push(p["id"].clone())
                    }
                } else if t == "escalation.answered" && open.contains(&p["id"]) {
                    open.retain(|id| id != &p["id"]);
                    if p["resolution"] != "abort" {
                        failures.clear()
                    } else {
                        aborted = true
                    }
                } else if t == "dispatch.failed"
                    && !(args["infrastructureOwnsWorkspace"] == true && p["stage"] == "workspace")
                {
                    failures.push(event.clone())
                }
            }
            _ => {}
        }
    }
    match name {
        "currentPrAttachments" => {
            let mut items: Vec<_> = selected
                .into_values()
                .filter(|event| seq(event) > restart)
                .collect();
            items.sort_by_key(seq);
            items.into()
        }
        "pendingPrAttachmentReclaims" => {
            hosted.sort_by_key(seq);
            hosted.retain(|event| {
                !reclaimed
                    .get(&event["seq"].to_string())
                    .is_some_and(|at| at.as_i64().unwrap() > seq(event))
            });
            hosted.into()
        }
        "summaryRequests" => requests
            .into_iter()
            .filter(|event| !settled.contains(&event["seq"]))
            .collect::<Vec<_>>()
            .into(),
        "currentDeferralObservation" => json!({"entries":ledger}),
        "executionNoProgress" => json!({"active":active,"count":count,"open":open,"latest":latest}),
        "dispatchFailureBudget" => {
            let mut value = json!({"count":failures.len(),"parked":aborted||!open.is_empty()});
            if let Some(last) = failures.last() {
                value["latest"] = last.clone()
            }
            value
        }
        _ => unreachable!(),
    }
}

fn dashboard_facts(events: &[Value]) -> Value {
    let mut value = json!({"sessionEvents":[],"intervals":{},"produced":{"planCompleted":{},"planReviewVerdict":{},"implementCompleted":{},"codeReviewVerdict":{}}});
    for event in events {
        let t = event["type"].as_str().unwrap();
        let p = &event["payload"];
        let phase = match t {
            "plan.started" | "plan.completed" => Some("plan".to_string()),
            "plan-review.started" | "plan-review.verdict" => Some("plan-review".to_string()),
            "implement.started" | "implement.completed" => Some("implement".to_string()),
            "code-review.started" | "code-review.verdict" => Some("code-review".to_string()),
            "verify.started" | "verify.completed" => {
                Some(format!("verify:{}", p["step"].as_str().unwrap()))
            }
            "finalize.started" | "finalize.completed" => Some("finalize".to_string()),
            "reconcile.started" | "reconcile.completed" => Some("reconcile".to_string()),
            _ => None,
        };
        if let Some(phase) = phase {
            if value["intervals"].get(&phase).is_none() {
                value["intervals"][&phase] = json!({"closed":[]})
            }
            let timing = &mut value["intervals"][&phase];
            let ms = chrono::DateTime::parse_from_rfc3339(event["ts"].as_str().unwrap())
                .unwrap()
                .timestamp_millis();
            if t.ends_with(".started") {
                timing["open"] = json!({"start":ms,"startSeq":event["seq"]})
            } else if let Some(open) = timing.as_object_mut().unwrap().remove("open") {
                timing["closed"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"start":open["start"],"end":ms,"startSeq":open["startSeq"]}))
            }
        }
        match t {
            "build.created" => value["created"] = event["seq"].clone(),
            "workspace.provisioned" => value["workspaceProvisioned"] = event["seq"].clone(),
            "workspace.released" => value["workspaceReleased"] = event["seq"].clone(),
            "spec.imported" | "spec.authored" => value["specLanded"] = event["seq"].clone(),
            "dispatch.comment-posted" => value["commentPosted"] = event["seq"].clone(),
            "dispatch.failed" => {
                let mut failed = pick(p, &["stage", "attempt", "error"]);
                failed["seq"] = event["seq"].clone();
                value["latestFailure"] = failed;
            }
            "session.suspended" | "session.resumed" | "session.started" | "session.ended" => value
                ["sessionEvents"]
                .as_array_mut()
                .unwrap()
                .push(event.clone()),
            "build.paused" => value["pausedAt"] = event["ts"].clone(),
            "plan.completed"
            | "plan-review.verdict"
            | "implement.completed"
            | "code-review.verdict" => {
                let field = match t {
                    "plan.completed" => "planCompleted",
                    "plan-review.verdict" => "planReviewVerdict",
                    "implement.completed" => "implementCompleted",
                    _ => "codeReviewVerdict",
                };
                let key = p["round"].to_string();
                let prior = value["produced"][field][&key].as_i64().unwrap_or(0);
                value["produced"][field][key] = json!(prior.max(seq(event)));
            }
            _ => {}
        }
    }
    value
}

fn delegation(events: &[Value], harvest: bool) -> Value {
    let mut state = if harvest {
        json!({"lastSeq":0,"runs":{},"sessions":{},"authorizations":{},"releases":{},"endings":{}})
    } else {
        json!({"lastSeq":0,"sessions":{},"terminals":[]})
    };
    for event in events {
        state["lastSeq"] = event["seq"].clone();
        let p = &event["payload"];
        let t = event["type"].as_str().unwrap();
        let key = |value: &Value| format!("id:{}", value.as_str().unwrap_or(""));
        if !harvest {
            if matches!(t, "session.started" | "session.ended") {
                let id = key(&p["session"]);
                if state["sessions"].get(&id).is_none() {
                    state["sessions"][&id] = json!({"starts":[],"endings":[]})
                }
                state["sessions"][&id][if t == "session.started" {
                    "starts"
                } else {
                    "endings"
                }]
                .as_array_mut()
                .unwrap()
                .push(if t == "session.started" {
                    event["seq"].clone()
                } else {
                    json!({"seq":event["seq"],"at":event["ts"]})
                })
            } else if matches!(t, "build.completed" | "build.aborted") {
                state["terminals"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"seq":event["seq"],"at":event["ts"]}))
            }
            continue;
        }
        let run = key(&p["run"]);
        if t == "harvest.started" {
            state["runs"][&run] = json!(true)
        }
        if t == "harvest.execution.authorized" {
            if state["authorizations"].get(&run).is_none() {
                state["authorizations"][&run] = json!({})
            }
            let id = key(&p["execution"]);
            if state["authorizations"][&run].get(&id).is_none() {
                state["authorizations"][&run][id] =
                    json!({"seq":event["seq"],"leaseHolder":p["leaseHolder"]})
            }
        }
        if matches!(
            t,
            "harvest.session.started" | "harvest.session.ended" | "harvest.session.suspended"
        ) {
            if state["sessions"].get(&run).is_none() {
                state["sessions"][&run] = json!({})
            }
            let id = key(&p["session"]);
            if state["sessions"][&run].get(&id).is_none() {
                state["sessions"][&run][&id] = json!({"starts":[],"endings":[]})
            }
            state["sessions"][&run][&id][if t == "harvest.session.started" {
                "starts"
            } else {
                "endings"
            }]
            .as_array_mut()
            .unwrap()
            .push(if t == "harvest.session.started" {
                event["seq"].clone()
            } else {
                json!({"seq":event["seq"],"at":event["ts"]})
            });
            if t == "harvest.session.suspended" {
                state["sessions"][&run][id]["suspended"] = json!(true)
            }
        }
        if matches!(t, "harvest.execution.released" | "harvest.execution.ended") {
            let id = key(&p["execution"]);
            if state["releases"].get(&id).is_none() {
                state["releases"][&id] = json!([])
            }
            state["releases"][id]
                .as_array_mut()
                .unwrap()
                .push(event["ts"].clone())
        }
        if matches!(
            t,
            "harvest.completed" | "harvest.escalated" | "harvest.recovery-exhausted"
        ) || (t == "harvest.failed" && p["willRetry"] != true)
        {
            if state["endings"].get(&run).is_none() {
                state["endings"][&run] = json!([])
            }
            state["endings"][run]
                .as_array_mut()
                .unwrap()
                .push(json!({"seq":event["seq"],"at":event["ts"]}))
        }
    }
    state
}
fn digest(events: &[Value], unknown: &[Value]) -> Result<Value, ProtocolError> {
    let mut state = json!({"observations":[]});
    let mut hosted = Vec::new();
    let mut reclaimed = Vec::new();
    let mut open = Value::Null;
    for e in events {
        let p = &e["payload"];
        let t = e["type"].as_str().unwrap();
        if [
            "node.writer-settled",
            "node.opened",
            "node.contribution-recorded",
            "pr.closed",
            "pr.merged",
            "build.completed",
            "build.aborted",
        ]
        .contains(&t)
        {
            state["readinessChangeSeq"] = e["seq"].clone()
        }
        match t {
            "integration.landed" => {
                if p.get("operation").is_some() {
                    state["integrationAuditPending"] = json!(true)
                } else {
                    remove(&mut state, "integrationAuditPending")
                }
            }
            "integration.audited" => remove(&mut state, "integrationAuditPending"),
            "build.created" => copy(&mut state, p, "kind"),
            "node.contribution-recorded" => state["nodeContribution"] = p.clone(),
            "node.opened" => state["nodeOpened"] = json!(true),
            "pr.closed" => state["prClosed"] = json!(true),
            "build.completed" => state["terminal"] = json!("done"),
            "build.aborted" => state["terminal"] = json!("aborted"),
            "pr.merged" => {
                state["merged"] = e["ts"].clone();
                if let Some(sha) = p.get("sha") {
                    state["mergedSha"] = sha.clone()
                } else {
                    remove(&mut state, "mergedSha")
                }
            }
            "observation.recorded" => state["observations"]
                .as_array_mut()
                .unwrap()
                .push(json!({"seq":e["seq"],"ts":e["ts"]})),
            "pr-attachment.hosted" => hosted.push(seq(e)),
            "pr-attachment.reclaimed" => {
                if p["hostedSeq"].as_i64().is_some_and(|s| seq(e) > s) {
                    reclaimed.push(p["hostedSeq"].as_i64().unwrap())
                }
            }
            "execution.started" => open = p.get("instance").cloned().unwrap_or(Value::Null),
            "execution.ended" if !open.is_null() && p["instance"] == open => open = Value::Null,
            _ => {}
        }
    }
    if hosted.iter().any(|seq| !reclaimed.contains(seq)) {
        state["reclaimPending"] = json!(true)
    }
    if !open.is_null() {
        state["executionOpen"] = json!(true)
    }
    if !unknown.is_empty() {
        state["compatibility"] = compatibility(unknown)?
    }
    Ok(state)
}
impl Store {
    pub async fn get_reducer_value(
        &self,
        scope: Scope<'_>,
        request: &Value,
    ) -> Result<Value, ProtocolError> {
        let resolved = resolve(scope, request)?;
        let mut client = self.database.client().await?;
        let tx = client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        if tx
            .query_opt(
                &format!("SELECT 1 FROM {} WHERE {}=$1", scope.table(), scope.key()),
                &[&scope.id()],
            )
            .await?
            .is_none()
        {
            return Err(ProtocolError::missing(scope.name(), scope.id()));
        }
        let rows = tx
            .query(
                &format!(
                    "SELECT * FROM {} WHERE {}=$1 ORDER BY seq",
                    scope.events(),
                    scope.event_key()
                ),
                &[&scope.id()],
            )
            .await?;
        let events = rows
            .iter()
            .map(|row| event_record(row, scope))
            .collect::<Result<Vec<_>, _>>()?;
        let mut cursor = 0;
        for event in &events {
            if seq(event) != cursor + 1 {
                return Err(ProtocolError::new(
                    500,
                    "internal",
                    "noncontiguous reducer log",
                ));
            }
            cursor += 1;
        }
        let value = reduce(scope, &resolved, &events)?;
        tx.commit().await?;
        Ok(
            json!({"version":resolved.version,"cursor":cursor,"value":serializable(value),"catalogIdentity":ServiceIdentity::current().catalog_identity}),
        )
    }
    pub async fn repo_build_digests(&self, repo: &str) -> Result<Value, ProtocolError> {
        self.repo_build_digests_lossless(repo)
            .await?
            .to_serde_checked()
            .map_err(|_| ProtocolError::internal())
    }
    pub async fn repo_build_digests_lossless(
        &self,
        repo: &str,
    ) -> Result<super::js_value::JsJson, ProtocolError> {
        use super::js_value::JsJson as J;
        let client = self.database.client().await?;
        let rows = client
            .query(
                "SELECT * FROM builds WHERE repo=$1 ORDER BY created_at,slug",
                &[&repo],
            )
            .await?;
        let records = rows
            .iter()
            .map(|row| super::store::records::record_lossless(row, Scope::Build("")))
            .collect::<Result<Vec<_>, _>>()?;
        drop(client);
        let mut digests = Vec::new();
        for record in records {
            let slug = record["slug"]
                .as_string()
                .unwrap()
                .to_scalar()
                .map_err(|_| ProtocolError::internal())?;
            let result = self
                .get_reducer_value_lossless(
                    Scope::Build(&slug),
                    &J::from_serde(&json!({"reducer":"buildDigest"})),
                )
                .await?;
            let mut digest = result["value"].clone();
            digest["slug"] = record["slug"].clone();
            digests.push(digest);
        }
        Ok(J::Array(digests))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;
    fn fixtures() -> Value {
        let mut text = String::new();
        GzDecoder::new(&include_bytes!("../../fixtures/protocol-reducers.json.gz")[..])
            .read_to_string(&mut text)
            .unwrap();
        parse_js_json(text.as_bytes()).unwrap()
    }
    #[test]
    fn every_catalog_name_scope_and_args_matches_typescript() {
        let f = fixtures();
        for case in f["validation"].as_array().unwrap() {
            let parsed = parse_reducer_request(case["raw"].as_str().unwrap().as_bytes());
            let scope = if case["scope"] == "repo" {
                Scope::Repo("fixture")
            } else {
                Scope::Build("fixture")
            };
            let actual = match parsed.and_then(|input| resolve(scope, &input)) {
                Ok(r) => json!({"name":r.name,"version":r.version}),
                Err(e) => json!(e.error),
            };
            assert_eq!(
                actual,
                case.get("accepted")
                    .or_else(|| case.get("rejected"))
                    .unwrap()
                    .clone(),
                "{} {}",
                case["scope"],
                case["raw"]
            );
        }
    }
    #[test]
    fn native_values_match_executable_catalog_replay() {
        let f = fixtures();
        for case in f["replay"].as_array().unwrap() {
            let scope = if case["scope"] == "repo" {
                Scope::Repo("fixture")
            } else {
                Scope::Build("fixture")
            };
            let resolved =
                resolve(scope, &json!({"reducer":case["name"],"args":case["args"]})).unwrap();
            let actual = reduce(scope, &resolved, case["events"].as_array().unwrap())
                .unwrap_or_else(|error| panic!("{}: {error}", case["id"]));
            assert_eq!(serializable(actual), case["value"], "{}", case["id"]);
        }
        assert!(f["replay"].as_array().unwrap().len() > 1000);
    }
}

#[path = "reducer_values_lossless.rs"]
mod lossless_values;
pub use lossless_values::{
    parse_reducer_request_lossless, reduce_events_lossless, reduce_lossless, resolve_lossless,
    ResolvedReducerLossless,
};

#[path = "reducer_kernels_lossless.rs"]
mod kernels_lossless;

#[path = "reducer_read_facts_lossless.rs"]
mod read_facts_lossless;
