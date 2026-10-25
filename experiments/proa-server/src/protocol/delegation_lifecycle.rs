//! Draft only: no mounted route or tracked module. Claims prevalidated by crypto port.
use chrono::DateTime;
use serde_json::Value;
const GRACE_MS: i64 = 60_000;
fn key(id: &str) -> String {
    format!("id:{id}")
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn at(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn grace(at: &str, now_ms: i64) -> bool {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .is_some_and(|t| now_ms < t.timestamp_millis().saturating_add(GRACE_MS))
}
/// Production evaluator uses reducer facts, NOT the legacy evaluateDelegationLifecycle helper.
/// Caller must freshly verify project registration and build.repo before every call.
pub fn evaluate_delegation_facts(claims: &Value, facts: &Value, now_ms: i64) -> bool {
    let anchor = claims["anchor"].as_i64().unwrap_or(0);
    if anchor < 1 || anchor > facts["lastSeq"].as_i64().unwrap_or(0) {
        return false;
    }
    let session_id = claims["session"].as_str();
    let mut endings: Vec<&str> = vec![];
    if facts.get("terminals").is_some() {
        let session = session_id.map(|s| &facts["sessions"][key(s)]);
        if session_id.is_some()
            && !list(&session.unwrap()["starts"])
                .iter()
                .any(|s| s.as_i64() == Some(anchor))
        {
            return false;
        }
        for event in list(&facts["terminals"])
            .iter()
            .chain(session.into_iter().flat_map(|s| list(&s["endings"])))
        {
            if event["seq"].as_i64().unwrap_or(0) >= anchor {
                endings.push(text(event, "at"));
            }
        }
        if !list(&facts["terminals"]).is_empty() && endings.is_empty() {
            return false;
        }
    } else {
        let run = key(text(claims, "id"));
        let execution = key(text(claims, "execution"));
        let authorized = &facts["authorizations"][&run][&execution];
        if facts["runs"][&run] != true || authorized.is_null() {
            return false;
        }
        let authorized_seq = authorized["seq"].as_i64().unwrap_or(0);
        if claims["kind"] == "harvest-runner"
            && (anchor != authorized_seq || claims["leaseHolder"] != authorized["leaseHolder"])
        {
            return false;
        }
        let session = session_id.map(|s| &facts["sessions"][&run][key(s)]);
        if let Some(s) = session {
            if !list(&s["starts"])
                .iter()
                .any(|v| v.as_i64() == Some(anchor))
                || s["suspended"] == true
            {
                return false;
            }
        }
        endings.extend(list(&facts["releases"][&execution]).iter().map(at));
        for event in list(&facts["endings"][&run])
            .iter()
            .chain(session.into_iter().flat_map(|s| list(&s["endings"])))
        {
            if event["seq"].as_i64().unwrap_or(0) >= authorized_seq {
                endings.push(text(event, "at"));
            }
        }
    }
    endings.into_iter().all(|ending| grace(ending, now_ms))
}
/// Earliest matching session start; latest build seq; first execution authorization.
pub fn issuance_anchor(target: &Value, facts: &Value, execution: Option<&str>) -> Option<i64> {
    if let Some(session) = target["session"].as_str() {
        let sessions = if facts.get("terminals").is_some() {
            &facts["sessions"]
        } else {
            &facts["sessions"][key(text(target, "id"))]
        };
        list(&sessions[key(session)]["starts"]).first()?.as_i64()
    } else if facts.get("terminals").is_some() {
        facts["lastSeq"].as_i64().filter(|n| *n != 0)
    } else {
        facts["authorizations"][key(text(target, "id"))][key(execution.unwrap_or(""))]["seq"]
            .as_i64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authoritative_lifecycle_matches_typescript() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../fixtures/protocol-delegation-lifecycle.json"
        ))
        .unwrap();
        assert!(fixtures.len() >= 1152);
        for row in fixtures {
            assert_eq!(
                evaluate_delegation_facts(
                    &row["claims"],
                    &row["facts"],
                    row["now"].as_i64().unwrap()
                ),
                row["active"] == true,
                "{}",
                row["name"]
            );
        }
    }
}
