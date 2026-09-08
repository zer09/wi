//! Opt-in, allowlisted smoke evidence. Native content never enters the public snapshot.
use crate::{ModelResponse, Transport};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SmokeCase {
    Text,
    Continuation,
    Tool,
}
impl SmokeCase {
    pub fn first_prompt(self) -> &'static str {
        match self {
            Self::Text => "Reply with exactly: gateway connected",
            Self::Continuation => "Remember the word lantern. Reply only: remembered",
            Self::Tool => "Use add_numbers with a=17 and b=25. What is the sum?",
        }
    }
    pub fn submissions(self) -> usize {
        if self == Self::Text { 1 } else { 2 }
    }
}
pub const FOLLOW_UP: &str = "What word did I ask you to remember? Reply only with that word.";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpaqueReplay {
    NotEmitted,
    Matched,
    Mismatched,
}

#[derive(Clone, Debug, Serialize)]
pub struct SendEvidence {
    pub transport: Transport,
    pub ordinal: usize,
    pub socket_reused: bool,
    pub prior_response_equal: Option<bool>,
    pub new_input_only_equal: Option<bool>,
    pub native_sse_replay_equal: Option<bool>,
    pub opaque_replay: Option<OpaqueReplay>,
    pub result_linkage_equal: Option<bool>,
    pub native_created_count: usize,
    pub terminal_type: Option<&'static str>,
    pub terminal_status: Option<&'static str>,
    pub validated_terminal: bool,
    pub text_deltas: usize,
    pub refusal_deltas: usize,
    pub reasoning_deltas: usize,
    pub argument_deltas: usize,
    pub native_expected_text_equal: Option<bool>,
    pub normalized_native_text_equal: Option<bool>,
    pub streamed_native_text_equal: Option<bool>,
    pub http: Option<HttpEvidence>,
    pub terminal_text_state: TextState,
    pub streamed_text_state: TextState,
    pub native_expected_text_unavailable: Option<TextState>,
    pub normalized_native_text_unavailable: Option<TextState>,
    pub streamed_native_text_unavailable: Option<TextState>,
    pub finalized_items: FinalizedCounts,
    pub native_terminal_items: Option<usize>,
    pub effective_items: Option<usize>,
    pub output_provenance: Option<crate::OutputProvenance>,
    pub effective_text_state: TextState,
    pub effective_expected_text_equal: Option<bool>,
    pub normalized_effective_text_equal: Option<bool>,
    pub streamed_effective_text_equal: Option<bool>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaClass {
    Missing,
    Invalid,
    EventStream,
    Json,
    Html,
    PlainText,
    Other,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BodyClass {
    Empty,
    JsonLike,
    HtmlLike,
    TextOrOther,
    BinaryOrNonUtf8,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SampleState {
    NotSampled,
    Unavailable,
    Complete,
    ReadError,
    Timeout,
    Truncated,
    // Missing-MIME admission uses 64 KiB / 10 seconds, not rejection sampling.
    SsePrologPending,
    SsePrologAdmitted,
    SsePrologRejected,
    SsePrologTimeout,
    SsePrologReadError,
    SsePrologTruncated,
}
#[derive(Clone, Debug, Serialize)]
pub struct HttpEvidence {
    pub status: u16,
    pub media: MediaClass,
    pub body_class: Option<BodyClass>,
    pub sample_state: SampleState,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextState {
    Available,
    NoOrdinaryParts,
    MissingOrInvalidOutput,
    MalformedContent,
    UnsupportedKindOrPart,
    OverLimit,
    NoTerminal,
    NoDeltas,
    NotApplicable,
    NotValidated,
}

// Counts include duplicates and saturate at 4096 per request. No native items are retained.
const MAX_DIAGNOSTIC_COUNT: usize = 4096;
#[derive(Clone, Debug, Default, Serialize)]
pub struct FinalizedCounts {
    pub total: usize,
    pub message: usize,
    pub function_call: usize,
    pub reasoning: usize,
    pub other: usize,
    pub malformed: usize,
    pub overflow: bool,
}
fn increment(count: &mut usize) {
    *count = count.saturating_add(1).min(MAX_DIAGNOSTIC_COUNT);
}

// Diagnostic text stays private and bounded, independently of transport limits.
pub(super) const MAX_DIAGNOSTIC_TEXT: usize = 1024 * 1024;
fn ordinary_items<'a>(
    items: impl IntoIterator<Item = &'a Value>,
) -> std::result::Result<String, TextState> {
    let mut text = String::new();
    let mut seen = false;
    for item in items {
        match item
            .get("type")
            .and_then(Value::as_str)
            .ok_or(TextState::MalformedContent)?
        {
            "reasoning" | "function_call" => continue,
            "message" => {}
            _ => return Err(TextState::UnsupportedKindOrPart),
        }
        for part in item
            .get("content")
            .and_then(Value::as_array)
            .ok_or(TextState::MalformedContent)?
        {
            let kind = part
                .get("type")
                .and_then(Value::as_str)
                .ok_or(TextState::MalformedContent)?;
            if kind != "output_text" {
                return Err(TextState::UnsupportedKindOrPart);
            }
            let part = part
                .get("text")
                .and_then(Value::as_str)
                .ok_or(TextState::MalformedContent)?;
            if part.len() > MAX_DIAGNOSTIC_TEXT - text.len() {
                return Err(TextState::OverLimit);
            }
            text.push_str(part);
            seen = true;
        }
    }
    if seen {
        Ok(text)
    } else {
        Err(TextState::NoOrdinaryParts)
    }
}
fn ordinary_text(output: Option<&Value>) -> std::result::Result<String, TextState> {
    ordinary_items(
        output
            .and_then(Value::as_array)
            .ok_or(TextState::MissingOrInvalidOutput)?,
    )
}
#[derive(Clone, Default)]
pub struct SmokeObserver(Arc<Mutex<Vec<SendEvidence>>>);
impl SmokeObserver {
    pub fn snapshot(&self) -> Vec<SendEvidence> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

// This private state exists only when explicitly enabled. It lives with one Wire,
// so a second WS dispatch here really uses that Wire's original socket.
pub(super) struct Observation {
    observer: SmokeObserver,
    case: SmokeCase,
    transport: Transport,
    history: Vec<Value>,
    prior_id: Option<String>,
    prior_call: Option<String>,
    streamed_text: Mutex<Option<String>>,
}
impl Observation {
    pub fn new(observer: SmokeObserver, case: SmokeCase, transport: Transport) -> Self {
        Self {
            observer,
            case,
            transport,
            history: vec![],
            prior_id: None,
            prior_call: None,
            streamed_text: Mutex::new(Some(String::new())),
        }
    }
    pub fn send(&mut self, body: &Value) {
        let mut records = self.observer.0.lock().unwrap_or_else(|e| e.into_inner());
        *self.streamed_text.lock().unwrap_or_else(|e| e.into_inner()) = Some(String::new());
        let ordinal = records.len() + 1;
        let next = if ordinal == 1 {
            json!([{"role":"user","content":[{"type":"input_text","text":self.case.first_prompt()}]}])
        } else if self.case == SmokeCase::Tool {
            json!([{"type":"function_call_output","call_id":self.prior_call,"output":"{\"sum\":42}"}])
        } else {
            json!([{"role":"user","content":[{"type":"input_text","text":FOLLOW_UP}]}])
        };
        let mut full = self.history.clone();
        full.extend(next.as_array().unwrap().iter().cloned());
        let input = body.get("input").and_then(Value::as_array);
        let websocket = self.transport == Transport::WebSocket;
        let replay_equal = input == Some(&full) && body.get("previous_response_id").is_none();
        let opaque_present = self
            .history
            .iter()
            .any(|item| item.get("encrypted_content").is_some_and(|v| !v.is_null()));
        let opaque = if !opaque_present {
            OpaqueReplay::NotEmitted
        } else if input.is_some_and(|items| items.starts_with(&self.history)) {
            OpaqueReplay::Matched
        } else {
            OpaqueReplay::Mismatched
        };
        let result_linkage_equal = if ordinal == 2 && self.case == SmokeCase::Tool {
            Some(
                self.prior_call.is_some()
                    && input.and_then(|items| items.last()) == next.as_array().unwrap().first(),
            )
        } else {
            None
        };
        records.push(SendEvidence {
            transport: self.transport,
            ordinal,
            socket_reused: websocket && ordinal > 1,
            prior_response_equal: if websocket && ordinal > 1 {
                Some(
                    self.prior_id.is_some()
                        && body.get("previous_response_id").and_then(Value::as_str)
                            == self.prior_id.as_deref(),
                )
            } else {
                None
            },
            new_input_only_equal: if websocket {
                Some(body.get("input") == Some(&next))
            } else {
                None
            },
            native_sse_replay_equal: if websocket { None } else { Some(replay_equal) },
            opaque_replay: if !websocket && ordinal > 1 {
                Some(opaque)
            } else {
                None
            },
            result_linkage_equal,
            native_created_count: 0,
            terminal_type: None,
            terminal_status: None,
            validated_terminal: false,
            text_deltas: 0,
            refusal_deltas: 0,
            reasoning_deltas: 0,
            argument_deltas: 0,
            native_expected_text_equal: None,
            normalized_native_text_equal: None,
            streamed_native_text_equal: None,
            http: None,
            terminal_text_state: TextState::NoTerminal,
            streamed_text_state: TextState::NoDeltas,
            native_expected_text_unavailable: Some(if self.expected(ordinal).is_some() {
                TextState::NoTerminal
            } else {
                TextState::NotApplicable
            }),
            normalized_native_text_unavailable: Some(TextState::NotValidated),
            streamed_native_text_unavailable: Some(TextState::NoTerminal),
            finalized_items: FinalizedCounts::default(),
            native_terminal_items: None,
            effective_items: None,
            output_provenance: None,
            effective_text_state: TextState::NotValidated,
            effective_expected_text_equal: None,
            normalized_effective_text_equal: None,
            streamed_effective_text_equal: None,
        });
        if let Some(input) = input {
            if websocket {
                self.history.extend(input.iter().cloned());
            } else {
                self.history = input.clone();
            }
        }
    }
    pub fn native(&self, value: &Value) {
        let mut records = self.observer.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(record) = records.last_mut() else {
            return;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("response.created") => increment(&mut record.native_created_count),
            Some("response.output_item.done") => {
                let counts = &mut record.finalized_items;
                counts.overflow |= counts.total == MAX_DIAGNOSTIC_COUNT;
                increment(&mut counts.total);
                let count = match value.pointer("/item/type").and_then(Value::as_str) {
                    Some("message") => &mut counts.message,
                    Some("function_call") => &mut counts.function_call,
                    Some("reasoning") => &mut counts.reasoning,
                    Some(_) => &mut counts.other,
                    None => &mut counts.malformed,
                };
                increment(count);
            }
            Some("response.output_text.delta") => {
                increment(&mut record.text_deltas);
                let mut aggregate = self.streamed_text.lock().unwrap_or_else(|e| e.into_inner());
                match (
                    aggregate.as_mut(),
                    value.get("delta").and_then(Value::as_str),
                ) {
                    (Some(text), Some(delta))
                        if delta.len() <= MAX_DIAGNOSTIC_TEXT - text.len() =>
                    {
                        text.push_str(delta);
                        record.streamed_text_state = TextState::Available;
                    }
                    (Some(_), delta) => {
                        record.streamed_text_state = if delta.is_none() {
                            TextState::MalformedContent
                        } else {
                            TextState::OverLimit
                        };
                        *aggregate = None;
                    }
                    (None, _) => {}
                }
            }
            Some("response.refusal.delta") => increment(&mut record.refusal_deltas),
            Some("response.reasoning_text.delta" | "response.reasoning_summary_text.delta") => {
                increment(&mut record.reasoning_deltas)
            }
            Some(
                "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta",
            ) => increment(&mut record.argument_deltas),
            Some(kind) => {
                record.terminal_type = match kind {
                    "response.completed" => Some("response.completed"),
                    "response.done" => Some("response.done"),
                    "response.failed" => Some("response.failed"),
                    "response.incomplete" => Some("response.incomplete"),
                    "response.cancelled" => Some("response.cancelled"),
                    _ => return,
                };
                record.native_terminal_items = value
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                    .map(|v| v.len().min(MAX_DIAGNOSTIC_COUNT));
                record.native_expected_text_equal = None;
                record.streamed_native_text_equal = None;
                let native_text = ordinary_text(value.pointer("/response/output"));
                record.terminal_text_state = native_text
                    .as_ref()
                    .err()
                    .copied()
                    .unwrap_or(TextState::Available);
                record.native_expected_text_unavailable = if self.expected(record.ordinal).is_none()
                {
                    Some(TextState::NotApplicable)
                } else {
                    native_text.as_ref().err().copied()
                };
                record.streamed_native_text_unavailable =
                    native_text.as_ref().err().copied().or_else(|| {
                        (record.streamed_text_state != TextState::Available)
                            .then_some(record.streamed_text_state)
                    });
                if let Ok(text) = native_text {
                    record.native_expected_text_equal = self
                        .expected(record.ordinal)
                        .map(|expected| text.trim() == expected);
                    if record.text_deltas > 0 {
                        record.streamed_native_text_equal = self
                            .streamed_text
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .as_ref()
                            .map(|stream| stream == &text);
                    }
                }
                record.terminal_status = Some(
                    match value.pointer("/response/status").and_then(Value::as_str) {
                        Some("completed") => "completed",
                        Some("failed") => "failed",
                        Some("incomplete") => "incomplete",
                        Some("cancelled") => "cancelled",
                        _ => "unknown",
                    },
                );
            }
            None => {}
        }
    }
    fn expected(&self, ordinal: usize) -> Option<&'static str> {
        match (self.case, ordinal) {
            (SmokeCase::Text, 1) => Some("gateway connected"),
            (SmokeCase::Continuation, 1) => Some("remembered"),
            (SmokeCase::Continuation, 2) => Some("lantern"),
            (SmokeCase::Tool, 2) => Some("42"),
            _ => None,
        }
    }
    pub fn http(&self, evidence: HttpEvidence) {
        if let Some(record) = self
            .observer
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_mut()
        {
            record.http = Some(evidence);
        }
    }
    pub fn terminal(&mut self, response: &ModelResponse) {
        if let Some(record) = self
            .observer
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_mut()
        {
            record.validated_terminal = true;
            record.native_terminal_items = response
                .native
                .get("output")
                .and_then(Value::as_array)
                .map(|v| v.len().min(MAX_DIAGNOSTIC_COUNT));
            record.effective_items = Some(response.output.len().min(MAX_DIAGNOSTIC_COUNT));
            record.output_provenance = Some(response.output_provenance);
            let effective = ordinary_items(response.output.iter().map(|item| &item.native));
            record.effective_text_state = effective
                .as_ref()
                .err()
                .copied()
                .unwrap_or(TextState::Available);
            if let Ok(text) = effective {
                record.effective_expected_text_equal = self
                    .expected(record.ordinal)
                    .map(|expected| text.trim() == expected);
                record.normalized_effective_text_equal = Some(response.text == text);
                if record.text_deltas > 0 {
                    record.streamed_effective_text_equal = self
                        .streamed_text
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                        .map(|stream| stream == &text);
                }
            }
            record.native_expected_text_equal = None;
            record.normalized_native_text_equal = None;
            record.streamed_native_text_equal = None;
            let native_text = ordinary_text(response.native.get("output"));
            record.terminal_text_state = native_text
                .as_ref()
                .err()
                .copied()
                .unwrap_or(TextState::Available);
            record.native_expected_text_unavailable = if self.expected(record.ordinal).is_none() {
                Some(TextState::NotApplicable)
            } else {
                native_text.as_ref().err().copied()
            };
            record.normalized_native_text_unavailable = native_text.as_ref().err().copied();
            record.streamed_native_text_unavailable =
                native_text.as_ref().err().copied().or_else(|| {
                    (record.streamed_text_state != TextState::Available)
                        .then_some(record.streamed_text_state)
                });
            if let Ok(text) = native_text {
                record.native_expected_text_equal = self
                    .expected(record.ordinal)
                    .map(|expected| text.trim() == expected);
                let normalized = ordinary_items(response.output.iter().map(|item| &item.native));
                record.normalized_native_text_unavailable = normalized.as_ref().err().copied();
                record.normalized_native_text_equal = normalized
                    .ok()
                    .map(|normalized| normalized == text && response.text == text);
                if record.text_deltas > 0 {
                    record.streamed_native_text_equal = self
                        .streamed_text
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                        .map(|stream| stream == &text);
                }
            }
        }
        self.prior_id = Some(response.id.clone());
        self.prior_call = response
            .output
            .iter()
            .find_map(|item| item.function_call.as_ref().map(|call| call.call_id.clone()));
        self.history
            .extend(response.output.iter().map(|item| item.native.clone()));
    }
}

pub fn required_proof(records: &[SendEvidence], case: SmokeCase, transport: Transport) -> bool {
    records.len() == case.submissions()
        && records.iter().enumerate().all(|(index, r)| {
            r.ordinal == index + 1
                && r.transport == transport
                && r.native_created_count == 1
                && r.validated_terminal
                && matches!(
                    r.terminal_type,
                    Some("response.completed" | "response.done")
                )
                && r.terminal_status == Some("completed")
                && r.refusal_deltas == 0
                && match transport {
                    Transport::WebSocket => {
                        r.new_input_only_equal == Some(true)
                            && (index == 0
                                || (r.socket_reused && r.prior_response_equal == Some(true)))
                    }
                    Transport::Sse => {
                        r.native_sse_replay_equal == Some(true)
                            && (index == 0
                                || matches!(
                                    r.opaque_replay,
                                    Some(OpaqueReplay::Matched | OpaqueReplay::NotEmitted)
                                ))
                    }
                }
                && (case != SmokeCase::Tool || index == 0 || r.result_linkage_equal == Some(true))
        })
}
