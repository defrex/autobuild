//! Draft only: no mounted route or tracked module. Claims prevalidated by crypto port.
use super::super::js_value::{JsJson as J, JsString as S};
use chrono::DateTime;
use serde_json::Value;
const GRACE_MS: i64 = 60_000;
fn key(id: &S) -> Option<String> {
    id.to_scalar().ok().map(|id| format!("id:{id}"))
}
fn claim<'a>(v: &'a J, k: &str) -> Option<&'a S> {
    v[k].as_string()
}
fn claim_key(v: &J, k: &str) -> Option<String> {
    key(claim(v, k)?)
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
pub fn evaluate_delegation_facts(claims: &J, facts: &Value, now_ms: i64) -> bool {
    let anchor = claims["anchor"].as_i64().unwrap_or(0);
    if anchor < 1 || anchor > facts["lastSeq"].as_i64().unwrap_or(0) {
        return false;
    }
    let session_id = claims["session"].as_string();
    let mut endings: Vec<&str> = vec![];
    if facts.get("terminals").is_some() {
        let session_key = session_id.and_then(key);
        if session_id.is_some() && session_key.is_none() {
            return false;
        }
        let session = session_key.as_ref().map(|s| &facts["sessions"][s]);
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
        let Some(run) = claim_key(claims, "id") else {
            return false;
        };
        let Some(execution) = claim_key(claims, "execution") else {
            return false;
        };
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
        let session_key = session_id.and_then(key);
        if session_id.is_some() && session_key.is_none() {
            return false;
        }
        let session = session_key.as_ref().map(|s| &facts["sessions"][&run][s]);
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
pub fn issuance_anchor(target: &J, facts: &Value, execution: Option<&S>) -> Option<i64> {
    if let Some(session) = target["session"].as_string() {
        let sessions = if facts.get("terminals").is_some() {
            &facts["sessions"]
        } else {
            &facts["sessions"][claim_key(target, "id")?]
        };
        list(&sessions[key(session)?]["starts"]).first()?.as_i64()
    } else if facts.get("terminals").is_some() {
        facts["lastSeq"].as_i64().filter(|n| *n != 0)
    } else {
        facts["authorizations"][claim_key(target, "id")?][key(execution?)?]["seq"].as_i64()
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
                    &J::from_serde(&row["claims"]),
                    &row["facts"],
                    row["now"].as_i64().unwrap()
                ),
                row["active"] == true,
                "{}",
                row["name"]
            );
        }
    }
    #[test]
    fn lifecycle_keys_never_alias_unpaired_units_to_replacements() {
        let facts = serde_json::json!({"lastSeq":1,"terminals":[],"sessions":{"id:�":{"starts":[1],"endings":[]}}});
        let mut claims = J::from_serde(
            &serde_json::json!({"kind":"build-runner","repo":"repo","id":"�","anchor":1}),
        );
        claims["id"] = J::String(S::from_units(vec![0xd800]));
        // Build-runner id is a database lookup identity; this fold does not
        // compare it to the requested path and must not invent that restriction.
        assert!(evaluate_delegation_facts(&claims, &facts, 0));
        assert_eq!(issuance_anchor(&claims, &facts, None), Some(1));
        claims["kind"] = J::String(S::from("build-phase"));
        claims["session"] = J::String(S::from_units(vec![0xd800]));
        assert!(!evaluate_delegation_facts(&claims, &facts, 0));
        assert_eq!(issuance_anchor(&claims, &facts, None), None);
        claims["session"] = J::String(S::from("�"));
        assert!(evaluate_delegation_facts(&claims, &facts, 0));
        let facts = serde_json::json!({"lastSeq":1,"runs":{"id:�":true},"authorizations":{"id:�":{"id:execution":{"seq":1,"leaseHolder":"holder"}}},"sessions":{},"releases":{},"endings":{}});
        let mut claims = J::from_serde(
            &serde_json::json!({"kind":"harvest-runner","repo":"repo","id":"�","execution":"execution","leaseHolder":"holder","anchor":1}),
        );
        assert!(evaluate_delegation_facts(&claims, &facts, 0));
        claims["id"] = J::String(S::from_units(vec![0xd800]));
        assert!(!evaluate_delegation_facts(&claims, &facts, 0));
        assert_eq!(
            issuance_anchor(&claims, &facts, claims["execution"].as_string()),
            None
        );
    }
}
