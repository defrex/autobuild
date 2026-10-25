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
fn corpus() -> Value {
    let path = std::env::var("PROA_PARITY_CORPUS")
        .unwrap_or_else(|_| format!("{}/fixtures/corpus.json", env!("CARGO_MANIFEST_DIR")));
    serde_json::from_slice(
        &std::fs::read(path).expect("generate corpus with bun tools/generate-fixtures.ts"),
    )
    .unwrap()
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
    for fixture in corpus["fixtures"].as_array().unwrap() {
        let name = fixture["id"].as_str().unwrap();
        let scope = scope(fixture["scope"].as_str().unwrap());
        let events = fixture["events"].as_array().unwrap();
        let mut acc = Accumulator::new(scope);
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
