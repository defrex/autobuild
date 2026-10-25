//! Focused per-scope failure and restart semantics; PostgreSQL/S3 interoperability
//! is exercised by tools/data-integration.ts with an actual TypeScript writer.
use proa_server::data::{
    error::DataError,
    reducers::{Accumulator, Scope},
};
use serde_json::json;

#[test]
fn unknown_events_are_isolated_at_each_scope() {
    let probes = [
        (
            Scope::Build,
            "runner.attached",
            json!({"instance":"reader-probe","host":"loopback"}),
        ),
        (
            Scope::Repository,
            "dispatcher.pause-set",
            json!({"enabled":true}),
        ),
        (Scope::Session, "session.wake-set", json!({"globs":["*"]})),
    ];
    for damaged_scope in [Scope::Build, Scope::Repository, Scope::Session] {
        let mut damaged = Accumulator::new(damaged_scope);
        let unknown = json!({"seq":1,"type":"future.unknown","ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"kernel"},"payload":{}});
        match damaged.advance(&[unknown]) {
            Err(DataError::Decode {
                scope,
                seq: 1,
                event_type,
            }) => {
                assert_eq!(scope, damaged_scope.name());
                assert_eq!(event_type, "future.unknown");
            }
            other => panic!("unknown event result: {other:?}"),
        }
        for (scope, event_type, payload) in &probes {
            let mut healthy = Accumulator::new(*scope);
            let before = healthy.finish();
            healthy.advance(&[json!({"seq":1,"type":event_type,"ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"human","user":"probe"},"payload":payload})]).unwrap();
            assert_ne!(
                healthy.finish(),
                before,
                "{} failed to advance independently of {}",
                scope.name(),
                damaged_scope.name()
            );
        }
        assert_eq!(damaged.finish(), Accumulator::new(damaged_scope).finish());
    }
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
        .unwrap_or_else(|_| format!("{}/fixtures/corpus.json.gz", env!("CARGO_MANIFEST_DIR")));
    let bytes = std::fs::read(&path).unwrap();
    let corpus: serde_json::Value = if path.ends_with(".gz") {
        serde_json::from_reader(flate2::read::GzDecoder::new(bytes.as_slice())).unwrap()
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    for fixture in corpus["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["scope"] == "repository")
    {
        let mut acc = Accumulator::new(Scope::Repository);
        let events = fixture["events"].as_array().unwrap();
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/event-schemas.json")).unwrap();
        let unknown = events.iter().find(|event| {
            catalog["repository"]
                .get(event["type"].as_str().unwrap())
                .is_none()
        });
        assert_eq!(
            fixture.get("rustUnreadable").is_some(),
            unknown.is_some(),
            "{}: unknown classification",
            fixture["id"]
        );
        if fixture.get("rustUnreadable").is_some() || fixture.get("expectedError").is_some() {
            let before = acc.finish();
            match acc.advance(events) {
                Err(DataError::Decode {
                    scope: "repository",
                    event_type,
                    seq,
                }) => {
                    if let Some(unknown) = unknown {
                        assert_eq!(event_type, unknown["type"].as_str().unwrap());
                        assert_eq!(seq, unknown["seq"].as_i64().unwrap());
                    }
                }
                other => panic!(
                    "{}: expected repository read failure, got {other:?}",
                    fixture["id"]
                ),
            }
            assert_eq!(before, acc.finish());
            continue;
        }
        acc.advance(events).unwrap();
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
