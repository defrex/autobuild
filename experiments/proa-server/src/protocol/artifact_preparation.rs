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
