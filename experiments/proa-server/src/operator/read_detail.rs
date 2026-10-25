//! API detail projection over authoritative native build/read facts.
use super::{
    query::{summary, ReadBuild},
    read_harvest::{array, copy, number},
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
pub fn detail(build: &ReadBuild, now: DateTime<Utc>) -> Value {
    let state = &build.state;
    let facts = &build.display;
    let mut out = summary(&build.record, state, now);
    out["runnerAttaches"] = facts["api"]["runnerAttaches"].clone();
    let mut tree =
        crate::dashboard::tree::project(&build.record, state, &facts["restack"], &Value::Null);
    tree["verification"]
        .as_object_mut()
        .unwrap()
        .shift_remove("expectedSteps");
    out["tree"] = tree;
    out["autoMerge"] = json!(crate::dashboard::landing::auto_merge(state));
    if state["landing"].as_object().is_some_and(|o| !o.is_empty()) {
        out["landing"] = state["landing"].clone();
    }
    out["openEscalations"] = state["openEscalations"].clone();
    if state["reviewRoundCeilings"].get("plan").is_some()
        || state["reviewRoundCeilings"].get("code").is_some()
    {
        out["reviewRoundCeilings"] = state["reviewRoundCeilings"].clone();
    }
    out["suspendedSessions"] = state["sessions"]["suspended"].clone();
    out["sessionTotals"] = state["sessions"]["totals"].clone();
    out["openSessions"] = state["sessions"]["open"].clone();
    out["observations"] = json!(array(&state["observations"])
        .iter()
        .map(|o| {
            let mut v = json!({"id":o["id"],"kind":o["kind"],"summary":o["summary"]});
            for key in ["files", "refs"] {
                copy(&mut v, o, key);
            }
            v
        })
        .collect::<Vec<_>>());
    if let Some(failure) = state.get("setupFailure") {
        out["setupFailure"] = json!({"attempt":failure["attempt"],"command":failure["command"],"exitStatus":failure["exitStatus"],"output":failure["output"]});
    }
    if let Some(execution) = array(&state["executions"]).last() {
        out["execution"] = execution.clone();
    }
    out["executionOpen"] = json!(!facts["api"]["open"].is_null());
    copy(&mut out, state, "infrastructureFailure");
    out["cleanupPending"] = json!(
        state["infrastructureFailure"]["cleanupPending"] == true
            || array(&state["cleanupAttempts"])
                .last()
                .is_some_and(|c| c["outcome"] == "unknown")
    );
    let steps = array(&state["verify"]["results"])
        .iter()
        .filter(|r| number(&r["seq"]) > number(&state["verify"]["cycleSince"]))
        .map(|r| {
            let mut v = json!({"step":r["step"],"outcome":r["outcome"]});
            copy(&mut v, r, "reason");
            v
        })
        .collect::<Vec<_>>();
    out["verify"] = json!({"attempt":state["verify"]["maxAttemptSeen"],"steps":steps});
    copy(&mut out["verify"], &state["verify"], "currentStep");
    if let Some(last) = state.get("lastEvent") {
        out["lastEvent"] =
            json!({"type":last["type"],"seq":last["seq"],"ts":last["ts"],"actor":last["actor"]});
    }
    copy(&mut out, state, "outcome");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detail_matches_actual_typescript_query_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/api-read-corpus.json")).unwrap();
        let now = corpus["now"].as_str().unwrap().parse().unwrap();
        let mut count = 0;
        for fixture in array(&corpus["fixtures"]) {
            if fixture["status"] != 200 || fixture["body"].get("detail").is_none() {
                continue;
            }
            let input = &fixture["seed"]["builds"][0];
            let events = array(&input["events"]);
            let mut acc =
                crate::data::reducers::Accumulator::new(crate::data::reducers::Scope::Build);
            acc.advance(events).unwrap();
            let mut dashboard = crate::dashboard::facts::DashboardFacts::default();
            dashboard.advance(events);
            let mut restack = crate::dashboard::restack::RestackFacts::default();
            restack.advance(events);
            let mut deferral = crate::dashboard::routing::DeferralFacts::default();
            deferral.advance(events);
            let mut api = crate::data::api_facts::ApiFacts::default();
            api.advance(events);
            let build = ReadBuild {
                record: input["record"].clone(),
                state: acc.finish()["build"].clone(),
                display: json!({"dashboard":dashboard.finish(),"restack":restack.finish(),"deferral":deferral.finish(),"api":api.finish()}),
            };
            assert_eq!(
                detail(&build, now),
                fixture["body"]["detail"],
                "{}",
                fixture["scenario"]["id"]
            );
            count += 1;
        }
        assert!(count >= 8);
    }
}
