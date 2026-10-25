//! ECMAScript TimeClip and Date.prototype.toISOString over the full Date range.
//! Formatting remains independent of Chrono's narrower representable year range.
use super::error::ProtocolError;
pub fn iso_from_millis(number: f64) -> Result<String, ProtocolError> {
    if !number.is_finite() || number.abs() > 8_640_000_000_000_000.0 {
        return Err(ProtocolError::new(500, "internal", "Invalid Date"));
    }
    let millis = number.trunc() as i64;
    let days = millis.div_euclid(86_400_000);
    let time = millis.rem_euclid(86_400_000);
    // Proleptic Gregorian civil date, with eras anchored at March 1.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    let hour = time / 3_600_000;
    let minute = time / 60_000 % 60;
    let second = time / 1000 % 60;
    let fraction = time % 1000;
    Ok(format!(
        "{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z"
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_date_range_matches_bun_oracle() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-lease-dates.json")).unwrap();
        for row in cases["dates"].as_array().unwrap() {
            let n = row["millis"].as_f64().unwrap();
            let actual = iso_from_millis(n).map_err(|e| e.error);
            let expected = if let Some(s) = row["iso"].as_str() {
                Ok(s.to_owned())
            } else {
                Err(row["error"].as_str().unwrap().to_owned())
            };
            assert_eq!(actual, expected, "{n}");
        }
    }
}
