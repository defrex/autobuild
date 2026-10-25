//! Chronological build-agent sessions, independent from operator sessions.
use serde_json::{json, Value};
use std::collections::HashMap;

fn copy(target: &mut Value, source: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = source.get(key) {
            target[*key] = value.clone();
        }
    }
}

pub fn project_sessions(events: &[Value], streams: Option<&[Value]>) -> Vec<Value> {
    let mut records = HashMap::new();
    for record in streams.unwrap_or_default() {
        if record["scope"]["kind"] == "build" {
            if let Some(label) = record["label"].as_str() {
                records.insert(label.to_owned(), record);
            }
        }
    }
    let mut sessions: Vec<Value> = Vec::new();
    let mut open: HashMap<String, usize> = HashMap::new();
    for event in events {
        let p = &event["payload"];
        let id = p["session"].as_str().unwrap_or_default();
        match event["type"].as_str().unwrap_or_default() {
            "session.started" => {
                if let Some(predecessor) = p["continuation"]["predecessor"].as_str() {
                    if let Some(index) = open.remove(predecessor) {
                        sessions[index]["status"] = json!("reclaimed");
                        sessions[index]["streamStatus"] = json!("closed");
                    }
                }
                let record = records.get(&format!("session:{id}"));
                let mut session = json!({
                    "id":id,"role":p["role"],"phase":p["phase"],"runtime":p["runner"],
                    "startedSeq":event["seq"],"status":"open",
                    "streamStatus": if p.get("stream").is_some() {"open"} else {"closed"}
                });
                copy(&mut session, p, &["round", "model", "stream"]);
                copy(
                    &mut session,
                    &p["continuation"],
                    &["predecessor", "root", "cause"],
                );
                if let Some(record) = record {
                    session["stream"] = record["id"].clone();
                    session["streamStatus"] = record["status"].clone();
                }
                open.insert(id.to_owned(), sessions.len());
                sessions.push(session);
            }
            "session.resume-fallback" if p["stale"] != true => {
                if let Some(session) = sessions.iter_mut().find(|s| s["id"] == id) {
                    session["fallbackReason"] = p["reason"].clone();
                }
            }
            "session.resumed" if p["stale"] != true => {
                if let Some(index) = open.get(id) {
                    sessions[*index]["status"] = json!("resumed");
                }
            }
            "session.suspended" => {
                if let Some(index) = open.remove(id) {
                    sessions[index]["status"] = json!("suspended");
                    copy(&mut sessions[index], p, &["cause", "transcript", "usage"]);
                    sessions[index]["streamStatus"] = json!("closed");
                }
            }
            "session.ended" => {
                if let Some(index) = open.remove(id) {
                    let session = &mut sessions[index];
                    session["status"] = json!(if p.get("transcript").is_some() {
                        "ended"
                    } else {
                        "reclaimed"
                    });
                    copy(session, p, &["transcript", "usage", "reclaimedBy"]);
                    session["streamStatus"] = json!("closed");
                    if let Some(record) = records.get(&format!("session:{id}")) {
                        session["stream"] = record["id"].clone();
                        session["streamStatus"] = record["status"].clone();
                    }
                }
            }
            _ => {}
        }
    }
    sessions
}
