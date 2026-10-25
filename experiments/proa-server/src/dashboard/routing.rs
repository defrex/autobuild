//! Compact projection of the native auto-merge diagnostic ledger.
use super::model::{array, number};
use serde_json::{json, Value};
#[derive(Clone, Debug)]
pub struct DeferralFacts(Value);
impl Default for DeferralFacts {
    fn default() -> Self {
        Self(json!({"entries":[]}))
    }
}
impl DeferralFacts {
    pub fn finish(&self) -> Value {
        self.0.clone()
    }
    pub fn advance(&mut self, events: &[Value]) {
        for event in events {
            let scope = if event.get("repo").is_some() {
                Some(crate::data::reducers::Scope::Repository)
            } else if event.get("build").is_some() {
                Some(crate::data::reducers::Scope::Build)
            } else {
                None
            };
            if scope.is_some_and(|scope| {
                !crate::data::events::known_event(scope, event["type"].as_str().unwrap_or_default())
            }) {
                continue;
            }

            let seq = &event["seq"];
            let p = &event["payload"];
            let entry = match event["type"].as_str().unwrap_or_default() {
                "observation.recorded"
                    if array(&p["refs"]).iter().any(|r| {
                        r.as_str()
                            .is_some_and(|r| r.starts_with("auto-merge-gate:pr:"))
                    }) =>
                {
                    Some(json!({"t":"observation","event":event}))
                }
                "finalize.completed" => {
                    Some(json!({"t":"finalized","seq":seq,"headSha":p["pr"]["headSha"]}))
                }
                "pr.merged" | "pr.closed" => Some(json!({"t":"terminal","seq":seq})),
                "reconcile.completed" => Some(json!({"t":"reconciled","seq":seq})),
                _ => None,
            };
            let entries = self.0["entries"].as_array_mut().unwrap();
            if let Some(entry) = entry {
                entries.push(entry);
            } else if let Some(last) = entries.last_mut().filter(|last| last["t"] == "barrier") {
                last["seq"] = json!(number(&last["seq"]).max(number(seq)));
            } else {
                entries.push(json!({"t":"barrier","seq":seq}));
            }
        }
    }
}
pub fn current_deferral(ledger: &Value, state: &Value) -> Option<String> {
    let auto = &state["autoMerge"];
    let command = auto["commandSeq"].as_i64()?;
    if auto["requested"] != true
        || (auto["applied"]["commandSeq"] == command
            && auto["applied"]["enabled"] == auto["requested"])
    {
        return None;
    }
    let pr = state["pr"]["number"].as_i64()?;
    let marker = format!("auto-merge-gate:pr:{pr}:command:{command}");
    let entries = array(&ledger["entries"]);
    let observation = &entries.iter().rev().find(|entry| {
        entry["t"] == "observation"
            && array(&entry["event"]["payload"]["refs"])
                .iter()
                .any(|r| r == &marker)
    })?["event"];
    let seq = number(&observation["seq"]);
    let mut head = None;
    for entry in entries {
        let entry_seq = if entry["t"] == "observation" {
            number(&entry["event"]["seq"])
        } else {
            number(&entry["seq"])
        };
        if entry_seq >= seq {
            break;
        }
        if entry["t"] == "finalized" {
            head = entry["headSha"].as_str();
        }
    }
    for entry in entries {
        if entry["t"] == "observation" || entry["t"] == "barrier" || number(&entry["seq"]) <= seq {
            continue;
        }
        if entry["t"] == "terminal" || entry["t"] == "reconciled" {
            return None;
        }
        if head.is_none() {
            head = entry["headSha"].as_str();
        } else if head != entry["headSha"].as_str() {
            return None;
        }
    }
    observation["payload"]["summary"]
        .as_str()
        .map(str::to_owned)
}
