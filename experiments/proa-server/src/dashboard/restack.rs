use serde_json::{json, Value};
#[derive(Clone, Debug)]
pub struct RestackFacts(Value);
impl Default for RestackFacts {
    fn default() -> Self {
        Self(json!({"gates":{}}))
    }
}
impl RestackFacts {
    pub fn finish(&self) -> Value {
        self.0.clone()
    }
    pub fn advance(&mut self, events: &[Value]) {
        let s = &mut self.0;
        for e in events {
            let p = &e["payload"];
            match e["type"].as_str().unwrap_or_default() {
                "workspace.provisioned" => {
                    if s.get("initialBase").is_none() {
                        s["initialBase"] = p["base"]["sha"].clone();
                    }
                }
                "finalize.completed" => s["finalizedAt"] = e["seq"].clone(),
                "node.parent-accepted" => {
                    s.as_object_mut().unwrap().remove("target");
                }
                "target.moved" => {
                    let mut t = p.clone();
                    t["seq"] = e["seq"].clone();
                    s["target"] = t;
                }
                "finalize.step-completed" if p["ok"] == true && p.get("headSha").is_some() => {
                    s["postStepAt"] = e["seq"].clone()
                }
                "restack.prepared" => {
                    s["active"] = p.clone();
                    for key in ["replay", "intent", "reconcileAttempt"] {
                        s.as_object_mut().unwrap().remove(key);
                    }
                }
                "restack.replayed" if p["id"] == s["active"]["id"] => s["replay"] = p.clone(),
                "restack.publish-intended" if p["id"] == s["active"]["id"] => {
                    s["intent"] = p.clone()
                }
                "reconcile.started" => {
                    if !s["active"].is_null() && p["restackId"] == s["active"]["id"] {
                        s["reconcileAttempt"] = p["attempt"].clone();
                        s["initialVerification"] = json!(s["active"]["trigger"] == "verify-entry");
                    } else {
                        s["initialVerification"] = json!(false);
                    }
                }
                "restack.completed" => {
                    s["completedAt"] = e["seq"].clone();
                    s["completed"] = p.clone();
                    let cycle = p["cycle"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| p["cycle"].to_string());
                    s["gates"][cycle] = p.clone();
                    if s["active"]["id"] == p["id"] {
                        for key in ["active", "replay", "intent"] {
                            s.as_object_mut().unwrap().remove(key);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}
