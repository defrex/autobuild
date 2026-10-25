//! Native close-time AI UI-message assembly. The pinned SDK is an oracle in
//! fixtures, never a runtime dependency. Processing errors stop that segment;
//! malformed/undefined chunks are separately dropped before segmentation.
use super::js_json::{parse_js_json, serializable};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
#[path = "stream_document/fragment.rs"]
mod fragment;
use fragment::Fragment;

#[derive(Debug, Clone)]
pub struct Assembly {
    /// Unicode-scalar inspection projection; artifact bytes retain lone UTF-16 fragments.
    pub document: Value,
    encoded_document: String,
    pub dropped_part_count: usize,
}
#[derive(Clone, Default)]
struct Part(Vec<(String, Option<Value>)>, HashMap<String, Fragment>);
impl Part {
    fn new(fields: &[(&str, Option<Value>)]) -> Self {
        Self(
            fields
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
            HashMap::new(),
        )
    }
    fn set(&mut self, key: &str, value: Option<Value>) {
        self.1.remove(key);
        if let Some((_, old)) = self.0.iter_mut().find(|(k, _)| k == key) {
            *old = value
        } else {
            self.0.push((key.into(), value))
        }
    }
    fn set_fragment(&mut self, key: &str, value: Fragment) {
        self.set(key, Some(value.projection()));
        self.1.insert(key.into(), value);
    }
    fn encoded(&self) -> String {
        format!(
            "{{{}}}",
            self.0
                .iter()
                .filter_map(|(key, value)| value.as_ref().map(|value| format!(
                    "{}:{}",
                    serde_json::to_string(key).unwrap(),
                    self.1
                        .get(key)
                        .map(Fragment::encoded)
                        .unwrap_or_else(|| canonical(value))
                )))
                .collect::<Vec<_>>()
                .join(",")
        )
    }
    fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
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
fn some(value: impl Into<Value>) -> Option<Value> {
    Some(value.into())
}
fn string(value: &Value, key: &str) -> Option<Value> {
    value.get(key).cloned()
}
fn json_value(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_f64().is_some(),
        Value::Array(a) => a.iter().all(json_value),
        Value::Object(o) => o.values().all(json_value),
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
        .all(|k| part.get(*k).is_some_and(Value::is_string))
        && optional_strings
            .iter()
            .all(|k| part.get(*k).is_none_or(Value::is_string))
        && optional_bools
            .iter()
            .all(|k| part.get(*k).is_none_or(Value::is_boolean))
}
fn provider(part: &Value) -> bool {
    part.get("providerMetadata").is_none_or(|v| {
        v.as_object().is_some_and(|o| {
            o.values()
                .all(|v| v.as_object().is_some_and(|o| o.values().all(json_value)))
        })
    })
}
fn tool_metadata(part: &Value) -> bool {
    part.get("toolMetadata")
        .is_none_or(|v| v.as_object().is_some_and(|o| o.values().all(json_value)))
}
/// Classification checks the SDK's loose union; extra properties survive.
pub fn is_defined_part(part: &Value) -> bool {
    let Some(kind) = part.get("type").and_then(Value::as_str) else {
        return false;
    };
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
            v.as_str().is_some_and(|v| {
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
    id: String,
    metadata: Option<Fragment>,
    parts: Vec<Part>,
    text: HashMap<String, usize>,
    reasoning: HashMap<String, usize>,
    partial: HashMap<String, Partial>,
    last: Option<Value>,
    last_encoded: Option<String>,
}
#[derive(Clone)]
struct Partial {
    text: String,
    name: Value,
    dynamic: bool,
    title: Option<Value>,
    metadata: Option<Value>,
}
fn is_tool(part: &Part) -> bool {
    part.get("type")
        .and_then(Value::as_str)
        .is_some_and(|s| s.starts_with("tool-") || s == "dynamic-tool")
}
impl State {
    fn write(&mut self) {
        let mut message = Map::new();
        message.insert("id".into(), self.id.clone().into());
        if let Some(metadata) = &self.metadata {
            message.insert("metadata".into(), metadata.projection());
        }
        message.insert("role".into(), "assistant".into());
        message.insert("parts".into(), self.parts.iter().map(Part::value).collect());
        let metadata = self
            .metadata
            .as_ref()
            .map(|v| format!(",\"metadata\":{}", v.encoded()))
            .unwrap_or_default();
        self.last_encoded = Some(format!(
            "{{\"id\":{}{metadata},\"role\":\"assistant\",\"parts\":[{}]}}",
            serde_json::to_string(&self.id).unwrap(),
            self.parts
                .iter()
                .map(Part::encoded)
                .collect::<Vec<_>>()
                .join(",")
        ));
        self.last = Some(Value::Object(message));
    }
    fn step_start(&self) -> usize {
        self.parts
            .iter()
            .rposition(|p| p.get("type") == Some(&json!("step-start")))
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
                        .and_then(Value::as_str)
                        .is_some_and(|kind| {
                            if dynamic {
                                kind == "dynamic-tool"
                            } else {
                                kind.starts_with("tool-")
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
                        options["state"].as_str(),
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
                        some(format!("tool-{}", options["toolName"].as_str().unwrap())),
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
                        options["state"].as_str(),
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
            base.merge(metadata)?
        } else {
            Fragment::from_value(metadata)
        });
        Ok(true)
    }
    fn process(&mut self, chunk: &Value) -> Result<(), ()> {
        let kind = chunk["type"].as_str().unwrap();
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
                        .insert(chunk["id"].as_str().unwrap().into(), index);
                } else {
                    self.text
                        .insert(chunk["id"].as_str().unwrap().into(), index);
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
                let id = chunk["id"].as_str().unwrap();
                let index = *active.get(id).ok_or(())?;
                let p = &mut self.parts[index];
                if kind.ends_with("delta") {
                    p.set(
                        "text",
                        some(format!(
                            "{}{}",
                            p.get("text").unwrap().as_str().unwrap(),
                            chunk["delta"].as_str().unwrap()
                        )),
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
                    chunk["toolCallId"].as_str().unwrap().into(),
                    Partial {
                        text: String::new(),
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
                    .get_mut(chunk["toolCallId"].as_str().unwrap())
                    .ok_or(())?;
                p.text.push_str(chunk["inputTextDelta"].as_str().unwrap());
                let mut options = json!({"toolCallId":chunk["toolCallId"],"toolName":p.name,"state":"input-streaming"});
                let fragment = partial_json(&p.text);
                if let Some(input) = &fragment {
                    options["input"] = input.projection();
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
                                    .and_then(Value::as_str)
                                    .is_some_and(|kind| {
                                        if dynamic {
                                            kind == "dynamic-tool"
                                        } else {
                                            kind.starts_with("tool-")
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
                        self.parts[i].get("type") == Some(&json!("dynamic-tool"))
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
                    options.as_object_mut().unwrap().remove("input");
                    options["rawInput"] = chunk["input"].clone();
                }
                self.update_tool(&options, dynamic, None);
                self.write();
            }
            "tool-output-available" | "tool-output-error" => {
                let index = self.tool(&chunk["toolCallId"]).ok_or(())?;
                let p = &self.parts[index];
                let dynamic = p.get("type") == Some(&json!("dynamic-tool"));
                let name = if dynamic {
                    p.get("toolName").unwrap().clone()
                } else {
                    json!(p
                        .get("type")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .strip_prefix("tool-")
                        .unwrap())
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
                let raw = p.1.get("input").cloned();
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
                let mut approval = json!({"id":chunk["approvalId"]});
                for (input, output) in [
                    ("approvalDescriptor", "descriptor"),
                    ("reason", "requestReason"),
                ] {
                    if let Some(v) = chunk.get(input).filter(|v| !v.is_null()) {
                        approval[output] = v.clone();
                    }
                }
                if chunk["isAutomatic"] == true {
                    approval["isAutomatic"] = true.into();
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
                    .unwrap_or_else(|| json!({"id":chunk["approvalId"]}));
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
                    self.id = id.as_str().unwrap().into();
                }
                let metadata = self.metadata(chunk.get("messageMetadata"))?;
                if chunk.get("messageId").is_some() || metadata {
                    self.write();
                }
            }
            "finish" | "message-metadata" => {
                if self.metadata(chunk.get("messageMetadata"))? {
                    self.write();
                }
            }
            data if data.starts_with("data-") => {
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
                        HashMap::new(),
                    ));
                }
                self.write();
            }
            _ => {}
        }
        Ok(())
    }
}
fn tool_options(chunk: &Value, state: &str, keys: &[&str]) -> Value {
    let mut value = json!({"toolCallId":chunk["toolCallId"],"state":state});
    if let Some(name) = chunk.get("toolName") {
        value["toolName"] = name.clone();
    }
    for key in keys {
        if let Some(v) = chunk.get(*key) {
            value[*key] = v.clone();
        }
    }
    value
}
fn canonical(value: &Value) -> String {
    let value = serializable(value.clone());
    let value = parse_js_json(&serde_json::to_vec(&value).expect("JSON value"))
        .expect("canonical JSON value");
    serde_json::to_string(&value).expect("JSON value")
}

/// The SDK closes each message segment independently, retaining its last snapshot.
pub fn assemble(parts: &[Value]) -> Assembly {
    let mut dropped = 0;
    let mut document = Vec::new();
    let mut encoded = Vec::new();
    let mut state = State::default();
    let mut populated = false;
    for part in parts {
        if !is_defined_part(part) {
            dropped += 1;
            continue;
        }
        if part["type"] == "start" && populated {
            if let Some(last) = state.last.take() {
                document.push(last);
                encoded.push(state.last_encoded.take().expect("written encoded snapshot"));
            }
            state = State::default();
        }
        populated = true;
        if !state.failed && state.process(part).is_err() {
            state.failed = true;
        }
    }
    if let Some(last) = state.last {
        document.push(last);
        encoded.push(state.last_encoded.expect("written encoded snapshot"));
    }
    Assembly {
        document: Value::Array(document),
        dropped_part_count: dropped,
        encoded_document: format!("[{}]", encoded.join(",")),
    }
}
pub fn artifact_input(
    stream: &str,
    scope: &Value,
    label: &str,
    outcome: &str,
    assembly: &Assembly,
    chunk_count: usize,
) -> Value {
    json!({"kind":format!("stream:{stream}"),"content":assembly.encoded_document,"metadata":{"stream":stream,"label":label,"scope":scope,"outcome":outcome,"chunkCount":chunk_count,"droppedPartCount":assembly.dropped_part_count}})
}

fn partial_json(text: &str) -> Option<Fragment> {
    Fragment::parse(text).or_else(|| Fragment::parse(&fix_json(text)))
}
fn fix_json(input: &str) -> String {
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
        c: char,
        i: usize,
        next: S,
        stack: &mut Vec<S>,
        last: &mut Option<usize>,
        literal: &mut usize,
    ) {
        match c {
            '"' => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::Str)
            }
            'f' | 't' | 'n' => {
                *last = Some(i);
                *literal = i;
                stack.pop();
                stack.push(next);
                stack.push(S::Literal)
            }
            '-' => {
                stack.pop();
                stack.push(next);
                stack.push(S::Number)
            }
            '0'..='9' => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::Number)
            }
            '{' => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::ObjectStart)
            }
            '[' => {
                *last = Some(i);
                stack.pop();
                stack.push(next);
                stack.push(S::ArrayStart)
            }
            _ => {}
        }
    }
    fn after(c: char, i: usize, stack: &mut Vec<S>, last: &mut Option<usize>, object: bool) {
        if c == ',' {
            stack.pop();
            stack.push(if object {
                S::ObjectComma
            } else {
                S::ArrayComma
            });
        } else if c == if object { '}' } else { ']' } {
            *last = Some(i);
            stack.pop();
        }
    }
    let mut stack = vec![S::Root];
    let mut last = None;
    let mut literal = 0;
    let mut unicode = 0;
    // Indices are byte boundaries, retaining complete Unicode scalar values.
    for (i, c) in input.char_indices() {
        let end = i + c.len_utf8() - 1;
        match stack.last().copied().unwrap_or(S::Finish) {
            S::Root => start(c, end, S::Finish, &mut stack, &mut last, &mut literal),
            S::ObjectStart => match c {
                '"' => {
                    stack.pop();
                    stack.push(S::ObjectKey)
                }
                '}' => {
                    last = Some(end);
                    stack.pop();
                }
                _ => {}
            },
            S::ObjectComma => {
                if c == '"' {
                    stack.pop();
                    stack.push(S::ObjectKey)
                }
            }
            S::ObjectKey => {
                if c == '"' {
                    stack.pop();
                    stack.push(S::ObjectAfterKey)
                }
            }
            S::ObjectAfterKey => {
                if c == ':' {
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
                if c == ']' {
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
                if c == ',' || c == ']' {
                    after(c, end, &mut stack, &mut last, false)
                } else {
                    last = Some(end)
                }
            }
            S::Str => match c {
                '"' => {
                    stack.pop();
                    last = Some(end)
                }
                '\\' => stack.push(S::Escape),
                _ => last = Some(end),
            },
            S::Escape => {
                stack.pop();
                if c == 'u' {
                    unicode = 0;
                    stack.push(S::Unicode)
                } else {
                    last = Some(end)
                }
            }
            S::Unicode => {
                if c.is_ascii_hexdigit() {
                    unicode += 1;
                    if unicode == 4 {
                        stack.pop();
                        last = Some(end)
                    }
                }
            }
            S::Number => match c {
                '0'..='9' => last = Some(end),
                'e' | 'E' | '-' | '.' => {}
                ',' => {
                    stack.pop();
                    match stack.last() {
                        Some(S::ArrayAfterValue) => after(c, end, &mut stack, &mut last, false),
                        Some(S::ObjectAfterValue) => after(c, end, &mut stack, &mut last, true),
                        _ => {}
                    }
                }
                '}' => {
                    stack.pop();
                    if stack.last() == Some(&S::ObjectAfterValue) {
                        after(c, end, &mut stack, &mut last, true)
                    }
                }
                ']' => {
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
                let partial = &input[literal..i + c.len_utf8()];
                if !["false", "true", "null"]
                    .iter()
                    .any(|v| v.starts_with(partial))
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
    let mut result = last.map_or_else(String::new, |i| input[..i + 1].to_string());
    for state in stack.iter().rev() {
        match state {
            S::Str => result.push('"'),
            S::ObjectStart
            | S::ObjectComma
            | S::ObjectKey
            | S::ObjectAfterKey
            | S::ObjectBeforeValue
            | S::ObjectAfterValue => result.push('}'),
            S::ArrayStart | S::ArrayComma | S::ArrayAfterValue => result.push(']'),
            S::Literal => {
                let partial = &input[literal..];
                if let Some(full) = ["true", "false", "null"]
                    .iter()
                    .find(|v| v.starts_with(partial))
                {
                    result.push_str(&full[partial.len()..]);
                }
            }
            _ => {}
        }
    }
    result
}

#[path = "stream_document_lossless.rs"]
mod lossless;
pub use lossless::{artifact_input_js, assemble_js, Assembly as JsAssembly};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sdk_classifier_and_complete_assembly_match() {
        let fixture = parse_js_json(include_bytes!(
            "../../fixtures/protocol-stream-document.json"
        ))
        .unwrap();
        for row in fixture["classified"].as_array().unwrap() {
            assert_eq!(
                is_defined_part(&row["part"]),
                row["defined"].as_bool().unwrap(),
                "{} {}",
                row["id"],
                row["part"]
            );
        }
        for row in fixture["assembled"].as_array().unwrap() {
            let assembly = assemble(row["parts"].as_array().unwrap());
            assert_eq!(
                assembly.document, row["assembly"]["document"],
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
                let actual = artifact_input(
                    "st_fixture",
                    &meta["scope"],
                    "label",
                    meta["outcome"].as_str().unwrap(),
                    &assembly,
                    3,
                );
                assert_eq!(actual, *expected, "{} artifact", row["id"]);
            }
        }
    }
    #[test]
    fn sdk_partial_inputs_and_metadata_retain_lone_utf16_in_artifact_bytes() {
        let fixture = parse_js_json(include_bytes!(
            "../../fixtures/protocol-stream-document.json"
        ))
        .unwrap();
        for row in fixture["lossless"].as_array().unwrap() {
            let assembly = assemble(row["parts"].as_array().unwrap());
            assert_eq!(
                assembly.encoded_document,
                row["documentText"].as_str().unwrap(),
                "{} UTF16 document",
                row["id"]
            );
            assert_eq!(
                assembly.dropped_part_count,
                row["droppedPartCount"].as_u64().unwrap() as usize
            );
            let artifact = artifact_input(
                "st_fixture",
                &json!({"kind":"build","build":"b"}),
                "label",
                "aborted",
                &assembly,
                3,
            );
            assert_eq!(artifact, row["artifact"], "{} UTF16 artifact", row["id"]);
        }
        assert!(fixture["lossless"].as_array().unwrap().len() > 100);
    }
}
