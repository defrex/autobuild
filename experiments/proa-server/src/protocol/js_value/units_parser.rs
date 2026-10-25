//! JSON.parse over UTF-16 source text, using heap frames rather than call frames.
use super::{array_index, JsJson, JsString, JsValueError};
use std::collections::HashMap;
struct Parser<'a> {
    input: &'a [u16],
    pos: usize,
}
impl Parser<'_> {
    fn whitespace(&mut self) {
        while self
            .input
            .get(self.pos)
            .is_some_and(|u| matches!(*u, 9 | 10 | 13 | 32))
        {
            self.pos += 1
        }
    }
    fn byte(&mut self) -> Result<u16, ()> {
        let unit = *self.input.get(self.pos).ok_or(())?;
        self.pos += 1;
        Ok(unit)
    }
    fn string(&mut self) -> Result<JsString, ()> {
        if self.byte() != Ok(34) {
            return Err(());
        }
        let mut out = Vec::new();
        loop {
            match self.byte()? {
                34 => return Ok(JsString(out)),
                92 => match self.byte()? {
                    unit @ (34 | 92 | 47) => out.push(unit),
                    98 => out.push(8),
                    102 => out.push(12),
                    110 => out.push(10),
                    114 => out.push(13),
                    116 => out.push(9),
                    117 => {
                        let mut code = 0;
                        for _ in 0..4 {
                            let unit = self.byte()?;
                            let digit = match unit {
                                48..=57 => unit - 48,
                                65..=70 => unit - 65 + 10,
                                97..=102 => unit - 97 + 10,
                                _ => return Err(()),
                            };
                            code = code * 16 + digit
                        }
                        out.push(code)
                    }
                    _ => return Err(()),
                },
                0..=31 => return Err(()),
                unit => out.push(unit),
            }
        }
    }
    fn literal(&mut self, text: &str, value: JsJson) -> Result<Atom, ()> {
        let units: Vec<_> = text.encode_utf16().collect();
        if !self.input[self.pos..].starts_with(&units) {
            return Err(());
        }
        self.pos += units.len();
        Ok(Atom::Value(value))
    }
    fn number(&mut self) -> Result<JsJson, ()> {
        let start = self.pos;
        if self.input.get(self.pos) == Some(&45) {
            self.pos += 1
        }
        match self.byte()? {
            48 => (),
            49..=57 => {
                while self
                    .input
                    .get(self.pos)
                    .is_some_and(|u| (48..=57).contains(u))
                {
                    self.pos += 1
                }
            }
            _ => return Err(()),
        }
        if self.input.get(self.pos) == Some(&46) {
            self.pos += 1;
            let digits = self.pos;
            while self
                .input
                .get(self.pos)
                .is_some_and(|u| (48..=57).contains(u))
            {
                self.pos += 1
            }
            if self.pos == digits {
                return Err(());
            }
        }
        if self
            .input
            .get(self.pos)
            .is_some_and(|u| matches!(*u, 101 | 69))
        {
            self.pos += 1;
            if self
                .input
                .get(self.pos)
                .is_some_and(|u| matches!(*u, 43 | 45))
            {
                self.pos += 1
            }
            let digits = self.pos;
            while self
                .input
                .get(self.pos)
                .is_some_and(|u| (48..=57).contains(u))
            {
                self.pos += 1
            }
            if self.pos == digits {
                return Err(());
            }
        }
        String::from_utf16(&self.input[start..self.pos])
            .map_err(|_| ())?
            .parse::<f64>()
            .map(JsJson::Number)
            .map_err(|_| ())
    }
    fn atom(&mut self) -> Result<Atom, ()> {
        self.whitespace();
        match self.input.get(self.pos).copied().ok_or(())? {
            34 => self.string().map(|s| Atom::Value(JsJson::String(s))),
            110 => self.literal("null", JsJson::Null),
            116 => self.literal("true", JsJson::Bool(true)),
            102 => self.literal("false", JsJson::Bool(false)),
            91 => {
                self.pos += 1;
                Ok(Atom::Array)
            }
            123 => {
                self.pos += 1;
                Ok(Atom::Object)
            }
            45 | 48..=57 => self.number().map(Atom::Value),
            _ => Err(()),
        }
    }
}
enum Atom {
    Value(JsJson),
    Array,
    Object,
}
enum ArrayState {
    First,
    Next,
    After,
}
enum ObjectState {
    First,
    Next,
    Colon,
    Value,
    After,
}
enum Frame {
    Array {
        values: Vec<JsJson>,
        state: ArrayState,
    },
    Object {
        values: Vec<(JsString, JsJson)>,
        positions: HashMap<JsString, usize>,
        key: Option<JsString>,
        state: ObjectState,
    },
}
fn attach(value: JsJson, frames: &mut [Frame], root: &mut Option<JsJson>) -> Result<(), ()> {
    match frames.last_mut() {
        None => {
            if root.is_some() {
                return Err(());
            }
            *root = Some(value)
        }
        Some(Frame::Array { values, state }) => {
            if matches!(state, ArrayState::After) {
                return Err(());
            }
            values.push(value);
            *state = ArrayState::After
        }
        Some(Frame::Object {
            values,
            positions,
            key,
            state,
        }) => {
            if !matches!(state, ObjectState::Value) {
                return Err(());
            }
            let key = key.take().ok_or(())?;
            if let Some(index) = positions.get(&key) {
                values[*index].1 = value
            } else {
                positions.insert(key.clone(), values.len());
                values.push((key, value))
            }
            *state = ObjectState::After
        }
    }
    Ok(())
}
fn finish(frame: Frame) -> JsJson {
    match frame {
        Frame::Array { values, .. } => JsJson::Array(values),
        Frame::Object { mut values, .. } => {
            values.sort_by_key(|(key, _)| array_index(key.units()).unwrap_or(u32::MAX));
            JsJson::Object(values)
        }
    }
}
fn parse_inner(parser: &mut Parser<'_>) -> Result<JsJson, ()> {
    let mut frames = Vec::new();
    let mut root = None;
    let mut value_needed = true;
    loop {
        if value_needed {
            match parser.atom()? {
                Atom::Value(value) => attach(value, &mut frames, &mut root)?,
                Atom::Array => frames.push(Frame::Array {
                    values: Vec::new(),
                    state: ArrayState::First,
                }),
                Atom::Object => frames.push(Frame::Object {
                    values: Vec::new(),
                    positions: HashMap::new(),
                    key: None,
                    state: ObjectState::First,
                }),
            }
            value_needed = false;
            continue;
        }
        parser.whitespace();
        let Some(frame) = frames.last_mut() else {
            return if parser.pos == parser.input.len() {
                root.ok_or(())
            } else {
                Err(())
            };
        };
        let mut closed = false;
        match frame {
            Frame::Array { state, .. } => match state {
                ArrayState::First if parser.input.get(parser.pos) == Some(&93) => {
                    parser.pos += 1;
                    closed = true
                }
                ArrayState::First | ArrayState::Next => value_needed = true,
                ArrayState::After => match parser.byte()? {
                    44 => *state = ArrayState::Next,
                    93 => closed = true,
                    _ => return Err(()),
                },
            },
            Frame::Object { key, state, .. } => match state {
                ObjectState::First if parser.input.get(parser.pos) == Some(&125) => {
                    parser.pos += 1;
                    closed = true
                }
                ObjectState::First | ObjectState::Next => {
                    *key = Some(parser.string()?);
                    *state = ObjectState::Colon
                }
                ObjectState::Colon => {
                    if parser.byte() != Ok(58) {
                        return Err(());
                    }
                    *state = ObjectState::Value
                }
                ObjectState::Value => value_needed = true,
                ObjectState::After => match parser.byte()? {
                    44 => *state = ObjectState::Next,
                    125 => closed = true,
                    _ => return Err(()),
                },
            },
        }
        if closed {
            let value = finish(frames.pop().ok_or(())?);
            attach(value, &mut frames, &mut root)?
        }
    }
}
pub(super) fn parse(input: &[u16]) -> Result<JsJson, JsValueError> {
    let mut parser = Parser { input, pos: 0 };
    parse_inner(&mut parser).map_err(|()| JsValueError::InvalidJson { offset: parser.pos })
}
