//! Fresh durable lifecycle authority over original JavaScript UTF-16 identities.
use super::super::js_value::{JsJson as J, JsString as S};
use chrono::DateTime;
#[cfg(test)]
use serde_json::Value;
const GRACE_MS: i64 = 60_000;
fn key(id: &S) -> S {
    S::from_units(
        "id:"
            .encode_utf16()
            .chain(id.units().iter().copied())
            .collect(),
    )
}
fn lookup<'a>(value: &'a J, key: &S) -> &'a J {
    static NULL: J = J::Null;
    value
        .as_object()
        .and_then(|v| v.iter().find(|(k, _)| k == key))
        .map(|(_, v)| v)
        .unwrap_or(&NULL)
}
fn claim<'a>(v: &'a J, k: &str) -> Option<&'a S> {
    v[k].as_string()
}
fn claim_key(v: &J, k: &str) -> Option<S> {
    Some(key(claim(v, k)?))
}
fn text(v: &J, k: &str) -> String {
    v[k].as_string()
        .and_then(|s| s.to_scalar().ok())
        .unwrap_or_default()
}
fn list(v: &J) -> &[J] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn at(v: &J) -> String {
    v.as_string()
        .and_then(|s| s.to_scalar().ok())
        .unwrap_or_default()
}
fn grace(at: &str, now_ms: i64) -> bool {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .is_some_and(|t| now_ms < t.timestamp_millis().saturating_add(GRACE_MS))
}
/// Production evaluator uses reducer facts, NOT the legacy evaluateDelegationLifecycle helper.
/// Caller must freshly verify project registration and build.repo before every call.
pub fn evaluate_delegation_facts(claims: &J, facts: &J, now_ms: i64) -> bool {
    let anchor = claims["anchor"].as_i64().unwrap_or(0);
    if anchor < 1 || anchor > facts["lastSeq"].as_i64().unwrap_or(0) {
        return false;
    }
    let session_id = claims["session"].as_string();
    let mut endings: Vec<String> = vec![];
    if facts.get("terminals").is_some() {
        let session_key = session_id.map(key);
        let session = session_key.as_ref().map(|s| lookup(&facts["sessions"], s));
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
        let authorized = lookup(lookup(&facts["authorizations"], &run), &execution);
        if *lookup(&facts["runs"], &run) != true || authorized.is_null() {
            return false;
        }
        let authorized_seq = authorized["seq"].as_i64().unwrap_or(0);
        if claims["kind"] == "harvest-runner"
            && (anchor != authorized_seq || claims["leaseHolder"] != authorized["leaseHolder"])
        {
            return false;
        }
        let session_key = session_id.map(key);
        let session = session_key
            .as_ref()
            .map(|s| lookup(lookup(&facts["sessions"], &run), s));
        if let Some(s) = session {
            if !list(&s["starts"])
                .iter()
                .any(|v| v.as_i64() == Some(anchor))
                || s["suspended"] == true
            {
                return false;
            }
        }
        endings.extend(list(lookup(&facts["releases"], &execution)).iter().map(at));
        for event in list(lookup(&facts["endings"], &run))
            .iter()
            .chain(session.into_iter().flat_map(|s| list(&s["endings"])))
        {
            if event["seq"].as_i64().unwrap_or(0) >= authorized_seq {
                endings.push(text(event, "at"));
            }
        }
    }
    endings.into_iter().all(|ending| grace(&ending, now_ms))
}
/// Earliest matching session start; latest build seq; first execution authorization.
pub fn issuance_anchor(target: &J, facts: &J, execution: Option<&S>) -> Option<i64> {
    if let Some(session) = target["session"].as_string() {
        let sessions = if facts.get("terminals").is_some() {
            &facts["sessions"]
        } else {
            lookup(&facts["sessions"], &claim_key(target, "id")?)
        };
        list(&lookup(sessions, &key(session))["starts"])
            .first()?
            .as_i64()
    } else if facts.get("terminals").is_some() {
        facts["lastSeq"].as_i64().filter(|n| *n != 0)
    } else {
        lookup(
            lookup(&facts["authorizations"], &claim_key(target, "id")?),
            &key(execution?),
        )["seq"]
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
                    &J::from_serde(&row["claims"]),
                    &J::from_serde(&row["facts"]),
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
        assert!(evaluate_delegation_facts(
            &claims,
            &J::from_serde(&facts),
            0
        ));
        assert_eq!(
            issuance_anchor(&claims, &J::from_serde(&facts), None),
            Some(1)
        );
        claims["kind"] = J::String(S::from("build-phase"));
        claims["session"] = J::String(S::from_units(vec![0xd800]));
        assert!(!evaluate_delegation_facts(
            &claims,
            &J::from_serde(&facts),
            0
        ));
        assert_eq!(issuance_anchor(&claims, &J::from_serde(&facts), None), None);
        claims["session"] = J::String(S::from("�"));
        assert!(evaluate_delegation_facts(
            &claims,
            &J::from_serde(&facts),
            0
        ));
        let facts = serde_json::json!({"lastSeq":1,"runs":{"id:�":true},"authorizations":{"id:�":{"id:execution":{"seq":1,"leaseHolder":"holder"}}},"sessions":{},"releases":{},"endings":{}});
        let mut claims = J::from_serde(
            &serde_json::json!({"kind":"harvest-runner","repo":"repo","id":"�","execution":"execution","leaseHolder":"holder","anchor":1}),
        );
        assert!(evaluate_delegation_facts(
            &claims,
            &J::from_serde(&facts),
            0
        ));
        claims["id"] = J::String(S::from_units(vec![0xd800]));
        assert!(!evaluate_delegation_facts(
            &claims,
            &J::from_serde(&facts),
            0
        ));
        assert_eq!(
            issuance_anchor(
                &claims,
                &J::from_serde(&facts),
                claims["execution"].as_string()
            ),
            None
        );
    }
}

#[cfg(test)]
mod persisted_utf16_tests {
    use super::*;
    use crate::protocol::{delegation_facts, js_value::parse};
    #[test]
    fn persisted_build_sessions_retain_both_unpaired_and_replacement_identities() {
        let events = parse(r#"[{"seq":1,"type":"session.started","payload":{"session":"\ud800"}},{"seq":2,"type":"session.started","payload":{"session":"�"}}]"#.as_bytes()).unwrap();
        let facts = delegation_facts::reduce(events.as_array().unwrap(), false);
        let mut claims = parse(br#"{"kind":"build-phase","session":"\ud800","anchor":1}"#).unwrap();
        assert!(evaluate_delegation_facts(&claims, &facts, 0));
        assert_eq!(issuance_anchor(&claims, &facts, None), Some(1));
        claims["session"] = J::String(S::from("�"));
        assert!(!evaluate_delegation_facts(&claims, &facts, 0));
        assert_eq!(issuance_anchor(&claims, &facts, None), Some(2));
    }
    #[test]
    fn persisted_harvest_authority_retains_each_original_identity_and_holder() {
        let events = parse(br#"[{"seq":1,"type":"harvest.started","payload":{"run":"\ud800"}},{"seq":2,"type":"harvest.execution.authorized","payload":{"run":"\ud800","execution":"\udfff","leaseHolder":"\ud800"}},{"seq":3,"type":"harvest.session.started","payload":{"run":"\ud800","session":"\ud800"}}]"#).unwrap();
        let facts = delegation_facts::reduce(events.as_array().unwrap(), true);
        let mut claims = parse(br#"{"kind":"harvest-runner","id":"\ud800","execution":"\udfff","leaseHolder":"\ud800","anchor":2}"#).unwrap();
        assert!(evaluate_delegation_facts(&claims, &facts, 0));
        assert_eq!(
            issuance_anchor(&claims, &facts, claims["execution"].as_string()),
            Some(2)
        );
        claims["leaseHolder"] = J::String(S::from("�"));
        assert!(!evaluate_delegation_facts(&claims, &facts, 0));
        claims["kind"] = J::String(S::from("harvest-phase"));
        claims["anchor"] = J::Number(3.0);
        claims["session"] = J::String(S::from_units(vec![0xd800]));
        assert!(evaluate_delegation_facts(&claims, &facts, 0));
        claims["id"] = J::String(S::from("�"));
        assert!(!evaluate_delegation_facts(&claims, &facts, 0));
    }
}
