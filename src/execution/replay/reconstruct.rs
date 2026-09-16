use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use super::{Result, incomplete, metadata, provenance};
use crate::{
    InputItem, ModelResponse, ProviderEvent, ReplayExchange, UpstreamOutcome,
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunResult, RunSummary, TurnOutcome},
    storage::{
        AcceptedPayload, RecordedProviderBinding, RunId, StoredHistorySelection, ToolResultPayload,
    },
    tools::ToolExecutionEvent,
};

pub(super) struct ActiveRun {
    pub run_id: RunId,
    pub accepted_sequence: u64,
    prompt: String,
    provider: String,
    model: String,
    selection: Option<StoredHistorySelection>,
    binding: Option<RecordedProviderBinding>,
    started: bool,
    runtime_sequence: u64,
    provider_sequence: Option<u64>,
    turns_started: u64,
    turns_finished: u64,
    next_turn_allowed: bool,
    request_ids: HashSet<String>,
    turn_ids: HashSet<String>,
    last_request: Option<String>,
    runtime_request: Option<String>,
    turn: Option<Turn>,
    unfinished_result: bool,
    exchanges: Vec<ReplayExchange>,
    saved: HashMap<String, SavedResult>,
    terminal: Option<(RunOutcome, RunSummary)>,
}

struct SavedResult {
    name: String,
    arguments: Value,
    // Keep the original request and actual flag, not a guessed flag from output JSON.
    request: String,
    output: String,
    is_error: bool,
}

#[derive(Default)]
struct Turn {
    id: String,
    request: Option<String>,
    response_id: Option<String>,
    response_started: bool,
    response: Option<ModelResponse>,
    results: Vec<InputItem>,
    intent: Option<String>,
    unfinished_result: Option<String>,
}

impl ActiveRun {
    pub fn new(accepted_sequence: u64, accepted: &AcceptedPayload) -> Self {
        let request = accepted.input().prepared_request();
        Self {
            run_id: accepted.run_id().clone(),
            accepted_sequence,
            prompt: request.prompt.clone(),
            provider: request.provider_id.clone(),
            model: request.options.model.clone(),
            selection: None,
            binding: None,
            started: false,
            runtime_sequence: 0,
            provider_sequence: None,
            turns_started: 0,
            turns_finished: 0,
            next_turn_allowed: true,
            request_ids: HashSet::new(),
            turn_ids: HashSet::new(),
            last_request: None,
            runtime_request: None,
            turn: None,
            unfinished_result: false,
            exchanges: Vec::new(),
            saved: HashMap::new(),
            terminal: None,
        }
    }

    pub fn require_selection(&self) -> Result<()> {
        self.selection.as_ref().ok_or_else(provenance).map(|_| ())
    }

    pub fn select(&mut self, sequence: u64, selection: &StoredHistorySelection) -> Result<()> {
        if self.selection.is_some()
            || sequence != self.accepted_sequence + 1
            || selection.through_sequence() != self.accepted_sequence - 1
            || selection.provider_id() != self.provider
            || selection.requested_model() != self.model
        {
            return Err(metadata());
        }
        self.selection = Some(selection.clone());
        Ok(())
    }

    pub fn bind(&mut self, binding: &RecordedProviderBinding) -> Result<()> {
        self.require_selection()?;
        if !self.started
            || self.runtime_sequence != 1
            || self.binding.is_some()
            || binding.run_id() != &self.run_id
            || binding.identity().provider_id() != self.provider
            || binding.requested_model() != self.model
        {
            return Err(metadata());
        }
        self.binding = Some(binding.clone());
        Ok(())
    }

    pub fn runtime(&mut self, event: &RunEventEnvelope) -> Result<()> {
        self.require_selection()?;
        if event.run_id != self.run_id.as_str()
            || event.sequence != self.runtime_sequence + 1
            || self.terminal.is_some()
        {
            return Err(incomplete());
        }
        self.runtime_sequence = event.sequence;
        if let Some(binding) = &self.binding
            && event.session_id.as_deref() != Some(binding.provider_session_id())
        {
            return Err(metadata());
        }
        match &event.event {
            RunEvent::RunStarted => {
                if self.started || event.sequence != 1 {
                    return Err(metadata());
                }
                self.started = true;
            }
            RunEvent::RunFinished { outcome, summary } => {
                if self.turn.is_some() || event.request_id != self.runtime_request {
                    return Err(incomplete());
                }
                self.terminal = Some((outcome.clone(), summary.clone()));
            }
            RunEvent::TurnStarted { number } => {
                if !self.started
                    || self.binding.is_none()
                    || self.turn.is_some()
                    || !self.next_turn_allowed
                    || *number != self.turns_started + 1
                    || self
                        .exchanges
                        .last()
                        .is_some_and(|last| last.tool_results().is_empty())
                {
                    return Err(incomplete());
                }
                let id = event.turn_id.clone().ok_or_else(metadata)?;
                if !self.turn_ids.insert(id.clone()) {
                    return Err(incomplete());
                }
                self.turns_started += 1;
                // A cancelled new turn has no request, although the summary still
                // identifies the last admitted request from an earlier turn.
                self.runtime_request = None;
                self.turn = Some(Turn {
                    id,
                    ..Turn::default()
                });
            }
            _ => {
                let turn = self.turn.as_mut().ok_or_else(incomplete)?;
                if event.turn_id.as_ref() != Some(&turn.id) {
                    return Err(incomplete());
                }
                if let Some(request) = &event.request_id {
                    if turn.request.as_ref().is_some_and(|old| old != request) || request.is_empty()
                    {
                        return Err(incomplete());
                    }
                    if turn.request.is_none() {
                        if !self.request_ids.insert(request.clone()) {
                            return Err(incomplete());
                        }
                        turn.request = Some(request.clone());
                        self.last_request = Some(request.clone());
                        self.runtime_request = Some(request.clone());
                    }
                } else if turn.request.is_some() {
                    return Err(incomplete());
                }
                match &event.event {
                    RunEvent::ProviderEvent { event: provider } => {
                        if provider.provider != self.provider
                            || provider.request_id != turn.request
                            || provider.session_id
                                != event.session_id.as_deref().ok_or_else(metadata)?
                            || self
                                .provider_sequence
                                .is_some_and(|old| provider.sequence <= old)
                            || turn.response.is_some()
                        {
                            return Err(incomplete());
                        }
                        self.provider_sequence = Some(provider.sequence);
                        turn.provider(&provider.event)?;
                    }
                    RunEvent::ToolEvent { event } => turn.tool_event(event, &mut self.saved)?,
                    RunEvent::TurnFinished {
                        number,
                        response_id,
                        outcome,
                        upstream_outcome,
                    } => {
                        if *number != self.turns_started || response_id != &turn.response_id {
                            return Err(incomplete());
                        }
                        if let Some(response) = &turn.response {
                            if *upstream_outcome != Some(UpstreamOutcome::TerminalReceived) {
                                return Err(incomplete());
                            }
                            let calls = response
                                .output
                                .iter()
                                .any(|item| item.function_call.is_some());
                            if matches!(outcome, TurnOutcome::ToolsPrepared) && !calls
                                || matches!(outcome, TurnOutcome::ModelCompleted) && calls
                            {
                                return Err(incomplete());
                            }
                        } else if !matches!(outcome, TurnOutcome::Stopped { .. }) {
                            return Err(incomplete());
                        }
                        self.next_turn_allowed = matches!(outcome, TurnOutcome::ToolsPrepared)
                            && turn.unfinished_result.is_none();
                        self.finish_turn()?;
                        self.turns_finished += 1;
                    }
                    _ => return Err(metadata()),
                }
            }
        }
        Ok(())
    }

    pub fn tool_result(&mut self, result: &ToolResultPayload) -> Result<()> {
        self.require_selection()?;
        let turn = self.turn.as_mut().ok_or_else(incomplete)?;
        let call = turn.next_call()?;
        if turn.intent.as_deref() != Some(result.call_id())
            || call.call_id != result.call_id()
            || result.request_id() != turn.request.as_deref()
            || self.saved.contains_key(result.call_id())
        {
            return Err(incomplete());
        }
        self.saved.insert(
            call.call_id.clone(),
            SavedResult {
                name: call.name.clone(),
                arguments: arguments(&call.arguments)?,
                request: turn.request.clone().ok_or_else(incomplete)?,
                output: result.output().into(),
                is_error: result.is_error(),
            },
        );
        turn.results.push(InputItem::ToolResult {
            call_id: result.call_id().into(),
            output: result.output().into(),
        });
        turn.intent = None;
        turn.unfinished_result = Some(result.call_id().into());
        Ok(())
    }

    fn finish_turn(&mut self) -> Result<()> {
        let turn = self.turn.take().ok_or_else(incomplete)?;
        self.unfinished_result |= turn.unfinished_result.is_some();
        if let Some(response) = turn.response {
            if turn.intent.is_some() {
                return Err(incomplete());
            }
            self.exchanges
                .push(ReplayExchange::new(response, turn.results).map_err(|_| incomplete())?);
        } else if turn.request.is_some() || turn.response_id.is_some() {
            return Err(incomplete());
        }
        Ok(())
    }

    pub fn close(mut self, interrupted: bool) -> Result<ClosedRun> {
        self.require_selection()?;
        // Process loss can excuse a missing finish only while its turn is still open.
        if self.unfinished_result {
            return Err(incomplete());
        }
        if self.turn.is_some() {
            self.finish_turn()?;
        }
        if self.unfinished_result && !interrupted {
            return Err(incomplete());
        }
        Ok(ClosedRun {
            run_id: self.run_id,
            prompt: self.prompt,
            selection: self.selection.unwrap(),
            binding: self.binding,
            exchanges: self.exchanges,
            terminal: self.terminal,
            turns_started: self.turns_started,
            turns_finished: self.turns_finished,
            last_request: self.last_request,
            interrupted,
            result_seen: false,
        })
    }
}

impl Turn {
    fn provider(&mut self, event: &ProviderEvent) -> Result<()> {
        let id = match event {
            ProviderEvent::ResponseStarted { response_id } => {
                if self.response_started {
                    return Err(incomplete());
                }
                self.response_started = true;
                Some(response_id)
            }
            ProviderEvent::ResponseStatus { response_id, .. }
            | ProviderEvent::OutputItemStarted { response_id, .. }
            | ProviderEvent::OutputItemUpdated { response_id, .. }
            | ProviderEvent::OutputItemFinished { response_id, .. } => Some(response_id),
            ProviderEvent::ResponseFinished { response } => {
                crate::provider::replay::validate_response(response).map_err(|_| incomplete())?;
                self.response = Some(response.clone());
                Some(&response.id)
            }
            ProviderEvent::ProviderExtension { .. } => None,
            ProviderEvent::RequestFailed { .. } | ProviderEvent::SessionClosed { .. } => {
                return Err(incomplete());
            }
        };
        if let Some(id) = id {
            if id.is_empty() || self.response_id.as_ref().is_some_and(|old| old != id) {
                return Err(incomplete());
            }
            self.response_id = Some(id.clone());
        }
        Ok(())
    }

    fn next_call(&self) -> Result<&crate::FunctionCall> {
        self.response
            .as_ref()
            .ok_or_else(incomplete)?
            .output
            .iter()
            .filter_map(|item| item.function_call.as_ref())
            .nth(self.results.len())
            .ok_or_else(incomplete)
    }

    fn tool_event(
        &mut self,
        event: &ToolExecutionEvent,
        saved: &mut HashMap<String, SavedResult>,
    ) -> Result<()> {
        if let ToolExecutionEvent::ToolExecutionFinished {
            call_id,
            tool_name,
            is_error,
        } = event
        {
            let old = saved.get(call_id).ok_or_else(incomplete)?;
            if self.unfinished_result.as_ref() != Some(call_id)
                || old.name != *tool_name
                || old.is_error != *is_error
                || self.request.as_ref() != Some(&old.request)
            {
                return Err(incomplete());
            }
            self.unfinished_result = None;
            return Ok(());
        }
        if self.intent.is_some() || self.unfinished_result.is_some() {
            return Err(incomplete());
        }
        let call = self.next_call()?;
        match event {
            ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name } => {
                if call.call_id != *call_id
                    || call.name != *tool_name
                    || saved.contains_key(call_id)
                {
                    return Err(incomplete());
                }
                self.intent = Some(call_id.clone());
            }
            ToolExecutionEvent::ToolResultReused { call_id, tool_name } => {
                let old = saved.get(call_id).ok_or_else(incomplete)?;
                if call.call_id != *call_id
                    || call.name != *tool_name
                    || old.name != *tool_name
                    || old.arguments != arguments(&call.arguments)?
                    || self.request.as_ref() == Some(&old.request)
                {
                    return Err(incomplete());
                }
                self.results.push(InputItem::ToolResult {
                    call_id: call_id.clone(),
                    output: old.output.clone(),
                });
            }
            _ => return Err(incomplete()),
        }
        Ok(())
    }
}

pub(super) struct ClosedRun {
    pub run_id: RunId,
    pub prompt: String,
    pub selection: StoredHistorySelection,
    pub binding: Option<RecordedProviderBinding>,
    pub exchanges: Vec<ReplayExchange>,
    terminal: Option<(RunOutcome, RunSummary)>,
    turns_started: u64,
    turns_finished: u64,
    last_request: Option<String>,
    interrupted: bool,
    result_seen: bool,
}
impl ClosedRun {
    pub fn result(&mut self, result: &RunResult) -> Result<()> {
        if self.result_seen
            || result.run_id != self.run_id.as_str()
            || result.summary.model_requests_attempted != self.exchanges.len() as u64
            || result.summary.model_requests_admitted != self.exchanges.len() as u64
            || result.summary.turns_started != self.turns_started
            || result.summary.turns_finished < self.turns_finished
            || result.summary.turns_finished > self.turns_started
            || result.summary.last_request_id != self.last_request
            || !equal(
                &result.last_response,
                &self.exchanges.last().map(|exchange| exchange.response()),
            )?
        {
            return Err(incomplete());
        }
        if let Some(binding) = &self.binding
            && result.session_id.as_deref() != Some(binding.provider_session_id())
        {
            return Err(metadata());
        }
        if let Some((outcome, summary)) = &self.terminal {
            if *outcome != result.outcome || !equal(summary, &result.summary)? {
                return Err(incomplete());
            }
        } else if result.events_complete {
            return Err(incomplete());
        }
        if matches!(result.outcome, RunOutcome::Completed)
            && self
                .exchanges
                .last()
                .is_none_or(|exchange| !exchange.tool_results().is_empty())
        {
            return Err(incomplete());
        }
        if self.exchanges.is_empty()
            && (result.summary.new_tool_dispatches != 0
                || result.summary.tool_results_prepared != 0
                || result.summary.reused_results != 0)
        {
            return Err(incomplete());
        }
        self.result_seen = true;
        Ok(())
    }
    pub fn require_result(&self) -> Result<()> {
        // Restart proves storage termination, not non-submission. Without a result,
        // every started turn needs a closed exchange, including any trailing turn.
        if !self.result_seen
            && (!self.interrupted
                || self.exchanges.is_empty()
                || self.turns_started != self.exchanges.len() as u64)
        {
            return Err(incomplete());
        }
        Ok(())
    }
}

fn arguments(encoded: &str) -> Result<Value> {
    serde_json::from_str(encoded).map_err(|_| incomplete())
}
fn equal(left: &impl Serialize, right: &impl Serialize) -> Result<bool> {
    Ok(serde_json::to_value(left).map_err(|_| metadata())?
        == serde_json::to_value(right).map_err(|_| metadata())?)
}
