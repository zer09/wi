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
        }
    }
    pub fn send(&mut self, body: &Value) {
        let mut records = self.observer.0.lock().unwrap_or_else(|e| e.into_inner());
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
            Some("response.created") => record.native_created_count += 1,
            Some("response.output_text.delta") => record.text_deltas += 1,
            Some("response.refusal.delta") => record.refusal_deltas += 1,
            Some("response.reasoning_text.delta" | "response.reasoning_summary_text.delta") => {
                record.reasoning_deltas += 1
            }
            Some(
                "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta",
            ) => record.argument_deltas += 1,
            Some(kind) => {
                record.terminal_type = match kind {
                    "response.completed" => Some("response.completed"),
                    "response.done" => Some("response.done"),
                    "response.failed" => Some("response.failed"),
                    "response.incomplete" => Some("response.incomplete"),
                    "response.cancelled" => Some("response.cancelled"),
                    _ => return,
                };
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
    pub fn terminal(&mut self, response: &ModelResponse) {
        if let Some(record) = self
            .observer
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_mut()
        {
            record.validated_terminal = true;
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
