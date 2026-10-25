//! Producer normalization retains UTF-16 actor, payload and compatibility data.
use super::{
    lossless::{self, concat, j, pretty, received, same, type_issue, unrecognized, ToJs},
    WriteScope,
};
use crate::protocol::js_value::{JsJson as J, JsString as S};
use serde_json::Value as Schema;
use std::sync::OnceLock;
fn fixture() -> &'static Schema {
    static DATA: OnceLock<Schema> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../fixtures/protocol-write-preparation.json"
        ))
        .expect("generated producer policy")
    })
}
fn joined(prefix: &str, text: &S, suffix: &str) -> S {
    concat(&[&S::from(prefix), text, &S::from(suffix)])
}
fn string_field(object: &J, key: &str, path: &[J], issues: &mut Vec<J>) {
    match object.get(key).and_then(J::as_string){Some(s)if s.is_empty()=>issues.push(j!({"origin":"string","code":"too_small","minimum":1_i64,"inclusive":true,"path":path,"message":"Too small: expected string to have >=1 characters"})),Some(_)=>(),None=>issues.push(type_issue("string",object.get(key),path))}
}
fn unknown_keys(object: &J, keys: &[&str], path: &[J], issues: &mut Vec<J>) {
    let extras = object
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, _)| k)
        .filter(|k| !keys.iter().any(|s| k.eq_str(s)))
        .cloned()
        .collect::<Vec<_>>();
    if !extras.is_empty() {
        issues.push(unrecognized(&extras, path))
    }
}
fn discriminator<'a>(
    value: Option<&J>,
    options: &'a [&str],
    path: &[J],
    issues: &mut Vec<J>,
) -> Option<&'a str> {
    let Some(object) = value.filter(|v| v.is_object()) else {
        issues.push(j!({"code":"invalid_type","expected":"object","path":path,"message":format!("Invalid input: expected object, received {}",received(value))}));
        return None;
    };
    if let Some(kind) = options.iter().find(|kind| same(&object["kind"], kind)) {
        return Some(kind);
    }
    let mut p = path.to_vec();
    p.push(j!("kind"));
    let expected = options
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(" | ");
    issues.push(j!({"code":"invalid_union","errors":Vec::<J>::new(),"note":"No matching discriminator","discriminator":"kind","options":options.iter().map(|s|s.to_string()).collect::<Vec<_>>(),"path":p,"message":format!("Invalid discriminator value. Expected {expected}")}));
    None
}
fn actor_issues(actor: Option<&J>) -> Vec<J> {
    let mut issues = vec![];
    let Some(kind) = discriminator(
        actor,
        &["kernel", "agent", "human", "dispatcher", "ingester"],
        &[],
        &mut issues,
    ) else {
        return issues;
    };
    let actor = actor.unwrap();
    let keys: &[&str] = match kind {
        "agent" => {
            string_field(actor, "role", &[j!("role")], &mut issues);
            string_field(actor, "session", &[j!("session")], &mut issues);
            &["kind", "role", "session"]
        }
        "human" => {
            string_field(actor, "user", &[j!("user")], &mut issues);
            if let Some(via) = actor.get("via") {
                if let Some(kind) =
                    discriminator(Some(via), &["session", "mcp"], &[j!("via")], &mut issues)
                {
                    let field = if kind == "session" { "id" } else { "client" };
                    string_field(via, field, &[j!("via"), j!(field)], &mut issues);
                    unknown_keys(via, &["kind", field], &[j!("via")], &mut issues)
                }
            }
            &["kind", "user", "via"]
        }
        "ingester" => {
            string_field(actor, "source", &[j!("source")], &mut issues);
            &["kind", "source"]
        }
        _ => &["kind"],
    };
    unknown_keys(actor, keys, &[], &mut issues);
    issues
}
/// Returns the catalog's scalar type name after exact UTF-16 authority matching.
pub fn validate_actor_type(scope: WriteScope, input: &J) -> Result<&'static str, S> {
    let kind = input["type"]
        .as_string()
        .ok_or_else(|| S::from("event type must be a string"))?;
    let catalog = &super::rules()[scope.name()];
    let Some((known_kind, allowed)) = catalog
        .as_object()
        .unwrap()
        .iter()
        .find(|(k, _)| kind.eq_str(k))
    else {
        let family = match scope {
            WriteScope::Build => "",
            WriteScope::Repository => "repository ",
            WriteScope::Session => "session ",
        };
        let known = catalog
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        return Err(joined(
            &format!("unknown {family}event type \""),
            kind,
            &format!("\" — known types: {known}"),
        ));
    };
    let actor = input.get("actor");
    if actor.is_some_and(|a| a.is_object() && a.get("via").is_some() && !same(&a["kind"], "human"))
    {
        return Err(S::from("only human actors may carry via"));
    }
    let issues = actor_issues(actor);
    if !issues.is_empty() {
        return Err(S::from(format!(
            "invalid actor for \"{known_kind}\": {}",
            pretty(&J::Array(issues), 0)
        )));
    }
    let actor = actor.unwrap();
    if !allowed
        .as_array()
        .unwrap()
        .iter()
        .any(|a| same(&actor["kind"], a.as_str().unwrap()))
    {
        let allowed = allowed
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(joined(
            "actor kind \"",
            actor["kind"].as_string().unwrap(),
            &format!("\" may not emit \"{known_kind}\" (allowed: {allowed})"),
        ));
    }
    Ok(known_kind)
}
fn payload(scope: WriteScope, kind: &str, input: Option<&J>) -> Result<J, S> {
    static PAYLOADS: OnceLock<Schema> = OnceLock::new();
    static SESSIONS: OnceLock<Schema> = OnceLock::new();
    let schema = if matches!(scope, WriteScope::Session) {
        &SESSIONS.get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../fixtures/protocol-session-schemas.json"
            ))
            .unwrap()
        })[kind]
    } else {
        let schemas = PAYLOADS.get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../fixtures/protocol-payload-schemas.json"
            ))
            .unwrap()
        });
        let Some(schema) = schemas["supported"][scope.name()].get(kind) else {
            return Err(S::from(format!(
                "unsupported producer payload schema for \"{kind}\": {}",
                schemas["unsupported"][scope.name()][kind]
                    .as_str()
                    .unwrap_or("unknown payload schema")
            )));
        };
        schema
    };
    let mut issues = vec![];
    let (out, _) = lossless::parse(schema, input, &mut vec![], &mut issues);
    if issues.is_empty() {
        Ok(out.unwrap())
    } else {
        Err(S::from(format!(
            "invalid payload for \"{kind}\": {}",
            pretty(&J::Array(issues), 0)
        )))
    }
}
fn compatibility(scope: WriteScope, kind: &str, supplied: Option<&J>) -> Result<J, S> {
    let classification = fixture()["policies"][scope.name()][kind].as_str().unwrap();
    let Some(supplied) = supplied else {
        return Ok(
            j!({"writerVersion":fixture()["writerVersion"],"classification":classification}),
        );
    };
    let metadata = lossless::validate_schema(&fixture()["compatibilitySchema"], supplied)
        .map_err(|e| joined("invalid compatibility metadata: ", &e, ""))?;
    if !same(&metadata["classification"], classification) {
        return Err(S::from("invalid compatibility metadata: event compatibility classification disagrees with catalog"));
    }
    Ok(metadata)
}
fn escalation(actor: &J, payload: &J) -> Result<(), S> {
    if same(&actor["kind"], "dispatcher")
        && (!same(&payload["source"], "policy")
            || ![
                "infrastructure-failure-limit",
                "dispatch-failure-limit",
                "execution-no-progress",
            ]
            .iter()
            .any(|c| same(&payload["policyCause"], c)))
    {
        return Err(S::from("invalid dispatcher escalation: only policy/infrastructure-failure-limit or policy/dispatch-failure-limit or policy/execution-no-progress may be raised outside the kernel"));
    }
    if same(&payload["source"], "policy") && payload.get("policyCause").is_none() {
        return Err(S::from("invalid payload for \"escalation.raised\": source \"policy\" requires a recognized policyCause"));
    }
    if !same(&payload["source"], "policy") && payload.get("policyCause").is_some() {
        return Err(S::from(format!("invalid payload for \"escalation.raised\": policyCause is only allowed when source is \"policy\", not {}",payload.get("source").map(J::stringify).unwrap_or_else(||"undefined".into()))));
    }
    Ok(())
}
pub fn prepare(scope: WriteScope, input: &J) -> Result<J, S> {
    let kind = validate_actor_type(scope, input)?;
    let payload = payload(scope, kind, input.get("payload"))?;
    if matches!(scope, WriteScope::Build) && kind == "escalation.raised" {
        escalation(&input["actor"], &payload)?
    }
    let mut out = j!({"actor":input["actor"],"type":kind,"payload":payload});
    if !matches!(scope, WriteScope::Session) {
        out["compatibility"] = compatibility(scope, kind, input.get("compatibility"))?
    }
    Ok(out)
}
pub fn prepare_build_write(input: &J) -> Result<J, S> {
    prepare(WriteScope::Build, input)
}
pub fn prepare_repository_write(input: &J) -> Result<J, S> {
    prepare(WriteScope::Repository, input)
}
pub fn prepare_session_write(input: &J) -> Result<J, S> {
    prepare(WriteScope::Session, input)
}
pub fn validate_created_event(input: &J) -> Result<Option<J>, S> {
    let Some(created) = input.get("created") else {
        return Ok(None);
    };
    let out = prepare_build_write(created)?;
    if !same(&out["type"], "build.created") {
        return Err(joined(
            "createBuild's initial event must be \"build.created\", got \"",
            out["type"].as_string().unwrap(),
            "\"",
        ));
    }
    Ok(Some(out))
}
fn js_string(value: &J) -> S {
    match value {
        J::Null => S::from("null"),
        J::Bool(v) => S::from(v.to_string()),
        J::Number(n) => S::from(if n.is_nan() {
            "NaN".into()
        } else if n.is_infinite() {
            if *n < 0.0 {
                "-Infinity".into()
            } else {
                "Infinity".into()
            }
        } else if *n == 0.0 {
            "0".into()
        } else {
            ryu_js::Buffer::new().format_finite(*n).to_owned()
        }),
        J::String(s) => s.clone(),
        J::Array(values) => {
            let mut units = vec![];
            for (i, v) in values.iter().enumerate() {
                if i > 0 {
                    units.push(u16::from(b','))
                }
                if !v.is_null() {
                    units.extend(js_string(v).units())
                }
            }
            S::from_units(units)
        }
        J::Object(_) => S::from("[object Object]"),
    }
}
pub fn validate_expected_seq(value: &J) -> Result<i64, S> {
    if let Some(number) = value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
    {
        return Ok(number as i64);
    }
    Err(joined(
        "expectedSeq must be a nonnegative integer, got ",
        &js_string(value),
        "",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;
    fn old_result(scope: &str, input: &Schema) -> Result<Schema, String> {
        let input = super::super::validate_request("eventWrite", input)
            .map_err(|s| format!("invalid request body: {s}"))?;
        match scope {
            "build" => super::super::writes::prepare_build_write(&input),
            "repository" => super::super::writes::prepare_repository_write(&input),
            "session" => {
                super::super::session::validate_session_write(&input).map(|v| v.to_value())
            }
            _ => unreachable!(),
        }
    }
    #[test]
    fn all_scalar_write_preparation_matches_existing_executable_oracles() {
        let mut text = String::new();
        GzDecoder::new(include_bytes!("../../../fixtures/protocol-writes.json.gz").as_slice())
            .read_to_string(&mut text)
            .unwrap();
        let corpus: Schema = serde_json::from_str(&text).unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert!(cases.len() > 11000);
        for case in cases {
            let scope = case["scope"].as_str().unwrap();
            let input = J::from_serde(&case["input"]);
            let actual = lossless::validate_request("eventWrite", &input)
                .map_err(|e| joined("invalid request body: ", &e, ""))
                .and_then(|input| match scope {
                    "build" => prepare_build_write(&input),
                    "repository" => prepare_repository_write(&input),
                    "session" => prepare_session_write(&input),
                    _ => unreachable!(),
                });
            let expected = old_result(scope, &case["input"])
                .map(|v| J::from_serde(&v))
                .map_err(S::from);
            assert_eq!(actual, expected, "{}", case["id"]);
        }
        for case in fixture()["cases"].as_array().unwrap() {
            let input = J::from_serde(&case["input"]);
            let actual = match case["scope"].as_str().unwrap() {
                "build" => prepare_build_write(&input),
                "repository" => prepare_repository_write(&input),
                "created" => validate_created_event(&input).map(|v| v.unwrap_or(J::Null)),
                "expected-seq" => validate_expected_seq(&input).map(|_| J::Bool(true)),
                _ => unreachable!(),
            };
            let expected = if let Some(message) = case["oracle"]["rejected"]["message"].as_str() {
                Err(S::from(message))
            } else {
                Ok(J::from_serde(&case["oracle"]["accepted"]))
            };
            assert_eq!(
                actual.map(|v| v.to_serde_checked().unwrap()),
                expected.map(|v| v.to_serde_checked().unwrap()),
                "{}",
                case["id"]
            );
        }
    }
    #[test]
    fn unicode_producer_oracles_preserve_actor_metadata_and_error_units() {
        fn canonical(value: J) -> J {
            match &value {
                J::Object(pairs) => {
                    let mut pairs = pairs.clone();
                    pairs.sort_by(|a, b| a.0.cmp(&b.0));
                    J::Object(pairs.into_iter().map(|(k, v)| (k, canonical(v))).collect())
                }
                J::Array(values) => J::Array(values.iter().cloned().map(canonical).collect()),
                _ => value,
            }
        }
        let mut text = String::new();
        GzDecoder::new(
            include_bytes!("../../../fixtures/protocol-unicode-validation.json.gz").as_slice(),
        )
        .read_to_string(&mut text)
        .unwrap();
        let corpus: Schema = serde_json::from_str(&text).unwrap();
        let cases = corpus["writes"].as_array().unwrap();
        assert!(cases.len() > 1000);
        for case in cases {
            let input = J::parse(case["raw"].as_str().unwrap().as_bytes()).unwrap();
            let actual = match case["scope"].as_str().unwrap() {
                "build" => prepare_build_write(&input),
                "repository" => prepare_repository_write(&input),
                "session" => prepare_session_write(&input),
                "created" => validate_created_event(&input).map(|v| v.unwrap_or(J::Null)),
                "expected-seq" => validate_expected_seq(&input).map(|_| J::Bool(true)),
                _ => unreachable!(),
            };
            let actual = actual.map(canonical).map_err(|e| e.quote());
            let expected = if let Some(raw) = case["accepted"].as_str() {
                Ok(canonical(J::parse(raw.as_bytes()).unwrap()))
            } else {
                Err(J::parse(case["rejected"].as_str().unwrap().as_bytes())
                    .unwrap()
                    .as_string()
                    .unwrap()
                    .quote())
            };
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }
    #[test]
    fn actor_values_and_unknown_type_errors_preserve_isolated_units() {
        let input=J::parse(br#"{"actor":{"kind":"human","user":"\ud800"},"type":"build.created","payload":{"message":"x"}}"#).unwrap();
        // Actor validation itself must accept the producer's arbitrary nonempty user.
        assert_eq!(
            validate_actor_type(WriteScope::Build, &input).unwrap(),
            "build.created"
        );
        let input =
            J::parse(br#"{"type":"\ud800","actor":{"kind":"kernel"},"payload":{}}"#).unwrap();
        let error = prepare_build_write(&input).unwrap_err();
        assert!(error.units().contains(&0xd800));
        assert!(!error.units().contains(&0xfffd));
        let bad = J::parse(br#"["\ud800",null,"\udfff"]"#).unwrap();
        let error = validate_expected_seq(&bad).unwrap_err();
        assert!(error.units().contains(&0xd800) && error.units().contains(&0xdfff));
    }
}
