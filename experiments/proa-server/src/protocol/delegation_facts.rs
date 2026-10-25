//! Delegation reducer facts preserve original persisted JavaScript identities.
use super::js_value::{JsJson as J, JsString as S};
macro_rules! j { ($($v:tt)*) => { J::from_serde(&serde_json::json!($($v)*)) }; }
fn key(value: &J) -> S {
    S::from_units(
        "id:"
            .encode_utf16()
            .chain(
                value
                    .as_string()
                    .map(S::units)
                    .unwrap_or(&[])
                    .iter()
                    .copied(),
            )
            .collect(),
    )
}
fn slot<'a>(value: &'a mut J, key: &S) -> &'a mut J {
    if value.is_null() {
        *value = J::Object(vec![]);
    }
    let values = value.as_object_mut().unwrap();
    let index = values
        .iter()
        .position(|(k, _)| k == key)
        .unwrap_or_else(|| {
            values.push((key.clone(), J::Null));
            values.len() - 1
        });
    &mut values[index].1
}
fn object(fields: Vec<(&str, J)>) -> J {
    J::Object(fields.into_iter().map(|(k, v)| (S::from(k), v)).collect())
}
pub fn reduce(events: &[J], harvest: bool) -> J {
    let mut state = if harvest {
        j!({"lastSeq":0,"runs":{},"sessions":{},"authorizations":{},"releases":{},"endings":{}})
    } else {
        j!({"lastSeq":0,"sessions":{},"terminals":[]})
    };
    for event in events {
        state["lastSeq"] = event["seq"].clone();
        let p = &event["payload"];
        let kind = event["type"]
            .as_string()
            .unwrap()
            .to_scalar()
            .unwrap_or_default();
        let t = kind.as_str();
        if !harvest {
            if matches!(t, "session.started" | "session.ended") {
                let id = key(&p["session"]);
                if slot(&mut state["sessions"], &id).is_null() {
                    *slot(&mut state["sessions"], &id) = j!({"starts":[],"endings":[]})
                }
                slot(&mut state["sessions"], &id)[if t == "session.started" {
                    "starts"
                } else {
                    "endings"
                }]
                .as_array_mut()
                .unwrap()
                .push(if t == "session.started" {
                    event["seq"].clone()
                } else {
                    object(vec![
                        ("seq", event["seq"].clone()),
                        ("at", event["ts"].clone()),
                    ])
                })
            } else if matches!(t, "build.completed" | "build.aborted") {
                state["terminals"].as_array_mut().unwrap().push(object(vec![
                    ("seq", event["seq"].clone()),
                    ("at", event["ts"].clone()),
                ]))
            }
            continue;
        }
        let run = key(&p["run"]);
        if t == "harvest.started" {
            *slot(&mut state["runs"], &run) = j!(true)
        }
        if t == "harvest.execution.authorized" {
            if slot(&mut state["authorizations"], &run).is_null() {
                *slot(&mut state["authorizations"], &run) = j!({})
            }
            let id = key(&p["execution"]);
            if slot(slot(&mut state["authorizations"], &run), &id).is_null() {
                *slot(slot(&mut state["authorizations"], &run), &id) = object(vec![
                    ("seq", event["seq"].clone()),
                    ("leaseHolder", p["leaseHolder"].clone()),
                ])
            }
        }
        if matches!(
            t,
            "harvest.session.started" | "harvest.session.ended" | "harvest.session.suspended"
        ) {
            if slot(&mut state["sessions"], &run).is_null() {
                *slot(&mut state["sessions"], &run) = j!({})
            }
            let id = key(&p["session"]);
            if slot(slot(&mut state["sessions"], &run), &id).is_null() {
                *slot(slot(&mut state["sessions"], &run), &id) = j!({"starts":[],"endings":[]})
            }
            slot(slot(&mut state["sessions"], &run), &id)[if t == "harvest.session.started" {
                "starts"
            } else {
                "endings"
            }]
            .as_array_mut()
            .unwrap()
            .push(if t == "harvest.session.started" {
                event["seq"].clone()
            } else {
                object(vec![
                    ("seq", event["seq"].clone()),
                    ("at", event["ts"].clone()),
                ])
            });
            if t == "harvest.session.suspended" {
                slot(slot(&mut state["sessions"], &run), &id)["suspended"] = j!(true)
            }
        }
        if matches!(t, "harvest.execution.released" | "harvest.execution.ended") {
            let id = key(&p["execution"]);
            if slot(&mut state["releases"], &id).is_null() {
                *slot(&mut state["releases"], &id) = j!([])
            }
            slot(&mut state["releases"], &id)
                .as_array_mut()
                .unwrap()
                .push(event["ts"].clone())
        }
        if matches!(
            t,
            "harvest.completed" | "harvest.escalated" | "harvest.recovery-exhausted"
        ) || (t == "harvest.failed" && p["willRetry"] != true)
        {
            if slot(&mut state["endings"], &run).is_null() {
                *slot(&mut state["endings"], &run) = j!([])
            }
            slot(&mut state["endings"], &run)
                .as_array_mut()
                .unwrap()
                .push(object(vec![
                    ("seq", event["seq"].clone()),
                    ("at", event["ts"].clone()),
                ]))
        }
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn persisted_delegation_folds_match_independent_scalar_source_oracles() {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(
            include_bytes!("../../fixtures/protocol-reducers.json.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .unwrap();
        let fixtures: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let mut checked = 0;
        for row in fixtures["replay"].as_array().unwrap() {
            let harvest = row["name"] == "harvestDelegation";
            if !harvest && row["name"] != "buildDelegation" {
                continue;
            }
            let events: Vec<J> = row["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(J::from_serde)
                .collect();
            assert_eq!(
                reduce(&events, harvest).to_serde_checked().unwrap(),
                row["value"],
                "{}",
                row["id"]
            );
            checked += 1;
        }
        assert!(checked > 10);
    }
}
