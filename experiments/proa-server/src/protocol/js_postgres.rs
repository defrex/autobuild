//! Explicit JavaScript string conversions at PostgreSQL's wire boundary.
//!
//! Authority must compare the original UTF-16 identities. Only TEXT parameters
//! perform the Node driver's replacement conversion; JSON parameters retain
//! escaped code units so PostgreSQL owns JSONB validation and error ordering.
use super::js_value::{JsJson, JsString};
use bytes::BytesMut;
use std::{error::Error, fmt};
use tokio_postgres::types::{to_sql_checked, FromSql, IsNull, ToSql, Type};

type SqlError = Box<dyn Error + Sync + Send>;

pub struct PgText<'a>(pub &'a JsString);
impl fmt::Debug for PgText<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PgText(..)")
    }
}
impl ToSql for PgText<'_> {
    fn to_sql(&self, kind: &Type, out: &mut BytesMut) -> Result<IsNull, SqlError> {
        self.0.to_usv_string().to_sql(kind, out)
    }
    fn accepts(kind: &Type) -> bool {
        <String as ToSql>::accepts(kind)
    }
    to_sql_checked!();
}

pub struct PgJson<'a>(pub &'a JsJson);
impl fmt::Debug for PgJson<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PgJson(..)")
    }
}
impl ToSql for PgJson<'_> {
    fn to_sql(&self, kind: &Type, out: &mut BytesMut) -> Result<IsNull, SqlError> {
        if *kind == Type::JSONB {
            out.extend_from_slice(&[1]);
        }
        out.extend_from_slice(self.0.stringify().as_bytes());
        Ok(IsNull::No)
    }
    fn accepts(kind: &Type) -> bool {
        *kind == Type::JSON || *kind == Type::JSONB
    }
    to_sql_checked!();
}

/// A JSONB scalar string may contain an inner JSON document with escaped lone
/// units. Decode the outer wire value losslessly; callers explicitly unwrap
/// their own envelope, rather than weakening all direct JSONB reads.
#[derive(Clone, Debug)]
pub struct PgValue(pub JsJson);
impl<'a> FromSql<'a> for PgValue {
    fn from_sql(kind: &Type, raw: &'a [u8]) -> Result<Self, SqlError> {
        let bytes = if *kind == Type::JSONB {
            if raw.first() != Some(&1) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unsupported JSONB format",
                )
                .into());
            }
            &raw[1..]
        } else {
            raw
        };
        Ok(Self(super::js_value::parse(bytes)?))
    }
    fn accepts(kind: &Type) -> bool {
        *kind == Type::JSON || *kind == Type::JSONB
    }
}

/// Match the source adapter's `json(column)` helper at explicitly named columns.
/// Only a string receives one JSON.parse layer; decoded strings are not parsed
/// recursively, and JSON.parse does not apply the HTTP decoder's BOM removal.
pub fn decode_json_column(value: JsJson) -> Result<JsJson, super::error::ProtocolError> {
    let Some(text) = value.as_js_string() else {
        return Ok(value);
    };
    super::js_value::parse_js_string(text).map_err(|_| {
        super::error::ProtocolError::new_js(
            500,
            "internal",
            super::js_postgres_diagnostics::parse_error(text),
        )
    })
}

/// JavaScript truthiness is tested on the outer driver value before optional
/// JSON columns are decoded (not on their parsed inner value).
pub fn json_truthy(value: &JsJson) -> bool {
    match value {
        JsJson::Null => false,
        JsJson::Bool(v) => *v,
        JsJson::Number(v) => *v != 0.0 && !v.is_nan(),
        JsJson::String(v) => !v.is_empty(),
        JsJson::Array(_) | JsJson::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::js_value::parse;

    #[test]
    fn persisted_json_parse_errors_match_bun_oracle() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-read-json.json")).unwrap();
        let mut errors = Vec::new();
        for row in fixture["cases"].as_array().unwrap() {
            let units = row["sourceUnits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect();
            let input = JsString::from_units(units);
            let actual = decode_json_column(JsJson::String(input.clone()));
            if let Some(json) = row["jsonUnits"].as_array() {
                let expected =
                    JsString::from_units(json.iter().map(|v| v.as_u64().unwrap() as u16).collect());
                let actual_json = actual.as_ref().ok().map(|v| JsString::from(v.stringify()));
                if actual_json.as_ref() != Some(&expected) {
                    errors.push(format!("{} success {:?}", input.quote(), actual));
                }
            } else {
                let expected = JsString::from_units(
                    row["errorUnits"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u16)
                        .collect(),
                );
                if actual.as_ref().err().map(|e| e.message_js()).as_ref() != Some(&expected) {
                    errors.push(format!(
                        "{} expected {} got {:?}",
                        input.quote(),
                        expected.quote(),
                        actual.err().map(|e| e.message_js().quote())
                    ));
                }
            }
        }
        assert!(
            errors.is_empty(),
            "{} parser differences:\n{}",
            errors.len(),
            errors.join("\n")
        );
    }
    #[test]
    fn named_json_columns_decode_exactly_one_layer_and_keep_original_units() {
        let original = parse(br#"{"x":"\ud800","\udfff":1}"#).unwrap();
        let envelope = JsJson::String(JsString::from(original.stringify()));
        assert_eq!(decode_json_column(envelope).unwrap(), original);
        let encoded_string = JsJson::String(JsString::from(r#""{\"x\":1}""#));
        assert_eq!(
            decode_json_column(encoded_string).unwrap(),
            JsJson::String(JsString::from(r#"{"x":1}"#))
        );
        assert_eq!(
            decode_json_column(JsJson::Bool(false)).unwrap(),
            JsJson::Bool(false)
        );
        // Inner JSON.parse rejects BOM; only Request.json strips a leading BOM.
        assert!(decode_json_column(JsJson::String(JsString::from("\u{feff}{}"))).is_err());
        assert_eq!(
            decode_json_column(JsJson::String(JsString::from("{")))
                .unwrap_err()
                .error,
            "JSON Parse error: Expected '}'"
        );
    }
    #[test]
    fn malformed_deep_column_diagnostics_use_heap_frames() {
        std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(|| {
                let source = JsString::from("[".repeat(16_384));
                let error = decode_json_column(JsJson::String(source)).unwrap_err();
                assert_eq!(error.error, "JSON Parse error: Unexpected EOF");
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn optional_json_columns_test_outer_driver_truthiness_before_decoding() {
        for input in ["null", "false", "0", "-0", r#""""#] {
            assert!(!json_truthy(&parse(input.as_bytes()).unwrap()));
        }
        for input in ["[]", "{}", "1", r#""null""#, r#""false""#] {
            assert!(json_truthy(&parse(input.as_bytes()).unwrap()));
        }
        assert_eq!(
            decode_json_column(JsJson::String(JsString::from("null"))).unwrap(),
            JsJson::Null
        );
    }

    #[test]
    fn text_binding_replaces_only_at_the_transport_boundary() {
        let original = JsString::from_units(vec![0xd800, 0x61, 0xdc00]);
        let mut bytes = BytesMut::new();
        PgText(&original).to_sql(&Type::TEXT, &mut bytes).unwrap();
        assert_eq!(&bytes[..], "�a�".as_bytes());
        assert_eq!(original.units(), &[0xd800, 0x61, 0xdc00]);
        assert!(!original.eq_str("�a�"));
        assert_eq!(format!("{:?}", PgText(&original)), "PgText(..)");
    }

    #[test]
    fn json_binding_preserves_escapes_and_envelopes_without_scalar_projection() {
        let value = parse(br#"{"\ud800":["\udfff",1e400]}"#).unwrap();
        let mut bytes = BytesMut::new();
        PgJson(&value).to_sql(&Type::JSONB, &mut bytes).unwrap();
        assert_eq!(&bytes[..], b"\x01{\"\\ud800\":[\"\\udfff\",null]}");
        // A direct JSONB write reaches the server with the original escape and
        // may fail there; a JSONB string envelope can retain this inner text.
        let envelope = JsJson::String(JsString::from(value.stringify()));
        bytes.clear();
        PgJson(&envelope).to_sql(&Type::JSONB, &mut bytes).unwrap();
        let outer = PgValue::from_sql(&Type::JSONB, &bytes).unwrap().0;
        assert_eq!(outer, envelope);
        let text = outer.as_js_string().unwrap().to_scalar().unwrap();
        assert_eq!(
            parse(text.as_bytes()).unwrap().stringify(),
            value.stringify()
        );
        assert_eq!(format!("{:?}", PgJson(&value)), "PgJson(..)");
        assert!(PgValue::from_sql(&Type::JSONB, &[2, b'{', b'}']).is_err());
    }
}
