//! Lossless JSON fragments produced by SDK partial-tool parsing. JavaScript can
//! materialize escaped lone UTF-16 surrogates that Rust String cannot represent.
//! This typed tree never uses a magic JSON key or user-colliding placeholder.
use serde_json::{json, Map, Value};
use std::collections::HashMap;
#[derive(Clone, Debug)]
enum Node {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<Node>),
    Object(Vec<(Vec<u16>, Node)>),
}
#[derive(Clone, Debug)]
pub(super) struct Fragment(Node);
struct Parser<'a> {
    input: &'a str,
    pos: usize,
}
impl Parser<'_> {
    fn whitespace(&mut self) {
        while self
            .input
            .as_bytes()
            .get(self.pos)
            .is_some_and(|b| matches!(b, b' ' | b'\n' | b'\r' | b'\t'))
        {
            self.pos += 1;
        }
    }
    fn byte(&mut self) -> Result<u8, ()> {
        let value = *self.input.as_bytes().get(self.pos).ok_or(())?;
        self.pos += 1;
        Ok(value)
    }
    fn literal(&mut self, expected: &str, node: Node) -> Result<Node, ()> {
        if self.input[self.pos..].starts_with(expected) {
            self.pos += expected.len();
            Ok(node)
        } else {
            Err(())
        }
    }
    fn string(&mut self) -> Result<Vec<u16>, ()> {
        if self.byte()? != b'"' {
            return Err(());
        }
        let mut out = Vec::new();
        loop {
            let start = self.pos;
            let b = self.byte()?;
            match b {
                b'"' => return Ok(out),
                b'\\' => {
                    let escape = self.byte()?;
                    match escape {
                        b'"' | b'\\' | b'/' => out.push(u16::from(escape)),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(10),
                        b'r' => out.push(13),
                        b't' => out.push(9),
                        b'u' => {
                            let mut code = 0u16;
                            for _ in 0..4 {
                                let c = self.byte()?;
                                let value = match c {
                                    b'0'..=b'9' => c - b'0',
                                    b'a'..=b'f' => c - b'a' + 10,
                                    b'A'..=b'F' => c - b'A' + 10,
                                    _ => return Err(()),
                                };
                                code = code * 16 + u16::from(value);
                            }
                            out.push(code)
                        }
                        _ => return Err(()),
                    }
                }
                0..=31 => return Err(()),
                32..=33 | 35..=91 | 93..=127 => out.push(u16::from(b)),
                _ => {
                    let c = self.input[start..].chars().next().ok_or(())?;
                    self.pos = start + c.len_utf8();
                    let mut buffer = [0; 2];
                    out.extend_from_slice(c.encode_utf16(&mut buffer));
                }
            }
        }
    }
    fn value(&mut self) -> Result<Node, ()> {
        self.whitespace();
        let Some(b) = self.input.as_bytes().get(self.pos).copied() else {
            return Err(());
        };
        match b {
            b'n' => self.literal("null", Node::Null),
            b't' => self.literal("true", Node::Bool(true)),
            b'f' => self.literal("false", Node::Bool(false)),
            b'"' => self.string().map(Node::String),
            b'[' => {
                self.pos += 1;
                self.whitespace();
                let mut values = Vec::new();
                if self.input.as_bytes().get(self.pos) == Some(&b']') {
                    self.pos += 1;
                    return Ok(Node::Array(values));
                }
                loop {
                    values.push(self.value()?);
                    self.whitespace();
                    match self.byte()? {
                        b']' => return Ok(Node::Array(values)),
                        b',' => {}
                        _ => return Err(()),
                    }
                }
            }
            b'{' => {
                self.pos += 1;
                self.whitespace();
                let mut values: Vec<(Vec<u16>, Node)> = Vec::new();
                let mut positions: HashMap<Vec<u16>, usize> = HashMap::new();
                if self.input.as_bytes().get(self.pos) == Some(&b'}') {
                    self.pos += 1;
                    return Ok(Node::Object(values));
                }
                loop {
                    self.whitespace();
                    let key = self.string()?;
                    self.whitespace();
                    if self.byte()? != b':' {
                        return Err(());
                    }
                    let value = self.value()?;
                    if let Some(index) = positions.get(&key) {
                        values[*index].1 = value
                    } else {
                        positions.insert(key.clone(), values.len());
                        values.push((key, value));
                    }
                    self.whitespace();
                    match self.byte()? {
                        b'}' => {
                            values.sort_by_key(|(key, _)| array_index(key).unwrap_or(u32::MAX));
                            return Ok(Node::Object(values));
                        }
                        b',' => {}
                        _ => return Err(()),
                    }
                }
            }
            b'-' | b'0'..=b'9' => {
                let start = self.pos;
                if b == b'-' {
                    self.pos += 1;
                }
                match self.byte()? {
                    b'0' => {}
                    b'1'..=b'9' => {
                        while self
                            .input
                            .as_bytes()
                            .get(self.pos)
                            .is_some_and(u8::is_ascii_digit)
                        {
                            self.pos += 1;
                        }
                    }
                    _ => return Err(()),
                }
                if self.input.as_bytes().get(self.pos) == Some(&b'.') {
                    self.pos += 1;
                    let digits = self.pos;
                    while self
                        .input
                        .as_bytes()
                        .get(self.pos)
                        .is_some_and(u8::is_ascii_digit)
                    {
                        self.pos += 1;
                    }
                    if self.pos == digits {
                        return Err(());
                    }
                }
                if self
                    .input
                    .as_bytes()
                    .get(self.pos)
                    .is_some_and(|b| matches!(b, b'e' | b'E'))
                {
                    self.pos += 1;
                    if self
                        .input
                        .as_bytes()
                        .get(self.pos)
                        .is_some_and(|b| matches!(b, b'+' | b'-'))
                    {
                        self.pos += 1;
                    }
                    let digits = self.pos;
                    while self
                        .input
                        .as_bytes()
                        .get(self.pos)
                        .is_some_and(u8::is_ascii_digit)
                    {
                        self.pos += 1;
                    }
                    if self.pos == digits {
                        return Err(());
                    }
                }
                self.input[start..self.pos]
                    .parse::<f64>()
                    .map(Node::Number)
                    .map_err(|_| ())
            }
            _ => Err(()),
        }
    }
}
fn key_is(key: &[u16], s: &str) -> bool {
    key.iter().copied().eq(s.encode_utf16())
}
fn array_index(key: &[u16]) -> Option<u32> {
    let text = String::from_utf16(key).ok()?;
    let index = text.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == text).then_some(index)
}
fn allowed(node: &Node) -> bool {
    match node{Node::Object(values)=>!values.iter().any(|(k,v)|key_is(k,"__proto__")||(key_is(k,"constructor")&&matches!(v,Node::Object(values) if values.iter().any(|(k,_)|key_is(k,"prototype")))))&&values.iter().all(|(_,v)|allowed(v)),Node::Array(values)=>values.iter().all(allowed),_=>true}
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
impl Node {
    fn encoded(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Bool(b) => b.to_string(),
            Self::Number(n) => {
                if n.is_finite() {
                    ryu_js::Buffer::new().format_finite(*n).into()
                } else {
                    "null".into()
                }
            }
            Self::String(s) => encode_string(s),
            Self::Array(a) => format!(
                "[{}]",
                a.iter().map(Self::encoded).collect::<Vec<_>>().join(",")
            ),
            Self::Object(o) => format!(
                "{{{}}}",
                o.iter()
                    .map(|(k, v)| format!("{}:{}", encode_string(k), v.encoded()))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
    fn projection(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(v) => json!(v),
            Self::Number(v) => {
                if v.is_finite() {
                    ryu_js::Buffer::new()
                        .format_finite(*v)
                        .parse()
                        .map(Value::Number)
                        .unwrap()
                } else {
                    Value::Null
                }
            }
            Self::String(v) => Value::String(String::from_utf16_lossy(v)),
            Self::Array(a) => a.iter().map(Self::projection).collect(),
            Self::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, v)| (String::from_utf16_lossy(k), v.projection()))
                    .collect::<Map<_, _>>(),
            ),
        }
    }
}
fn object_entries(node: &Node) -> Vec<(Vec<u16>, Node)> {
    match node {
        Node::Object(values) => values.clone(),
        Node::Array(values) => values
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string().encode_utf16().collect(), v.clone()))
            .collect(),
        Node::String(value) => value
            .iter()
            .enumerate()
            .map(|(i, v)| {
                (
                    i.to_string().encode_utf16().collect(),
                    Node::String(vec![*v]),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}
fn merge(base: &Node, overrides: &Node) -> Result<Node, ()> {
    let mut result = object_entries(base);
    let original: HashMap<_, _> = result.iter().cloned().collect();
    let mut positions: HashMap<_, _> = result
        .iter()
        .enumerate()
        .map(|(i, (k, _))| (k.clone(), i))
        .collect();
    for (key, value) in object_entries(overrides) {
        if ["__proto__", "constructor", "prototype"]
            .iter()
            .any(|s| key_is(&key, s))
        {
            continue;
        }
        if !matches!(base, Node::Object(_) | Node::Array(_)) {
            return Err(());
        }
        let old = original.get(&key);
        let value = if matches!(value, Node::Object(_)) && matches!(old, Some(Node::Object(_))) {
            merge(old.unwrap(), &value)?
        } else {
            value
        };
        if let Some(index) = positions.get(&key) {
            result[*index].1 = value
        } else {
            positions.insert(key.clone(), result.len());
            result.push((key, value));
        }
    }
    result.sort_by_key(|(key, _)| array_index(key).unwrap_or(u32::MAX));
    Ok(Node::Object(result))
}
impl Fragment {
    pub(super) fn from_value(value: &Value) -> Self {
        let text = serde_json::to_string(value).expect("JSON value");
        let mut parser = Parser {
            input: &text,
            pos: 0,
        };
        Self(parser.value().expect("serialized JSON value"))
    }
    pub(super) fn merge(&self, value: &Value) -> Result<Self, ()> {
        merge(&self.0, &Self::from_value(value).0).map(Self)
    }
    pub(super) fn parse(text: &str) -> Option<Self> {
        let mut parser = Parser {
            input: text,
            pos: 0,
        };
        let value = parser.value().ok()?;
        parser.whitespace();
        (parser.pos == text.len() && allowed(&value)).then_some(Self(value))
    }
    pub(super) fn encoded(&self) -> String {
        self.0.encoded()
    }
    /// A Rust Unicode-scalar projection is only for internal inspection. The
    /// separate encoded document retains original lone UTF-16 code units.
    pub(super) fn projection(&self) -> Value {
        self.0.projection()
    }
}
