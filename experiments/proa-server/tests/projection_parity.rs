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
            &fixture["expected"]["facts"],
            &restack.finish(),
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
    let mut mismatches = Vec::new();
    for fixture in corpus["fixtures"].as_array().unwrap() {
        let events = fixture["events"].as_array().unwrap();
        let expected = &fixture["expected"]["facts"];
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
                expected,
                &restack.finish(),
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
        let mut cursor = 0;
        for end in fixture["boundaries"].as_array().unwrap() {
            let end = end.as_u64().unwrap() as usize;
            chunked.advance(&events[cursor..end]);
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
