//! Query coercion is deliberately different for cursors and wait budgets.
use super::error::ProtocolError;

fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
pub fn parameter(query: Option<&str>, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}
pub fn int_parameter(query: Option<&str>, name: &str) -> Result<Option<i64>, ProtocolError> {
    let Some(raw) = parameter(query, name) else {
        return Ok(None);
    };
    let text = raw.trim_matches(js_space);
    let number = if text.is_empty() {
        Some(0.0)
    } else if let Some((radix, digits)) = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .map(|s| (16, s))
        .or_else(|| {
            text.strip_prefix("0o")
                .or_else(|| text.strip_prefix("0O"))
                .map(|s| (8, s))
        })
        .or_else(|| {
            text.strip_prefix("0b")
                .or_else(|| text.strip_prefix("0B"))
                .map(|s| (2, s))
        })
    {
        if digits.is_empty() {
            None
        } else {
            digits.chars().try_fold(0.0, |value, digit| {
                digit
                    .to_digit(radix)
                    .map(|digit| value * f64::from(radix) + f64::from(digit))
            })
        }
    } else {
        text.parse::<f64>().ok()
    };
    match number {
        Some(value) if value.is_finite() && value.fract() == 0.0 => Ok(Some(value as i64)),
        _ => Err(ProtocolError::validation(format!(
            "query parameter \"{name}\" must be an integer, got \"{raw}\""
        ))),
    }
}
pub fn wait_parameter(query: Option<&str>) -> Result<u64, ProtocolError> {
    let Some(raw) = parameter(query, "wait") else {
        return Ok(0);
    };
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ProtocolError::validation(format!(
            "query parameter \"wait\" must be a whole number of seconds, got \"{raw}\""
        )));
    }
    Ok(raw.parse::<u64>().unwrap_or(u64::MAX).min(30))
}
/// Fetch Headers exposes HTTP field bytes as Latin1 and joins repeated fields.
/// UTF8 decoding or taking only the first field changes credential semantics.
pub fn header_text(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| {
            value
                .as_bytes()
                .iter()
                .map(|byte| char::from(*byte))
                .collect()
        })
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_uses_number_coercion_while_wait_requires_digits() {
        for (raw, number) in [
            ("", 0),
            ("%20", 0),
            ("0x10", 16),
            ("0o10", 8),
            ("0b10", 2),
            ("1e2", 100),
            ("-2", -2),
            ("%2B2", 2),
            ("2.0", 2),
        ] {
            assert_eq!(
                int_parameter(Some(&format!("since={raw}")), "since").unwrap(),
                Some(number)
            );
        }
        for raw in ["", "%20", "0x10", "+2", "1.0", "-1", "%D9%A1"] {
            assert!(wait_parameter(Some(&format!("wait={raw}"))).is_err());
        }
        assert_eq!(
            wait_parameter(Some("wait=9999999999999999999999999999")).unwrap(),
            30
        );
        assert_eq!(wait_parameter(Some("wait=0001")).unwrap(), 1);
        for raw in ["NaN", "Infinity", "0x", "1.1"] {
            assert!(int_parameter(Some(&format!("since={raw}")), "since").is_err());
        }
    }
}
