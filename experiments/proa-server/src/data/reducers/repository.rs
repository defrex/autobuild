use super::repository_harvest::HarvestAcc;
use super::{compatibility, copy, max, number, pick, push, remove, with_seq};
use crate::data::error::DataError;
use serde_json::{json, Value};
#[derive(Clone, Debug)]
pub struct RepositoryAcc {
    facts: Value,
    settings_seq: Value,
    retained: Vec<Value>,
    journal: Vec<Value>,
    anchor: Option<i64>,
    harvest: HarvestAcc,
}
impl Default for RepositoryAcc {
    fn default() -> Self {
        Self {
            facts: json!({"compatibility":compatibility(),"presence":{},"upgrades":{"runs":{},"holds":{},"lineages":{},"rollbackIds":[]},"harvestFailures":{},"harvestVerdicts":{},"harvestAuthorizations":{},"harvestExecutionStarts":{},"latestHarvestResumedSeq":0,"harvestSessionEndings":{},"harvestSessions":[],"attention":{"sources":[],"tickStarts":[]},"dismissedThrough":0,"failedAt":{},"openHarvest":[],"settings":{"intake":true,"paused":false,"defaultAutoMerge":false},"ticketMigrations":{"migrations":[]},"autoMerge":{},"config":{},"sandboxes":[],"recentRuns":[],"publications":[]}),
            settings_seq: json!({}),
            retained: vec![],
            journal: vec![],
            anchor: None,
            harvest: Default::default(),
        }
    }
}
fn durable(t: &str) -> bool {
    t == "tickets.migration-recorded"
        || t.starts_with("harvest.")
        || t.starts_with("orchestrator.sandbox.")
        || t.starts_with("change-presence.")
        || t.starts_with("dispatcher.ticket-source-")
        || [
            "dispatcher.target-prepared",
            "dispatcher.yield-requested",
            "dispatcher.upgrade-failed",
            "dispatcher.handoff-started",
            "dispatcher.terminal-released",
            "dispatcher.takeover",
            "dispatcher.drain-deadline",
            "dispatcher.drain-settled",
            "dispatcher.handoff-completed",
            "dispatcher.forge-degraded",
            "dispatcher.forge-recovered",
            "dispatcher.intake-set",
            "dispatcher.pause-set",
            "dispatcher.auto-merge-default-set",
        ]
        .contains(&t)
}
impl RepositoryAcc {
    pub fn fold(&mut self, e: &Value, raw: &Value) -> Result<(), DataError> {
        self.fold_inner(e, raw, true)
    }
    pub fn fold_without_harvest(&mut self, e: &Value, raw: &Value) -> Result<(), DataError> {
        self.fold_inner(e, raw, false)
    }
    fn fold_inner(&mut self, e: &Value, raw: &Value, with_harvest: bool) -> Result<(), DataError> {
        let p = &e["payload"];
        let t = e["type"].as_str().unwrap_or("");
        // The TS read-facts reducer gives its constituent folds the stored
        // facts, then projects known payloads only for its own selector loop.
        // Bounded journal views also retain source envelopes verbatim.
        if with_harvest {
            self.harvest.fold(raw)?;
        }
        super::repository_upgrades::fold(&mut self.facts["upgrades"], raw);
        super::repository_attention::fold(&mut self.facts["attention"], raw);
        if t == "dispatcher.run-started" {
            self.anchor = Some(number(&e["seq"]));
            self.journal.retain(|h| {
                durable(h["type"].as_str().unwrap_or(""))
                    || h["type"] == "dispatcher.ticket-scan-completed"
            });
        }
        if t == "dispatcher.ticket-scan-completed" {
            if !self
                .retained
                .iter()
                .any(|h| h["type"] == t && number(&h["seq"]) >= number(&e["seq"]))
            {
                self.retained.retain(|h| h["type"] != t);
                self.retained.push(raw.clone());
            }
            if !self
                .journal
                .iter()
                .any(|h| h["type"] == t && number(&h["seq"]) >= number(&e["seq"]))
            {
                self.journal.retain(|h| h["type"] != t);
                self.journal.push(raw.clone());
            }
        } else {
            self.retained.push(raw.clone());
            if durable(t) || self.anchor.is_some() {
                self.journal.push(raw.clone());
            }
        }
        match t {
            "change-presence.observed" => {
                self.facts["presence"][p["destination"].as_str().unwrap_or("")] = p.clone()
            }
            "dispatcher.intake-set"
            | "dispatcher.pause-set"
            | "dispatcher.auto-merge-default-set" => {
                let key = match t {
                    "dispatcher.intake-set" => "intake",
                    "dispatcher.pause-set" => "paused",
                    _ => "defaultAutoMerge",
                };
                if number(&e["seq"]) > number(&self.settings_seq[key]) {
                    self.settings_seq[key] = e["seq"].clone();
                    self.facts["settings"][key] = p["enabled"].clone();
                }
                if t == "dispatcher.auto-merge-default-set" {
                    let fact = json!({"enabled":p["enabled"],"seq":e["seq"],"actor":e["actor"]});
                    self.facts["autoMerge"]["latest"] = fact.clone();
                    self.facts["autoMerge"][if p["enabled"] == true {
                        "latestEnabled"
                    } else {
                        "latestDisabled"
                    }] = fact;
                }
            }
            "dispatcher.forge-degraded" => self.facts["forgeHealth"] = raw["payload"].clone(),
            "dispatcher.forge-recovered" => {
                if self.facts["forgeHealth"]["forge"] == p["forge"] {
                    remove(&mut self.facts, "forgeHealth");
                }
            }
            "dispatcher.ticket-source-degraded" => self.facts["health"] = raw["payload"].clone(),
            "dispatcher.ticket-source-dependency-limited" => {
                if self.facts["health"]["cause"] == "rate-limited"
                    && self.facts["health"]["source"] == p["source"]
                {
                    self.facts["health"]["operation"] = json!("dependency-check");
                }
            }
            "dispatcher.ticket-source-recovered" => remove(&mut self.facts, "health"),
            "dispatcher.run-started" => {
                self.facts["config"] =
                    json!({"run":p["run"],"reference":raw["payload"]["effectiveConfig"]});
                self.facts["run"] = p["run"].clone();
                self.facts["status"] = json!({"run":p["run"],"health":"starting","roleWarnings":[],"diagnostics":[],"lastSeq":0});
                self.facts["latestRun"] = p["run"].clone();
            }
            "dispatcher.config-reloaded" => {
                if self.facts["config"]["run"] == p["run"] {
                    if let Some(reference) = raw["payload"].get("effectiveConfig") {
                        self.facts["config"]["reference"] = reference.clone();
                    }
                }
            }
            "dispatcher.ticket-scan-completed" => self.facts["scan"] = p.clone(),
            "dispatcher.run-stopped" => self.facts["latestStoppedRun"] = p["run"].clone(),
            "tickets.migration-recorded" => self.migration(raw)?,
            "harvest.failed" => {
                let key = serde_json::to_string(&json!([
                    p["run"],
                    p["step"],
                    p.get("round").unwrap_or(&Value::Null)
                ]))
                .unwrap();
                let count = number(&self.facts["harvestFailures"][&key]["count"]) + 1;
                self.facts["harvestFailures"][&key] = json!({"count":count,"latest":e});
                if p["willRetry"] != true {
                    self.facts["failedAt"][serde_json::to_string(&p["run"]).unwrap()] =
                        e["ts"].clone();
                }
            }
            "harvest.review.verdict" => {
                let key = serde_json::to_string(&json!([p["run"], p["round"]])).unwrap();
                let first = self.facts["harvestVerdicts"][&key]
                    .get("first")
                    .cloned()
                    .unwrap_or_else(|| e.clone());
                self.facts["harvestVerdicts"][key] = json!({"first":first,"latest":e});
            }
            "harvest.execution.started" => {
                self.facts["harvestExecutionStarts"][number(&e["seq"]).to_string()] =
                    p["execution"].clone();
                let entry = with_seq(
                    &pick(
                        p,
                        &[
                            "execution",
                            "provider",
                            "environmentId",
                            "sessionId",
                            "commandId",
                        ],
                    ),
                    e,
                );
                let a = self.facts["openHarvest"].as_array_mut().unwrap();
                if let Some(held) = a.iter_mut().find(|s| s["execution"] == p["execution"]) {
                    *held = entry;
                } else {
                    a.push(entry);
                }
            }
            "harvest.execution.released" => self.facts["openHarvest"]
                .as_array_mut()
                .unwrap()
                .retain(|s| s["execution"] != p["execution"]),
            "harvest.execution.authorized" => {
                let key = serde_json::to_string(&p["execution"]).unwrap();
                if self.facts["harvestAuthorizations"].get(&key).is_none() {
                    self.facts["harvestAuthorizations"][key] = e.clone();
                }
            }
            "harvest.resumed" => {
                self.facts["latestHarvestResumedSeq"] = e["seq"].clone();
                if let Some(seq) = self.facts.get("pendingHumanResume").cloned() {
                    max(&mut self.facts, "dismissedThrough", &seq);
                }
            }
            "harvest.resume-requested" if e["actor"]["kind"] == "human" => {
                self.facts["pendingHumanResume"] = e["seq"].clone()
            }
            "harvest.pause-requested" => remove(&mut self.facts, "pendingHumanResume"),
            "harvest.session.started" => {
                if let Some(c) = p.get("continuation") {
                    if let Some(prior) = self.facts["harvestSessions"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|s| s["session"] == c["predecessor"])
                    {
                        prior["status"] = json!("ended");
                    }
                }
                let mut entry = pick(
                    p,
                    &[
                        "run",
                        "session",
                        "role",
                        "step",
                        "round",
                        "continuation",
                        "stream",
                    ],
                );
                entry["status"] = json!("open");
                entry["streamStatus"] = json!(if p.get("stream").is_some() {
                    "open"
                } else {
                    "closed"
                });
                push(&mut self.facts, "harvestSessions", entry);
            }
            "harvest.session.ended" | "harvest.session.suspended" => {
                let key = serde_json::to_string(&p["session"]).unwrap();
                if self.facts["harvestSessionEndings"].get(&key).is_none() {
                    self.facts["harvestSessionEndings"][key] = e["seq"].clone();
                }
                if let Some(s) = self.facts["harvestSessions"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .rev()
                    .find(|s| s["session"] == p["session"] && s["status"] == "open")
                {
                    s["status"] = json!(if t == "harvest.session.suspended" {
                        "suspended"
                    } else {
                        "ended"
                    });
                    s["transcript"] = p["transcript"].clone();
                    s["streamStatus"] = json!("closed");
                }
            }
            "orchestrator.sandbox.published" => {
                self.facts["publications"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|prior| {
                        prior["payload"]["operator"] != p["operator"]
                            || prior["payload"]["branch"] != p["branch"]
                    });
                push(&mut self.facts, "publications", e.clone());
            }
            _ => {}
        }
        self.sandbox(raw);
        self.status(e);
        if t.starts_with("dispatcher.") && p["run"].is_string() {
            self.run_fact(e);
        }
        Ok(())
    }
    pub fn finish(&self) -> Value {
        let mut facts = self.facts.clone();
        remove(&mut facts, "run");
        remove(&mut facts, "pendingHumanResume");
        facts["harvest"] = self.harvest.finish();
        let mut retained = self
            .retained
            .iter()
            .filter(|e| {
                let t = e["type"].as_str().unwrap_or("");
                durable(t)
                    || t == "dispatcher.ticket-scan-completed"
                    || self.anchor.is_some_and(|a| number(&e["seq"]) >= a)
            })
            .cloned()
            .collect::<Vec<_>>();
        retained.sort_by_key(|e| number(&e["seq"]));
        json!({"repositoryStateEvents":retained,"journalView":self.journal,"repositoryReadFacts":facts})
    }
    fn sandbox(&mut self, e: &Value) {
        let t = e["type"].as_str().unwrap_or("");
        if ![
            "orchestrator.sandbox.provisioned",
            "orchestrator.sandbox.resumed",
            "orchestrator.sandbox.activity",
            "orchestrator.sandbox.stopped",
            "orchestrator.sandbox.reset",
            "orchestrator.sandbox.released",
        ]
        .contains(&t)
        {
            return;
        }
        let p = &e["payload"];
        let entries = self.facts["sandboxes"].as_array_mut().unwrap();
        let index = entries
            .iter()
            .position(|s| s["environmentId"] == p["environmentId"]);
        let prior = index.map(|i| entries[i].clone());
        let next = match t {
            "orchestrator.sandbox.provisioned"
            | "orchestrator.sandbox.resumed"
            | "orchestrator.sandbox.released" => {
                let mut next = pick(p, &["operator", "environmentId"]);
                next["lastEvidenceTs"] = e["ts"].clone();
                next["state"] = json!(if t == "orchestrator.sandbox.released" {
                    "released"
                } else {
                    "live"
                });
                next["provider"] = if t == "orchestrator.sandbox.released" {
                    prior
                        .as_ref()
                        .and_then(|v| v.get("provider"))
                        .cloned()
                        .unwrap_or(json!(""))
                } else {
                    p["provider"].clone()
                };
                if t == "orchestrator.sandbox.provisioned" {
                    for k in ["sessionId", "baseSha"] {
                        copy(&mut next, p, k);
                    }
                } else {
                    if let Some(prior) = prior {
                        for k in ["sessionId", "baseSha"] {
                            copy(&mut next, &prior, k);
                        }
                    }
                    if t == "orchestrator.sandbox.resumed" {
                        if let Some(id) = p.get("sessionId") {
                            next["sessionId"] = id.clone();
                        }
                    }
                }
                Some(next)
            }
            _ => prior.and_then(|mut prior| {
                if prior["lastEvidenceTs"].as_str().unwrap_or("") <= e["ts"].as_str().unwrap_or("")
                {
                    prior["lastEvidenceTs"] = e["ts"].clone();
                    if t == "orchestrator.sandbox.stopped" {
                        prior["state"] = json!("stopped");
                    }
                    Some(prior)
                } else {
                    None
                }
            }),
        };
        if let Some(next) = next {
            if let Some(i) = index {
                entries[i] = next;
            } else {
                entries.push(next);
            }
        }
    }
    fn migration(&mut self, e: &Value) -> Result<(), DataError> {
        let p = &e["payload"];
        let migrations = self.facts["ticketMigrations"]["migrations"]
            .as_array_mut()
            .unwrap();
        let bad = || DataError::Decode {
            scope: "repository",
            event_type: "tickets.migration-recorded".into(),
            seq: number(&e["seq"]),
        };
        if let Some(old) = migrations.iter().find(|m| m["identity"] == p["identity"]) {
            if old["from"] != p["from"] || old["to"] != p["to"] || old["mapping"] != p["mapping"] {
                return Err(bad());
            }
            return Ok(());
        }
        for old in migrations.iter() {
            if old["from"] != old["to"] && p["from"] != p["to"] && old["from"] == p["from"] {
                for (id, next) in p["mapping"].as_object().unwrap() {
                    if old["mapping"].get(id).is_some()
                        && (old["to"] != p["to"] || old["mapping"][id] != *next)
                    {
                        return Err(bad());
                    }
                }
            }
        }
        migrations.push(p.clone());
        for m in migrations.iter() {
            for id in m["mapping"].as_object().unwrap().keys() {
                let mut source = m["from"].clone();
                let mut id = json!(id);
                let mut visited = vec![];
                loop {
                    let key = json!([source, id]);
                    if visited.contains(&key) {
                        return Err(bad());
                    }
                    visited.push(key);
                    let next = migrations.iter().find(|m| {
                        m["from"] == source
                            && m["from"] != m["to"]
                            && m["mapping"].get(id.as_str().unwrap_or("")).is_some()
                    });
                    if let Some(m) = next {
                        let next = m["mapping"][id.as_str().unwrap_or("")].clone();
                        source = m["to"].clone();
                        id = next;
                    } else {
                        break;
                    }
                }
            }
        }
        Ok(())
    }
    fn run_fact(&mut self, e: &Value) {
        let p = &e["payload"];
        let t = e["type"].as_str().unwrap_or("");
        let runs = self.facts["recentRuns"].as_array_mut().unwrap();
        let i = if let Some(i) = runs.iter().position(|r| r[0] == p["run"]) {
            i
        } else {
            runs.push(json!([p["run"], {}]));
            runs.len() - 1
        };
        let s = &mut runs[i][1];
        match t {
            "dispatcher.run-started" => {
                if s.get("start").is_none() {
                    s["start"] = e.clone();
                }
                s["latestStart"] = e.clone();
            }
            "dispatcher.runtime-recorded" => s["runtime"] = e.clone(),
            "dispatcher.run-stopped" => s["stop"] = e.clone(),
            "dispatcher.stop-requested" => {
                if s.get("stopRequest").is_none() {
                    s["stopRequest"] = e.clone();
                }
            }
            "dispatcher.tick-started" | "dispatcher.tick-completed" | "dispatcher.tick-failed" => {
                s["boundary"] = e["type"].clone();
                if t != "dispatcher.tick-started" {
                    s["tick"] = e.clone();
                }
                if t == "dispatcher.tick-completed" {
                    s["completed"] = e.clone();
                }
            }
            _ => {}
        }
        let latest = self.facts["latestRun"].clone();
        let stopped = self.facts["latestStoppedRun"].clone();
        let runs = self.facts["recentRuns"].as_array_mut().unwrap();
        while runs.len() > 16 {
            if let Some(i) = runs.iter().position(|r| r[0] != latest && r[0] != stopped) {
                runs.remove(i);
            } else {
                break;
            }
        }
    }
    /// Parameterized status replay does not retain the bounded recent-run window.
    pub fn status_for_events(run: &str, events: &[Value]) -> Value {
        let mut acc = Self::default();
        acc.facts["run"] = json!(run);
        acc.facts["status"] =
            json!({"run":run,"health":"starting","roleWarnings":[],"diagnostics":[],"lastSeq":0});
        for event in events {
            acc.status(event);
        }
        acc.facts["status"].clone()
    }
    fn status(&mut self, e: &Value) {
        if self.facts.get("run").is_none() {
            return;
        }
        let p = &e["payload"];
        let t = e["type"].as_str().unwrap_or("");
        if p["run"] != self.facts["run"]
            || number(&e["seq"]) <= number(&self.facts["status"]["lastSeq"])
        {
            return;
        }
        let s = &mut self.facts["status"];
        s["lastSeq"] = e["seq"].clone();
        let mut warning = false;
        match t {
            "dispatcher.run-started" => {
                for k in [
                    "yieldedHolder",
                    "forgeReadinessFailures",
                    "notice",
                    "warningNotice",
                ] {
                    remove(s, k);
                }
                s["health"] = json!("running");
                copy(s, p, "effectiveConfig");
                copy(s, p, "roleWarnings");
            }
            "dispatcher.config-reloaded" => {
                for k in ["effectiveConfig", "roleWarnings"] {
                    if let Some(v) = p.get(k) {
                        s[k] = v.clone();
                    }
                }
                let required = p["restartRequired"].as_array().cloned().unwrap_or_default();
                s["notice"] = json!(if required.is_empty() {
                    "autobuild.toml reloaded".to_string()
                } else {
                    format!(
                        "autobuild.toml reload requires dispatch restart for: {}",
                        required
                            .iter()
                            .map(|v| v.as_str().unwrap_or(""))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                });
                warning = !required.is_empty();
            }
            "dispatcher.forge-readiness-failed" => {
                if !s["forgeReadinessFailures"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|f| f["check"] == p["check"]))
                {
                    push(s, "forgeReadinessFailures", p.clone());
                }
            }
            "dispatcher.config-rejected"
            | "dispatcher.config-publication-failed"
            | "dispatcher.tick-failed"
            | "dispatcher.harvest-runner-failed" => {
                let prefix = match t {
                    "dispatcher.config-rejected" => "config reload rejected",
                    "dispatcher.config-publication-failed" => {
                        "config reload not applied because its durable trace failed"
                    }
                    "dispatcher.tick-failed" => "tick failed",
                    _ => "harvest runner failed",
                };
                s["notice"] = json!(format!("{}: {}", prefix, p["error"].as_str().unwrap_or("")));
                warning = true;
            }
            "dispatcher.tick-yielded" => s["yieldedHolder"] = p["holder"].clone(),
            "dispatcher.tick-started" => remove(s, "yieldedHolder"),
            "dispatcher.tick-completed" => {
                s["queued"] = p["queued"].clone();
                copy(s, &p["counters"], "creationWithheld");
                let mut diagnostics = vec![];
                for k in [
                    "janitorDiagnostics",
                    "ticketDiagnostics",
                    "creationDiagnostics",
                    "dependencyDiagnostics",
                ] {
                    diagnostics.extend(p[k].as_array().cloned().unwrap_or_default());
                }
                s["diagnostics"] = json!(diagnostics);
            }
            "dispatcher.runner-settled" => {
                let slug = p["slug"].as_str().unwrap_or("");
                s["notice"] = json!(match p["outcome"].as_str().unwrap_or("") {
                    "relaunch" => format!("build {slug} relaunching on the accepted runtime"),
                    "parked" => format!(
                        "build {slug} parked ({})",
                        p["status"].as_str().unwrap_or("unknown")
                    ),
                    "lease-held" =>
                        format!("build {slug} already held by another runner — skipped"),
                    _ => format!(
                        "build {slug} runner failed: {}",
                        p.get("error")
                            .unwrap_or(&p["outcome"])
                            .as_str()
                            .unwrap_or("")
                    ),
                });
                warning = true;
            }
            "dispatcher.upgrade-available" => s["availableUpgrade"] = p["version"].clone(),
            "dispatcher.operator-reported" => {
                s["notice"] = p["message"].clone();
                warning = p["level"] == "warning";
            }
            "dispatcher.run-stopped" => {
                s["health"] = json!(if p["outcome"] == "normal" {
                    "stopped"
                } else {
                    "failed"
                });
                if p["outcome"] != "normal" {
                    s["notice"] = json!(format!(
                        "dispatcher stopped unexpectedly{}",
                        p.get("error")
                            .map(|v| format!(": {}", v.as_str().unwrap_or("")))
                            .unwrap_or_default()
                    ));
                    warning = true;
                } else if p["reason"] == "superseded" {
                    s["notice"] = json!("dispatcher superseded by another invocation");
                }
            }
            _ => {}
        }
        if warning {
            s["warningNotice"] = s["notice"].clone();
        }
    }
}
