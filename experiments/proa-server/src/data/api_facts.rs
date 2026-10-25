//! Additional source-derived read facts; folded with the same validated suffix.
use serde_json::{json, Value};
#[derive(Clone, Debug)]
pub struct ApiFacts(Value);
impl Default for ApiFacts {
    fn default() -> Self {
        Self(json!({"runnerAttaches":[],"open":null,"workspace":null,"provisionMarker":null}))
    }
}
impl ApiFacts {
    pub fn finish(&self) -> Value {
        self.0.clone()
    }
    pub fn advance(&mut self, events: &[Value]) {
        for event in events {
            let p = &event["payload"];
            match event["type"].as_str().unwrap_or_default() {
                "runner.attached" => {
                    let mut attach = p.clone();
                    attach["seq"] = event["seq"].clone();
                    attach["ts"] = event["ts"].clone();
                    attach["runtime"] = Value::Null;
                    self.0["runnerAttaches"]
                        .as_array_mut()
                        .unwrap()
                        .push(attach);
                }
                "runner.runtime-recorded" => {
                    if let Some(attach) = self.0["runnerAttaches"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|a| a["seq"] == p["attachedSeq"] && a["instance"] == p["instance"])
                    {
                        attach["runtime"] = p["runtime"].clone();
                    }
                }
                "execution.started" => {
                    self.0["open"] = p.clone();
                }
                "execution.ended" => {
                    if self.0["open"]["instance"] == p["instance"] {
                        self.0["open"] = Value::Null;
                    }
                }
                "workspace.provision-started" => self.0["provisionMarker"] = p.clone(),
                "workspace.provisioned" => {
                    self.0["workspace"] = p.clone();
                    self.0["provisionMarker"] = Value::Null;
                }
                "workspace.released" => {
                    self.0["workspace"] = Value::Null;
                    self.0["provisionMarker"] = Value::Null;
                }
                _ => {}
            }
        }
    }
}
