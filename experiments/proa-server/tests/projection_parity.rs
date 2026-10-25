use flate2::read::GzDecoder;
use proa_server::dashboard::facts::DashboardFacts;
use serde_json::Value;
use std::io::Read;

#[test]
fn retained_display_facts_match_the_typescript_oracle_whole_and_chunked() {
    let bytes = include_bytes!("../fixtures/projection.json.gz");
    let mut decoded = String::new();
    GzDecoder::new(&bytes[..])
        .read_to_string(&mut decoded)
        .unwrap();
    let corpus: Value = serde_json::from_str(&decoded).unwrap();
    for cell in corpus["cells"].as_array().unwrap() {
        let text = proa_server::dashboard::cells::display_text(cell["value"].as_str().unwrap());
        assert_eq!(text, cell["text"]);
        assert_eq!(
            proa_server::dashboard::cells::cell_width(&text) as u64,
            cell["width"].as_u64().unwrap()
        );
        assert_eq!(
            serde_json::to_value(proa_server::dashboard::cells::split_cells(&text, 4)).unwrap(),
            cell["rows"]
        );
    }
    for fixture in corpus["sessionCases"].as_array().unwrap() {
        let events = fixture["events"].as_array().unwrap();
        let mut state = proa_server::data::reducers::Accumulator::new(
            proa_server::data::reducers::Scope::Build,
        );
        state.advance(events).unwrap();
        let mut restack = proa_server::dashboard::restack::RestackFacts::default();
        restack.advance(events);
        let streams = fixture
            .get("streams")
            .and_then(Value::as_array)
            .map(Vec::as_slice);
        let actual = proa_server::dashboard::model::project(
            &fixture["record"],
            &state.finish()["build"],
            proa_server::dashboard::model::ProjectionFacts {
                dashboard: &fixture["expected"]["facts"],
                restack: &restack.finish(),
                deferral: &fixture["expected"]["deferral"],
            },
            &corpus["config"],
            streams,
            fixture.get("pinnedConfig"),
        );
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            fixture["expected"]["row"],
            "stream metadata: {}",
            fixture["id"]
        );
    }
    for (tree_index, tree) in corpus["treeCases"].as_array().unwrap().iter().enumerate() {
        let mut rows = Vec::new();
        for fixture in tree.as_array().unwrap() {
            let events = fixture["events"].as_array().unwrap();
            let mut state = proa_server::data::reducers::Accumulator::new(
                proa_server::data::reducers::Scope::Build,
            );
            state.advance(events).unwrap();
            let mut restack = proa_server::dashboard::restack::RestackFacts::default();
            restack.advance(events);
            let row = proa_server::dashboard::model::project(
                &fixture["record"],
                &state.finish()["build"],
                proa_server::dashboard::model::ProjectionFacts {
                    dashboard: &fixture["expected"]["facts"],
                    restack: &restack.finish(),
                    deferral: &fixture["expected"]["deferral"],
                },
                &corpus["config"],
                None,
                None,
            )
            .unwrap();
            assert_eq!(row, fixture["expected"]["row"]);
            rows.push(row);
        }
        let records = tree
            .as_array()
            .unwrap()
            .iter()
            .map(|fixture| fixture["record"].clone())
            .collect::<Vec<_>>();
        proa_server::dashboard::integration::enrich(&mut rows, &records);
        assert_eq!(
            serde_json::to_value(&rows).unwrap(),
            corpus["treeEnriched"][tree_index]
        );
        proa_server::data::dashboard::order_rows(&mut rows);
        assert_eq!(rows.len(), tree.as_array().unwrap().len());
        let unique: std::collections::HashSet<_> = rows
            .iter()
            .map(|row| row["slug"].as_str().unwrap())
            .collect();
        assert_eq!(unique.len(), rows.len());
        for row in &rows {
            if let Some(parent) = row["collectionIdentity"]["targetBuild"].as_str() {
                if let Some(parent_index) = rows.iter().position(|r| r["slug"] == parent) {
                    let child_index = rows.iter().position(|r| r["slug"] == row["slug"]).unwrap();
                    if row["depth"].as_u64().unwrap() > 0 {
                        assert!(parent_index < child_index);
                    }
                }
            }
        }
    }
    let mut mismatches = Vec::new();
    for fixture in corpus["fixtures"].as_array().unwrap() {
        let events = fixture["events"].as_array().unwrap();
        let expected = &fixture["expected"]["facts"];
        let mut deferral = proa_server::dashboard::routing::DeferralFacts::default();
        deferral.advance(events);
        assert_eq!(deferral.finish(), fixture["expected"]["deferral"]);
        if fixture["unreadable"].is_null() {
            let mut state = proa_server::data::reducers::Accumulator::new(
                proa_server::data::reducers::Scope::Build,
            );
            state.advance(events).unwrap();
            assert_eq!(
                serde_json::to_value(proa_server::dashboard::routing::current_deferral(
                    &deferral.finish(),
                    &state.finish()["build"]
                ))
                .unwrap(),
                fixture["expected"]["currentDeferral"]
            );
        }

        if fixture["unreadable"].is_null() {
            let mut state = proa_server::data::reducers::Accumulator::new(
                proa_server::data::reducers::Scope::Build,
            );
            state.advance(events).unwrap();
            let mut restack = proa_server::dashboard::restack::RestackFacts::default();
            restack.advance(events);
            let actual = proa_server::dashboard::model::project(
                &fixture["record"],
                &state.finish()["build"],
                proa_server::dashboard::model::ProjectionFacts {
                    dashboard: expected,
                    restack: &restack.finish(),
                    deferral: &fixture["expected"]["deferral"],
                },
                &corpus["config"],
                None,
                None,
            );
            let actual = serde_json::to_value(actual).unwrap();
            if actual != fixture["expected"]["row"] {
                let keys: Vec<_> = fixture["expected"]["row"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(key, value)| actual[*key] != **value)
                    .map(|(key, _)| key.clone())
                    .collect();
                mismatches.push(serde_json::json!({"id":fixture["id"],"keys":keys,"actual":actual,"expected":fixture["expected"]["row"]}));
            }
        }
        let mut whole = DashboardFacts::default();
        whole.advance(events);
        assert_eq!(&whole.finish(), expected, "whole: {}", fixture["id"]);
        if let Some(sessions) = fixture["expected"]["row"]["sessions"].as_array() {
            assert_eq!(
                &proa_server::dashboard::detail::project_sessions(events, None),
                sessions,
                "sessions: {}",
                fixture["id"]
            );
        }
        let mut chunked = DashboardFacts::default();
        let mut state = proa_server::data::reducers::Accumulator::new(
            proa_server::data::reducers::Scope::Build,
        );
        let mut restack = proa_server::dashboard::restack::RestackFacts::default();
        let mut cursor = 0;
        let mut deferral = proa_server::dashboard::routing::DeferralFacts::default();
        for checkpoint in fixture["checkpoints"].as_array().unwrap() {
            let end = checkpoint["end"].as_u64().unwrap() as usize;
            let suffix = &events[cursor..end];
            chunked.advance(suffix);
            deferral.advance(suffix);
            assert_eq!(deferral.finish(), checkpoint["expected"]["deferral"]);
            if fixture["unreadable"].is_null() {
                state.advance(suffix).unwrap();
                restack.advance(suffix);
                let row = proa_server::dashboard::model::project(
                    &fixture["record"],
                    &state.finish()["build"],
                    proa_server::dashboard::model::ProjectionFacts {
                        dashboard: &chunked.finish(),
                        restack: &restack.finish(),
                        deferral: &checkpoint["expected"]["deferral"],
                    },
                    &corpus["config"],
                    None,
                    None,
                );
                assert_eq!(
                    serde_json::to_value(row).unwrap(),
                    checkpoint["expected"]["row"],
                    "prefix {} at {}",
                    fixture["id"],
                    end
                );
            }
            assert_eq!(
                chunked.finish(),
                checkpoint["expected"]["facts"],
                "prefix facts {}",
                fixture["id"]
            );
            cursor = end;
        }
        chunked.advance(&events[cursor..]);
        assert_eq!(&chunked.finish(), expected, "chunked: {}", fixture["id"]);
    }
    if !mismatches.is_empty() {
        panic!(
            "{} projection mismatches; first {}",
            mismatches.len(),
            mismatches[0]
        );
    }
}
