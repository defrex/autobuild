//! Requests and PostgreSQL JSON reads use JavaScript's IEEE-754 semantics.
//! Producer and stored-event schema validation retain their separate contracts.
use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{value::RawValue, Value};
use std::{error::Error, fmt};
use tokio_postgres::types::{FromSql, Type};

// Deserialize objects ourselves: arbitrary_precision's Value visitor reserves
// a private object key as a number transport marker. That key is ordinary user
// JSON here and must never convert an object into a scalar or reject its text.
struct ObjectEntries(Vec<(String, Box<RawValue>)>);
impl<'de> Deserialize<'de> for ObjectEntries {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntriesVisitor;
        impl<'de> Visitor<'de> for EntriesVisitor {
            type Value = ObjectEntries;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, Box<RawValue>>()? {
                    entries.push(entry);
                }
                Ok(ObjectEntries(entries))
            }
        }
        deserializer.deserialize_map(EntriesVisitor)
    }
}

/// Parse numeric lexemes before rounding, while keeping actual JSON objects
/// distinct from serde's synthetic private number map. Overflow remains a raw
/// Number until the schema either rejects it or accepts it as unknown data.
pub fn parse_js_json(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    let raw: Box<RawValue> = serde_json::from_slice(bytes)?;
    parse_raw(&raw)
}
fn parse_raw(raw: &RawValue) -> Result<Value, serde_json::Error> {
    let text = raw.get();
    match text.as_bytes()[0] {
        b'{' => {
            let entries: ObjectEntries = serde_json::from_str(text)?;
            let mut object = serde_json::Map::new();
            for (key, raw) in entries.0 {
                object.insert(key, parse_raw(&raw)?);
            }
            // Object.keys / JSON.stringify enumerate array-index names first
            // in ascending numeric order, then other keys in insertion order.
            // 2^32-1 is excluded, as are noncanonical spellings such as "01".
            let mut indices = Vec::new();
            let mut others = Vec::new();
            for (key, value) in object {
                match key.parse::<u32>() {
                    Ok(index) if index != u32::MAX && index.to_string() == key => {
                        indices.push((index, key, value));
                    }
                    _ => others.push((key, value)),
                }
            }
            indices.sort_by_key(|(index, _, _)| *index);
            Ok(Value::Object(
                indices
                    .into_iter()
                    .map(|(_, key, value)| (key, value))
                    .chain(others)
                    .collect(),
            ))
        }
        b'[' => {
            let elements: Vec<Box<RawValue>> = serde_json::from_str(text)?;
            elements
                .iter()
                .map(|raw| parse_raw(raw))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        b'"' => serde_json::from_str::<String>(text).map(Value::String),
        b't' | b'f' => serde_json::from_str::<bool>(text).map(Value::Bool),
        b'n' => Ok(Value::Null),
        _ => text.parse::<serde_json::Number>().map(normalize_number),
    }
}
fn normalize_number(number: serde_json::Number) -> Value {
    let float = number
        .to_string()
        .parse::<f64>()
        .expect("valid JSON number");
    if !float.is_finite() {
        return Value::Number(number);
    }
    // A cast above 2^53 publishes the float's exact binary integer rather
    // than JavaScript's shortest decimal. ECMAScript formatting owns this
    // boundary, exponent spelling and negative zero normalization.
    let mut buffer = ryu_js::Buffer::new();
    Value::Number(
        buffer
            .format_finite(float)
            .parse()
            .expect("formatted JSON number"),
    )
}

/// PostgreSQL JSON values enter the same JavaScript-compatible decoding
/// boundary as request JSON. The ordinary serde Value FromSql path would also
/// mistake a real user object with the private number key for a scalar.
#[derive(Debug, Clone)]
pub struct JsValue(pub Value);
impl<'a> FromSql<'a> for JsValue {
    fn from_sql(kind: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Sync + Send>> {
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
        Ok(Self(parse_js_json(bytes)?))
    }
    fn accepts(kind: &Type) -> bool {
        *kind == Type::JSON || *kind == Type::JSONB
    }
}

/// JSON.stringify turns accepted unknown Infinity values into null. Apply at
/// the serialization/persistence boundary, after schema checks have had their
/// chance to reject them. This also handles nested records and arrays.
pub fn serializable(value: Value) -> Value {
    match value {
        Value::Number(number) => {
            if number.as_f64().is_none() {
                Value::Null
            } else {
                normalize_number(number)
            }
        }
        Value::Array(values) => Value::Array(values.into_iter().map(serializable).collect()),
        Value::Object(values) => {
            let mut indices = Vec::new();
            let mut others = Vec::new();
            for (key, value) in values {
                let value = serializable(value);
                match key.parse::<u32>() {
                    Ok(index) if index != u32::MAX && index.to_string() == key => {
                        indices.push((index, key, value))
                    }
                    _ => others.push((key, value)),
                }
            }
            indices.sort_by_key(|(index, _, _)| *index);
            Value::Object(
                indices
                    .into_iter()
                    .map(|(_, key, value)| (key, value))
                    .chain(others)
                    .collect(),
            )
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fingerprint(value: &Value) -> Value {
        match value {
            Value::Number(number) => match number.as_f64() {
                Some(float) => json!({"bits":format!("{:016x}",float.to_bits())}),
                None => {
                    json!({"nonfinite":if number.to_string().starts_with('-'){"-Infinity"}else{"Infinity"}})
                }
            },
            Value::Array(values) => Value::Array(values.iter().map(fingerprint).collect()),
            Value::Object(values) => Value::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), fingerprint(value)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    #[test]
    fn raw_json_numbers_match_javascript_binary_values_and_serialization() {
        let fixture: Value =
            parse_js_json(include_bytes!("../../fixtures/protocol-json-numbers.json")).unwrap();
        for row in fixture["cases"].as_array().unwrap() {
            let parsed = parse_js_json(row["raw"].as_str().unwrap().as_bytes()).unwrap();
            assert_eq!(fingerprint(&parsed), row["parsed"], "{} parsed", row["id"]);
            let serialized = serializable(parsed);
            assert_eq!(
                serialized.to_string(),
                row["serializedText"].as_str().unwrap(),
                "{} serialized text",
                row["id"]
            );
            assert_eq!(
                fingerprint(&serialized),
                row["serialized"],
                "{} serialized",
                row["id"]
            );
        }
        assert!(fixture["cases"].as_array().unwrap().len() > 50);
    }
    #[test]
    fn postgres_jsonb_preserves_literal_private_number_keys() {
        for raw in [
            r#"{"$serde_json::private::Number":"1"}"#,
            r#"{"$serde_json::private::Number":"ordinary text","other":1}"#,
            r#"{"nested":{"$serde_json::private::Number":9007199254740993}}"#,
        ] {
            let mut bytes = vec![1];
            bytes.extend_from_slice(raw.as_bytes());
            assert_eq!(
                JsValue::from_sql(&Type::JSONB, &bytes).unwrap().0,
                parse_js_json(raw.as_bytes()).unwrap()
            );
            assert!(JsValue::from_sql(&Type::JSON, raw.as_bytes())
                .unwrap()
                .0
                .is_object());
        }
        assert!(JsValue::from_sql(&Type::JSONB, &[2, b'{', b'}']).is_err());
    }
    #[test]
    fn invalid_json_still_refuses_before_body_schemas() {
        for raw in [
            "{",
            "[1,]",
            "{\"n\":NaN}",
            "{\"n\":Infinity}",
            "01",
            "1e",
            "--1",
            "{\"n\":1}garbage",
        ] {
            assert!(parse_js_json(raw.as_bytes()).is_err(), "{raw}");
        }
    }
}
