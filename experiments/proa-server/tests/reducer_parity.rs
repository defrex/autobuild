use proa_server::data::{
    events::decode,
    reducers::{Accumulator, Scope},
};
use serde_json::Value;
fn scope(s: &str) -> Scope {
    match s {
        "build" => Scope::Build,
        "repository" => Scope::Repository,
        "session" => Scope::Session,
        _ => panic!("unknown fixture scope {s}"),
    }
}
fn difference(left: &Value, right: &Value, path: &str) -> Option<String> {
    if left == right {
        return None;
    }
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                if !a.contains_key(key) || !b.contains_key(key) {
                    return Some(format!("{path}.{key}: omitted differs from present"));
                }
                if let Some(diff) = difference(&a[key], &b[key], &format!("{path}.{key}")) {
                    return Some(diff);
                }
            }
            None
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path}: array lengths {} != {}", a.len(), b.len()));
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(i, (a, b))| difference(a, b, &format!("{path}[{i}]")))
        }
        _ => {
            if left == right {
                None
            } else {
                Some(format!("{path}: {left} != {right}"))
            }
        }
    }
}
fn corpus() -> &'static Value {
    static CORPUS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    CORPUS.get_or_init(|| {
        let path = std::env::var("PROA_PARITY_CORPUS")
            .unwrap_or_else(|_| format!("{}/fixtures/corpus.json.gz", env!("CARGO_MANIFEST_DIR")));
        let bytes =
            std::fs::read(&path).expect("generate corpus with bun tools/generate-fixtures.ts");
        if path.ends_with(".gz") {
            serde_json::from_reader(flate2::read::GzDecoder::new(bytes.as_slice())).unwrap()
        } else {
            serde_json::from_slice(&bytes).unwrap()
        }
    })
}

#[test]
fn every_catalog_witness_decodes() {
    let corpus = corpus();
    for witness in corpus["decodingWitnesses"].as_array().unwrap() {
        decode(scope(witness["scope"].as_str().unwrap()), &witness["event"]).unwrap_or_else(
            |err| panic!("{} {}: {err}", witness["scope"], witness["event"]["type"]),
        );
    }
}
#[test]
fn typescript_corpus_matches_native_reducers_and_incremental_splits() {
    let corpus = corpus();
    let mut failures = vec![];
    let catalog: Value =
        serde_json::from_str(include_str!("../fixtures/event-schemas.json")).unwrap();
    for fixture in corpus["fixtures"].as_array().unwrap() {
        let name = fixture["id"].as_str().unwrap();
        let scope = scope(fixture["scope"].as_str().unwrap());
        let events = fixture["events"].as_array().unwrap();
        let mut acc = Accumulator::new(scope);
        let unknown = events.iter().find(|event| {
            catalog[scope.name()]
                .get(event["type"].as_str().unwrap_or(""))
                .is_none()
        });
        assert_eq!(fixture.get("rustUnreadable").is_some(), unknown.is_some(), "{name}: unknown-event classification must be exhaustive and exclude every known-only log");
        if let Some(unreadable) = fixture.get("rustUnreadable") {
            let unknown = unknown.unwrap();
            if let Some(kind) = unreadable.get("type") {
                assert_eq!(kind, &unknown["type"], "{name}: negative event type");
            }
            if let Some(seq) = unreadable.get("seq") {
                assert_eq!(seq, &unknown["seq"], "{name}: negative event seq");
            }
            let before = acc.finish();
            match acc.advance(events) {
                Err(proa_server::data::error::DataError::Decode {
                    scope: actual_scope,
                    event_type,
                    seq,
                }) => {
                    assert_eq!(actual_scope, scope.name(), "{name}: failure scope");
                    assert_eq!(
                        event_type,
                        unknown["type"].as_str().unwrap(),
                        "{name}: failure type"
                    );
                    assert_eq!(
                        seq,
                        unknown["seq"].as_i64().unwrap(),
                        "{name}: failure cursor"
                    );
                }
                other => panic!("{name}: expected unknown-event decode failure, got {other:?}"),
            }
            assert_eq!(
                acc.finish(),
                before,
                "{name}: error committed partial state"
            );
            continue;
        }
        if fixture.get("expectedError").is_some() {
            let before = acc.finish();
            assert!(
                acc.advance(events).is_err(),
                "{name}: corrupt history accepted"
            );
            assert_eq!(acc.finish(), before);
            continue;
        }
        if let Err(err) = acc.advance(events) {
            failures.push(format!("{name}: {err}"));
            continue;
        }
        let actual = acc.finish();
        if let Some(diff) = difference(&actual, &fixture["expected"], "$") {
            failures.push(format!("{name}: {diff}"));
            continue;
        }
        assert_eq!(acc.finish(), actual, "{name}: finish mutates state");
        acc.advance(&[]).unwrap();
        assert_eq!(acc.finish(), actual, "{name}: empty suffix mutates state");
        let splits: Vec<_> = if events.len() <= 32 {
            (0..=events.len()).collect()
        } else {
            fixture["boundaries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as usize)
                .collect()
        };
        for split in splits {
            let mut chunked = Accumulator::new(scope);
            chunked.advance(&events[..split]).unwrap();
            let _ = chunked.finish();
            chunked.advance(&events[split..]).unwrap();
            if let Some(diff) = difference(&chunked.finish(), &actual, "$") {
                panic!("{name}, split {split}: {diff}");
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} parity failures:\n{}",
        failures.len(),
        failures
            .iter()
            .take(100)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
#[test]
fn unknown_events_and_malformed_suffixes_fail_without_partial_state() {
    let mut acc = Accumulator::new(Scope::Build);
    let before = acc.finish();
    let event = serde_json::json!({"seq":1,"ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"kernel"},"type":"future.unknown","payload":{}});
    assert!(acc.advance(&[event]).is_err());
    assert_eq!(before, acc.finish());
    for scope in [Scope::Build, Scope::Repository, Scope::Session] {
        assert!(decode(
            scope,
            &serde_json::json!({"type":"future.unknown","seq":1,"payload":{}})
        )
        .is_err());
    }
}
