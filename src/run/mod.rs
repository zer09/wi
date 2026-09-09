//! One provider-neutral, bounded run with synchronous fallible observation.
mod collect;
pub mod events;
pub use events::{RunEvent, RunEventEnvelope, RunSinkError, TurnOutcome};

use crate::{
    Gateway, GatewayError, InputItem, ItemKind, ModelResponse, ProviderEvent, ProviderSession,
    ResponseOutcome, SessionControl, SessionOptions, Transport, UpstreamOutcome,
    tools::{ToolExecutionEvent, ToolRegistry},
    validate_input,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct RunRequest {
    pub provider_id: String,
    pub options: SessionOptions,
    pub prompt: String,
    pub limits: RunLimits,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunLimits {
    pub max_model_requests: u32,
    pub max_tool_executions: u32,
    pub deadline: Duration,
}
impl Default for RunLimits {
    fn default() -> Self {
        Self {
            max_model_requests: 4,
            max_tool_executions: 8,
            deadline: Duration::from_secs(120),
        }
    }
}
impl RunLimits {
    pub fn validate(&self) -> crate::Result<()> {
        if !(1..=32).contains(&self.max_model_requests)
            || self.max_tool_executions > 128
            || self.deadline.is_zero()
            || self.deadline > Duration::from_secs(600)
        {
            return Err(GatewayError::InvalidRequest("invalid run limits"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunOutcome {
    Completed,
    LimitReached { limit: LimitKind },
    Failed { code: String },
    CancelledLocally,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitKind {
    ModelRequests,
    ToolExecutions,
    Deadline,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct RunSummary {
    pub turns_started: u32,
    pub turns_finished: u32,
    pub model_requests_attempted: u32,
    pub model_requests_admitted: u32,
    pub new_tool_dispatches: u32,
    pub tool_results_prepared: u32,
    pub reused_results: u32,
    pub last_request_id: Option<String>,
    pub last_upstream_outcome: Option<UpstreamOutcome>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub run_id: String,
    pub session_id: Option<String>,
    pub outcome: RunOutcome,
    pub summary: RunSummary,
    pub last_response: Option<ModelResponse>,
    pub events_complete: bool,
    pub sink_error: Option<RunSinkError>,
}

fn failed(code: &'static str) -> RunOutcome {
    RunOutcome::Failed { code: code.into() }
}
impl From<GatewayError> for RunOutcome {
    fn from(_: GatewayError) -> Self {
        failed("tool_execution")
    }
}
fn limit(limit: LimitKind) -> RunOutcome {
    RunOutcome::LimitReached { limit }
}
fn checkpoint(cancel: &CancellationToken, deadline: Instant) -> Result<(), RunOutcome> {
    if cancel.is_cancelled() {
        Err(RunOutcome::CancelledLocally)
    } else if Instant::now() >= deadline {
        Err(limit(LimitKind::Deadline))
    } else {
        Ok(())
    }
}
async fn stopped(cancel: &CancellationToken, deadline: Instant) -> RunOutcome {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => RunOutcome::CancelledLocally,
        _ = tokio::time::sleep_until(deadline) => limit(LimitKind::Deadline),
    }
}
async fn bounded<T>(
    cancel: &CancellationToken,
    deadline: Instant,
    future: impl Future<Output = T>,
) -> Result<T, RunOutcome> {
    tokio::select! {
        biased;
        reason = stopped(cancel, deadline) => Err(reason),
        result = future => Ok(result),
    }
}

struct CloseGuard(Option<Arc<dyn SessionControl>>);
impl CloseGuard {
    fn close(&mut self) {
        if let Some(control) = self.0.take() {
            control.close();
        }
    }
}
impl Drop for CloseGuard {
    fn drop(&mut self) {
        self.close();
    }
}

struct State<F> {
    emit: F,
    sequence: u64,
    run_id: String,
    session_id: Option<String>,
    turn_id: Option<String>,
    request_id: Option<String>,
    sink_error: Option<RunSinkError>,
    summary: RunSummary,
    last_response: Option<ModelResponse>,
}
impl<F: FnMut(&RunEventEnvelope) -> Result<(), RunSinkError>> State<F> {
    fn send(&mut self, event: RunEvent) -> Result<(), RunOutcome> {
        if self.sink_error.is_some() {
            return Err(failed("event_sink"));
        }
        self.sequence += 1;
        let envelope = RunEventEnvelope {
            schema_version: 1,
            sequence: self.sequence,
            event_id: Uuid::new_v4().to_string(),
            run_id: self.run_id.clone(),
            turn_id: self.turn_id.clone(),
            session_id: self.session_id.clone(),
            request_id: self.request_id.clone(),
            event,
        };
        if let Err(error) = (self.emit)(&envelope) {
            self.sink_error = Some(error);
            return Err(failed("event_sink"));
        }
        Ok(())
    }
}

pub async fn run<F>(
    gateway: &Gateway,
    mut request: RunRequest,
    tools: &ToolRegistry,
    cancel: CancellationToken,
    emit: F,
) -> crate::Result<RunResult>
where
    F: FnMut(&RunEventEnvelope) -> Result<(), RunSinkError>,
{
    request.limits.validate()?;
    if !request.options.tools.is_empty() {
        return Err(GatewayError::InvalidRequest("caller tools must be empty"));
    }
    let input = vec![InputItem::user(request.prompt)];
    validate_input(&input)?;
    let mut scope = tools.fresh_scope();
    request.options.tools = scope.definitions();
    request.options.validate()?;
    let capabilities = gateway.capabilities(&request.provider_id)?;
    let transport = match request.options.transport {
        Transport::WebSocket => &capabilities.websocket,
        Transport::Sse => &capabilities.sse,
    };
    if !transport.implemented {
        return Err(GatewayError::UnsupportedFeature("transport"));
    }
    if !request.options.tools.is_empty() && !capabilities.function_tools.implemented {
        return Err(GatewayError::UnsupportedFeature("function_tools"));
    }
    if !request.options.tools.is_empty() && !capabilities.continuation.implemented {
        return Err(GatewayError::UnsupportedFeature("continuation"));
    }
    capabilities.require(&request.options.required_features)?;
    if cancel.is_cancelled() {
        return Err(GatewayError::InvalidRequest("run pre-cancelled"));
    }

    let deadline = Instant::now() + request.limits.deadline;
    let mut state = State {
        emit,
        sequence: 0,
        run_id: Uuid::new_v4().to_string(),
        session_id: None,
        turn_id: None,
        request_id: None,
        sink_error: None,
        summary: RunSummary::default(),
        last_response: None,
    };
    let mut guard = CloseGuard(None);
    let execution = async {
        state.send(RunEvent::RunStarted {
            limits: request.limits.clone(),
        })?;
        checkpoint(&cancel, deadline)?;
        let mut session = bounded(
            &cancel,
            deadline,
            gateway.open_session(&request.provider_id, request.options),
        )
        .await?
        .map_err(|_| failed("session_open"))?;
        guard.0 = Some(session.control.clone());
        state.session_id = Some(session.id.clone());
        let context = TurnContext {
            provider: &request.provider_id,
            limits: &request.limits,
            cancel: &cancel,
            deadline,
        };
        drive(&mut state, &mut session, input, &mut scope, &context).await
    }
    .await;
    let outcome = match execution {
        Ok(()) => RunOutcome::Completed,
        Err(reason) => reason,
    };
    guard.close();
    state.turn_id = None;
    // Final delivery cannot rewrite the execution outcome or trigger a second final.
    let _ = state.send(RunEvent::RunFinished {
        outcome: outcome.clone(),
        summary: state.summary.clone(),
    });
    Ok(RunResult {
        run_id: state.run_id,
        session_id: state.session_id,
        outcome,
        summary: state.summary,
        last_response: state.last_response,
        events_complete: state.sink_error.is_none(),
        sink_error: state.sink_error,
    })
}

struct TurnContext<'a> {
    provider: &'a str,
    limits: &'a RunLimits,
    cancel: &'a CancellationToken,
    deadline: Instant,
}

async fn drive<F: FnMut(&RunEventEnvelope) -> Result<(), RunSinkError>>(
    state: &mut State<F>,
    session: &mut ProviderSession,
    mut input: Vec<InputItem>,
    scope: &mut ToolRegistry,
    context: &TurnContext<'_>,
) -> Result<(), RunOutcome> {
    let mut sequence = None;
    let TurnContext {
        limits,
        cancel,
        deadline,
        ..
    } = *context;
    loop {
        checkpoint(cancel, deadline)?;
        if state.summary.model_requests_attempted >= limits.max_model_requests {
            return Err(limit(LimitKind::ModelRequests));
        }
        state.turn_id = Some(Uuid::new_v4().to_string());
        state.request_id = None;
        state.summary.turns_started += 1;
        state.summary.last_upstream_outcome = Some(UpstreamOutcome::NotSubmitted);
        let mut collector = collect::Collector::default();
        let turn = async {
            state.send(RunEvent::TurnStarted {
                number: state.summary.turns_started,
            })?;
            checkpoint(cancel, deadline)?;
            // Count only when generate is actually polled, not when its future is built.
            let generation = bounded(cancel, deadline, async {
                state.summary.model_requests_attempted += 1;
                state.summary.last_upstream_outcome = Some(UpstreamOutcome::Unknown);
                session.control.generate(input).await
            })
            .await?;
            let receipt = generation.map_err(|_| {
                state.summary.last_upstream_outcome = Some(UpstreamOutcome::NotSubmitted);
                failed("generate_rejected")
            })?;
            state.summary.model_requests_admitted += 1;
            state.request_id = Some(receipt.request_id.clone());
            state.summary.last_request_id = Some(receipt.request_id);
            collect_response(state, session, &mut collector, &mut sequence, context).await?;
            prepare_tools(state, scope, context).await
        }
        .await;
        let outcome = match &turn {
            Ok(Some(_)) => TurnOutcome::ToolsPrepared,
            Ok(None) => TurnOutcome::ModelCompleted,
            Err(reason) => TurnOutcome::Stopped {
                reason: reason.clone(),
            },
        };
        if state.sink_error.is_none() {
            state.summary.turns_finished += 1;
            state.send(RunEvent::TurnFinished {
                number: state.summary.turns_started,
                response_id: collector.response_id,
                outcome,
                upstream_outcome: state.summary.last_upstream_outcome,
            })?;
        }
        match turn? {
            Some(results) => input = results,
            None => return Ok(()),
        }
    }
}

async fn collect_response<F: FnMut(&RunEventEnvelope) -> Result<(), RunSinkError>>(
    state: &mut State<F>,
    session: &mut ProviderSession,
    collector: &mut collect::Collector,
    sequence: &mut Option<u64>,
    context: &TurnContext<'_>,
) -> Result<(), RunOutcome> {
    loop {
        checkpoint(context.cancel, context.deadline)?;
        let event = bounded(context.cancel, context.deadline, session.events.next())
            .await?
            .ok_or_else(|| failed("provider_eof"))?;
        collector.observe(
            &event,
            &session.id,
            context.provider,
            state.request_id.as_deref().unwrap(),
            sequence,
        )?;
        let terminal = match &event.event {
            ProviderEvent::ResponseFinished { response } => {
                state.summary.last_upstream_outcome = Some(UpstreamOutcome::TerminalReceived);
                state.last_response = Some(response.clone());
                Some(Ok(()))
            }
            ProviderEvent::RequestFailed {
                upstream_outcome, ..
            } => {
                state.summary.last_upstream_outcome = Some(*upstream_outcome);
                Some(Err(failed("provider_request_failed")))
            }
            _ => None,
        };
        state.send(RunEvent::ProviderEvent {
            event: Box::new(event),
        })?;
        if let Some(result) = terminal {
            return result;
        }
    }
}

async fn prepare_tools<F: FnMut(&RunEventEnvelope) -> Result<(), RunSinkError>>(
    state: &mut State<F>,
    scope: &mut ToolRegistry,
    context: &TurnContext<'_>,
) -> Result<Option<Vec<InputItem>>, RunOutcome> {
    let response = state.last_response.as_ref().unwrap();
    match response.outcome {
        ResponseOutcome::Completed => {}
        ResponseOutcome::Incomplete { .. } => return Err(failed("model_incomplete")),
        ResponseOutcome::Failed => return Err(failed("model_failed")),
        ResponseOutcome::Cancelled => return Err(failed("model_cancelled")),
    }
    if response.output.iter().any(|item| {
        !matches!(
            item.kind,
            ItemKind::Message | ItemKind::Reasoning | ItemKind::FunctionCall
        )
    }) {
        return Err(failed("unsupported_output"));
    }
    if !response
        .output
        .iter()
        .any(|item| item.kind == ItemKind::FunctionCall)
    {
        return Ok(None);
    }
    // Terminal completion wins; only pending tool work needs another stop check.
    checkpoint(context.cancel, context.deadline)?;
    let mut batch = scope
        .preflight(response)
        .map_err(|_| failed("tool_preflight"))?;
    checkpoint(context.cancel, context.deadline)?;
    if state.summary.model_requests_attempted >= context.limits.max_model_requests {
        return Err(limit(LimitKind::ModelRequests));
    }
    if state.summary.new_tool_dispatches as usize + batch.new_executions
        > context.limits.max_tool_executions as usize
    {
        return Err(limit(LimitKind::ToolExecutions));
    }
    let mut results = Vec::new();
    while let Some(result) = batch
        .execute_next(
            || checkpoint(context.cancel, context.deadline),
            stopped(context.cancel, context.deadline),
            |event| {
                match &event {
                    ToolExecutionEvent::ToolExecutionStarted { .. } => {
                        state.summary.new_tool_dispatches += 1
                    }
                    ToolExecutionEvent::ToolResultReused { .. } => {
                        state.summary.reused_results += 1
                    }
                    ToolExecutionEvent::ToolExecutionFinished { .. } => {}
                }
                state.send(RunEvent::ToolEvent { event })
            },
        )
        .await?
    {
        state.summary.tool_results_prepared += 1;
        results.push(result);
    }
    checkpoint(context.cancel, context.deadline)?;
    Ok(Some(results))
}
