//! CLI-only consistency checks. Streamed material never becomes response output.
use harness_gateway::{
    DeltaKind, GatewayError, ItemKind, ModelResponse, ProviderEvent, ResponseOutcome, Result,
};
use serde_json::Value;
use std::io::Write;

pub(super) const MAX_BYTES: usize = 1024 * 1024;
pub(super) const MAX_EVENTS: usize = 4096;
const MAX_ITEMS: usize = 512;
const ERROR: &str =
    "CLI streamed output is inconsistent with terminal output or exceeds tracking limits";
fn invalid() -> GatewayError {
    GatewayError::Protocol(ERROR)
}

#[derive(Default)]
pub(super) struct Lifecycle {
    bytes: usize,
    events: usize,
    identities: Vec<(u64, String)>,
    kinds: Vec<(u64, ItemKind)>,
    parts: Vec<(u64, usize, DeltaKind, String)>,
    finalized: Vec<(u64, Value)>,
    pub rendered: String,
}
// Count serialized bytes without allocating a second native item or JSON buffer.
struct Budget<'a>(&'a mut usize);
impl Write for Budget<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_BYTES - *self.0 {
            return Err(std::io::ErrorKind::FileTooLarge.into());
        }
        *self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl Lifecycle {
    fn identity(&mut self, index: u64, id: &str) -> Result<()> {
        if id.is_empty() || index >= MAX_ITEMS as u64 {
            return Err(invalid());
        }
        if let Some((old_index, old_id)) =
            self.identities.iter().find(|(i, s)| *i == index || s == id)
        {
            if *old_index != index || old_id != id {
                return Err(invalid());
            }
        } else {
            self.identities.push((index, id.into()));
        }
        Ok(())
    }
    fn kind(&mut self, index: u64, kind: ItemKind) -> Result<()> {
        if index >= MAX_ITEMS as u64 {
            return Err(invalid());
        }
        if let Some((_, old)) = self.kinds.iter().find(|(i, _)| *i == index) {
            if old != &kind {
                return Err(invalid());
            }
        } else {
            self.kinds.push((index, kind));
        }
        Ok(())
    }
    pub fn observe(&mut self, event: &ProviderEvent) -> Result<()> {
        self.events += 1;
        if self.events > MAX_EVENTS {
            return Err(invalid());
        }
        // Charge every occurrence, including duplicates, before cloning retained fields.
        if matches!(
            event,
            ProviderEvent::OutputItemStarted { .. }
                | ProviderEvent::OutputItemUpdated { .. }
                | ProviderEvent::OutputItemFinished { .. }
        ) {
            serde_json::to_writer(Budget(&mut self.bytes), event).map_err(|_| invalid())?;
        }
        match event {
            ProviderEvent::OutputItemStarted {
                output_index, item, ..
            }
            | ProviderEvent::OutputItemFinished {
                output_index, item, ..
            } => {
                self.kind(*output_index, item.kind.clone())?;
                if !matches!(item.kind, ItemKind::Message | ItemKind::FunctionCall) {
                    return Ok(());
                }
                let expected_type = if item.kind == ItemKind::Message {
                    "message"
                } else {
                    "function_call"
                };
                if item.native_type != expected_type
                    || item.native.get("type").and_then(Value::as_str) != Some(expected_type)
                {
                    return Err(invalid());
                }
                self.identity(*output_index, item.id.as_deref().ok_or_else(invalid)?)?;
                if item.native.get("id").and_then(Value::as_str) != item.id.as_deref() {
                    return Err(invalid());
                }
                if matches!(event, ProviderEvent::OutputItemFinished { .. }) {
                    if self.finalized.len() >= MAX_ITEMS {
                        return Err(invalid());
                    }
                    if self
                        .finalized
                        .iter()
                        .any(|(i, v)| i == output_index && v != &item.native)
                    {
                        return Err(invalid());
                    }
                    self.finalized.push((*output_index, item.native.clone()));
                }
            }
            ProviderEvent::OutputItemUpdated {
                output_index,
                item_id,
                content_index,
                kind: kind @ (DeltaKind::Text | DeltaKind::Refusal),
                delta,
                ..
            } => {
                if delta.is_empty() {
                    return Ok(());
                }
                self.identity(*output_index, item_id)?;
                self.kind(*output_index, ItemKind::Message)?;
                // The rendered copy is separate from the per-part copy.
                Budget(&mut self.bytes)
                    .write_all(delta.as_bytes())
                    .map_err(|_| invalid())?;
                let content =
                    usize::try_from(content_index.ok_or_else(invalid)?).map_err(|_| invalid())?;
                if content >= MAX_ITEMS {
                    return Err(invalid());
                }
                if let Some((_, _, old_kind, text)) = self
                    .parts
                    .iter_mut()
                    .find(|(i, c, _, _)| i == output_index && *c == content)
                {
                    if old_kind != kind {
                        return Err(invalid());
                    }
                    text.push_str(delta);
                } else {
                    self.parts
                        .push((*output_index, content, *kind, delta.clone()));
                }
                self.rendered.push_str(delta);
            }
            _ => {}
        }
        Ok(())
    }
    pub fn validate(&self, response: &ModelResponse) -> Result<()> {
        if response.outcome != ResponseOutcome::Completed {
            return Ok(());
        }
        // Exact finalized native equality is deliberately conservative. Metadata
        // enrichment can reject a response, but cannot change callable authority.
        for (index, native) in &self.finalized {
            if response.output.get(*index as usize).map(|i| &i.native) != Some(native) {
                return Err(invalid());
            }
        }
        for (index, content, kind, text) in &self.parts {
            let item = response.output.get(*index as usize).ok_or_else(invalid)?;
            let id = self
                .identities
                .iter()
                .find(|(i, _)| i == index)
                .map(|(_, id)| id.as_str());
            if item.kind != ItemKind::Message
                || item.native_type != "message"
                || item.native.get("type").and_then(Value::as_str) != Some("message")
                || item.id.as_deref() != id
                || item.native.get("id").and_then(Value::as_str) != id
            {
                return Err(invalid());
            }
            let part = item
                .native
                .get("content")
                .and_then(Value::as_array)
                .and_then(|p| p.get(*content))
                .ok_or_else(invalid)?;
            let (part_kind, field) = if *kind == DeltaKind::Text {
                ("output_text", "text")
            } else {
                ("refusal", "refusal")
            };
            if part.get("type").and_then(Value::as_str) != Some(part_kind)
                || !part
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.starts_with(text))
            {
                return Err(invalid());
            }
        }
        // Parts can arrive interleaved. Check each part above, not arrival-order
        // concatenation; the terminal still supplies all returned output.

        Ok(())
    }
}
