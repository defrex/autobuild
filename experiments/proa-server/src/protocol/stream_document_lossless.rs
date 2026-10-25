//! Lossless native AI UI-message assembly; source SDK remains a fixture oracle.
use crate::protocol::js_value::{parse_js_string, JsJson as Value, JsString};
use std::collections::HashMap;
trait ToJs {
    fn js(&self) -> Value;
}
impl ToJs for Value {
    fn js(&self) -> Value {
        self.clone()
    }
}
impl ToJs for JsString {
    fn js(&self) -> Value {
        Value::String(self.clone())
    }
}
impl ToJs for str {
    fn js(&self) -> Value {
        Value::String(JsString::from(self))
    }
}
impl ToJs for String {
    fn js(&self) -> Value {
        self.as_str().js()
    }
}
impl<T: ToJs + ?Sized> ToJs for &T {
    fn js(&self) -> Value {
        (*self).js()
    }
}
impl ToJs for bool {
    fn js(&self) -> Value {
        Value::Bool(*self)
    }
}
impl ToJs for usize {
    fn js(&self) -> Value {
        Value::Number(*self as f64)
    }
}
macro_rules! j {({$($key:literal:$value:expr),*$(,)?})=>{Value::Object(vec![$((JsString::from($key),ToJs::js(&$value))),*])};($value:expr)=>{ToJs::js(&$value)}}
fn some(value: impl ToJs) -> Option<Value> {
    Some(value.js())
}
fn scalar(value: &Value) -> Option<String> {
    value.as_string()?.to_scalar().ok()
}
fn starts(value: &JsString, prefix: &str) -> bool {
    value
        .units()
        .starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
}
fn concat(parts: &[&JsString]) -> JsString {
    JsString::from_units(
        parts
            .iter()
            .flat_map(|s| s.units().iter().copied())
            .collect(),
    )
}
#[derive(Clone, Debug)]
pub struct Assembly {
    pub document: Value,
    pub dropped_part_count: usize,
}
#[derive(Clone, Default)]
struct Part(Vec<(JsString, Option<Value>)>);
impl Part {
    fn new(fields: &[(&str, Option<Value>)]) -> Self {
        Self(
            fields
                .iter()
                .map(|(k, v)| (JsString::from(*k), v.clone()))
                .collect(),
        )
    }
    fn set(&mut self, key: &str, value: Option<Value>) {
        if let Some((_, old)) = self.0.iter_mut().find(|(k, _)| k.eq_str(key)) {
            *old = value
        } else {
            self.0.push((JsString::from(key), value))
        }
    }
    fn set_fragment(&mut self, key: &str, value: Value) {
        self.set(key, Some(value))
    }
    fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(k, _)| k.eq_str(key))
            .and_then(|(_, v)| v.as_ref())
    }
    fn value(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .filter_map(|(k, v)| v.clone().map(|v| (k.clone(), v)))
                .collect(),
        )
    }
}
fn string(value: &Value, key: &str) -> Option<Value> {
    value.get(key).cloned()
}
fn json_value(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.is_finite(),
        Value::Array(a) => a.iter().all(json_value),
        Value::Object(o) => o.iter().map(|(_, v)| v).all(json_value),
        _ => true,
    }
}
fn fields(
    part: &Value,
    required: &[&str],
    optional_strings: &[&str],
    optional_bools: &[&str],
) -> bool {
    required
        .iter()
        .all(|k| part.get(k).is_some_and(Value::is_string))
        && optional_strings
            .iter()
            .all(|k| part.get(k).is_none_or(Value::is_string))
        && optional_bools
            .iter()
            .all(|k| part.get(k).is_none_or(Value::is_boolean))
}
fn provider(part: &Value) -> bool {
    part.get("providerMetadata").is_none_or(|v| {
        v.as_object().is_some_and(|o| {
            o.iter().map(|(_, v)| v).all(|v| {
                v.as_object()
                    .is_some_and(|o| o.iter().map(|(_, v)| v).all(json_value))
            })
        })
    })
}
fn tool_metadata(part: &Value) -> bool {
    part.get("toolMetadata").is_none_or(|v| {
        v.as_object()
            .is_some_and(|o| o.iter().map(|(_, v)| v).all(json_value))
    })
}
/// Classification checks the SDK's loose union; extra properties survive.
pub fn is_defined_part(part: &Value) -> bool {
    let Some(kind_value) = part["type"].as_string() else {
        return false;
    };
    if starts(kind_value, "data-") {
        return fields(part, &[], &["id"], &["transient"]) && part.get("data").is_some();
    }
    let Ok(kind) = kind_value.to_scalar() else {
        return false;
    };
    let kind = kind.as_str();
    match kind {
        "text-start" | "text-end" | "reasoning-start" | "reasoning-end" => {
            fields(part, &["id"], &[], &[]) && provider(part)
        }
        "text-delta" | "reasoning-delta" => {
            fields(part, &["id", "delta"], &[], &[]) && provider(part)
        }
        "error" => fields(part, &["errorText"], &[], &[]),
        "tool-input-start" => {
            fields(
                part,
                &["toolCallId", "toolName"],
                &["title"],
                &["providerExecuted", "dynamic"],
            ) && provider(part)
                && tool_metadata(part)
        }
        "tool-input-delta" => fields(part, &["toolCallId", "inputTextDelta"], &[], &[]),
        "tool-input-available" | "tool-input-error" => {
            fields(
                part,
                if kind == "tool-input-error" {
                    &["toolCallId", "toolName", "errorText"]
                } else {
                    &["toolCallId", "toolName"]
                },
                &["title"],
                &["providerExecuted", "dynamic"],
            ) && part.get("input").is_some()
                && provider(part)
                && tool_metadata(part)
        }
        "tool-output-available" => {
            fields(
                part,
                &["toolCallId"],
                &[],
                &["providerExecuted", "dynamic", "preliminary"],
            ) && part.get("output").is_some()
                && provider(part)
                && tool_metadata(part)
        }
        "tool-output-error" => {
            fields(
                part,
                &["toolCallId", "errorText"],
                &[],
                &["providerExecuted", "dynamic"],
            ) && provider(part)
                && tool_metadata(part)
        }
        "tool-output-denied" => fields(part, &["toolCallId"], &[], &[]),
        "tool-approval-request" => fields(
            part,
            &["approvalId", "toolCallId"],
            &["reason", "signature"],
            &["isAutomatic"],
        ),
        "tool-approval-response" => {
            fields(part, &["approvalId"], &["reason"], &["providerExecuted"])
                && part.get("approved").is_some_and(Value::is_boolean)
                && provider(part)
        }
        "custom" => fields(part, &["kind"], &[], &[]) && provider(part),
        "file" | "reasoning-file" => {
            fields(part, &["url", "mediaType"], &[], &[]) && provider(part)
        }
        "source-url" => fields(part, &["sourceId", "url"], &["title"], &[]) && provider(part),
        "source-document" => {
            fields(
                part,
                &["sourceId", "mediaType", "title"],
                &["filename"],
                &[],
            ) && provider(part)
        }
        "start-step" | "finish-step" | "reset-step" => true,
        "start" => fields(part, &[], &["messageId"], &[]),
        "finish" => part.get("finishReason").is_none_or(|v| {
            scalar(v).as_deref().is_some_and(|v| {
                matches!(
                    v,
                    "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"
                )
            })
        }),
        "abort" => fields(part, &[], &["reason"], &[]),
        "message-metadata" => part.get("messageMetadata").is_some(),
        data if data.starts_with("data-") => {
            fields(part, &[], &["id"], &["transient"]) && part.get("data").is_some()
        }
        _ => false,
    }
}
#[derive(Default)]
struct State {
    failed: bool,
    id: JsString,
    metadata: Option<Value>,
    parts: Vec<Part>,
    text: HashMap<JsString, usize>,
    reasoning: HashMap<JsString, usize>,
    partial: HashMap<JsString, Partial>,
    last: Option<Value>,
}
#[derive(Clone)]
struct Partial {
    text: JsString,
    name: Value,
    dynamic: bool,
    title: Option<Value>,
    metadata: Option<Value>,
}
fn is_tool(part: &Part) -> bool {
    part.get("type")
        .and_then(Value::as_string)
        .is_some_and(|s| starts(s, "tool-") || s.eq_ascii("dynamic-tool"))
}
impl State {
    fn write(&mut self) {
        let mut fields = vec![(JsString::from("id"), Value::String(self.id.clone()))];
        if let Some(metadata) = &self.metadata {
            fields.push((JsString::from("metadata"), metadata.clone()))
        }
        fields.push((
            JsString::from("role"),
            Value::String(JsString::from("assistant")),
        ));
        fields.push((
            JsString::from("parts"),
            Value::Array(self.parts.iter().map(Part::value).collect()),
        ));
        self.last = Some(Value::Object(fields));
    }
    fn step_start(&self) -> usize {
        self.parts
            .iter()
            .rposition(|p| p.get("type") == Some(&j!("step-start")))
            .map_or(0, |i| i + 1)
    }
    fn tool(&self, id: &Value) -> Option<usize> {
        (self.step_start()..self.parts.len())
            .find(|&i| is_tool(&self.parts[i]) && self.parts[i].get("toolCallId") == Some(id))
            .or_else(|| {
                (0..self.parts.len()).rev().find(|&i| {
                    is_tool(&self.parts[i]) && self.parts[i].get("toolCallId") == Some(id)
                })
            })
    }
    fn update_tool(&mut self, options: &Value, dynamic: bool, existing: Option<usize>) {
        let id = &options["toolCallId"];
        let index = existing.or_else(|| {
            (self.step_start()..self.parts.len()).find(|&i| {
                self.parts[i].get("toolCallId") == Some(id)
                    && self.parts[i]
                        .get("type")
                        .and_then(Value::as_string)
                        .is_some_and(|kind| {
                            if dynamic {
                                kind.eq_ascii("dynamic-tool")
                            } else {
                                starts(kind, "tool-")
                            }
                        })
            })
        });
        if let Some(index) = index {
            let p = &mut self.parts[index];
            p.set("state", string(options, "state"));
            if dynamic {
                p.set("toolName", string(options, "toolName"));
            }
            for key in ["input", "output", "errorText"] {
                p.set(key, string(options, key));
            }
            if dynamic {
                let raw = options
                    .get("rawInput")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .or_else(|| p.get("rawInput").cloned());
                p.set("rawInput", raw);
            } else {
                p.set("rawInput", string(options, "rawInput"));
            }
            p.set("preliminary", string(options, "preliminary"));
            for key in ["title", "toolMetadata"] {
                if options.get(key).is_some() {
                    p.set(key, string(options, key));
                }
            }
            if options.get("providerExecuted").is_some() {
                p.set("providerExecuted", string(options, "providerExecuted"));
            }
            if let Some(metadata) = options.get("providerMetadata").filter(|v| !v.is_null()) {
                p.set(
                    if matches!(
                        scalar(&options["state"]).as_deref(),
                        Some("output-available" | "output-error")
                    ) {
                        "resultProviderMetadata"
                    } else {
                        "callProviderMetadata"
                    },
                    Some(metadata.clone()),
                );
            }
        } else {
            let mut p = if dynamic {
                Part::new(&[
                    ("type", some("dynamic-tool")),
                    ("toolName", string(options, "toolName")),
                    ("toolCallId", Some(id.clone())),
                    ("state", string(options, "state")),
                    ("input", string(options, "input")),
                    ("output", string(options, "output")),
                    ("errorText", string(options, "errorText")),
                    ("preliminary", string(options, "preliminary")),
                    ("providerExecuted", string(options, "providerExecuted")),
                    ("title", string(options, "title")),
                ])
            } else {
                Part::new(&[
                    (
                        "type",
                        some(concat(&[
                            &JsString::from("tool-"),
                            options["toolName"].as_string().unwrap(),
                        ])),
                    ),
                    ("toolCallId", Some(id.clone())),
                    ("state", string(options, "state")),
                    ("title", string(options, "title")),
                ])
            };
            if let Some(metadata) = options.get("toolMetadata") {
                p.set("toolMetadata", Some(metadata.clone()));
            }
            if !dynamic {
                for key in [
                    "input",
                    "output",
                    "rawInput",
                    "errorText",
                    "providerExecuted",
                    "preliminary",
                ] {
                    p.set(key, string(options, key));
                }
            }
            if let Some(metadata) = options.get("providerMetadata").filter(|v| !v.is_null()) {
                p.set(
                    if matches!(
                        scalar(&options["state"]).as_deref(),
                        Some("output-available" | "output-error")
                    ) {
                        "resultProviderMetadata"
                    } else {
                        "callProviderMetadata"
                    },
                    Some(metadata.clone()),
                );
            }
            self.parts.push(p);
        }
    }
    fn metadata(&mut self, metadata: Option<&Value>) -> Result<bool, ()> {
        let Some(metadata) = metadata.filter(|v| !v.is_null()) else {
            return Ok(false);
        };
        self.metadata = Some(if let Some(base) = &self.metadata {
            merge_metadata(base, metadata)?
        } else {
            metadata.clone()
        });
        Ok(true)
    }
    fn process_data(&mut self, chunk: &Value) -> Result<(), ()> {
        if chunk["transient"] == true {
            return Ok(());
        }
        if let Some(index) = chunk.get("id").and_then(|id| {
            self.parts
                .iter()
                .position(|p| p.get("type") == chunk.get("type") && p.get("id") == Some(id))
        }) {
            self.parts[index].set("data", string(chunk, "data"));
        } else {
            self.parts.push(Part(
                chunk
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.clone())))
                    .collect(),
            ));
        }
        self.write();
        Ok(())
    }
    fn process(&mut self, chunk: &Value) -> Result<(), ()> {
        let kind_value = chunk["type"].as_string().unwrap();
        if starts(kind_value, "data-") {
            return self.process_data(chunk);
        }
        let kind_text = kind_value.to_scalar().map_err(|_| ())?;
        let kind = kind_text.as_str();
        match kind {
            "text-start" | "reasoning-start" => {
                let reasoning = kind == "reasoning-start";
                let mut p =
                    Part::new(&[("type", some(if reasoning { "reasoning" } else { "text" }))]);
                if reasoning {
                    p.set("id", string(chunk, "id"));
                }
                p.set("text", some(""));
                p.set("providerMetadata", string(chunk, "providerMetadata"));
                p.set("state", some("streaming"));
                let index = self.parts.len();
                self.parts.push(p);
                if reasoning {
                    self.reasoning
                        .insert(chunk["id"].as_string().unwrap().clone(), index);
                } else {
                    self.text
                        .insert(chunk["id"].as_string().unwrap().clone(), index);
                }
                self.write();
            }
            "text-delta" | "text-end" | "reasoning-delta" | "reasoning-end" => {
                let reasoning = kind.starts_with("reasoning");
                let active = if reasoning {
                    &mut self.reasoning
                } else {
                    &mut self.text
                };
                let id = chunk["id"].as_string().unwrap();
                let index = *active.get(id).ok_or(())?;
                let p = &mut self.parts[index];
                if kind.ends_with("delta") {
                    p.set(
                        "text",
                        some(concat(&[
                            p.get("text").unwrap().as_string().unwrap(),
                            chunk["delta"].as_string().unwrap(),
                        ])),
                    );
                } else {
                    p.set("state", some("done"));
                    active.remove(id);
                }
                if let Some(metadata) = chunk.get("providerMetadata") {
                    p.set("providerMetadata", Some(metadata.clone()));
                }
                self.write();
            }
            "custom" => {
                self.parts.push(Part::new(&[
                    ("type", some("custom")),
                    ("kind", string(chunk, "kind")),
                    ("providerMetadata", string(chunk, "providerMetadata")),
                ]));
                self.write();
            }
            "file" | "reasoning-file" => {
                let mut p = Part::new(&[
                    ("type", some(kind)),
                    ("mediaType", string(chunk, "mediaType")),
                    ("url", string(chunk, "url")),
                ]);
                if let Some(v) = chunk.get("providerMetadata") {
                    p.set("providerMetadata", Some(v.clone()));
                }
                self.parts.push(p);
                self.write();
            }
            "source-url" | "source-document" => {
                let mut p = Part::new(&[
                    ("type", some(kind)),
                    ("sourceId", string(chunk, "sourceId")),
                ]);
                if kind == "source-url" {
                    p.set("url", string(chunk, "url"));
                    p.set("title", string(chunk, "title"));
                } else {
                    p.set("mediaType", string(chunk, "mediaType"));
                    p.set("title", string(chunk, "title"));
                    p.set("filename", string(chunk, "filename"));
                }
                p.set("providerMetadata", string(chunk, "providerMetadata"));
                self.parts.push(p);
                self.write();
            }
            "tool-input-start" => {
                self.partial.insert(
                    chunk["toolCallId"].as_string().unwrap().clone(),
                    Partial {
                        text: JsString::default(),
                        name: chunk["toolName"].clone(),
                        dynamic: chunk["dynamic"] == true,
                        title: string(chunk, "title"),
                        metadata: string(chunk, "toolMetadata"),
                    },
                );
                let options = tool_options(
                    chunk,
                    "input-streaming",
                    &[
                        "providerExecuted",
                        "title",
                        "toolMetadata",
                        "providerMetadata",
                    ],
                );
                self.update_tool(&options, chunk["dynamic"] == true, None);
                self.write();
            }
            "tool-input-delta" => {
                let p = self
                    .partial
                    .get_mut(chunk["toolCallId"].as_string().unwrap())
                    .ok_or(())?;
                p.text
                    .0
                    .extend_from_slice(chunk["inputTextDelta"].as_string().unwrap().units());
                let mut options = j!({"toolCallId":chunk["toolCallId"],"toolName":p.name,"state":"input-streaming"});
                let fragment = partial_json(&p.text);
                if let Some(input) = &fragment {
                    options["input"] = input.clone();
                }
                if let Some(v) = &p.title {
                    options["title"] = v.clone();
                }
                if let Some(v) = &p.metadata {
                    options["toolMetadata"] = v.clone();
                }
                let dynamic = p.dynamic;
                self.update_tool(&options, dynamic, None);
                if let Some(fragment) = fragment {
                    let index = (self.step_start()..self.parts.len())
                        .find(|&i| {
                            self.parts[i].get("toolCallId") == chunk.get("toolCallId")
                                && self.parts[i]
                                    .get("type")
                                    .and_then(Value::as_string)
                                    .is_some_and(|kind| {
                                        if dynamic {
                                            kind.eq_ascii("dynamic-tool")
                                        } else {
                                            starts(kind, "tool-")
                                        }
                                    })
                        })
                        .expect("updated partial tool");
                    self.parts[index].set_fragment("input", fragment);
                }
                self.write();
            }
            "tool-input-available" => {
                let options = tool_options(
                    chunk,
                    "input-available",
                    &[
                        "input",
                        "providerExecuted",
                        "title",
                        "toolMetadata",
                        "providerMetadata",
                    ],
                );
                self.update_tool(&options, chunk["dynamic"] == true, None);
                self.write();
            }
            "tool-input-error" => {
                let dynamic = (self.step_start()..self.parts.len())
                    .find(|&i| {
                        is_tool(&self.parts[i])
                            && self.parts[i].get("toolCallId") == chunk.get("toolCallId")
                    })
                    .map_or(chunk["dynamic"] == true, |i| {
                        self.parts[i].get("type") == Some(&j!("dynamic-tool"))
                    });
                let mut options = tool_options(
                    chunk,
                    "output-error",
                    &[
                        "input",
                        "errorText",
                        "providerExecuted",
                        "providerMetadata",
                        "toolMetadata",
                    ],
                );
                if !dynamic {
                    options
                        .as_object_mut()
                        .unwrap()
                        .retain(|(k, _)| !k.eq_ascii("input"));
                    options["rawInput"] = chunk["input"].clone();
                }
                self.update_tool(&options, dynamic, None);
                self.write();
            }
            "tool-output-available" | "tool-output-error" => {
                let index = self.tool(&chunk["toolCallId"]).ok_or(())?;
                let p = &self.parts[index];
                let dynamic = p.get("type") == Some(&j!("dynamic-tool"));
                let name = if dynamic {
                    p.get("toolName").unwrap().clone()
                } else {
                    Value::String(JsString::from_units(
                        p.get("type").unwrap().as_string().unwrap().units()[5..].to_vec(),
                    ))
                };
                let mut options = tool_options(
                    chunk,
                    kind.strip_prefix("tool-").unwrap(),
                    if kind == "tool-output-available" {
                        &[
                            "output",
                            "preliminary",
                            "providerExecuted",
                            "providerMetadata",
                        ]
                    } else {
                        &["errorText", "providerExecuted", "providerMetadata"]
                    },
                );
                options["toolName"] = name;
                for key in ["input", "title", "toolMetadata"] {
                    if let Some(v) = p.get(key) {
                        options[key] = v.clone();
                    }
                }
                if kind == "tool-output-error" && !dynamic {
                    if let Some(v) = p.get("rawInput") {
                        options["rawInput"] = v.clone();
                    }
                }
                let raw = p.get("input").cloned();
                self.update_tool(&options, dynamic, Some(index));
                if let Some(raw) = raw {
                    self.parts[index].set_fragment("input", raw);
                }
                self.write();
            }
            "tool-output-denied" => {
                let index = self.tool(&chunk["toolCallId"]).ok_or(())?;
                self.parts[index].set("state", some("output-denied"));
                self.write();
            }
            "tool-approval-request" => {
                let index = self.tool(&chunk["toolCallId"]).ok_or(())?;
                let mut approval = j!({"id":chunk["approvalId"]});
                for (input, output) in [
                    ("approvalDescriptor", "descriptor"),
                    ("reason", "requestReason"),
                ] {
                    if let Some(v) = chunk.get(input).filter(|v| !v.is_null()) {
                        approval[output] = v.clone();
                    }
                }
                if chunk["isAutomatic"] == true {
                    approval["isAutomatic"] = Value::Bool(true);
                }
                if let Some(v) = chunk.get("signature") {
                    approval["signature"] = v.clone();
                }
                self.parts[index].set("state", some("approval-requested"));
                self.parts[index].set("approval", Some(approval));
                self.write();
            }
            "tool-approval-response" => {
                let index = self
                    .parts
                    .iter()
                    .position(|p| {
                        is_tool(p)
                            && p.get("approval").and_then(|a| a.get("id"))
                                == chunk.get("approvalId")
                    })
                    .ok_or(())?;
                let p = &mut self.parts[index];
                let mut approval = p
                    .get("approval")
                    .cloned()
                    .unwrap_or_else(|| j!({"id":chunk["approvalId"]}));
                approval["id"] = chunk["approvalId"].clone();
                approval["approved"] = chunk["approved"].clone();
                if let Some(reason) = chunk.get("reason") {
                    approval["reason"] = reason.clone();
                }
                p.set("state", some("approval-responded"));
                p.set("approval", Some(approval));
                if let Some(v) = chunk.get("providerExecuted") {
                    p.set("providerExecuted", Some(v.clone()));
                }
                if let Some(v) = chunk.get("providerMetadata") {
                    p.set("callProviderMetadata", Some(v.clone()));
                }
                self.write();
            }
            "start-step" => self.parts.push(Part::new(&[("type", some("step-start"))])),
            "finish-step" | "abort" | "error" => {}
            "reset-step" => {
                let start = self.step_start();
                let changed = self.parts.len() > start;
                self.parts.truncate(start);
                self.text.clear();
                self.reasoning.clear();
                self.partial.clear();
                if changed {
                    self.write();
                }
            }
            "start" => {
                if let Some(id) = chunk.get("messageId") {
                    self.id = id.as_string().unwrap().clone();
                }
                let metadata = self.metadata(chunk.get("messageMetadata"))?;
                if chunk.get("messageId").is_some() || metadata {
                    self.write();
                }
            }
            "finish" | "message-metadata" if self.metadata(chunk.get("messageMetadata"))? => {
                self.write();
            }
            _ => {}
        }
        Ok(())
    }
}
fn tool_options(chunk: &Value, state: &str, keys: &[&str]) -> Value {
    let mut value = j!({"toolCallId":chunk["toolCallId"],"state":state});
    if let Some(name) = chunk.get("toolName") {
        value["toolName"] = name.clone();
    }
    for key in keys {
        if let Some(v) = chunk.get(key) {
            value[*key] = v.clone();
        }
    }
    value
}

pub fn assemble_js(parts: &[Value]) -> Assembly {
    let mut dropped = 0;
    let mut document = Vec::new();
    let mut state = State::default();
    let mut populated = false;
    for part in parts {
        if !is_defined_part(part) {
            dropped += 1;
            continue;
        }
        if part["type"] == "start" && populated {
            if let Some(last) = state.last.take() {
                document.push(last)
            }
            state = State::default()
        }
        populated = true;
        if !state.failed && state.process(part).is_err() {
            state.failed = true
        }
    }
    if let Some(last) = state.last {
        document.push(last)
    }
    Assembly {
        document: Value::Array(document),
        dropped_part_count: dropped,
    }
}
pub fn artifact_input_js(
    stream: &str,
    scope: &Value,
    label: &JsString,
    outcome: &str,
    assembly: &Assembly,
    chunk_count: usize,
) -> Value {
    j!({"kind":format!("stream:{stream}"),"content":assembly.document.stringify(),"metadata":j!({"stream":stream,"label":label,"scope":scope,"outcome":outcome,"chunkCount":chunk_count,"droppedPartCount":assembly.dropped_part_count})})
}
fn object_entries(value: &Value) -> Vec<(JsString, Value)> {
    match value {
        Value::Object(v) => v.clone(),
        Value::Array(v) => v
            .iter()
            .enumerate()
            .map(|(i, v)| (JsString::from(i.to_string()), v.clone()))
            .collect(),
        Value::String(s) => s
            .units()
            .iter()
            .enumerate()
            .map(|(i, u)| {
                (
                    JsString::from(i.to_string()),
                    Value::String(JsString::from_units(vec![*u])),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}
fn merge_metadata(base: &Value, overrides: &Value) -> Result<Value, ()> {
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
            .any(|k| key.eq_str(k))
        {
            continue;
        }
        if !matches!(base, Value::Object(_) | Value::Array(_)) {
            return Err(());
        }
        let old = original.get(&key);
        let value = if matches!(value, Value::Object(_)) && matches!(old, Some(Value::Object(_))) {
            merge_metadata(old.unwrap(), &value)?
        } else {
            value
        };
        if let Some(index) = positions.get(&key) {
            result[*index].1 = value
        } else {
            positions.insert(key.clone(), result.len());
            result.push((key, value))
        }
    }
    Ok(Value::Object(result))
}
fn partial_allowed(value: &Value) -> bool {
    match value{
    Value::Object(values)=>!values.iter().any(|(k,v)|k.eq_ascii("__proto__")||(k.eq_ascii("constructor")&&matches!(v,Value::Object(values) if values.iter().any(|(k,_)|k.eq_ascii("prototype")))))&&values.iter().all(|(_,v)|partial_allowed(v)),
    Value::Array(values)=>values.iter().all(partial_allowed),_=>true
}
}
fn partial_json(text: &JsString) -> Option<Value> {
    parse_js_string(text)
        .ok()
        .filter(partial_allowed)
        .or_else(|| {
            parse_js_string(&fix_json(text))
                .ok()
                .filter(partial_allowed)
        })
}
fn fix_json(input: &JsString) -> JsString {
    #[derive(Clone, Copy, PartialEq)]
    enum S {
        Root,
        Finish,
        ObjectStart,
        ObjectComma,
        ObjectKey,
        ObjectAfterKey,
        ObjectBeforeValue,
        ObjectAfterValue,
        ArrayStart,
        ArrayComma,
        ArrayAfterValue,
        Str,
        Escape,
        Unicode,
        Number,
        Literal,
    }
    fn start(
        c: u16,
        i: usize,
        next: S,
        stack: &mut Vec<S>,
        last: &mut Option<usize>,
        literal: &mut usize,
    ) {
        match c {
            34 => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::Str)
            }
            102 | 116 | 110 => {
                *last = Some(i);
                *literal = i;
                stack.pop();
                stack.push(next);
                stack.push(S::Literal)
            }
            45 => {
                stack.pop();
                stack.push(next);
                stack.push(S::Number)
            }
            48..=57 => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::Number)
            }
            123 => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::ObjectStart)
            }
            91 => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::ArrayStart)
            }
            _ => {}
        }
    }
    fn after(c: u16, i: usize, stack: &mut Vec<S>, last: &mut Option<usize>, object: bool) {
        if c == 44 {
            stack.pop();
            stack.push(if object {
                S::ObjectComma
            } else {
                S::ArrayComma
            });
        } else if c == if object { 125 } else { 93 } {
            *last = Some(i);
            stack.pop();
        }
    }
    let mut stack = vec![S::Root];
    let mut last = None;
    let mut literal = 0;
    let mut unicode = 0;
    // Indices are byte boundaries, retaining complete Unicode scalar values.
    for (i, c) in input.units().iter().copied().enumerate() {
        let end = i;
        match stack.last().copied().unwrap_or(S::Finish) {
            S::Root => start(c, end, S::Finish, &mut stack, &mut last, &mut literal),
            S::ObjectStart => match c {
                34 => {
                    stack.pop();
                    stack.push(S::ObjectKey)
                }
                125 => {
                    last = Some(end);
                    stack.pop();
                }
                _ => {}
            },
            S::ObjectComma => {
                if c == 34 {
                    stack.pop();
                    stack.push(S::ObjectKey)
                }
            }
            S::ObjectKey => {
                if c == 34 {
                    stack.pop();
                    stack.push(S::ObjectAfterKey)
                }
            }
            S::ObjectAfterKey => {
                if c == 58 {
                    stack.pop();
                    stack.push(S::ObjectBeforeValue)
                }
            }
            S::ObjectBeforeValue => start(
                c,
                end,
                S::ObjectAfterValue,
                &mut stack,
                &mut last,
                &mut literal,
            ),
            S::ObjectAfterValue => after(c, end, &mut stack, &mut last, true),
            S::ArrayStart => {
                if c == 93 {
                    last = Some(end);
                    stack.pop();
                } else {
                    last = Some(end);
                    start(
                        c,
                        end,
                        S::ArrayAfterValue,
                        &mut stack,
                        &mut last,
                        &mut literal,
                    )
                }
            }
            S::ArrayComma => start(
                c,
                end,
                S::ArrayAfterValue,
                &mut stack,
                &mut last,
                &mut literal,
            ),
            S::ArrayAfterValue => {
                if c == 44 || c == 93 {
                    after(c, end, &mut stack, &mut last, false)
                } else {
                    last = Some(end)
                }
            }
            S::Str => match c {
                34 => {
                    stack.pop();
                    last = Some(end)
                }
                92 => stack.push(S::Escape),
                _ => last = Some(end),
            },
            S::Escape => {
                stack.pop();
                if c == 117 {
                    unicode = 0;
                    stack.push(S::Unicode)
                } else {
                    last = Some(end)
                }
            }
            S::Unicode => {
                if c <= 127 && char::from_u32(u32::from(c)).unwrap().is_ascii_hexdigit() {
                    unicode += 1;
                    if unicode == 4 {
                        stack.pop();
                        last = Some(end)
                    }
                }
            }
            S::Number => match c {
                48..=57 => last = Some(end),
                101 | 69 | 45 | 46 => {}
                44 => {
                    stack.pop();
                    match stack.last() {
                        Some(S::ArrayAfterValue) => after(c, end, &mut stack, &mut last, false),
                        Some(S::ObjectAfterValue) => after(c, end, &mut stack, &mut last, true),
                        _ => {}
                    }
                }
                125 => {
                    stack.pop();
                    if stack.last() == Some(&S::ObjectAfterValue) {
                        after(c, end, &mut stack, &mut last, true)
                    }
                }
                93 => {
                    stack.pop();
                    if stack.last() == Some(&S::ArrayAfterValue) {
                        after(c, end, &mut stack, &mut last, false)
                    }
                }
                _ => {
                    stack.pop();
                }
            },
            S::Literal => {
                let partial = &input.units()[literal..i + 1];
                if !["false", "true", "null"]
                    .iter()
                    .any(|v| v.encode_utf16().collect::<Vec<_>>().starts_with(partial))
                {
                    stack.pop();
                    match stack.last() {
                        Some(S::ObjectAfterValue) => after(c, end, &mut stack, &mut last, true),
                        Some(S::ArrayAfterValue) => after(c, end, &mut stack, &mut last, false),
                        _ => {}
                    }
                } else {
                    last = Some(end)
                }
            }
            S::Finish => {}
        }
    }
    let mut result = last.map_or_else(Vec::new, |i| input.units()[..i + 1].to_vec());
    for state in stack.iter().rev() {
        match state {
            S::Str => result.push(34),
            S::ObjectStart
            | S::ObjectComma
            | S::ObjectKey
            | S::ObjectAfterKey
            | S::ObjectBeforeValue
            | S::ObjectAfterValue => result.push(125),
            S::ArrayStart | S::ArrayComma | S::ArrayAfterValue => result.push(93),
            S::Literal => {
                let partial = &input.units()[literal..];
                if let Some(full) = ["true", "false", "null"]
                    .iter()
                    .find(|v| v.encode_utf16().collect::<Vec<_>>().starts_with(partial))
                {
                    result.extend(full[partial.len()..].encode_utf16());
                }
            }
            _ => {}
        }
    }
    JsString::from_units(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_existing_sdk_witnesses_pass_without_scalar_projection() {
        let fixture = crate::protocol::js_json::parse_js_json(include_bytes!(
            "../../fixtures/protocol-stream-document.json"
        ))
        .unwrap();
        for row in fixture["classified"].as_array().unwrap() {
            assert_eq!(
                is_defined_part(&Value::from_serde(&row["part"])),
                row["defined"].as_bool().unwrap(),
                "{} classifier",
                row["id"]
            )
        }
        for row in fixture["assembled"].as_array().unwrap() {
            let parts: Vec<_> = row["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(Value::from_serde)
                .collect();
            let assembly = assemble_js(&parts);
            assert_eq!(
                assembly.document.to_serde_checked().unwrap(),
                row["assembly"]["document"],
                "{} document",
                row["id"]
            );
            assert_eq!(
                assembly.dropped_part_count,
                row["assembly"]["droppedPartCount"].as_u64().unwrap() as usize,
                "{} dropped",
                row["id"]
            );
            for expected in row["artifacts"].as_array().unwrap() {
                let meta = &expected["metadata"];
                let actual = artifact_input_js(
                    "st_fixture",
                    &Value::from_serde(&meta["scope"]),
                    &JsString::from("label"),
                    meta["outcome"].as_str().unwrap(),
                    &assembly,
                    3,
                );
                assert_eq!(
                    actual.to_serde_checked().unwrap(),
                    *expected,
                    "{} artifact",
                    row["id"]
                )
            }
        }
        for row in fixture["lossless"].as_array().unwrap() {
            let parts: Vec<_> = row["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(Value::from_serde)
                .collect();
            let assembly = assemble_js(&parts);
            assert_eq!(
                assembly.document.stringify(),
                row["documentText"].as_str().unwrap(),
                "{} lossless document",
                row["id"]
            );
            assert_eq!(
                assembly.dropped_part_count,
                row["droppedPartCount"].as_u64().unwrap() as usize,
                "{} dropped",
                row["id"]
            );
            let artifact = artifact_input_js(
                "st_fixture",
                &j!({"kind":"build","build":"b"}),
                &JsString::from("label"),
                "aborted",
                &assembly,
                3,
            );
            assert_eq!(
                artifact.to_serde_checked().unwrap(),
                row["artifact"],
                "{} lossless artifact",
                row["id"]
            )
        }
    }
    #[test]
    fn raw_unit_json_source_is_not_http_replacement_decoded() {
        let source = JsString::from_units(vec![34, 0xd800, 34]);
        assert_eq!(
            parse_js_string(&source).unwrap(),
            Value::String(JsString::from_units(vec![0xd800]))
        );
        assert!(parse_js_string(&JsString::from_units(vec![0xd800])).is_err());
        let repaired = fix_json(&JsString::from_units(vec![
            123, 34, 107, 34, 58, 34, 0xd800,
        ]));
        assert_eq!(
            parse_js_string(&repaired).unwrap()["k"],
            Value::String(JsString::from_units(vec![0xd800]))
        );
    }
}
