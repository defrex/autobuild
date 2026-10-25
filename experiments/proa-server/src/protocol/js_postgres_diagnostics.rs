//! Bun JSON.parse grammar diagnostics for persisted JavaScript strings. Values
//! are parsed by the lossless model; this lexer runs only after parsing fails.
use super::js_value::JsString as S;
#[derive(Clone, Copy, PartialEq)]
enum Token {
    String,
    Number,
    Literal,
    Punct(u16),
    Eof,
    Identifier,
}
struct Lexer<'a> {
    input: &'a [u16],
    pos: usize,
    identifier: &'a [u16],
}
fn error(detail: &str) -> S {
    S::from(format!("JSON Parse error: {detail}"))
}
fn inserted(prefix: &str, units: &[u16], suffix: &str) -> S {
    S::from_units(
        prefix
            .encode_utf16()
            .chain(units.iter().copied())
            .chain(suffix.encode_utf16())
            .collect(),
    )
}
fn digit(u: u16) -> bool {
    (48..=57).contains(&u)
}
fn identifier(u: u16) -> bool {
    (65..=90).contains(&u) || (97..=122).contains(&u) || matches!(u, 36 | 95)
}
impl Lexer<'_> {
    fn peek(&self) -> Option<u16> {
        self.input.get(self.pos).copied()
    }
    fn string(&mut self) -> Result<Token, S> {
        self.pos += 1;
        while let Some(u) = self.peek() {
            self.pos += 1;
            match u {
                34 => return Ok(Token::String),
                0..=31 => return Err(error("Unterminated string")),
                92 => {
                    let Some(escape) = self.peek() else {
                        return Err(error("Unterminated string"));
                    };
                    self.pos += 1;
                    match escape {
                        34 | 47 | 92 | 98 | 102 | 110 | 114 | 116 => (),
                        117 => {
                            if self.input.len() - self.pos < 4 {
                                return Err(error("\\u must be followed by 4 hex digits"));
                            }
                            let digits = &self.input[self.pos..self.pos + 4];
                            if !digits.iter().all(|u| {
                                digit(*u) || (65..=70).contains(u) || (97..=102).contains(u)
                            }) {
                                return Err(inserted(
                                    "JSON Parse error: \"",
                                    &self.input[self.pos - 2..self.pos + 4],
                                    "\" is not a valid unicode escape",
                                ));
                            }
                            self.pos += 4;
                        }
                        other => {
                            return Err(inserted(
                                "JSON Parse error: Invalid escape character ",
                                &[other],
                                "",
                            ))
                        }
                    }
                }
                _ => (),
            }
        }
        Err(error("Unterminated string"))
    }
    fn number(&mut self) -> Result<Token, S> {
        if self.peek() == Some(45) {
            self.pos += 1;
        }
        match self.peek() {
            Some(48) => self.pos += 1,
            Some(u) if (49..=57).contains(&u) => {
                self.pos += 1;
                while self.peek().is_some_and(digit) {
                    self.pos += 1;
                }
            }
            _ => return Err(error("Invalid number")),
        }
        if self.peek() == Some(46) {
            self.pos += 1;
            let start = self.pos;
            while self.peek().is_some_and(digit) {
                self.pos += 1;
            }
            if self.pos == start {
                return Err(error("Invalid digits after decimal point"));
            }
        }
        if self.peek().is_some_and(|u| matches!(u, 69 | 101)) {
            let mut end = self.pos + 1;
            if self.input.get(end).is_some_and(|u| matches!(*u, 43 | 45)) {
                end += 1;
            }
            let start = end;
            while self.input.get(end).is_some_and(|u| digit(*u)) {
                end += 1;
            }
            if end > start {
                self.pos = end;
            }
        }
        Ok(Token::Number)
    }
    fn next(&mut self) -> Result<Token, S> {
        while self.peek().is_some_and(|u| matches!(u, 9 | 10 | 13 | 32)) {
            self.pos += 1;
        }
        let Some(u) = self.peek() else {
            return Ok(Token::Eof);
        };
        if u == 39 {
            return Err(error("Single quotes (') are not allowed in JSON"));
        }
        if u == 34 {
            return self.string();
        }
        if u == 45 || digit(u) {
            return self.number();
        }
        if matches!(u, 91 | 93 | 123 | 125 | 58 | 44 | 46 | 61 | 40 | 41 | 59) {
            self.pos += 1;
            return Ok(Token::Punct(u));
        }
        for literal in [b"null".as_slice(), b"true", b"false"] {
            if self.input[self.pos..]
                .iter()
                .zip(literal)
                .all(|(u, b)| *u == u16::from(*b))
                && self.input.len() - self.pos >= literal.len()
            {
                self.pos += literal.len();
                return Ok(Token::Literal);
            }
        }
        if identifier(u) {
            let start = self.pos;
            while self.peek().is_some_and(|u| identifier(u) || digit(u)) {
                self.pos += 1;
            }
            self.identifier = &self.input[start..self.pos];
            return Ok(Token::Identifier);
        }
        Err(inserted(
            "JSON Parse error: Unrecognized token '",
            &[u],
            "'",
        ))
    }
    fn unexpected(&self, token: Token) -> S {
        match token {
            Token::Identifier => inserted(
                "JSON Parse error: Unexpected identifier \"",
                self.identifier,
                "\"",
            ),
            Token::Punct(u) => inserted("JSON Parse error: Unexpected token '", &[u], "'"),
            Token::Eof => error("Unexpected EOF"),
            _ => error("Unable to parse JSON string"),
        }
    }
}
#[derive(Clone, Copy)]
enum Frame {
    ArrayFirst,
    ArrayNext,
    ArrayAfter,
    ObjectFirst,
    ObjectNext,
    ObjectColon,
    ObjectValue,
    ObjectAfter,
}
fn completed(frames: &mut [Frame]) {
    if let Some(frame) = frames.last_mut() {
        *frame = match frame {
            Frame::ArrayFirst | Frame::ArrayNext => Frame::ArrayAfter,
            _ => Frame::ObjectAfter,
        };
    }
}
pub(super) fn parse_error(input: &S) -> S {
    let mut lex = Lexer {
        input: input.units(),
        pos: 0,
        identifier: &[],
    };
    let mut frames = Vec::new();
    let mut root = false;
    loop {
        let token = match lex.next() {
            Ok(t) => t,
            Err(e) => return e,
        };
        let frame = frames.last().copied();
        let needs_value = match frame {
            None if root => return error("Unable to parse JSON string"),
            None => true,
            Some(Frame::ArrayFirst) if token == Token::Punct(93) => {
                frames.pop();
                completed(&mut frames);
                root = true;
                false
            }
            Some(Frame::ArrayFirst | Frame::ObjectValue) => true,
            Some(Frame::ArrayNext) => {
                if token == Token::Punct(93) {
                    return error("Unexpected comma at the end of array expression");
                }
                true
            }
            Some(Frame::ArrayAfter) => {
                match token {
                    Token::Punct(44) => *frames.last_mut().unwrap() = Frame::ArrayNext,
                    Token::Punct(93) => {
                        frames.pop();
                        completed(&mut frames);
                    }
                    _ => return error("Expected ']'"),
                };
                false
            }
            Some(Frame::ObjectFirst | Frame::ObjectNext) => {
                if token == Token::Punct(125) && matches!(frame, Some(Frame::ObjectFirst)) {
                    frames.pop();
                    completed(&mut frames);
                } else if token == Token::String {
                    *frames.last_mut().unwrap() = Frame::ObjectColon;
                } else {
                    return error(if matches!(frame, Some(Frame::ObjectFirst)) {
                        "Expected '}'"
                    } else {
                        "Property name must be a string literal"
                    });
                }
                false
            }
            Some(Frame::ObjectColon) => {
                if token != Token::Punct(58) {
                    return error("Expected ':' before value in object property definition");
                }
                *frames.last_mut().unwrap() = Frame::ObjectValue;
                false
            }
            Some(Frame::ObjectAfter) => {
                match token {
                    Token::Punct(44) => *frames.last_mut().unwrap() = Frame::ObjectNext,
                    Token::Punct(125) => {
                        frames.pop();
                        completed(&mut frames);
                    }
                    _ => return error("Expected '}'"),
                };
                false
            }
        };
        if needs_value {
            match token {
                Token::Punct(91) => {
                    frames.push(Frame::ArrayFirst);
                    root = true;
                }
                Token::Punct(123) => {
                    frames.push(Frame::ObjectFirst);
                    root = true;
                }
                Token::String | Token::Number | Token::Literal => {
                    completed(&mut frames);
                    root = true;
                }
                _ => return lex.unexpected(token),
            }
        }
        // A valid complete document never reaches this diagnostic path, but
        // leave a total fallback for callers that already established failure.
        if frames.is_empty() && root {
            return match lex.next() {
                Err(e) => e,
                Ok(_) => error("Unable to parse JSON string"),
            };
        }
    }
}
