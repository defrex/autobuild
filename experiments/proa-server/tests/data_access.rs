//! Focused per-scope failure and restart semantics; PostgreSQL/S3 interoperability
//! is exercised by tools/data-integration.ts with an actual TypeScript writer.
use proa_server::data::{
    error::DataError,
    reducers::{Accumulator, Scope},
};
use serde_json::json;

#[test]
fn unknown_build_does_not_poison_an_independent_scope() {
    let mut damaged = Accumulator::new(Scope::Build);
    let mut healthy = Accumulator::new(Scope::Build);
    let mut session = Accumulator::new(Scope::Session);
    let before = healthy.finish();
    let unknown = json!({"seq":1,"type":"future.unknown","ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"kernel"},"payload":{}});
    assert!(matches!(
        damaged.advance(&[unknown]),
        Err(DataError::Decode {
            scope: "build",
            seq: 1,
            ..
        })
    ));
    healthy.advance(&[]).unwrap();
    session.advance(&[]).unwrap();
    assert_eq!(healthy.finish(), before);
    assert_eq!(healthy.finish(), Accumulator::new(Scope::Build).finish());
    assert_eq!(session.finish(), Accumulator::new(Scope::Session).finish());
}

#[test]
fn malformed_known_event_cannot_publish_a_partial_state() {
    for scope in [Scope::Build, Scope::Repository, Scope::Session] {
        let mut acc = Accumulator::new(scope);
        let before = acc.finish();
        let name = match scope {
            Scope::Build => "build.created",
            Scope::Repository => "dispatcher.run-started",
            Scope::Session => "message.posted",
        };
        let malformed = json!({"seq":17,"ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"kernel"},"type":name,"payload":{}});
        assert!(
            acc.advance(&[malformed]).is_err(),
            "{} accepted malformed payload",
            scope.name()
        );
        assert_eq!(acc.finish(), before);
    }
}

#[test]
fn repository_upgrade_and_attention_snapshots_match_typescript() {
    let path = std::env::var("PROA_PARITY_CORPUS")
        .unwrap_or_else(|_| format!("{}/fixtures/corpus.json", env!("CARGO_MANIFEST_DIR")));
    let corpus: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for fixture in corpus["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["scope"] == "repository")
    {
        let mut acc = Accumulator::new(Scope::Repository);
        acc.advance(fixture["events"].as_array().unwrap()).unwrap();
        let actual = acc.finish();
        for key in ["upgrades", "attention"] {
            assert_eq!(
                actual["repositoryReadFacts"][key], fixture["expected"]["repositoryReadFacts"][key],
                "{}: {key}",
                fixture["id"]
            );
        }
    }
}
