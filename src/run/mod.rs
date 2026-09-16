//! One provider-neutral run with synchronous public and awaitable private observation.
mod collect;
pub mod events;
mod observer;
pub use events::{RunEvent, RunEventEnvelope, RunSinkError, TurnOutcome};
pub(crate) use observer::RunObserver;
use observer::SyncObserver;

use crate::{
    ConversationReplay, Gateway, GatewayError, InputItem, ItemKind, ModelResponse, ProviderEvent,
    ProviderSession, ResponseOutcome, SessionControl, SessionOptions, ToolDefinition, Transport,
    UpstreamOutcome,
    tools::{ToolExecutionEvent, ToolObserver, ToolRegistry},
    validate_input,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{future::Future, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRequest {
    pub provider_id: String,
    pub options: SessionOptions,
    pub prompt: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunOutcome {
    Completed,
    Failed { code: String },
    CancelledLocally,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct RunSummary {
    pub turns_started: u64,
    pub turns_finished: u64,
    pub model_requests_attempted: u64,
    pub model_requests_admitted: u64,
    pub new_tool_dispatches: u64,
    pub tool_results_prepared: u64,
    pub reused_results: u64,
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
fn increment(counter: &mut u64) -> Result<(), RunOutcome> {
    // Counters describe work; fail rather than wrap if the number cannot fit.
    *counter = counter
        .checked_add(1)
        .ok_or_else(|| failed("counter_overflow"))?;
    Ok(())
}
fn checkpoint(cancel: &CancellationToken) -> Result<(), RunOutcome> {
    if cancel.is_cancelled() {
        Err(RunOutcome::CancelledLocally)
    } else {
        Ok(())
    }
}
async fn stopped(cancel: &CancellationToken) -> RunOutcome {
    cancel.cancelled().await;
    RunOutcome::CancelledLocally
}
async fn cancellable<T>(
    cancel: &CancellationToken,
    future: impl Future<Output = T>,
) -> Result<T, RunOutcome> {
    tokio::select! {
        biased;
        reason = stopped(cancel) => Err(reason),
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

struct State<'a, O> {
    observer: &'a mut O,
    sequence: u64,
    run_id: String,
    session_id: Option<String>,
    turn_id: Option<String>,
    request_id: Option<String>,
    sink_error: Option<RunSinkError>,
    summary: RunSummary,
    last_response: Option<ModelResponse>,
}
impl<O: RunObserver> State<'_, O> {
    async fn send(&mut self, event: RunEvent) -> Result<(), RunOutcome> {
        if self.sink_error.is_some() {
            return Err(failed("event_sink"));
        }
        increment(&mut self.sequence)?;
        let envelope = RunEventEnvelope {
            schema_version: 2,
            sequence: self.sequence,
            event_id: Uuid::new_v4().to_string(),
            run_id: self.run_id.clone(),
            turn_id: self.turn_id.clone(),
            session_id: self.session_id.clone(),
            request_id: self.request_id.clone(),
            event,
        };
        if let Err(error) = self.observer.event(&envelope).await {
            self.sink_error = Some(error);
            return Err(failed("event_sink"));
        }
        Ok(())
    }
}

pub async fn run<F>(
    gateway: &Gateway,
    request: RunRequest,
    tools: &ToolRegistry,
    cancel: CancellationToken,
    emit: F,
) -> crate::Result<RunResult>
where
    F: FnMut(&RunEventEnvelope) -> Result<(), RunSinkError>,
{
    let admitted = admit(gateway, request, tools, &cancel)?;
    Ok(run_admitted(
        gateway,
        admitted,
        Uuid::new_v4(),
        cancel,
        &mut SyncObserver(emit),
    )
    .await)
}

pub(crate) struct AdmittedRun {
    provider_id: String,
    options: SessionOptions,
    input: Vec<InputItem>,
    scope: ToolRegistry,
    replay: Option<ConversationReplay>,
}

impl AdmittedRun {
    pub(crate) fn with_replay(
        mut self,
        gateway: &Gateway,
        replay: ConversationReplay,
    ) -> crate::Result<Self> {
        // Validate the exact snapshot and new input that provider opening and drive will use.
        gateway.validate_replay(&self.provider_id, &self.options, &replay, &self.input)?;
        self.replay = Some(replay);
        Ok(self)
    }
}

pub(crate) fn admit(
    gateway: &Gateway,
    request: RunRequest,
    tools: &ToolRegistry,
    cancel: &CancellationToken,
) -> crate::Result<AdmittedRun> {
    admit_with_snapshot(gateway, request, tools, cancel, None)
}

pub(crate) fn admit_with_snapshot(
    gateway: &Gateway,
    mut request: RunRequest,
    tools: &ToolRegistry,
    cancel: &CancellationToken,
    recorded_definitions: Option<&[ToolDefinition]>,
) -> crate::Result<AdmittedRun> {
    if !request.options.tools.is_empty() {
        return Err(GatewayError::InvalidRequest("caller tools must be empty"));
    }
    let input = vec![InputItem::user(request.prompt)];
    validate_input(&input)?;
    let scope = tools.fresh_scope();
    request.options.tools = scope.definitions();
    if let Some(recorded) = recorded_definitions {
        // Compare the same vector that validation and provider opening will use.
        let actual = serde_json::to_value(&request.options.tools)
            .map_err(|_| GatewayError::Serialization)?;
        let recorded = serde_json::to_value(recorded).map_err(|_| GatewayError::Serialization)?;
        if actual != recorded {
            return Err(GatewayError::InvalidRequest(
                "recorded tool definitions do not match registry",
            ));
        }
    }
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

    Ok(AdmittedRun {
        provider_id: request.provider_id,
        options: request.options,
        input,
        scope,
        replay: None,
    })
}

pub(crate) async fn run_admitted<O: RunObserver>(
    gateway: &Gateway,
    admitted: AdmittedRun,
    run_id: Uuid,
    cancel: CancellationToken,
    observer: &mut O,
) -> RunResult {
    let AdmittedRun {
        provider_id,
        options,
        input,
        mut scope,
        replay,
    } = admitted;
    let mut state = State {
        observer,
        sequence: 0,
        run_id: run_id.to_string(),
        session_id: None,
        turn_id: None,
        request_id: None,
        sink_error: None,
        summary: RunSummary::default(),
        last_response: None,
    };
    let mut guard = CloseGuard(None);
    let execution = async {
        state.send(RunEvent::RunStarted).await?;
        checkpoint(&cancel)?;
        let requested_model = options.model.clone();
        let mut session = cancellable(&cancel, gateway.open_session(&provider_id, options))
            .await?
            .map_err(|_| failed("session_open"))?;
        guard.0 = Some(session.control.clone());
        state.session_id = Some(session.id.clone());
        if let Some(replay) = replay {
            let identity = session
                .control
                .replay_identity()
                .ok_or_else(|| failed("history_identity"))?;
            if let Err(error) = state
                .observer
                .provider_opened(&session.id, &requested_model, &identity)
                .await
            {
                state.sink_error = Some(error);
                return Err(failed("event_sink"));
            }
            // Save the actual binding even when this account cannot receive the old history.
            if !replay.runs().is_empty() && replay.expected_identity() != Some(&identity) {
                return Err(failed("history_identity"));
            }
            checkpoint(&cancel)?;
            cancellable(&cancel, session.control.install_replay(replay))
                .await?
                .map_err(|_| failed("history_restore"))?;
        }
        let context = TurnContext {
            provider: &provider_id,
            cancel: &cancel,
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
    let events_complete = state
        .send(RunEvent::RunFinished {
            outcome: outcome.clone(),
            summary: state.summary.clone(),
        })
        .await
        .is_ok();
    RunResult {
        run_id: state.run_id,
        session_id: state.session_id,
        outcome,
        summary: state.summary,
        last_response: state.last_response,
        events_complete,
        sink_error: state.sink_error,
    }
}

struct TurnContext<'a> {
    provider: &'a str,
    cancel: &'a CancellationToken,
}

async fn drive<O: RunObserver>(
    state: &mut State<'_, O>,
    session: &mut ProviderSession,
    mut input: Vec<InputItem>,
    scope: &mut ToolRegistry,
    context: &TurnContext<'_>,
) -> Result<(), RunOutcome> {
    let mut sequence = None;
    let cancel = context.cancel;
    loop {
        checkpoint(cancel)?;
        state.turn_id = Some(Uuid::new_v4().to_string());
        state.request_id = None;
        increment(&mut state.summary.turns_started)?;
        state.summary.last_upstream_outcome = Some(UpstreamOutcome::NotSubmitted);
        let mut collector = collect::Collector::default();
        let turn = async {
            state
                .send(RunEvent::TurnStarted {
                    number: state.summary.turns_started,
                })
                .await?;
            checkpoint(cancel)?;
            // Count only when generate is actually polled, not when its future is built.
            let receipt = cancellable(cancel, async {
                increment(&mut state.summary.model_requests_attempted)?;
                state.summary.last_upstream_outcome = Some(UpstreamOutcome::Unknown);
                session.control.generate(input).await.map_err(|_| {
                    state.summary.last_upstream_outcome = Some(UpstreamOutcome::NotSubmitted);
                    failed("generate_rejected")
                })
            })
            .await??;
            increment(&mut state.summary.model_requests_admitted)?;
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
            increment(&mut state.summary.turns_finished)?;
            state
                .send(RunEvent::TurnFinished {
                    number: state.summary.turns_started,
                    response_id: collector.response_id,
                    outcome,
                    upstream_outcome: state.summary.last_upstream_outcome,
                })
                .await?;
        }
        match turn? {
            Some(results) => input = results,
            None => return Ok(()),
        }
    }
}

async fn collect_response<O: RunObserver>(
    state: &mut State<'_, O>,
    session: &mut ProviderSession,
    collector: &mut collect::Collector,
    sequence: &mut Option<u64>,
    context: &TurnContext<'_>,
) -> Result<(), RunOutcome> {
    loop {
        checkpoint(context.cancel)?;
        let event = cancellable(context.cancel, session.events.next())
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
        state
            .send(RunEvent::ProviderEvent {
                event: Box::new(event),
            })
            .await?;
        if let Some(result) = terminal {
            return result;
        }
    }
}

async fn prepare_tools<O: RunObserver>(
    state: &mut State<'_, O>,
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
    checkpoint(context.cancel)?;
    let mut batch = scope
        .preflight(response)
        .map_err(|_| failed("tool_preflight"))?;
    checkpoint(context.cancel)?;
    let mut results = Vec::new();
    while let Some(result) = batch
        .execute_next_observed(
            || checkpoint(context.cancel),
            stopped(context.cancel),
            state,
        )
        .await?
    {
        increment(&mut state.summary.tool_results_prepared)?;
        results.push(result);
    }
    checkpoint(context.cancel)?;
    // Tool effects are complete; reject an incompatible input without sending a subset.
    validate_input(&results).map_err(|_| failed("tool_result_input"))?;
    Ok(Some(results))
}

impl<O: RunObserver> ToolObserver<RunOutcome> for State<'_, O> {
    async fn event(&mut self, event: ToolExecutionEvent) -> Result<(), RunOutcome> {
        match &event {
            ToolExecutionEvent::ToolExecutionStarted { .. } => {
                increment(&mut self.summary.new_tool_dispatches)?
            }
            ToolExecutionEvent::ToolResultReused { .. } => {
                increment(&mut self.summary.reused_results)?
            }
            ToolExecutionEvent::ToolExecutionFinished { .. } => {}
        }
        self.send(RunEvent::ToolEvent { event }).await
    }

    async fn result(
        &mut self,
        call_id: &str,
        output: &str,
        is_error: bool,
    ) -> Result<(), RunOutcome> {
        if self.sink_error.is_some() {
            return Err(failed("event_sink"));
        }
        if let Err(error) = self
            .observer
            .tool_result(
                self.request_id.as_deref().unwrap(),
                call_id,
                output,
                is_error,
            )
            .await
        {
            self.sink_error = Some(error);
            return Err(failed("event_sink"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod observation_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_cross_u32_and_fail_without_wrapping_at_u64() {
        let mut counter = u64::from(u32::MAX);
        increment(&mut counter).unwrap();
        assert_eq!(counter, u64::from(u32::MAX) + 1);
        counter = u64::MAX - 1;
        increment(&mut counter).unwrap();
        assert_eq!(counter, u64::MAX);
        assert_eq!(increment(&mut counter), Err(failed("counter_overflow")));
        assert_eq!(counter, u64::MAX);
    }

    #[tokio::test]
    async fn event_sequence_overflow_fails_delivery_without_wrapping() {
        let mut events = Vec::new();
        let mut observer = SyncObserver(|event: &RunEventEnvelope| {
            events.push(event.clone());
            Ok(())
        });
        let mut state = State {
            observer: &mut observer,
            sequence: u64::MAX - 1,
            run_id: "synthetic".into(),
            session_id: None,
            turn_id: None,
            request_id: None,
            sink_error: None,
            summary: RunSummary::default(),
            last_response: None,
        };
        state.send(RunEvent::RunStarted).await.unwrap();
        assert_eq!(
            state
                .send(RunEvent::RunFinished {
                    outcome: RunOutcome::Completed,
                    summary: RunSummary::default(),
                })
                .await,
            Err(failed("counter_overflow"))
        );
        assert_eq!(state.sequence, u64::MAX);
        assert_eq!(state.sink_error, None);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].sequence, u64::MAX);
    }

    #[tokio::test]
    async fn ready_cancellation_does_not_poll_ready_work() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = cancellable(&cancel, async { panic!("cancelled work was polled") }).await;
        assert_eq!(result, Err::<(), _>(RunOutcome::CancelledLocally));
    }
}
