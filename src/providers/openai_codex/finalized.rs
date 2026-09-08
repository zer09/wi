//! Recovery is private to the decoder; partial events never become executable output.
use crate::{GatewayError, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};

const LIMIT: usize = 1024 * 1024;
#[derive(Default)]
pub(super) struct FinalizedItems {
    events: Vec<Value>,
    count: usize,
    bytes: usize,
    invalid: bool,
    evidence: bool,
}
struct Counter(usize);
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(io::Error::other("recovery limit"));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn associated(v: &Value) -> bool {
    let kind = v["type"].as_str().unwrap_or("");
    v.get("item").is_some()
        || v.get("item_id").is_some()
        || v.get("output_index").is_some()
        || v.get("content_index").is_some()
        || v.get("summary_index").is_some()
        || v.get("call_id").is_some()
        || [
            "response.output_item.",
            "response.output_text.",
            "response.refusal.",
            "response.content_part.",
            "response.function_call_arguments.",
            "response.reasoning_",
            "response.custom_tool_call_input.",
        ]
        .iter()
        .any(|p| kind.starts_with(p))
}
impl FinalizedItems {
    pub fn observe(&mut self, v: &Value) {
        self.count = self.count.saturating_add(1);
        self.evidence |= associated(v);
        if self.count > 4096 {
            self.invalid = true;
        }
        if !self.invalid && associated(v) {
            let mut counter = Counter(LIMIT - self.bytes);
            if serde_json::to_writer(&mut counter, v).is_err() {
                self.invalid = true;
            } else {
                self.bytes = LIMIT - counter.0;
                let kind = v["type"].as_str().unwrap_or("");
                let index = v["output_index"].as_u64();
                let duplicate = self.events.iter().any(|old| {
                    old["output_index"] == v["output_index"]
                        && (old["type"] == "response.output_item.done"
                            || (old["type"] == kind && kind == "response.output_item.added"))
                });
                let known = matches!(
                    kind,
                    "response.output_item.added"
                        | "response.output_item.done"
                        | "response.output_text.delta"
                        | "response.output_text.done"
                        | "response.refusal.delta"
                        | "response.refusal.done"
                        | "response.function_call_arguments.delta"
                        | "response.function_call_arguments.done"
                        | "response.content_part.added"
                        | "response.content_part.done"
                        | "response.reasoning_summary_text.delta"
                        | "response.reasoning_summary_text.done"
                        | "response.reasoning_summary_part.added"
                        | "response.reasoning_summary_part.done"
                        | "response.reasoning_text.delta"
                        | "response.reasoning_text.done"
                        | "response.reasoning_text_part.added"
                        | "response.reasoning_text_part.done"
                );
                self.invalid = !known
                    || index.is_none_or(|i| i >= 512)
                    || duplicate
                    || (kind == "response.output_item.done" && complete(&v["item"]).is_none());
                if !self.invalid {
                    self.events.push(v.clone());
                }
            }
        }
        if self.invalid {
            self.events.clear();
        }
    }
    pub fn recover(&mut self, response_id: &str) -> Result<Vec<Value>> {
        let result = if self.invalid {
            None
        } else if !self.evidence {
            Some(vec![])
        } else {
            validate(&self.events, response_id)
        };
        self.events.clear();
        if result.is_none() {
            self.invalid = true;
        }
        result.ok_or(GatewayError::Protocol("invalid finalized output recovery"))
    }
}
fn bounded(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty() && s.len() <= 512)
}
fn parts(v: &Value, kinds: &[(&str, &str)]) -> Option<()> {
    for part in v.as_array()? {
        let kind = part["type"].as_str()?;
        let (_, field) = kinds.iter().find(|(k, _)| *k == kind)?;
        part[*field].as_str()?;
        if let Some(a) = part.get("annotations") {
            a.as_array()?;
        }
        if let Some(a) = part.get("logprobs") {
            a.as_array()?;
        }
    }
    Some(())
}
fn complete(item: &Value) -> Option<()> {
    bounded(&item["id"])?;
    if let Some(status) = item.get("status")
        && status.as_str() != Some("completed")
    {
        return None;
    }
    match item["type"].as_str()? {
        "message" => {
            if item
                .get("role")
                .is_some_and(|v| v.as_str() != Some("assistant"))
            {
                return None;
            }
            parts(
                &item["content"],
                &[("output_text", "text"), ("refusal", "refusal")],
            )?;
        }
        "reasoning" => {
            if item.get("summary").is_none()
                && item.get("content").is_none()
                && item.get("encrypted_content").is_none_or(Value::is_null)
            {
                return None;
            }
            if let Some(summary) = item.get("summary") {
                parts(summary, &[("summary_text", "text")])?;
            }
            if let Some(content) = item.get("content") {
                parts(content, &[("reasoning_text", "text")])?;
            }
            if let Some(encrypted) = item.get("encrypted_content")
                && !encrypted.is_null()
            {
                encrypted.as_str()?;
            }
        }
        "function_call" => {
            bounded(&item["call_id"])?;
            bounded(&item["name"])?;
            let args = item["arguments"].as_str()?;
            if args.len() > LIMIT || !serde_json::from_str::<Value>(args).ok()?.is_object() {
                return None;
            }
            if item.get("namespace").is_some_and(|v| !v.is_null()) {
                return None;
            }
            if item
                .get("caller")
                .is_some_and(|v| !v.is_null() && v["type"].as_str() != Some("direct"))
            {
                return None;
            }
        }
        _ => return None,
    }
    Some(())
}
fn compatible(value: &Value, item: &Value) -> Option<()> {
    for field in ["call_id", "name", "caller", "namespace", "arguments"] {
        if let Some(present) = value.get(field) {
            if item["type"] != "function_call" {
                return None;
            }
            // Arguments can grow between added and done; call authority cannot change.
            if field != "arguments" && Some(present) != item.get(field) {
                return None;
            }
        }
    }
    if value.get("role").is_some_and(|role| {
        item["type"] != "message"
            || role.as_str() != Some("assistant")
            || item.get("role").is_some_and(|done_role| role != done_role)
    }) || (value.get("content").is_some() && item["type"] == "function_call")
        || (value.get("summary").is_some() && item["type"] != "reasoning")
    {
        return None;
    }
    Some(())
}
fn provisional_content(value: &Value, item: &Value) -> Option<()> {
    if let Some(arguments) = value.get("arguments")
        && !item["arguments"].as_str()?.starts_with(arguments.as_str()?)
    {
        return None;
    }
    for array in ["content", "summary"] {
        let Some(provided) = value.get(array) else {
            continue;
        };
        let provided = provided.as_array()?;
        let finalized = match item.get(array) {
            Some(parts) => parts.as_array()?.as_slice(),
            None => &[],
        };
        if provided.len() > finalized.len() {
            return None;
        }
        for (part, target) in provided.iter().zip(finalized) {
            let field = match (item["type"].as_str()?, array, part["type"].as_str()?) {
                ("message", "content", "output_text")
                | ("reasoning", "content", "reasoning_text")
                | ("reasoning", "summary", "summary_text") => "text",
                ("message", "content", "refusal") => "refusal",
                _ => return None,
            };
            if part["type"] != target["type"]
                || !target[field].as_str()?.starts_with(part[field].as_str()?)
            {
                return None;
            }
        }
    }
    Some(())
}
fn validate(events: &[Value], response_id: &str) -> Option<Vec<Value>> {
    let mut done = BTreeMap::new();
    let mut ids = BTreeSet::new();
    let mut calls = BTreeSet::new();
    for v in events {
        if v.get("response_id")
            .is_some_and(|id| id.as_str() != Some(response_id))
            || v.pointer("/response/id")
                .is_some_and(|id| id.as_str() != Some(response_id))
        {
            return None;
        }
        if v["type"] == "response.output_item.done" {
            let index = v["output_index"].as_u64()?;
            if index >= 512 {
                return None;
            }
            let item = v.get("item")?;
            complete(item)?;
            if !ids.insert(item["id"].as_str()?) || done.insert(index, item).is_some() {
                return None;
            }
            if item["type"] == "function_call" && !calls.insert(item["call_id"].as_str()?) {
                return None;
            }
        }
    }
    if done.is_empty() || done.keys().copied().ne(0..done.len() as u64) {
        return None;
    }
    let mut added = BTreeSet::new();
    let mut finished = BTreeSet::new();
    let mut finals = BTreeSet::new();
    let mut fragments: BTreeMap<(u64, String, u64), String> = BTreeMap::new();
    for v in events {
        let index = v["output_index"].as_u64()?;
        let item = *done.get(&index)?;
        let kind = v["type"].as_str()?;
        if v.get("item_id").is_some_and(|id| id != &item["id"]) {
            return None;
        }
        // Check associations before item events bypass the part validation below.
        compatible(v, item)?;
        if matches!(
            kind,
            "response.output_item.added" | "response.output_item.done"
        ) {
            if [
                "content_index",
                "summary_index",
                "part",
                "delta",
                "text",
                "refusal",
                "arguments",
            ]
            .iter()
            .any(|field| v.get(field).is_some())
            {
                return None;
            }
            let nested = v.get("item")?;
            compatible(nested, item)?;
            for field in ["id", "type"] {
                if nested.get(field) != item.get(field) {
                    return None;
                }
            }
        } else if v.get("item").is_some() {
            return None;
        }
        if kind == "response.output_item.done" {
            finished.insert(index);
            continue;
        }
        if finished.contains(&index) {
            return None;
        }
        if kind == "response.output_item.added" {
            // Supplied text may grow, but must not contradict the finalized item.
            provisional_content(&v["item"], item)?;
            if !added.insert(index) {
                return None;
            }
            continue;
        }
        if v["item_id"] != item["id"] {
            return None;
        }
        let (family, field, part_index, target) = match kind {
            "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                if item["type"] != "function_call" {
                    return None;
                }
                ("arguments", "arguments", 0, item)
            }
            "response.output_text.delta"
            | "response.output_text.done"
            | "response.refusal.delta"
            | "response.refusal.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_text_part.added"
            | "response.reasoning_text_part.done" => {
                let i = v["content_index"].as_u64()?;
                let target = item["content"].as_array()?.get(usize::try_from(i).ok()?)?;
                let t = target["type"].as_str()?;
                let (expected_item, field) = match t {
                    "output_text" => ("message", "text"),
                    "refusal" => ("message", "refusal"),
                    "reasoning_text" => ("reasoning", "text"),
                    _ => return None,
                };
                if item["type"] != expected_item {
                    return None;
                }
                let matches_family = if kind.starts_with("response.content_part.") {
                    true
                } else if kind.starts_with("response.reasoning_text_part.") {
                    t == "reasoning_text"
                } else {
                    kind.starts_with(&format!("response.{t}."))
                };
                if !matches_family {
                    return None;
                }
                ("content", field, i, target)
            }
            "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done" => {
                if item["type"] != "reasoning" {
                    return None;
                }
                let i = v["summary_index"].as_u64()?;
                let target = item["summary"].as_array()?.get(usize::try_from(i).ok()?)?;
                ("summary", "text", i, target)
            }
            _ => return None,
        };
        if (family != "content" && v.get("content_index").is_some())
            || (family != "summary" && v.get("summary_index").is_some())
        {
            return None;
        }
        let key = (index, family.to_owned(), part_index);
        let final_text = target[field].as_str()?;
        if kind.ends_with(".delta") {
            if finals.contains(&(key.clone(), "field")) || finals.contains(&(key.clone(), "part")) {
                return None;
            }
            let text = fragments.entry(key).or_default();
            text.push_str(v["delta"].as_str()?);
            if !final_text.starts_with(text.as_str()) {
                return None;
            }
        } else if kind.contains("part.") {
            let part = &v["part"];
            if part["type"] != target["type"] {
                return None;
            }
            let text = part[field].as_str()?;
            if kind.ends_with(".done") {
                if !finals.insert((key, "part")) || part != target {
                    return None;
                }
            } else if !finals.insert((key.clone(), "added"))
                || finals.contains(&(key, "part"))
                || !final_text.starts_with(text)
            {
                return None;
            }
        } else if !finals.insert((key, "field")) || v[field].as_str()? != final_text {
            return None;
        }
    }
    Some(done.values().map(|v| (*v).clone()).collect())
}
