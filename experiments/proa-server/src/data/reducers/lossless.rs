use crate::js_json as json;
use crate::protocol::js_value::JsJson as J;
pub(crate) fn remove(v: &mut J, key: &str) {
    if let Some(o) = v.as_object_mut() {
        o.retain(|(k, _)| !k.eq_str(key));
    }
}
pub(crate) fn copy(v: &mut J, from: &J, key: &str) {
    if let Some(x) = from.get(key) {
        v[key] = x.clone();
    } else {
        remove(v, key);
    }
}
pub(crate) fn pick(from: &J, keys: &[&str]) -> J {
    let mut out = json!({});
    for key in keys {
        copy(&mut out, from, key);
    }
    out
}
pub(crate) fn push(v: &mut J, key: &str, item: J) {
    if !v[key].is_array() {
        v[key] = json!([]);
    }
    v[key].as_array_mut().unwrap().push(item);
}
pub(crate) fn with_seq(payload: &J, event: &J) -> J {
    let mut out = payload.clone();
    out["seq"] = event["seq"].clone();
    out
}
pub(crate) fn number(v: &J) -> i64 {
    v.as_i64().unwrap_or(0)
}
pub(crate) fn max(v: &mut J, key: &str, n: &J) {
    v[key] = json!(number(&v[key]).max(number(n)));
}
pub(crate) fn compatibility() -> J {
    json!({"unknownFacts":0,"decisiveFacts":0,"lastSeq":0,"decisiveBoundary":0,"types":[],"writerVersions":[],"legacyVersionUnavailable":false,"decisiveTypes":[],"decisiveWriterVersions":[],"decisiveLegacyVersionUnavailable":false})
}
