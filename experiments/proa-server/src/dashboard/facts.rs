use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct DashboardFacts {
    value: Value,
}

impl Default for DashboardFacts {
    fn default() -> Self {
        Self {
            value: json!({
                "sessionEvents": [], "intervals": {},
                "produced": {"planCompleted": {}, "planReviewVerdict": {},
                    "implementCompleted": {}, "codeReviewVerdict": {}}
            }),
        }
    }
}

fn epoch(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| json!(t.timestamp_millis()))
        .unwrap_or(Value::Null)
}

impl DashboardFacts {
    pub fn finish(&self) -> Value {
        self.value.clone()
    }

    /// Called only after the enclosing lifecycle suffix has decoded successfully.
    pub fn advance(&mut self, events: &[Value]) {
        for event in events {
            let kind = event["type"].as_str().unwrap_or_default();
            let phase = match kind {
                "plan.started" | "plan.completed" => Some("plan".to_owned()),
                "plan-review.started" | "plan-review.verdict" => Some("plan-review".to_owned()),
                "implement.started" | "implement.completed" => Some("implement".to_owned()),
                "code-review.started" | "code-review.verdict" => Some("code-review".to_owned()),
                "verify.started" | "verify.completed" => Some(format!(
                    "verify:{}",
                    event["payload"]["step"].as_str().unwrap_or_default()
                )),
                "finalize.started" | "finalize.completed" => Some("finalize".to_owned()),
                "reconcile.started" | "reconcile.completed" => Some("reconcile".to_owned()),
                _ => None,
            };
            if let Some(phase) = phase {
                let intervals = self.value["intervals"].as_object_mut().unwrap();
                let timing = intervals
                    .entry(phase)
                    .or_insert_with(|| json!({"closed":[]}));
                if kind.ends_with(".started") {
                    timing["open"] = json!({"start":epoch(&event["ts"]),"startSeq":event["seq"]});
                } else if let Some(open) = timing.as_object_mut().unwrap().remove("open") {
                    timing["closed"].as_array_mut().unwrap().push(json!({
                        "start":open["start"], "startSeq":open["startSeq"], "end":epoch(&event["ts"])
                    }));
                }
            }
            let key = match kind {
                "build.created" => Some("created"),
                "workspace.provisioned" => Some("workspaceProvisioned"),
                "workspace.released" => Some("workspaceReleased"),
                "spec.imported" | "spec.authored" => Some("specLanded"),
                "dispatch.comment-posted" => Some("commentPosted"),
                _ => None,
            };
            if let Some(key) = key {
                self.value[key] = event["seq"].clone();
            }
            match kind {
                "dispatch.failed" => {
                    let p = &event["payload"];
                    self.value["latestFailure"] = json!({"seq":event["seq"],"stage":p["stage"],"attempt":p["attempt"],"error":p["error"]});
                }
                "session.started" | "session.ended" | "session.suspended" | "session.resumed" => {
                    self.value["sessionEvents"]
                        .as_array_mut()
                        .unwrap()
                        .push(event.clone());
                }
                "build.paused" => self.value["pausedAt"] = event["ts"].clone(),
                _ => {}
            }
            let output = match kind {
                "plan.completed" => Some("planCompleted"),
                "plan-review.verdict" => Some("planReviewVerdict"),
                "implement.completed" => Some("implementCompleted"),
                "code-review.verdict" => Some("codeReviewVerdict"),
                _ => None,
            };
            if let Some(output) = output {
                let round = event["payload"]["round"].to_string();
                let previous = self.value["produced"][output][&round].as_i64().unwrap_or(0);
                self.value["produced"][output][round] =
                    json!(previous.max(event["seq"].as_i64().unwrap_or(0)));
            }
        }
    }
}
