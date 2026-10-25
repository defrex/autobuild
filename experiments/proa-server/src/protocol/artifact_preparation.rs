//! Artifact wire preparation before provider or database mutation. Payload-only
//! substitution is intentionally distinct from complete producer validation,
//! which happens after the locked transaction allocates artifact revisions.
use super::error::ProtocolError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactInput {
    pub kind: String,
    pub bytes: Vec<u8>,
    pub blob_ref: String,
    pub metadata: Value,
}

/// The request schema is parsed separately, before this helper. All artifacts
/// must be decoded before a caller uploads even the first provider object.
pub fn decode_artifact(input: &Value) -> Result<ArtifactInput, ProtocolError> {
    let text = input["contentBase64"]
        .as_str()
        .expect("parsed artifact request content");
    let bytes = STANDARD
        .decode(text)
        .map_err(|_| ProtocolError::validation("artifact content is not valid base64"))?;
    // Explicit re-encoding rejects nonzero padding bits and any alternative
    // alphabet/whitespace, independently of the decoder configuration.
    if STANDARD.encode(&bytes) != text {
        return Err(ProtocolError::validation(
            "artifact content is not valid base64",
        ));
    }
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(ProtocolError::new(
            413,
            "validation",
            format!("artifact exceeds decoded byte ceiling of {MAX_ARTIFACT_BYTES} bytes"),
        ));
    }
    Ok(ArtifactInput {
        kind: input["kind"]
            .as_str()
            .expect("parsed artifact request kind")
            .to_owned(),
        blob_ref: format!("{:x}", Sha256::digest(&bytes)),
        bytes,
        metadata: input.get("metadata").cloned().unwrap_or_else(|| json!({})),
    })
}

pub fn decode_artifacts(inputs: &[Value]) -> Result<Vec<ArtifactInput>, ProtocolError> {
    inputs.iter().map(decode_artifact).collect()
}

/// Replace exact two-key negative refs, including nested arrays/objects. The
/// provided kind is not an assertion: the indexed deposited metadata owns both
/// resulting fields. Out-of-range and noninteger refs remain untouched so the
/// ordinary event validator makes the eventual decision.
pub fn substitute_placeholder_refs(value: &Value, deposited: &[Value]) -> Value {
    if let Some(object) = value.as_object() {
        if object.len() == 2 && object.get("kind").is_some_and(Value::is_string) {
            if let Some(revision) = object
                .get("rev")
                .and_then(Value::as_f64)
                .filter(|revision| revision.fract() == 0.0 && *revision < 0.0)
            {
                let index = -revision - 1.0;
                if index < deposited.len() as f64 {
                    let meta = &deposited[index as usize];
                    return json!({"kind":meta["kind"],"rev":meta["revision"]});
                }
                return value.clone();
            }
        }
        return Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), substitute_placeholder_refs(value, deposited)))
                .collect(),
        );
    }
    if let Some(array) = value.as_array() {
        return Value::Array(
            array
                .iter()
                .map(|value| substitute_placeholder_refs(value, deposited))
                .collect(),
        );
    }
    value.clone()
}

/// Lossless wire preparation keeps kind/metadata in JavaScript's string domain
/// until the provider and PostgreSQL boundaries explicitly consume them.
#[derive(Debug, Clone, PartialEq)]
pub struct LosslessArtifactInput {
    pub kind: super::js_value::JsString,
    pub bytes: Vec<u8>,
    pub blob_ref: String,
    pub metadata: super::js_value::JsJson,
}
pub fn decode_artifact_lossless(
    input: &super::js_value::JsJson,
) -> Result<LosslessArtifactInput, ProtocolError> {
    use super::js_value::JsJson;
    let content = input
        .get("contentBase64")
        .and_then(JsJson::as_string)
        .ok_or_else(ProtocolError::internal)?;
    // Canonical base64 is ASCII: a lone unit is a validation refusal, never a
    // lossy conversion that might manufacture accepted upload bytes.
    let text = content
        .to_scalar()
        .map_err(|_| ProtocolError::validation("artifact content is not valid base64"))?;
    let scalar = json!({"kind":"validated","contentBase64":text});
    let decoded = decode_artifact(&scalar)?;
    Ok(LosslessArtifactInput {
        kind: input
            .get("kind")
            .and_then(JsJson::as_string)
            .ok_or_else(ProtocolError::internal)?
            .clone(),
        bytes: decoded.bytes,
        blob_ref: decoded.blob_ref,
        metadata: input
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| JsJson::Object(vec![])),
    })
}
pub fn decode_artifacts_lossless(
    inputs: &[super::js_value::JsJson],
) -> Result<Vec<LosslessArtifactInput>, ProtocolError> {
    inputs.iter().map(decode_artifact_lossless).collect()
}
pub fn substitute_placeholder_refs_lossless(
    value: &super::js_value::JsJson,
    deposited: &[super::js_value::JsJson],
) -> super::js_value::JsJson {
    use super::js_value::{JsJson, JsString};
    if let Some(object) = value.as_object() {
        if object.len() == 2 && value.get("kind").is_some_and(JsJson::is_string) {
            if let Some(revision) = value
                .get("rev")
                .and_then(JsJson::as_f64)
                .filter(|v| v.fract() == 0.0 && *v < 0.0)
            {
                let index = -revision - 1.0;
                if index < deposited.len() as f64 {
                    let meta = &deposited[index as usize];
                    return JsJson::Object(vec![
                        (JsString::from("kind"), meta.get("kind").unwrap().clone()),
                        (JsString::from("rev"), meta.get("revision").unwrap().clone()),
                    ]);
                }
                return value.clone();
            }
        }
        return JsJson::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        substitute_placeholder_refs_lossless(value, deposited),
                    )
                })
                .collect(),
        );
    }
    if let Some(array) = value.as_array() {
        return JsJson::Array(
            array
                .iter()
                .map(|value| substitute_placeholder_refs_lossless(value, deposited))
                .collect(),
        );
    }
    value.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_artifact_bytes_and_recursive_refs_match_typescript_oracles() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/protocol-artifact-preparation.json"
        ))
        .unwrap();
        let mut count = 0;
        for row in fixture["decode"].as_array().unwrap() {
            let result = decode_artifact(&row["input"]);
            let actual = match result {
                Ok(input) => {
                    json!({"accepted":{"kind":input.kind,"hex":input.bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),"blobRef":input.blob_ref,"metadata":input.metadata}})
                }
                Err(error) => {
                    json!({"rejected":{"status":error.status.as_u16(),"kind":error.kind,"error":error.error}})
                }
            };
            assert_eq!(actual, row["oracle"], "{}", row["id"]);
            count += 1;
        }
        for row in fixture["substitution"].as_array().unwrap() {
            assert_eq!(
                substitute_placeholder_refs(&row["input"], row["deposited"].as_array().unwrap()),
                row["oracle"],
                "{}",
                row["id"]
            );
            count += 1;
        }
        assert!(count > 100);
    }
    #[test]
    fn lossless_preparation_preserves_kind_metadata_and_placeholder_strings() {
        use crate::protocol::js_value::{parse, JsJson};
        let input =
            parse(br#"{"kind":"\ud800","contentBase64":"YQ==","metadata":{"\udfff":"\ud800"}}"#)
                .unwrap();
        let prepared = decode_artifact_lossless(&input).unwrap();
        assert_eq!(prepared.kind.units(), &[0xd800]);
        assert_eq!(prepared.metadata.stringify(), r#"{"\udfff":"\ud800"}"#);
        assert_eq!(prepared.bytes, b"a");
        let input = parse(br#"{"\ud800":[{"kind":"ignored","rev":-1},"\udfff"]}"#).unwrap();
        let deposited = vec![parse(br#"{"kind":"\udfff","revision":3}"#).unwrap()];
        assert_eq!(
            substitute_placeholder_refs_lossless(&input, &deposited).stringify(),
            r#"{"\ud800":[{"kind":"\udfff","rev":3},"\udfff"]}"#
        );
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/protocol-artifact-preparation.json"
        ))
        .unwrap();
        for row in fixture["substitution"].as_array().unwrap() {
            let input = JsJson::from_serde(&row["input"]);
            let deposited: Vec<_> = row["deposited"]
                .as_array()
                .unwrap()
                .iter()
                .map(JsJson::from_serde)
                .collect();
            assert_eq!(
                substitute_placeholder_refs_lossless(&input, &deposited),
                JsJson::from_serde(&row["oracle"]),
                "{}",
                row["id"]
            );
        }
    }
    #[test]
    fn decoded_ceiling_accepts_boundary_and_refuses_one_more_without_mutation() {
        let accepted =
            json!({"kind":"notes","contentBase64":STANDARD.encode(vec![0;MAX_ARTIFACT_BYTES])});
        assert_eq!(
            decode_artifact(&accepted).unwrap().bytes.len(),
            MAX_ARTIFACT_BYTES
        );
        let refused =
            json!({"kind":"notes","contentBase64":STANDARD.encode(vec![0;MAX_ARTIFACT_BYTES+1])});
        let error = decode_artifact(&refused).unwrap_err();
        assert_eq!(error.status.as_u16(), 413);
        assert_eq!(
            error.error,
            "artifact exceeds decoded byte ceiling of 1048576 bytes"
        );
        assert!(decode_artifacts(&[accepted, refused]).is_err());
    }
}
