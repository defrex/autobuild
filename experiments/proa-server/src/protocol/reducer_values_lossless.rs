//! Catalog validation retains JavaScript keys and arguments until an executable
//! kernel explicitly consumes them. No replacement identity or sentinel aliases.
use super::*;
use crate::protocol::{
    js_value::{JsJson as J, JsString as S},
    validation::lossless,
};
fn obj(fields: Vec<(&str, J)>) -> J {
    J::Object(fields.into_iter().map(|(k, v)| (S::from(k), v)).collect())
}
fn text(v: impl Into<S>) -> J {
    J::String(v.into())
}
fn format_js(template: &str, values: &[&S]) -> S {
    let mut units = Vec::new();
    let mut parts = template.split("{}");
    units.extend(parts.next().unwrap().encode_utf16());
    for (part, value) in parts.zip(values) {
        units.extend(value.units());
        units.extend(part.encode_utf16());
    }
    S::from_units(units)
}
fn pretty(value: &J, depth: usize) -> String {
    let indent = "  ".repeat(depth);
    let child = "  ".repeat(depth + 1);
    match value {
        J::Array(items) if !items.is_empty() => format!(
            "[\n{}\n{indent}]",
            items
                .iter()
                .map(|v| format!("{child}{}", pretty(v, depth + 1)))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        J::Object(items) if !items.is_empty() => format!(
            "{{\n{}\n{indent}}}",
            items
                .iter()
                .map(|(k, v)| format!("{child}{}: {}", k.quote(), pretty(v, depth + 1)))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        _ => value.stringify(),
    }
}
pub fn parse_reducer_request_lossless(bytes: &[u8]) -> Result<J, ProtocolError> {
    let decoded = crate::protocol::js_value::decode_http_utf8(bytes);
    if decoded.len() > REDUCER_REQUEST_MAX_BYTES {
        return Err(ProtocolError::new(
            413,
            "validation",
            "reducer request exceeds 4 KiB",
        ));
    }
    crate::protocol::js_value::parse(decoded.as_bytes()).map_err(|_| {
        // Retain the existing Bun grammar diagnostic corpus. Successful lossless
        // values never pass through the scalar parser or a serde value bridge.
        parse_reducer_request(
            crate::protocol::js_value::grammar_diagnostic_text(&decoded).as_bytes(),
        )
        .err()
        .unwrap_or_else(|| error("SyntaxError: JSON Parse error: Unable to parse JSON string"))
    })
}
#[derive(Debug)]
pub struct ResolvedReducerLossless {
    pub name: String,
    pub args: J,
    pub version: i64,
}
fn type_issue_js(expected: &str, value: &J) -> J {
    let received = match value {
        J::Null => "null",
        J::Bool(_) => "boolean",
        J::Number(_) => "number",
        J::String(_) => "string",
        J::Array(_) => "array",
        J::Object(_) => "object",
    };
    let mut fields = vec![("expected", text(expected)), ("code", text("invalid_type"))];
    if expected == "number" && value.as_f64().is_some_and(|n| !n.is_finite()) {
        fields.push(("received", text("Infinity")));
    }
    fields.push(("path", J::Array(vec![])));
    fields.push((
        "message",
        text(format!(
            "Invalid input: expected {expected}, received {received}"
        )),
    ));
    obj(fields)
}
fn json_issue_js(value: &J, path: Vec<J>) -> Option<J> {
    let valid = match value {
        J::Number(n) => n.is_finite(),
        J::Array(v) => v.iter().all(|v| json_issue_js(v, vec![]).is_none()),
        J::Object(v) => v
            .iter()
            .filter(|(k, _)| !k.eq_str("__proto__"))
            .all(|(_, v)| json_issue_js(v, vec![]).is_none()),
        _ => true,
    };
    if valid {
        return None;
    }
    let mut branches: Vec<J> = ["string", "number", "boolean", "null"]
        .iter()
        .map(|k| J::Array(vec![type_issue_js(k, value)]))
        .collect();
    branches.push(if let Some(items) = value.as_array() {
        J::Array(
            items
                .iter()
                .enumerate()
                .filter_map(|(i, v)| json_issue_js(v, vec![J::Number(i as f64)]))
                .collect(),
        )
    } else {
        J::Array(vec![type_issue_js("array", value)])
    });
    branches.push(if let Some(items) = value.as_object() {
        J::Array(
            items
                .iter()
                .filter(|(k, _)| !k.eq_str("__proto__"))
                .filter_map(|(k, v)| json_issue_js(v, vec![text(k.clone())]))
                .collect(),
        )
    } else {
        J::Array(vec![type_issue_js("record", value)])
    });
    Some(obj(vec![
        ("code", text("invalid_union")),
        ("errors", J::Array(branches)),
        ("path", J::Array(path)),
        ("message", text("Invalid input")),
    ]))
}
pub fn resolve_lossless(
    scope: Scope<'_>,
    input: &J,
) -> Result<ResolvedReducerLossless, ProtocolError> {
    let parsed = lossless::validate_schema(&catalog()["request"], input);
    let mut issues = match &parsed {
        Ok(_) => vec![],
        Err(message) => crate::protocol::js_value::parse(
            message
                .to_scalar()
                .map_err(|_| ProtocolError::internal())?
                .as_bytes(),
        )
        .map_err(|_| ProtocolError::internal())?
        .as_array()
        .unwrap()
        .clone(),
    };
    if let Some(args) = input.get("args").and_then(J::as_object) {
        let more: Vec<_> = args
            .iter()
            .filter(|(k, _)| !k.eq_str("__proto__"))
            .filter_map(|(k, v)| json_issue_js(v, vec![text("args"), text(k.clone())]))
            .collect();
        let at = issues
            .iter()
            .position(|v| {
                v["code"]
                    .as_string()
                    .is_some_and(|v| v.eq_str("unrecognized_keys"))
                    && v["path"].as_array().is_some_and(Vec::is_empty)
            })
            .unwrap_or(issues.len());
        issues.splice(at..at, more);
    }
    if !issues.is_empty() {
        return Err(ProtocolError::validation_js(S::from(pretty(
            &J::Array(issues),
            0,
        ))));
    }
    let parsed = parsed.unwrap();
    let name = parsed["reducer"].as_string().unwrap();
    let scalar = name.to_scalar().ok();
    let entry = scalar
        .as_deref()
        .and_then(|n| catalog()["catalog"].get(n))
        .ok_or_else(|| {
            ProtocolError::validation_js(format_js("Error: unknown reducer \"{}\"", &[name]))
        })?;
    if let Some(reason) = entry["excluded"].as_str() {
        return Err(ProtocolError::validation_js(format_js(
            "Error: excluded reducer \"{}\": {}",
            &[name, &S::from(reason)],
        )));
    }
    let expected = if matches!(scope, Scope::Repo(_)) {
        "repo"
    } else {
        "build"
    };
    if entry["scope"] != expected {
        return Err(ProtocolError::validation_js(format_js(
            "Error: wrong scope for reducer \"{}\"",
            &[name],
        )));
    }
    let empty = J::Object(vec![]);
    let args = lossless::validate_schema(&entry["args"], parsed.get("args").unwrap_or(&empty))
        .map_err(ProtocolError::validation_js)?;
    Ok(ResolvedReducerLossless {
        name: scalar.unwrap(),
        args,
        version: entry["version"].as_i64().unwrap(),
    })
}
pub fn reduce_lossless(
    scope: Scope<'_>,
    resolved: &ResolvedReducerLossless,
    raw: &[Value],
) -> Result<J, ProtocolError> {
    if let Ok(args) = resolved.args.to_serde_checked() {
        return reduce(
            scope,
            &ResolvedReducer {
                name: resolved.name.clone(),
                args: serializable(args),
                version: resolved.version,
            },
            raw,
        )
        .map(|v| J::from_serde(&serializable(v)));
    }
    let (events, _unknown) = projected(scope, raw)?;
    match resolved.name.as_str() {
        "dispatchStatus" => {
            let run = &resolved.args["run"];
            // Direct JSONB event strings cannot contain isolated UTF-16 units. Compare
            // original code units anyway, so a replacement-valued run never matches.
            if events
                .iter()
                .any(|e| J::from_serde(&e["payload"]["run"]) == *run)
            {
                return Err(ProtocolError::internal());
            }
            Ok(obj(vec![
                ("run", run.clone()),
                ("health", text("starting")),
                ("roleWarnings", J::Array(vec![])),
                ("diagnostics", J::Array(vec![])),
                ("lastSeq", J::Number(0.0)),
            ]))
        }
        "dispatcherRunFacts" | "openTick" => {
            let run = &resolved.args["run"];
            if events
                .iter()
                .any(|e| J::from_serde(&e["payload"]["run"]) == *run)
            {
                return Err(ProtocolError::internal());
            }
            Ok(if resolved.name == "openTick" {
                J::Bool(false)
            } else {
                J::Object(vec![])
            })
        }
        "phaseFailures" => {
            let phase = &resolved.args["phase"];
            if events
                .iter()
                .any(|e| J::from_serde(&e["payload"]["phase"]) == *phase)
            {
                return Err(ProtocolError::internal());
            }
            Ok(obj(vec![("count", J::Number(0.0))]))
        }
        "terminalGuard" => terminal_guard_lossless(&resolved.args, &events),
        _ => Err(ProtocolError::internal()),
    }
}
fn eq_string(value: &Value, wanted: &S) -> bool {
    value.as_str().is_some_and(|v| wanted.eq_str(v))
}
fn terminal_guard_lossless(args: &J, events: &[Value]) -> Result<J, ProtocolError> {
    let phase = args["phase"]
        .as_string()
        .ok_or_else(ProtocolError::internal)?;
    let session = args["session"]
        .as_string()
        .ok_or_else(ProtocolError::internal)?;
    let round = &args["round"];
    let verify = phase.units().starts_with(&S::from("verify:").0);
    let scalar_phase = phase.to_scalar().ok();
    let phase_name = if verify {
        "verify"
    } else {
        scalar_phase
            .as_deref()
            .ok_or_else(ProtocolError::internal)?
    };
    let terminal = catalog()["terminalEvents"][phase_name]
        .as_str()
        .ok_or_else(ProtocolError::internal)?;
    let mut reconcile = 0;
    let mut started = None;
    let mut permanent = None;
    let mut completion = None;
    for e in events {
        let t = e["type"].as_str().unwrap();
        let p = &e["payload"];
        let sequence = seq(e);
        if t == "spec.revised" && (verify || phase.eq_str("finalize")) {
            completion = None;
        }
        if t == "reconcile.started" {
            reconcile = p["attempt"].as_i64().unwrap_or(0);
        }
        if t == "session.started" && eq_string(&p["session"], session) {
            started = Some(sequence);
        }
        let round_matches = J::from_serde(&p["round"]) == *round;
        let diagnostic = if t == "session.started"
            && eq_string(&p["continuation"]["predecessor"], session)
        {
            Some(format_js(
                "terminal rejected (D5): session \"{}\" was superseded by continuation {}",
                &[session, &S::from(p["session"].as_str().unwrap())],
            ))
        } else if matches!(t, "session.ended" | "session.suspended")
            && eq_string(&p["session"], session)
        {
            Some(format_js(&format!("terminal rejected (D5): session \"{{}}\" already {} ({t} at seq {sequence}) — a session that ended without a terminal was failed and retried; only the live retry may complete this phase round (§8.4).",if t=="session.suspended"{"suspended"}else{"ended"}),&[session]))
        } else if t == "phase.failed"
            && eq_string(&p["phase"], phase)
            && round_matches
            && started.is_some_and(|start| sequence > start)
        {
            Some(format_js(&format!("terminal rejected (D5): {{}}@{} already failed after this session started (phase.failed at seq {sequence}) — the retry session owns this round now (§8.4).",round.stringify()),&[phase]))
        } else if t == "escalation.raised"
            && e["actor"]["kind"] == "agent"
            && eq_string(&e["actor"]["session"], session)
        {
            Some(S::from(format!("second terminal call rejected (D5): this session already escalated — escalation.raised \"{}\" at seq {sequence}. Every phase ends with exactly one terminal command (§8.4).",p["id"].as_str().unwrap())))
        } else if t == "publication.requested"
            && e["actor"]["kind"] == "agent"
            && eq_string(&e["actor"]["session"], session)
            && ((phase.eq_str("implement") && p["operation"] == "implement" && round_matches)
                || (phase.eq_str("reconcile") && p["operation"] == "reconcile")
                || (phase.eq_str("finalize") && p["operation"] == "finalize"))
        {
            Some(format_js(&format!("second terminal call rejected (D5): {t} for {{}}@{} already recorded at seq {sequence}. Remote publication is pending; do not run ab done again (§8.4).",round.stringify()),&[phase]))
        } else if t == terminal
            && match t {
                "plan.completed"
                | "plan-review.verdict"
                | "implement.completed"
                | "code-review.verdict" => round_matches,
                "verify.completed" => {
                    phase.eq_str(&format!("verify:{}", p["step"].as_str().unwrap()))
                        && J::from_serde(&p["attempt"]) == *round
                }
                "finalize.completed" => true,
                "reconcile.completed" => {
                    reconcile == 0 || reconcile as f64 == round.as_f64().unwrap_or(0.0)
                }
                _ => false,
            }
        {
            Some(format_js(&format!("second terminal call rejected (D5): {t} for {{}}@{} already recorded at seq {sequence}. Every phase ends with exactly one terminal command (§8.4).",round.stringify()),&[phase]))
        } else {
            None
        };
        if let Some(diagnostic) = diagnostic {
            let target = if t == terminal {
                &mut completion
            } else {
                &mut permanent
            };
            if target.is_none() {
                *target = Some((sequence, diagnostic));
            }
        }
    }
    Ok(permanent
        .into_iter()
        .chain(completion)
        .min_by_key(|(seq, _)| *seq)
        .map(|(_, diagnostic)| obj(vec![("diagnostic", text(diagnostic))]))
        .unwrap_or_else(|| J::Object(vec![])))
}
impl Store {
    pub async fn get_reducer_value_lossless(
        &self,
        scope: Scope<'_>,
        request: &J,
    ) -> Result<J, ProtocolError> {
        let resolved = resolve_lossless(scope, request)?;
        let mut client = self.database.client().await?;
        let tx = client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        if tx
            .query_opt(
                &format!("SELECT 1 FROM {} WHERE {}=$1", scope.table(), scope.key()),
                &[&scope.id()],
            )
            .await?
            .is_none()
        {
            return Err(ProtocolError::missing(scope.name(), scope.id()));
        }
        let rows = tx
            .query(
                &format!(
                    "SELECT * FROM {} WHERE {}=$1 ORDER BY seq",
                    scope.events(),
                    scope.event_key()
                ),
                &[&scope.id()],
            )
            .await?;
        let events = rows
            .iter()
            .map(|row| event_record(row, scope))
            .collect::<Result<Vec<_>, _>>()?;
        let mut cursor = 0;
        for event in &events {
            if seq(event) != cursor + 1 {
                return Err(ProtocolError::new(
                    500,
                    "internal",
                    "noncontiguous reducer log",
                ));
            }
            cursor += 1;
        }
        let value = reduce_lossless(scope, &resolved, &events)?;
        tx.commit().await?;
        Ok(obj(vec![
            ("version", J::Number(resolved.version as f64)),
            ("cursor", J::Number(cursor as f64)),
            ("value", value),
            (
                "catalogIdentity",
                text(ServiceIdentity::current().catalog_identity.clone()),
            ),
        ]))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn unordered(value: &J) -> J {
        match value {
            J::Object(v) => {
                let mut v: Vec<_> = v.iter().map(|(k, v)| (k.clone(), unordered(v))).collect();
                v.sort_by(|a, b| a.0.cmp(&b.0));
                J::Object(v)
            }
            J::Array(v) => J::Array(v.iter().map(unordered).collect()),
            v => v.clone(),
        }
    }
    #[test]
    fn unicode_catalog_arguments_and_replay_match_independent_source() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-reducer-unicode.json"))
                .unwrap();
        for row in fixture["syntax"].as_array().unwrap() {
            let error = parse_reducer_request_lossless(row["input"].as_str().unwrap().as_bytes())
                .unwrap_err();
            let expected: Vec<u16> = row["expectedUnits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect();
            assert_eq!(error.message_js().units(), expected, "{}", row["input"]);
        }
        for row in fixture["cases"].as_array().unwrap() {
            let scope = if row["scope"] == "repo" {
                Scope::Repo("fixture")
            } else {
                Scope::Build("fixture")
            };
            let input =
                parse_reducer_request_lossless(row["input"].as_str().unwrap().as_bytes()).unwrap();
            let actual = match resolve_lossless(scope, &input) {
                Ok(v) => obj(vec![(
                    "accepted",
                    obj(vec![
                        ("name", text(v.name)),
                        ("args", v.args),
                        ("version", J::Number(v.version as f64)),
                    ]),
                )]),
                Err(e) => obj(vec![("rejected", text(e.message_js()))]),
            };
            let expected: String = String::from_utf16(
                &row["expectedUnits"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            let expected = crate::protocol::js_value::parse(expected.as_bytes()).unwrap();
            assert_eq!(unordered(&actual), unordered(&expected), "{}", row["name"]);
        }
        for row in fixture["replay"].as_array().unwrap() {
            let scope = if row["scope"] == "repo" {
                Scope::Repo("fixture")
            } else {
                Scope::Build("fixture")
            };
            let input =
                parse_reducer_request_lossless(row["input"].as_str().unwrap().as_bytes()).unwrap();
            let resolved = resolve_lossless(scope, &input).unwrap();
            let value =
                reduce_lossless(scope, &resolved, row["events"].as_array().unwrap()).unwrap();
            let expected: Vec<u16> = row["valueUnits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect();
            let expected =
                crate::protocol::js_value::parse(String::from_utf16(&expected).unwrap().as_bytes())
                    .unwrap();
            assert_eq!(unordered(&value), unordered(&expected), "{}", row["name"]);
        }
    }
    #[test]
    fn every_existing_scalar_validation_and_replay_oracle_remains_unchanged() {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(
            include_bytes!("../../fixtures/protocol-reducers.json.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .unwrap();
        let fixture: Value = serde_json::from_slice(&bytes).unwrap();
        for row in fixture["validation"].as_array().unwrap() {
            let scope = if row["scope"] == "repo" {
                Scope::Repo("fixture")
            } else {
                Scope::Build("fixture")
            };
            let actual =
                match parse_reducer_request_lossless(row["raw"].as_str().unwrap().as_bytes())
                    .and_then(|input| resolve_lossless(scope, &input))
                {
                    Ok(r) => json!({"name":r.name,"version":r.version}),
                    Err(e) => json!(e.error),
                };
            assert_eq!(
                actual,
                row.get("accepted")
                    .or_else(|| row.get("rejected"))
                    .unwrap()
                    .clone(),
                "{} {}",
                row["scope"],
                row["raw"]
            );
        }
        for row in fixture["replay"].as_array().unwrap() {
            let scope = if row["scope"] == "repo" {
                Scope::Repo("fixture")
            } else {
                Scope::Build("fixture")
            };
            let request = J::from_serde(&json!({"reducer":row["name"],"args":row["args"]}));
            let resolved = resolve_lossless(scope, &request).unwrap();
            let value =
                reduce_lossless(scope, &resolved, row["events"].as_array().unwrap()).unwrap();
            assert_eq!(
                serializable(value.to_serde_checked().unwrap()),
                row["value"],
                "{}",
                row["id"]
            );
        }
    }
}
