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
        for event in events {
            crate::protocol::restack_values::advance_leaf(&mut self.0, event);
        }
    }
}
