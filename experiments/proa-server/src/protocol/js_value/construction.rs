//! Construction helpers never pass a JavaScript value through a scalar serializer.
use super::{JsJson as J, JsString as S};
pub trait ToJs {
    fn to_js(&self) -> J;
}
impl ToJs for J {
    fn to_js(&self) -> J {
        self.clone()
    }
}
impl ToJs for S {
    fn to_js(&self) -> J {
        J::String(self.clone())
    }
}
impl ToJs for str {
    fn to_js(&self) -> J {
        J::String(S::from(self))
    }
}
impl ToJs for String {
    fn to_js(&self) -> J {
        self.as_str().to_js()
    }
}
impl<T: ToJs + ?Sized> ToJs for &T {
    fn to_js(&self) -> J {
        (**self).to_js()
    }
}
impl ToJs for bool {
    fn to_js(&self) -> J {
        J::Bool(*self)
    }
}
macro_rules! numbers { ($($t:ty),*) => { $(impl ToJs for $t { fn to_js(&self) -> J { J::Number(*self as f64) } })* }; }
numbers!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize, f32, f64);
impl<T: ToJs> ToJs for Option<T> {
    fn to_js(&self) -> J {
        self.as_ref().map(ToJs::to_js).unwrap_or(J::Null)
    }
}
impl<T: ToJs> ToJs for [T] {
    fn to_js(&self) -> J {
        J::Array(self.iter().map(ToJs::to_js).collect())
    }
}
impl<T: ToJs> ToJs for Vec<T> {
    fn to_js(&self) -> J {
        self.as_slice().to_js()
    }
}
impl<T: ToJs, const N: usize> ToJs for [T; N] {
    fn to_js(&self) -> J {
        self.as_slice().to_js()
    }
}
impl<K: Clone + Into<S>, V: ToJs> ToJs for std::collections::BTreeMap<K, V> {
    fn to_js(&self) -> J {
        J::Object(
            self.iter()
                .map(|(k, v)| (k.clone().into(), v.to_js()))
                .collect(),
        )
    }
}
/// JSON-shaped literals with lossless expression leaves. Borrowing leaves also
/// permits references to indexed values without moving out of the owning tree.
#[macro_export]
macro_rules! js_json {
 ({}) => { $crate::protocol::js_value::JsJson::Object(Vec::new()) };
 ([]) => { $crate::protocol::js_value::JsJson::Array(Vec::new()) };
 (null) => { $crate::protocol::js_value::JsJson::Null };
 (true) => { $crate::protocol::js_value::JsJson::Bool(true) };
 (false) => { $crate::protocol::js_value::JsJson::Bool(false) };
 ({$($tokens:tt)*}) => {{ let mut fields = Vec::new(); $crate::js_json!(@object fields; $($tokens)*); $crate::protocol::js_value::JsJson::Object(fields) }};
 ([$($tokens:tt)*]) => {{ let mut values = Vec::new(); $crate::js_json!(@array values; $($tokens)*); $crate::protocol::js_value::JsJson::Array(values) }};
 (@object $out:ident;) => {};
 (@object $out:ident; $key:literal : {$($value:tt)*} $(, $($rest:tt)*)?) => {{ $out.push(($crate::protocol::js_value::JsString::from($key),$crate::js_json!({$($value)*}))); $crate::js_json!(@object $out; $($($rest)*)?); }};
 (@object $out:ident; $key:literal : [$($value:tt)*] $(, $($rest:tt)*)?) => {{ $out.push(($crate::protocol::js_value::JsString::from($key),$crate::js_json!([$($value)*]))); $crate::js_json!(@object $out; $($($rest)*)?); }};
 (@object $out:ident; $key:literal : null $(, $($rest:tt)*)?) => {{ $out.push(($crate::protocol::js_value::JsString::from($key),$crate::js_json!(null))); $crate::js_json!(@object $out; $($($rest)*)?); }};
 (@object $out:ident; $key:literal : $value:expr $(, $($rest:tt)*)?) => {{ $out.push(($crate::protocol::js_value::JsString::from($key),$crate::protocol::js_value::ToJs::to_js(&$value))); $crate::js_json!(@object $out; $($($rest)*)?); }};
 (@array $out:ident;) => {};
 (@array $out:ident; {$($value:tt)*} $(, $($rest:tt)*)?) => {{ $out.push($crate::js_json!({$($value)*})); $crate::js_json!(@array $out; $($($rest)*)?); }};
 (@array $out:ident; [$($value:tt)*] $(, $($rest:tt)*)?) => {{ $out.push($crate::js_json!([$($value)*])); $crate::js_json!(@array $out; $($($rest)*)?); }};
 (@array $out:ident; null $(, $($rest:tt)*)?) => {{ $out.push($crate::js_json!(null)); $crate::js_json!(@array $out; $($($rest)*)?); }};
 (@array $out:ident; $value:expr $(, $($rest:tt)*)?) => {{ $out.push($crate::protocol::js_value::ToJs::to_js(&$value)); $crate::js_json!(@array $out; $($($rest)*)?); }};
 ($value:expr) => { $crate::protocol::js_value::ToJs::to_js(&$value) };
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_literals_preserve_original_units_and_own_property_names() {
        let lone = S::from_units(vec![0xd800]);
        let value =
            js_json!({"__proto__":{"items":[lone, null, true, {"v":2}]},"optional":None::<J>});
        assert_eq!(value["__proto__"]["items"][0].as_string(), Some(&lone));
        assert_eq!(value["optional"], J::Null);
        assert_eq!(
            super::super::parse(value.stringify().as_bytes()).unwrap(),
            value
        );
    }
}
