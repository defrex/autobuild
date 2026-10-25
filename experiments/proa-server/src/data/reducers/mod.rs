//! Pure reductions over decoded append-only facts. Finished values are independent clones.
pub mod build;
pub mod repository;
mod repository_attention;
mod repository_harvest;
mod repository_upgrades;
pub mod session;
use crate::data::{error::DataError, events};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Build,
    Repository,
    Session,
}
impl Scope {
    pub fn name(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Repository => "repository",
            Self::Session => "session",
        }
    }
}
#[derive(Clone, Debug)]
pub enum Accumulator {
    Build(build::BuildAcc),
    Repository(repository::RepositoryAcc),
    Session(session::SessionAcc),
}
impl Accumulator {
    pub fn new(scope: Scope) -> Self {
        match scope {
            Scope::Build => Self::Build(Default::default()),
            Scope::Repository => Self::Repository(Default::default()),
            Scope::Session => Self::Session(Default::default()),
        }
    }
    pub fn scope(&self) -> Scope {
        match self {
            Self::Build(_) => Scope::Build,
            Self::Repository(_) => Scope::Repository,
            Self::Session(_) => Scope::Session,
        }
    }
    /// Validate the complete suffix before committing any accumulator mutation.
    pub fn advance(&mut self, values: &[Value]) -> Result<(), DataError> {
        let decoded = values
            .iter()
            .map(|e| events::decode(self.scope(), e))
            .collect::<Result<Vec<_>, _>>()?;
        let mut next = self.clone();
        for (event, raw) in decoded.iter().zip(values) {
            match &mut next {
                Self::Build(a) => a.fold(event)?,
                Self::Repository(a) => a.fold(event, raw)?,
                Self::Session(a) => a.fold(raw),
            }
        }
        *self = next;
        Ok(())
    }
    pub fn finish(&self) -> Value {
        match self {
            Self::Build(a) => json!({"build":a.finish()}),
            Self::Repository(a) => a.finish(),
            Self::Session(a) => json!({"session":a.finish()}),
        }
    }
}
pub(crate) fn remove(v: &mut Value, key: &str) {
    if let Some(o) = v.as_object_mut() {
        o.remove(key);
    }
}
pub(crate) fn copy(v: &mut Value, from: &Value, key: &str) {
    if let Some(x) = from.get(key) {
        v[key] = x.clone();
    } else {
        remove(v, key);
    }
}
pub(crate) fn pick(from: &Value, keys: &[&str]) -> Value {
    let mut out = json!({});
    for key in keys {
        copy(&mut out, from, key);
    }
    out
}
pub(crate) fn push(v: &mut Value, key: &str, item: Value) {
    if !v[key].is_array() {
        v[key] = json!([]);
    }
    v[key].as_array_mut().unwrap().push(item);
}
pub(crate) fn with_seq(payload: &Value, event: &Value) -> Value {
    let mut out = payload.clone();
    out["seq"] = event["seq"].clone();
    out
}
pub(crate) fn number(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}
pub(crate) fn max(v: &mut Value, key: &str, n: &Value) {
    v[key] = json!(number(&v[key]).max(number(n)));
}
pub(crate) fn compatibility() -> Value {
    json!({"unknownFacts":0,"decisiveFacts":0,"lastSeq":0,"decisiveBoundary":0,"types":[],"writerVersions":[],"legacyVersionUnavailable":false,"decisiveTypes":[],"decisiveWriterVersions":[],"decisiveLegacyVersionUnavailable":false})
}

pub mod build_lossless;
pub mod lossless;

mod repository_attention_lossless;
mod repository_harvest_lossless;
pub mod repository_lossless;
mod repository_upgrades_lossless;
