use serde_json::{json, Value};

/// Incremental session fold; archive is terminal and freezes the carried state.
#[derive(Clone, Debug)]
pub struct SessionAcc {
    turns: Vec<Value>,
    archived: bool,
    pending: Option<Value>,
    wake_globs: Value,
    wake_cursors: Value,
    journal_cursor: u64,
}
impl Default for SessionAcc {
    fn default() -> Self {
        Self {
            turns: vec![],
            archived: false,
            pending: None,
            wake_globs: json!([]),
            wake_cursors: json!({}),
            journal_cursor: 0,
        }
    }
}
impl SessionAcc {
    pub fn fold(&mut self, event: &Value) {
        if self.archived {
            return;
        }
        let p = &event["payload"];
        match event["type"].as_str().unwrap_or("") {
            "session.wake-set" => self.wake_globs = p["globs"].clone(),
            "turn.started" => {
                self.turns.push(json!({"turn":p["turn"],"stream":p["stream"],"startedSeq":event["seq"],"trigger":p["trigger"],"state":"open"}));
                let trigger = &p["trigger"];
                if trigger["kind"] == "wake" {
                    let seq = trigger["seq"].as_u64().unwrap_or(0);
                    if trigger["journal"] == true {
                        self.journal_cursor = self.journal_cursor.max(seq);
                    } else if let Some(build) = trigger["build"].as_str() {
                        let held = self.wake_cursors[build].as_u64().unwrap_or(0);
                        self.wake_cursors[build] = json!(held.max(seq));
                    }
                }
            }
            "approval.requested" => {
                self.pending = Some(
                    json!({"turn":p["turn"],"toolCallId":p["toolCallId"],"toolName":p["toolName"],"input":p["input"],"requestedSeq":event["seq"]}),
                )
            }
            "approval.answered" => {
                if self.pending.as_ref().is_some_and(|held| {
                    held["turn"] == p["turn"] && held["toolCallId"] == p["toolCallId"]
                }) {
                    self.pending = None;
                }
            }
            "session.archived" => self.archived = true,
            kind @ ("turn.suspended" | "turn.resumed" | "turn.completed" | "turn.failed") => {
                if let Some(turn) = self.turns.iter_mut().rev().find(|t| t["turn"] == p["turn"]) {
                    let state = turn["state"].as_str().unwrap_or("");
                    match kind {
                        "turn.suspended" if state == "open" => {
                            turn["state"] = json!("suspended");
                            turn["suspensionCause"] = p["cause"].clone();
                        }
                        "turn.resumed" if state == "suspended" => turn["state"] = json!("open"),
                        "turn.completed" if state != "completed" && state != "failed" => {
                            turn["state"] = json!("completed");
                            if let Some(usage) = p.get("usage") {
                                turn["usage"] = usage.clone();
                            }
                        }
                        "turn.failed" if state != "completed" && state != "failed" => {
                            turn["state"] = json!("failed");
                            for key in ["error", "kind"] {
                                if let Some(v) = p.get(key) {
                                    turn[key] = v.clone();
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    pub fn finish(&self) -> Value {
        let open = self
            .turns
            .iter()
            .rev()
            .find(|t| t["state"] != "completed" && t["state"] != "failed");
        let status = if self.archived {
            "archived"
        } else if self.pending.is_some() {
            "awaiting-approval"
        } else if let Some(turn) = open {
            if turn["state"] == "suspended" {
                "suspended"
            } else {
                "running"
            }
        } else {
            "idle"
        };
        let turns: Vec<_> = self
            .turns
            .iter()
            .map(|t| {
                let mut t = t.clone();
                t.as_object_mut().unwrap().remove("suspensionCause");
                t
            })
            .collect();
        let mut result = json!({"status":status,"wakeGlobs":self.wake_globs,"wakeCursors":self.wake_cursors,"journalWakeCursor":self.journal_cursor,"turns":turns});
        if let Some(turn) = open {
            result["openTurn"] = json!({"turn":turn["turn"],"stream":turn["stream"],"startedSeq":turn["startedSeq"],"trigger":turn["trigger"]});
            if status == "suspended" {
                if let Some(cause) = turn.get("suspensionCause") {
                    result["suspendedCause"] = cause.clone();
                }
            }
        }
        if let Some(pending) = &self.pending {
            result["pendingApproval"] = pending.clone();
        }
        result
    }
}
