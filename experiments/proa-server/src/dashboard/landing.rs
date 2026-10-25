use serde_json::{json, Value};

pub fn authorized(landing: &Value) -> bool {
    if landing["command"]["kind"] == "hold" {
        return false;
    }
    if landing["command"]["legacy"] == true && landing["command"]["kind"] == "land" {
        return true;
    }
    !landing["decision"].is_null()
        && (landing["command"]["kind"] == "land" || landing["decision"]["mode"] == "auto")
}
pub fn policy(landing: &Value) -> Value {
    if landing["command"]["kind"] == "hold" {
        json!("held")
    } else {
        landing["decision"]
            .get("mode")
            .cloned()
            .unwrap_or(json!("policy pending"))
    }
}
pub fn auto_merge(state: &Value) -> &'static str {
    let landing = &state["landing"];
    if !landing["decision"].is_null() || !landing["command"].is_null() {
        if landing["command"]["kind"] == "hold" {
            if state["pr"].is_null() && landing["native"]["enabled"] != true {
                return "off";
            }
            return if landing["acknowledgedSeq"] == landing["command"]["seq"] {
                "off"
            } else {
                "cancelling"
            };
        }
        if authorized(landing) {
            return if landing["native"]["enabled"] == true
                && landing["native"]["decisionSeq"] == landing["decision"]["seq"]
            {
                "enabled"
            } else {
                "requested"
            };
        }
        return "off";
    }
    let auto = &state["autoMerge"];
    if auto["requested"] == true {
        return if auto["applied"]["enabled"] == true
            && auto["applied"]["commandSeq"] == auto["commandSeq"]
        {
            "enabled"
        } else {
            "requested"
        };
    }
    if auto["commandSeq"].is_null()
        || (auto["applied"]["enabled"] == false
            && auto["applied"]["commandSeq"] == auto["commandSeq"])
        || (state["pr"].is_null() && auto["applied"]["enabled"] != true)
    {
        "off"
    } else {
        "cancelling"
    }
}
