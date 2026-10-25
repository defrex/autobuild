//! JavaScript JSON values retain UTF-16 code units, including isolated surrogates.
//! Scalar conversion is checked; USV replacement is explicit and boundary-specific.
use serde_json::Value;
use std::{collections::HashMap, fmt};
mod construction;
pub use construction::ToJs;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JsValueError {
    InvalidUtf8,
    InvalidJson { offset: usize },
    UnpairedSurrogate,
    NonFiniteNumber,
}
impl fmt::Display for JsValueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUtf8 => f.write_str("JSON input is not valid UTF-8"),
            Self::InvalidJson { offset } => write!(f, "invalid JSON at byte {offset}"),
            Self::UnpairedSurrogate => f.write_str("string contains an unpaired UTF-16 surrogate"),
            Self::NonFiniteNumber => f.write_str("number is not finite"),
        }
    }
}
impl std::error::Error for JsValueError {}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JsString(pub Vec<u16>);
impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}
impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}
impl From<Vec<u16>> for JsString {
    fn from(value: Vec<u16>) -> Self {
        Self(value)
    }
}
impl JsString {
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn eq_ascii(&self, value: &str) -> bool {
        value.is_ascii() && self.0.iter().copied().eq(value.bytes().map(u16::from))
    }
    pub fn eq_str(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.encode_utf16())
    }
    pub fn to_scalar(&self) -> Result<String, JsValueError> {
        String::from_utf16(&self.0).map_err(|_| JsValueError::UnpairedSurrogate)
    }
    /// Only for APIs whose specified conversion is a Unicode scalar-value string.
    /// Never use this conversion for authority equality or claim normalization.
    pub fn to_usv_string(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
    pub fn trim_js(&self) -> Self {
        let whitespace = |unit: &u16| matches!(*unit,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff);
        let start = self
            .0
            .iter()
            .position(|u| !whitespace(u))
            .unwrap_or(self.0.len());
        let end = self
            .0
            .iter()
            .rposition(|u| !whitespace(u))
            .map_or(start, |i| i + 1);
        Self(self.0[start..end].to_vec())
    }
    pub fn quote(&self) -> String {
        encode_string(&self.0)
    }
}

pub enum JsJson {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsJson>),
    Object(Vec<(JsString, JsJson)>),
}

fn encode_string(value: &[u16]) -> String {
    let mut out = String::from("\"");
    let mut index = 0;
    while index < value.len() {
        let code = value[index];
        index += 1;
        match code {
            34 => out.push_str("\\\""),
            92 => out.push_str("\\\\"),
            8 => out.push_str("\\b"),
            9 => out.push_str("\\t"),
            10 => out.push_str("\\n"),
            12 => out.push_str("\\f"),
            13 => out.push_str("\\r"),
            0..=31 => out.push_str(&format!("\\u{code:04x}")),
            0xd800..=0xdbff
                if value
                    .get(index)
                    .is_some_and(|low| (0xdc00..=0xdfff).contains(low)) =>
            {
                let low = value[index];
                index += 1;
                let scalar =
                    0x10000 + (u32::from(code) - 0xd800) * 0x400 + (u32::from(low) - 0xdc00);
                out.push(char::from_u32(scalar).expect("surrogate pair"));
            }
            0xd800..=0xdfff => out.push_str(&format!("\\u{code:04x}")),
            _ => out.push(char::from_u32(u32::from(code)).expect("non-surrogate code unit")),
        }
    }
    out.push('"');
    out
}
fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || key.iter().any(|u| !matches!(*u, 48..=57)) {
        return None;
    }
    if key.len() > 1 && key[0] == 48 {
        return None;
    }
    let mut n = 0u32;
    for unit in key {
        n = n.checked_mul(10)?.checked_add(u32::from(*unit - 48))?;
    }
    (n != u32::MAX).then_some(n)
}
fn ordered_entries(values: &[(JsString, JsJson)]) -> Vec<(&JsString, &JsJson)> {
    let mut entries = Vec::new();
    let mut positions = HashMap::new();
    for (key, value) in values {
        if let Some(index) = positions.get(key) {
            entries[*index] = (key, value)
        } else {
            positions.insert(key, entries.len());
            entries.push((key, value));
        }
    }
    entries.sort_by_key(|(key, _)| array_index(key.units()).unwrap_or(u32::MAX));
    entries
}
/// JSON.parse grammar over strict UTF-8 bytes. No SDK prototype-key policy applies.
pub fn parse(bytes: &[u8]) -> Result<JsJson, JsValueError> {
    let text = std::str::from_utf8(bytes).map_err(|_| JsValueError::InvalidUtf8)?;
    units_parser::parse(&text.encode_utf16().collect::<Vec<_>>())
}

/// Fetch Body.json's UTF-8 replacement decode, including one leading BOM removal.
pub fn parse_http(bytes: &[u8]) -> Result<JsJson, JsValueError> {
    parse(decode_http_utf8(bytes).as_bytes())
}
/// Fetch's UTF-8 decoder replaces malformed sequences and strips one initial BOM.
pub fn decode_http_utf8(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
}
pub fn stringify(value: &JsJson) -> String {
    value.stringify()
}
impl JsJson {
    pub fn parse(bytes: &[u8]) -> Result<Self, JsValueError> {
        parse(bytes)
    }
    pub fn stringify(&self) -> String {
        enum Task<'a> {
            Value(&'a JsJson),
            Key(&'a JsString),
            Char(char),
        }
        let mut tasks = vec![Task::Value(self)];
        let mut out = String::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Key(key) => out.push_str(&key.quote()),
                Task::Char(c) => out.push(c),
                Task::Value(value) => match value {
                    Self::Null => out.push_str("null"),
                    Self::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
                    Self::Number(v) => {
                        if v.is_finite() {
                            out.push_str(ryu_js::Buffer::new().format_finite(*v))
                        } else {
                            out.push_str("null")
                        }
                    }
                    Self::String(s) => out.push_str(&s.quote()),
                    Self::Array(values) => {
                        out.push('[');
                        tasks.push(Task::Char(']'));
                        for (index, value) in values.iter().enumerate().rev() {
                            tasks.push(Task::Value(value));
                            if index > 0 {
                                tasks.push(Task::Char(','))
                            }
                        }
                    }
                    Self::Object(values) => {
                        out.push('{');
                        tasks.push(Task::Char('}'));
                        for (index, (key, value)) in
                            ordered_entries(values).into_iter().enumerate().rev()
                        {
                            tasks.push(Task::Value(value));
                            tasks.push(Task::Char(':'));
                            tasks.push(Task::Key(key));
                            if index > 0 {
                                tasks.push(Task::Char(','))
                            }
                        }
                    }
                },
            }
        }
        out
    }
    pub fn get(&self, key: &str) -> Option<&Self> {
        self.as_object()?
            .iter()
            .rev()
            .find(|(k, _)| k.eq_str(key))
            .map(|(_, v)| v)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Self> {
        match self {
            Self::Object(v) => v
                .iter_mut()
                .rev()
                .find(|(k, _)| k.eq_str(key))
                .map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_string(&self) -> Option<&JsString> {
        match self {
            Self::String(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_js_string(&self) -> Option<&JsString> {
        self.as_string()
    }
    pub fn as_array(&self) -> Option<&Vec<Self>> {
        match self {
            Self::Array(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_object(&self) -> Option<&Vec<(JsString, Self)>> {
        match self {
            Self::Object(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(v) => Some(*v),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(v) => Some(*v),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    /// Checked compatibility bridge. Nonfinite numbers need explicit stringify
    /// normalization; unpaired strings/keys are never projected to replacements.
    pub fn to_serde_checked(&self) -> Result<Value, JsValueError> {
        // Validate first, so an error never drops a partially built deep serde
        // tree through serde's own recursive destructor.
        let mut check = vec![self];
        while let Some(value) = check.pop() {
            match value {
                Self::Number(n) if !n.is_finite() => return Err(JsValueError::NonFiniteNumber),
                Self::String(s)
                    if char::decode_utf16(s.units().iter().copied()).any(|c| c.is_err()) =>
                {
                    return Err(JsValueError::UnpairedSurrogate)
                }
                Self::Array(values) => check.extend(values),
                Self::Object(values) => {
                    for (key, value) in ordered_entries(values) {
                        if char::decode_utf16(key.units().iter().copied()).any(|c| c.is_err()) {
                            return Err(JsValueError::UnpairedSurrogate);
                        }
                        check.push(value)
                    }
                }
                _ => (),
            }
        }
        enum Task<'a> {
            Visit(&'a JsJson),
            Array(usize),
            Object(Vec<String>),
        }
        let mut tasks = vec![Task::Visit(self)];
        let mut built = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Visit(value) => match value {
                    Self::Null => built.push(Value::Null),
                    Self::Bool(v) => built.push(Value::Bool(*v)),
                    Self::Number(v) => {
                        let number = if *v == 0.0 && v.is_sign_negative() {
                            serde_json::Number::from_f64(*v).expect("finite zero")
                        } else {
                            ryu_js::Buffer::new()
                                .format_finite(*v)
                                .parse()
                                .expect("formatted finite JSON number")
                        };
                        built.push(Value::Number(number))
                    }
                    Self::String(s) => built.push(Value::String(
                        s.to_scalar().expect("validated scalar string"),
                    )),
                    Self::Array(values) => {
                        tasks.push(Task::Array(values.len()));
                        tasks.extend(values.iter().rev().map(Task::Visit))
                    }
                    Self::Object(values) => {
                        let entries = ordered_entries(values);
                        tasks.push(Task::Object(
                            entries
                                .iter()
                                .map(|(k, _)| k.to_scalar().expect("validated scalar key"))
                                .collect(),
                        ));
                        tasks.extend(entries.into_iter().rev().map(|(_, v)| Task::Visit(v)))
                    }
                },
                Task::Array(count) => {
                    let values = built.split_off(built.len() - count);
                    built.push(Value::Array(values))
                }
                Task::Object(keys) => {
                    let values = built.split_off(built.len() - keys.len());
                    built.push(Value::Object(keys.into_iter().zip(values).collect()))
                }
            }
        }
        Ok(built.pop().expect("one converted root"))
    }
    /// Structural import avoids serde's private arbitrary-number transport key.
    pub fn from_serde(value: &Value) -> Self {
        enum Task<'a> {
            Visit(&'a Value),
            Array(usize),
            Object(Vec<JsString>),
        }
        let mut tasks = vec![Task::Visit(value)];
        let mut built = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Visit(value) => match value {
                    Value::Null => built.push(Self::Null),
                    Value::Bool(v) => built.push(Self::Bool(*v)),
                    Value::Number(v) => built.push(Self::Number(
                        v.to_string()
                            .parse()
                            .expect("serde JSON number is a valid float lexeme"),
                    )),
                    Value::String(v) => built.push(Self::String(JsString::from(v.as_str()))),
                    Value::Array(values) => {
                        tasks.push(Task::Array(values.len()));
                        tasks.extend(values.iter().rev().map(Task::Visit))
                    }
                    Value::Object(values) => {
                        tasks.push(Task::Object(
                            values.keys().map(|k| JsString::from(k.as_str())).collect(),
                        ));
                        tasks.extend(values.values().rev().map(Task::Visit))
                    }
                },
                Task::Array(count) => {
                    let values = built.split_off(built.len() - count);
                    built.push(Self::Array(values))
                }
                Task::Object(keys) => {
                    let values = built.split_off(built.len() - keys.len());
                    built.push(Self::Object(keys.into_iter().zip(values).collect()))
                }
            }
        }
        built.pop().expect("one imported root")
    }
}

impl JsJson {
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub fn is_number(&self) -> bool {
        matches!(self, Self::Number(_))
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub fn as_array_mut(&mut self) -> Option<&mut Vec<Self>> {
        match self {
            Self::Array(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_object_mut(&mut self) -> Option<&mut Vec<(JsString, Self)>> {
        match self {
            Self::Object(v) => Some(v),
            _ => None,
        }
    }
}
static NULL: JsJson = JsJson::Null;
impl std::ops::Index<&str> for JsJson {
    type Output = JsJson;
    fn index(&self, key: &str) -> &JsJson {
        self.get(key).unwrap_or(&NULL)
    }
}
impl std::ops::Index<usize> for JsJson {
    type Output = JsJson;
    fn index(&self, index: usize) -> &JsJson {
        self.as_array().and_then(|v| v.get(index)).unwrap_or(&NULL)
    }
}
impl JsJson {
    /// Object lookup compares the original UTF-16 property name.
    pub fn get_js(&self, key: &JsString) -> Option<&Self> {
        self.as_object()?
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
    pub fn get_js_mut(&mut self, key: &JsString) -> Option<&mut Self> {
        self.as_object_mut()?
            .iter_mut()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
    pub fn remove_js(&mut self, key: &JsString) -> Option<Self> {
        let values = self.as_object_mut()?;
        let index = values.iter().rposition(|(k, _)| k == key)?;
        Some(values.remove(index).1)
    }
}
impl std::ops::Index<&JsString> for JsJson {
    type Output = JsJson;
    fn index(&self, key: &JsString) -> &JsJson {
        self.get_js(key).unwrap_or(&NULL)
    }
}
impl std::ops::IndexMut<&JsString> for JsJson {
    fn index_mut(&mut self, key: &JsString) -> &mut JsJson {
        if self.is_null() {
            *self = Self::Object(Vec::new());
        }
        let values = self
            .as_object_mut()
            .expect("cannot index non-object JSON value with string");
        let index = values
            .iter()
            .rposition(|(k, _)| k == key)
            .unwrap_or_else(|| {
                values.push((key.clone(), Self::Null));
                values.len() - 1
            });
        &mut values[index].1
    }
}
impl std::ops::Index<String> for JsJson {
    type Output = JsJson;
    fn index(&self, key: String) -> &JsJson {
        &self[key.as_str()]
    }
}
impl std::ops::IndexMut<String> for JsJson {
    fn index_mut(&mut self, key: String) -> &mut JsJson {
        &mut self[key.as_str()]
    }
}
impl std::ops::Index<&String> for JsJson {
    type Output = JsJson;
    fn index(&self, key: &String) -> &JsJson {
        &self[key.as_str()]
    }
}
impl std::ops::IndexMut<&String> for JsJson {
    fn index_mut(&mut self, key: &String) -> &mut JsJson {
        &mut self[key.as_str()]
    }
}
impl PartialEq<String> for JsJson {
    fn eq(&self, other: &String) -> bool {
        self.as_string().is_some_and(|s| s.eq_str(other))
    }
}
impl PartialEq<JsString> for JsJson {
    fn eq(&self, other: &JsString) -> bool {
        self.as_string() == Some(other)
    }
}
impl PartialEq<&JsString> for JsJson {
    fn eq(&self, other: &&JsString) -> bool {
        self.as_string() == Some(*other)
    }
}
impl JsJson {
    /// Canonical reducer comparison sorts original UTF-16 property names.
    pub fn sort_all_objects(&mut self) {
        let mut pending = vec![self];
        while let Some(value) = pending.pop() {
            match value {
                Self::Object(fields) => {
                    fields.sort_by(|a, b| a.0.cmp(&b.0));
                    pending.extend(fields.iter_mut().map(|(_, child)| child));
                }
                Self::Array(items) => pending.extend(items.iter_mut()),
                _ => {}
            }
        }
    }
}
impl std::ops::IndexMut<&str> for JsJson {
    fn index_mut(&mut self, key: &str) -> &mut JsJson {
        if self.is_null() {
            *self = Self::Object(Vec::new())
        }
        let values = self
            .as_object_mut()
            .expect("cannot index non-object JSON value with string");
        let index = values
            .iter()
            .rposition(|(k, _)| k.eq_str(key))
            .unwrap_or_else(|| {
                values.push((JsString::from(key), Self::Null));
                values.len() - 1
            });
        &mut values[index].1
    }
}
impl std::ops::IndexMut<usize> for JsJson {
    fn index_mut(&mut self, index: usize) -> &mut JsJson {
        &mut self
            .as_array_mut()
            .expect("cannot index non-array JSON value with integer")[index]
    }
}

impl PartialEq<&str> for JsJson {
    fn eq(&self, other: &&str) -> bool {
        self.as_string().is_some_and(|s| s.eq_str(other))
    }
}
impl PartialEq<bool> for JsJson {
    fn eq(&self, other: &bool) -> bool {
        self.as_bool() == Some(*other)
    }
}
impl PartialEq<Value> for JsJson {
    fn eq(&self, other: &Value) -> bool {
        self == &Self::from_serde(other)
    }
}
impl PartialEq<JsJson> for Value {
    fn eq(&self, other: &JsJson) -> bool {
        &JsJson::from_serde(self) == other
    }
}
impl JsJson {
    pub fn as_i64(&self) -> Option<i64> {
        self.as_f64()
            .filter(|n| {
                n.is_finite() && n.fract() == 0.0 && *n >= i64::MIN as f64 && *n < (i64::MAX as f64)
            })
            .map(|n| n as i64)
    }
}

mod units_parser;
/// JSON.parse source strings retain raw lone units that cannot enter via UTF-8.
pub fn parse_js_string(input: &JsString) -> Result<JsJson, JsValueError> {
    units_parser::parse(input.units())
}

// This buffer is used only to classify a failed grammar parse. A valid Unicode
// escape is grammar-neutral; masking it prevents serde's narrower string domain
// from hiding the later syntax error. No value parsed from this buffer is used.
pub(crate) fn grammar_diagnostic_text(input: &str) -> String {
    let mut bytes = input.as_bytes().to_vec();
    let mut inside = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            inside = !inside;
            i += 1;
            continue;
        }
        if inside && bytes[i] == b'\\' {
            if bytes.get(i + 1) == Some(&b'u') && i + 6 <= bytes.len() {
                if let Ok(hex) = std::str::from_utf8(&bytes[i + 2..i + 6]) {
                    if let Ok(code) = u16::from_str_radix(hex, 16) {
                        if (0xd800..=0xdfff).contains(&code) {
                            bytes[i + 2..i + 6].copy_from_slice(b"0061");
                        }
                    }
                }
                i += 6;
            } else {
                i += 2;
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(bytes).expect("only ASCII escape tokens changed")
}

impl Clone for JsJson {
    fn clone(&self) -> Self {
        enum Task<'a> {
            Visit(&'a JsJson),
            Array(usize),
            Object(Vec<JsString>),
        }
        let mut tasks = vec![Task::Visit(self)];
        let mut built = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Visit(value) => match value {
                    Self::Null => built.push(Self::Null),
                    Self::Bool(v) => built.push(Self::Bool(*v)),
                    Self::Number(v) => built.push(Self::Number(*v)),
                    Self::String(v) => built.push(Self::String(v.clone())),
                    Self::Array(values) => {
                        tasks.push(Task::Array(values.len()));
                        tasks.extend(values.iter().rev().map(Task::Visit))
                    }
                    Self::Object(values) => {
                        tasks.push(Task::Object(
                            values.iter().map(|(k, _)| k.clone()).collect(),
                        ));
                        tasks.extend(values.iter().rev().map(|(_, v)| Task::Visit(v)))
                    }
                },
                Task::Array(count) => {
                    let values = built.split_off(built.len() - count);
                    built.push(Self::Array(values))
                }
                Task::Object(keys) => {
                    let values = built.split_off(built.len() - keys.len());
                    built.push(Self::Object(keys.into_iter().zip(values).collect()))
                }
            }
        }
        built.pop().expect("one cloned root")
    }
}
impl PartialEq for JsJson {
    fn eq(&self, other: &Self) -> bool {
        let mut pairs = vec![(self, other)];
        while let Some((a, b)) = pairs.pop() {
            match (a, b) {
                (Self::Null, Self::Null) => (),
                (Self::Bool(a), Self::Bool(b)) if a == b => (),
                (Self::Number(a), Self::Number(b)) if a == b => (),
                (Self::String(a), Self::String(b)) if a == b => (),
                (Self::Array(a), Self::Array(b)) if a.len() == b.len() => {
                    pairs.extend(a.iter().zip(b))
                }
                (Self::Object(a), Self::Object(b)) if a.len() == b.len() => {
                    for ((ak, av), (bk, bv)) in a.iter().zip(b) {
                        if ak != bk {
                            return false;
                        }
                        pairs.push((av, bv))
                    }
                }
                _ => return false,
            }
        }
        true
    }
}
impl fmt::Debug for JsJson {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.stringify())
    }
}
impl Drop for JsJson {
    fn drop(&mut self) {
        fn children(value: &mut JsJson, pending: &mut Vec<JsJson>) {
            match value {
                JsJson::Array(values) => pending.append(values),
                JsJson::Object(values) => {
                    for (_, value) in std::mem::take(values) {
                        pending.push(value)
                    }
                }
                _ => (),
            }
        }
        let mut pending = Vec::new();
        children(self, &mut pending);
        while let Some(mut value) = pending.pop() {
            children(&mut value, &mut pending)
        }
    }
}
impl JsJson {
    pub fn into_array(mut self) -> Option<Vec<Self>> {
        match &mut self {
            Self::Array(v) => Some(std::mem::take(v)),
            _ => None,
        }
    }
    pub fn into_object(mut self) -> Option<Vec<(JsString, Self)>> {
        match &mut self {
            Self::Object(v) => Some(std::mem::take(v)),
            _ => None,
        }
    }
    pub fn into_string(mut self) -> Option<JsString> {
        match &mut self {
            Self::String(v) => Some(std::mem::take(v)),
            _ => None,
        }
    }
}

/// Dispose a checked scalar projection without serde Value's recursive Drop.
/// JsJson itself always uses its iterative Drop automatically.
pub fn drop_serde_iterative(value: Value) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Array(values) => pending.extend(values),
            Value::Object(values) => pending.extend(values.into_iter().map(|(_, v)| v)),
            _ => (),
        }
    }
}

impl From<&JsString> for JsString {
    fn from(v: &JsString) -> Self {
        v.clone()
    }
}
impl std::ops::Index<JsString> for JsJson {
    type Output = Self;
    fn index(&self, key: JsString) -> &Self {
        &self[&key]
    }
}
impl std::ops::IndexMut<JsString> for JsJson {
    fn index_mut(&mut self, key: JsString) -> &mut Self {
        &mut self[&key]
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn dynamic_property_mutation_never_aliases_replacement_or_prototype_names() {
        use super::*;
        let lone = JsString::from_units(vec![0xd800]);
        let replacement = JsString::from("�");
        let mut value = JsJson::Null;
        value[&lone] = JsJson::Bool(true);
        value[&replacement] = JsJson::Bool(false);
        value[String::from("__proto__")] = JsJson::Number(3.0);
        assert_eq!(value[&lone], true);
        assert_eq!(value[&replacement], false);
        assert_eq!(value["__proto__"].as_i64(), Some(3));
        *value.get_js_mut(&lone).unwrap() = JsJson::Number(4.0);
        assert_eq!(value.remove_js(&lone).unwrap().as_i64(), Some(4));
        assert!(value.get_js(&lone).is_none());
        assert_eq!(value[&replacement], false);
        assert_eq!(super::parse(value.stringify().as_bytes()).unwrap(), value);
    }
    use super::*;
    use serde_json::json;
    fn fingerprint(value: &JsJson) -> Value {
        match value {
            JsJson::Null => json!({"type":"null"}),
            JsJson::Bool(v) => json!({"type":"boolean","value":v}),
            JsJson::Number(v) => {
                json!({"type":"number","json":value.stringify(),"negativeZero":*v==0.0&&v.is_sign_negative()})
            }
            JsJson::String(v) => json!({"type":"string","units":v.units()}),
            JsJson::Array(v) => {
                json!({"type":"array","items":v.iter().map(fingerprint).collect::<Vec<_>>()})
            }
            JsJson::Object(v) => {
                json!({"type":"object","entries":ordered_entries(v).into_iter().map(|(k,v)|json!({"keyUnits":k.units(),"value":fingerprint(v)})).collect::<Vec<_>>()})
            }
        }
    }
    fn numeric_fingerprint(value: &JsJson) -> Value {
        match value {
            JsJson::Number(v) => {
                if v.is_finite() {
                    json!({"bits":format!("{:016x}",if *v==0.0 {0} else {v.to_bits()})})
                } else {
                    json!({"nonfinite":if v.is_sign_negative(){"-Infinity"}else{"Infinity"}})
                }
            }
            JsJson::Array(v) => Value::Array(v.iter().map(numeric_fingerprint).collect()),
            JsJson::Object(v) => Value::Object(
                v.iter()
                    .map(|(k, v)| (k.to_scalar().unwrap(), numeric_fingerprint(v)))
                    .collect(),
            ),
            _ => value.to_serde_checked().unwrap(),
        }
    }
    #[test]
    fn unicode_json_matches_javascript_oracle() {
        let fixture = crate::protocol::js_json::parse_js_json(include_bytes!(
            "../../fixtures/protocol-unicode.json"
        ))
        .unwrap();
        for row in fixture["valid"].as_array().unwrap() {
            let parsed = parse(row["input"].as_str().unwrap().as_bytes()).unwrap();
            assert_eq!(
                parsed.stringify().encode_utf16().collect::<Vec<_>>(),
                row["stringifyUnits"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>(),
                "{} stringify",
                row["name"]
            );
            assert_eq!(
                fingerprint(&parsed),
                row["fingerprint"],
                "{} fingerprint",
                row["name"]
            );
        }
        for row in fixture["invalid"].as_array().unwrap() {
            assert!(
                parse(
                    JsString::from_units(
                        row["inputUnits"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|n| n.as_u64().unwrap() as u16)
                            .collect()
                    )
                    .to_scalar()
                    .unwrap()
                    .as_bytes()
                )
                .is_err(),
                "{}",
                row["name"]
            );
        }
        for row in fixture["utf8"].as_array().unwrap() {
            let bytes: Vec<u8> = row["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            let text = decode_http_utf8(&bytes);
            assert_eq!(
                text.encode_utf16().collect::<Vec<_>>(),
                row["units"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>(),
                "{} UTF8",
                row["name"]
            );
        }
        assert!(fixture["valid"].as_array().unwrap().len() >= 76);
    }
    #[test]
    fn existing_numeric_oracle_retains_js_binary_values() {
        let fixture = crate::protocol::js_json::parse_js_json(include_bytes!(
            "../../fixtures/protocol-json-numbers.json"
        ))
        .unwrap();
        for row in fixture["cases"].as_array().unwrap() {
            let parsed = parse(row["raw"].as_str().unwrap().as_bytes()).unwrap();
            assert_eq!(
                numeric_fingerprint(&parsed),
                row["parsed"],
                "{} parsed",
                row["id"]
            );
            assert_eq!(
                parsed.stringify(),
                row["serializedText"].as_str().unwrap(),
                "{} stringify",
                row["id"]
            );
        }
    }
    #[test]
    fn checked_conversion_never_replaces_identity_or_private_keys() {
        let surrogate = JsString::from_units(vec![0xd800]);
        assert_eq!(surrogate.to_scalar(), Err(JsValueError::UnpairedSurrogate));
        assert_eq!(surrogate.to_usv_string(), "\u{fffd}");
        assert_ne!(surrogate, JsString::from("\u{fffd}"));
        assert_eq!(
            JsJson::String(surrogate.clone()).to_serde_checked(),
            Err(JsValueError::UnpairedSurrogate)
        );
        assert!(JsJson::Object(vec![(surrogate, JsJson::Null)])
            .to_serde_checked()
            .is_err());
        assert_eq!(
            JsJson::Number(f64::INFINITY).to_serde_checked(),
            Err(JsValueError::NonFiniteNumber)
        );
        let value = Value::Object(
            [(
                "$serde_json::private::Number".to_owned(),
                Value::String("ordinary text".into()),
            )]
            .into_iter()
            .collect(),
        );
        assert_eq!(
            JsJson::from_serde(&value).to_serde_checked().unwrap(),
            value
        );
        assert_eq!(
            parse(br#"{"a":1,"2":2,"a":3,"1":4,"__proto__":{"x":1}}"#)
                .unwrap()
                .stringify(),
            r#"{"1":4,"2":2,"a":3,"__proto__":{"x":1}}"#
        );
    }
    #[test]
    fn string_units_trim_order_and_http_decode_are_explicit() {
        assert_eq!(JsString::from("😀").len(), 2);
        assert!(JsString::from_units(vec![0xd800]) < JsString::from("\u{fffd}"));
        assert_eq!(
            JsString::from_units(vec![0xfeff, 32, 0xd800, 0x2029])
                .trim_js()
                .units(),
            &[0xd800]
        );
        assert!(!JsString::from_units(vec![0x85]).trim_js().is_empty());
        assert_eq!(
            parse_http(b"\xef\xbb\xbf\"\xff\"").unwrap(),
            JsJson::String(JsString::from("\u{fffd}"))
        );
        assert_eq!(parse(b"\"\xff\""), Err(JsValueError::InvalidUtf8));
        let mut value = JsJson::Null;
        value["2"] = JsJson::Bool(true);
        value["1"] = JsJson::Null;
        assert_eq!(value.stringify(), r#"{"1":null,"2":true}"#);
    }
    #[test]
    fn deep_values_are_stack_safe_on_a_small_thread() {
        std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(|| {
                let depth = 8192;
                let input = format!("{}-0{}", "[".repeat(depth), "]".repeat(depth));
                let value = parse(input.as_bytes()).unwrap();
                let cloned = value.clone();
                assert_eq!(value, cloned);
                assert_eq!(
                    value.stringify(),
                    format!("{}0{}", "[".repeat(depth), "]".repeat(depth))
                );
                let mut leaf = &value;
                for _ in 0..depth {
                    leaf = &leaf[0]
                }
                assert!(leaf.as_f64().unwrap().is_sign_negative());
                let scalar = value.to_serde_checked().unwrap();
                let imported = JsJson::from_serde(&scalar);
                assert_eq!(value, imported);
                drop_serde_iterative(scalar);
                drop(imported);
                drop(cloned);
                drop(value);
                let deep = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
                let duplicate = format!("{{\"x\":{deep},\"x\":1}}");
                assert_eq!(
                    parse(duplicate.as_bytes()).unwrap().stringify(),
                    "{\"x\":1}"
                );
                let object = format!(
                    "{}\"\\udfff\"{}",
                    "{\"\\ud800\":".repeat(depth),
                    "}".repeat(depth)
                );
                let value = parse(object.as_bytes()).unwrap();
                let cloned = value.clone();
                assert_eq!(value, cloned);
                assert_eq!(value.stringify(), object);
                drop(value);
                drop(cloned);
                assert!(parse(
                    format!("{}0{}x", "[".repeat(depth), "]".repeat(depth / 2)).as_bytes()
                )
                .is_err());
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
