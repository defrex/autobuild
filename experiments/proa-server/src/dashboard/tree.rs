use super::model::{array, number};
use serde_json::{json, Value};
pub fn integration_complete(s: &Value) -> bool {
    let o = &s["integration"]["observation"];
    !o.is_null()
        && array(&o["openChildren"]).is_empty()
        && array(&o["diagnostics"]).is_empty()
        && !array(&o["contributions"]).is_empty()
}
fn cycle_current(s: &Value) -> bool {
    !s["integration"]["cycle"].is_null()
        && number(&s["integration"]["cycle"]["seq"]) > number(&s["restartSince"])
}
pub fn integration_current(s: &Value) -> bool {
    let c = &s["integration"]["cycle"];
    let n = &s["nodeRestack"];
    cycle_current(s)
        && integration_complete(s)
        && n["parentRequest"].is_null()
        && n["parentChange"].is_null()
        && n["active"].is_null()
        && s["nodeComparison"]["headSha"] == c["head"]
        && s["nodeComparison"]["parentSha"] == c["parent"]
        && (n["observedParent"].is_null() || n["observedParent"]["sha"] == c["parent"])
        && n["contributionBase"] == c["parent"]
}
pub fn integration_failed(s: &Value) -> bool {
    let c = &s["integration"]["cycle"];
    cycle_current(s)
        && s["nodeComparison"]["headSha"] == c["head"]
        && s["nodeComparison"]["parentSha"] == c["parent"]
        && array(&s["verify"]["results"]).iter().any(|r| {
            number(&r["seq"]) > number(&c["seq"]).max(number(&s["verify"]["cycleSince"]))
                && r["restackId"] == c["id"]
                && r["outcome"] == "fail"
        })
}
pub fn cycle_verified(s: &Value) -> bool {
    let c = &s["integration"]["cycle"];
    if !cycle_current(s) {
        return false;
    }
    let config: Value =
        serde_json::from_str(c["config"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    let receipts: Vec<_> = array(&s["verify"]["results"])
        .iter()
        .filter(|r| {
            number(&r["seq"]) > number(&c["seq"]).max(number(&s["verify"]["cycleSince"]))
                && r["restackId"] == c["id"]
                && r["headSha"] == c["head"]
                && r["baseSha"] == c["parent"]
        })
        .collect();
    !receipts.iter().any(|r| r["outcome"] == "fail")
        && array(&config["verify"]["steps"]).iter().all(|step| {
            receipts.iter().any(|r| {
                &r["step"] == step && (r["outcome"] == "pass" || r["outcome"] == "skipped")
            })
        })
}
pub fn ready(s: &Value, r: &Value) -> bool {
    let d = &s["landing"]["decision"];
    let c = &s["integration"]["cycle"];
    let node = s["kind"] == "node";
    if d.is_null()
        || (node && !cycle_current(s))
        || s["status"] == "paused"
        || !s["currentPhase"].is_null()
        || !array(&s["openEscalations"]).is_empty()
        || !array(&s["pendingCommands"]).is_empty()
        || s["prState"] != "open"
        || (if node {
            &c["head"]
        } else {
            &s["pr"]["headSha"]
        }) != &d["candidate"]["head"]
        || (!node && !r["target"].is_null() && r["target"]["sha"] != d["candidate"]["parent"])
        || !r["active"].is_null()
        || !s["nodeRestack"]["active"].is_null()
    {
        return false;
    }
    if ["queued", "done", "aborted"]
        .iter()
        .any(|v| s["status"] == *v)
        || !s["discardRequest"].is_null()
        || !s["nodeRestack"]["parentRequest"].is_null()
        || !s["nodeRestack"]["parentChange"].is_null()
        || !array(&s["sessions"]["open"]).is_empty()
    {
        return false;
    }
    let candidate = &d["candidate"];
    if node {
        return integration_current(s)
            && cycle_verified(s)
            && candidate["parent"] == c["parent"]
            && candidate["cycle"] == c["id"];
    }
    if number(&s["finalizeCompletedSeq"]) <= number(&s["restartSince"])
        || number(&d["seq"]) < number(&s["verify"]["cycleSince"])
        || array(&s["verify"]["results"]).iter().any(|v| {
            number(&v["seq"]) > number(&s["verify"]["cycleSince"]) && v["outcome"] == "fail"
        })
    {
        return false;
    }
    let cycle_id = number(&s["finalizeCompletedSeq"]).to_string();
    candidate["cycle"].as_str() == Some(cycle_id.as_str())
        && candidate["parent"]
            == r["completed"]["targetBase"]
                .as_str()
                .or(r["initialBase"].as_str())
                .unwrap_or("")
}
pub fn vocabulary(s: &Value) -> Value {
    let mut out = json!({"kind":if s["kind"]=="node" {"integration"} else {"work"}});
    if let Some(target) = s["target"]["ticket"]["id"]
        .as_str()
        .or(s["baseBranch"].as_str())
    {
        if !target.is_empty() {
            out["target"] = json!(target);
        }
    }
    if s["kind"] == "node" {
        let i = &s["integration"];
        out["integration"] = json!(if !i["audit"].is_null()
            && i["audit"]["verifiedTree"] != i["audit"]["landedTree"]
        {
            "unverified landing"
        } else if i["landing"]["provenance"] == "human" {
            "human landing"
        } else if !i["landing"].is_null() {
            if i["landing"]["fenced"] == true {
                "fenced landing"
            } else {
                "unfenced landing"
            }
        } else if !s["nodeRestack"]["parentRequest"].is_null()
            || !s["nodeRestack"]["parentChange"].is_null()
        {
            "reparenting"
        } else if integration_failed(s) {
            "verification failed"
        } else if integration_current(s) && integration_complete(s) {
            if !cycle_verified(s) {
                "verifying"
            } else if super::landing::authorized(&s["landing"]) {
                "ready to land"
            } else {
                "awaiting consent"
            }
        } else if s["nodeOpened"].is_null() {
            "opening"
        } else if s["pr"].is_null() && number(&s["nodeComparison"]["ahead"]) == 0 {
            "empty"
        } else {
            "collecting"
        });
    }
    out
}
pub fn project(record: &Value, s: &Value, r: &Value, steps: &Value) -> Value {
    let node = s["kind"] == "node";
    let c = &s["integration"]["cycle"];
    let candidate = &s["landing"]["decision"]["candidate"];
    let mut target = json!({"kind":if s["target"].is_null() {"root"} else {"node"}});
    if let Some(branch) = s.get("baseBranch") {
        target["branch"] = branch.clone();
    }
    for key in ["ticket", "build"] {
        if let Some(v) = s["target"].get(key) {
            target[key] = v.clone();
        }
    }
    let receipts: Vec<_> = array(&s["verify"]["results"])
        .iter()
        .filter(|v| {
            if node {
                !c.is_null()
                    && v["restackId"] == c["id"]
                    && v["headSha"] == c["head"]
                    && v["baseSha"] == c["parent"]
            } else {
                number(&v["seq"]) > number(&s["verify"]["cycleSince"])
            }
        })
        .cloned()
        .collect();
    let mut verification = json!({"current":if node {integration_current(s)&&cycle_verified(s)} else {ready(s,r)},"results":receipts,"expectedSteps":steps});
    for (to, key) in [("head", "head"), ("parent", "parent")] {
        if let Some(v) = c.get(key).or(candidate.get(key)) {
            verification[to] = v.clone();
        }
    }
    let consent = ready(s, r)
        && (s["landing"]["command"]["kind"] == "hold"
            || (s["landing"]["decision"]["mode"] == "consent"
                && s["landing"]["command"]["kind"] != "land"));
    let mut out = json!({"kind":if node {"node"} else {"work"},"target":target,"restack":if !s["nodeRestack"]["conflict"].is_null() || (!r["active"].is_null() && r["replay"]["conflicted"]==true) {"conflicted"} else if !s["nodeRestack"]["active"].is_null() || !r["active"].is_null() {"active"} else {"idle"},"verification":verification,"ready":ready(s,r),"consent":consent});
    if let Some(branch) = record.get("branch").or(s["nodeOpening"].get("branch")) {
        out["branch"] = branch.clone();
    }
    if !candidate.is_null() {
        out["candidate"] = candidate.clone();
    }
    if node {
        let o = &s["integration"]["observation"];
        if let Some(v) = o.get("diagnostics") {
            out["diagnostics"] = v.clone();
        }
        if let Some(v) = o.get("openChildren") {
            out["children"] = v.clone();
        }
        out["completeness"] = json!(if o.is_null() {
            "unknown"
        } else if integration_complete(s) {
            "complete"
        } else {
            "incomplete"
        });
    }
    if consent {
        out["reason"] = json!(if s["landing"]["command"]["kind"] == "hold" {
            "held"
        } else {
            "consent required"
        });
    }
    out
}
