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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::js_value::parse;

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
