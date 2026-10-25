use url::Url;
pub fn validate(value: &str, origin: &Url) -> String {
    let invalid = || "/".to_owned();
    if !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return invalid();
    }
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return invalid();
            }
            let Some(n) = bytes[i + 1]
                .is_ascii_hexdigit()
                .then(|| bytes[i + 2].is_ascii_hexdigit())
                .filter(|b| *b)
                .and_then(|_| std::str::from_utf8(&bytes[i + 1..i + 3]).ok())
                .and_then(|s| u8::from_str_radix(s, 16).ok())
            else {
                return invalid();
            };
            if n < 32 || [b'/', b'\\', b'%', 127].contains(&n) {
                return invalid();
            }
            i += 2;
        }
        i += 1;
    }
    let Ok(url) = origin.join(value) else {
        return invalid();
    };
    if url.origin() != origin.origin()
        || url.fragment().is_some()
        || url.path().starts_with("/auth")
        || url.path().starts_with("/sign-in")
    {
        return invalid();
    }
    value.to_owned()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hostile_returns() {
        let origin = Url::parse("https://example.com").unwrap();
        for v in [
            "//evil.test",
            "https://evil.test",
            "/%2f/evil",
            "/\\evil",
            "/%zz",
            "/%0a",
            "/auth/dev-session",
            "/sign-in",
            "/a#b",
        ] {
            assert_eq!(validate(v, &origin), "/");
        }
        assert_eq!(
            validate("/builds?state=open%20now", &origin),
            "/builds?state=open%20now"
        );
    }
}
