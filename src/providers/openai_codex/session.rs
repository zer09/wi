use super::{PROVIDER_ID, codec::ResponseDecoder, state::Conversation, wire::Wire};
use crate::{
    EventEnvelope, GatewayError, InputItem, ModelResponse, ProviderEvent, ProviderSession,
    RequestReceipt, ResponseOutcome, Result, SessionControl, SessionOptions, UpstreamOutcome,
    validate_input,
};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub(super) struct Timeouts {
    pub connect: Duration,
    pub idle: Duration,
    pub total: Duration,
    pub consumer: Duration,
}
impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            idle: Duration::from_secs(90),
            total: Duration::from_secs(600),
            consumer: Duration::from_secs(30),
        }
    }
}
struct Flags {
    busy: AtomicBool,
    closed: AtomicBool,
}
struct Generate {
    input: Vec<InputItem>,
    reply: oneshot::Sender<Result<RequestReceipt>>,
}
struct Control {
    tx: mpsc::Sender<Generate>,
    flags: Arc<Flags>,
    cancel: CancellationToken,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        validate_input(&input)?;
        if self.flags.closed.load(Ordering::SeqCst) {
            return Err(GatewayError::SessionClosed);
        }
        if self
            .flags
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(GatewayError::Busy);
        }
        let (reply, receiver) = oneshot::channel();
        if self.tx.send(Generate { input, reply }).await.is_err() {
            self.flags.busy.store(false, Ordering::SeqCst);
            return Err(GatewayError::SessionClosed);
        }
        receiver.await.unwrap_or(Err(GatewayError::SessionClosed))
    }
    fn close(&self) {
        self.flags.closed.store(true, Ordering::SeqCst);
        self.cancel.cancel();
    }
}

/// A final slot ensures slow-consumer failure or known terminal output can still
/// be observed after the bounded event queue drains. Never drop deltas silently
/// and then pretend the response succeeded.
struct EventSink {
    tx: mpsc::Sender<EventEnvelope>,
    final_slot: Arc<Mutex<Option<EventEnvelope>>>,
    session_id: String,
    sequence: u64,
    consumer_timeout: Duration,
}
impl EventSink {
    fn envelope(
        &mut self,
        request_id: Option<&str>,
        provider_sequence: Option<u64>,
        event: ProviderEvent,
    ) -> EventEnvelope {
        self.sequence += 1;
        EventEnvelope {
            schema_version: 1,
            sequence: self.sequence,
            event_id: format!("{}:{}", self.session_id, self.sequence),
            session_id: self.session_id.clone(),
            request_id: request_id.map(String::from),
            provider: PROVIDER_ID.into(),
            provider_sequence,
            event,
        }
    }
    async fn emit(
        &mut self,
        request_id: &str,
        seq: Option<u64>,
        event: ProviderEvent,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let envelope = self.envelope(Some(request_id), seq, event);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(GatewayError::Cancelled),
            result = tokio::time::timeout(self.consumer_timeout, self.tx.send(envelope)) => {
                match result {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(_)) => Err(GatewayError::SessionClosed),
                    Err(_) => Err(GatewayError::SlowConsumer),
                }
            }
        }
    }
    /// Returns false when the last event had to use the final slot. The caller
    /// then ends this session: no subsequent request may overtake that slot.
    fn terminal(
        &mut self,
        request_id: Option<&str>,
        seq: Option<u64>,
        event: ProviderEvent,
    ) -> bool {
        let envelope = self.envelope(request_id, seq, event);
        match self.tx.try_send(envelope) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(envelope)) => {
                *self.final_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(envelope);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }
}

pub(super) fn spawn(
    id: String,
    wire: Wire,
    options: SessionOptions,
    timeouts: Timeouts,
) -> ProviderSession {
    let (tx, rx) = mpsc::channel(1);
    let (events_tx, mut events_rx) = mpsc::channel(64);
    let flags = Arc::new(Flags {
        busy: AtomicBool::new(false),
        closed: AtomicBool::new(false),
    });
    let cancel = CancellationToken::new();
    let final_slot = Arc::new(Mutex::new(None));
    let sink = EventSink {
        tx: events_tx,
        final_slot: final_slot.clone(),
        session_id: id.clone(),
        sequence: 0,
        consumer_timeout: timeouts.consumer,
    };
    let control = Arc::new(Control {
        tx,
        flags: flags.clone(),
        cancel: cancel.clone(),
    });
    tokio::spawn(worker(
        wire,
        options,
        rx,
        sink,
        flags,
        cancel.clone(),
        timeouts,
    ));
    // Construct outside the generator so dropping a NEVER-POLLED event stream
    // also cancels the worker and closes its authenticated connection.
    let guard = cancel.drop_guard();
    let events = Box::pin(async_stream::stream! {
        let _guard = guard;
        while let Some(event) = events_rx.recv().await { yield event; }
        let last = { final_slot.lock().unwrap_or_else(|e| e.into_inner()).take() };
        if let Some(event) = last { yield event; }
    });
    ProviderSession {
        id,
        control,
        events,
    }
}

async fn worker(
    mut wire: Wire,
    options: SessionOptions,
    mut commands: mpsc::Receiver<Generate>,
    mut sink: EventSink,
    flags: Arc<Flags>,
    cancel: CancellationToken,
    timeouts: Timeouts,
) {
    let mut state = Conversation::default();
    loop {
        let command = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            _ = sink.tx.closed() => break,
            command = commands.recv() => match command { Some(c) => c, None => break },
            idle = wire.receive() => {
                // Service Ping/Pong during idle (inside receive). A semantic
                // event without an active request is not assigned to a new run.
                let reason = match idle {
                    Ok(None) => "provider_closed_idle_connection",
                    Ok(Some(_)) => "unexpected_idle_provider_event",
                    Err(_) => "idle_transport_error",
                };
                flags.closed.store(true, Ordering::SeqCst);
                sink.terminal(None, None, ProviderEvent::SessionClosed { reason: reason.into() });
                break;
            }
        };
        let (mut body, full_input) = match state.prepare(&options, &command.input) {
            Ok(prepared) => prepared,
            Err(error) => {
                flags.busy.store(false, Ordering::SeqCst);
                let _ = command.reply.send(Err(error));
                continue;
            }
        };
        let request_id = Uuid::new_v4().to_string();
        body["prompt_cache_key"] = Value::String(sink.session_id.clone());
        if command
            .reply
            .send(Ok(RequestReceipt {
                request_id: request_id.clone(),
            }))
            .is_err()
        {
            // Caller abandoned admission before receiving its receipt. No send.
            flags.busy.store(false, Ordering::SeqCst);
            continue;
        }
        let mut upstream = UpstreamOutcome::NotSubmitted;
        let result = tokio::time::timeout(
            timeouts.total,
            drive(
                &mut wire,
                &mut state,
                body,
                full_input,
                &request_id,
                &mut sink,
                &cancel,
                &mut upstream,
                timeouts.idle,
            ),
        )
        .await;
        match result {
            Ok(Ok((response, seq))) => {
                let completed = response.outcome == ResponseOutcome::Completed;
                // Set state before publishing terminal output, so a consumer
                // that immediately submits a continuation does not see Busy.
                if !completed {
                    flags.closed.store(true, Ordering::SeqCst);
                }
                flags.busy.store(false, Ordering::SeqCst);
                let delivered = sink.terminal(
                    Some(&request_id),
                    seq,
                    ProviderEvent::ResponseFinished { response },
                );
                if !completed || !delivered {
                    break;
                }
            }
            other => {
                let error = match other {
                    Ok(Err(e)) => e,
                    Err(_) => GatewayError::Timeout,
                    _ => unreachable!(),
                };
                flags.closed.store(true, Ordering::SeqCst);
                flags.busy.store(false, Ordering::SeqCst);
                sink.terminal(
                    Some(&request_id),
                    None,
                    ProviderEvent::RequestFailed {
                        code: error.code().into(),
                        message: error.to_string(),
                        upstream_outcome: upstream,
                    },
                );
                break;
            }
        }
    }
    flags.closed.store(true, Ordering::SeqCst);
    flags.busy.store(false, Ordering::SeqCst);
    commands.close();
    while let Ok(command) = commands.try_recv() {
        let _ = command.reply.send(Err(GatewayError::SessionClosed));
    }
    wire.close().await;
    // Sink sender drops here; stream drains queued events and the final slot.
}

#[cfg(test)]
#[path = "tests/consistency/consistency_settlement_tests.rs"]
mod consistency_settlement_tests;

#[allow(clippy::too_many_arguments)]
async fn drive(
    wire: &mut Wire,
    state: &mut Conversation,
    body: Value,
    full_input: Vec<Value>,
    request_id: &str,
    sink: &mut EventSink,
    cancel: &CancellationToken,
    upstream: &mut UpstreamOutcome,
    idle_timeout: Duration,
) -> Result<(ModelResponse, Option<u64>)> {
    // After send begins, cancellation/error is conservatively uncertain. A
    // transport error cannot be used as proof of non-execution upstream.
    if cancel.is_cancelled() {
        return Err(GatewayError::Cancelled);
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(GatewayError::Cancelled),
        result = wire.send(body, request_id, upstream) => result?,
    }
    let mut decoder = ResponseDecoder::default();
    let mut lifecycle = super::consistency::Lifecycle::default();
    loop {
        let value = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(GatewayError::Cancelled),
            result = tokio::time::timeout(idle_timeout, wire.receive()) => result.map_err(|_| GatewayError::Timeout)??,
        }.ok_or(GatewayError::UnexpectedEnd)?;
        wire.observe_native(&value);
        let seq = value.get("sequence_number").and_then(Value::as_u64);
        let decoded = decoder.apply(value);
        if decoder.terminal_received {
            *upstream = UpstreamOutcome::TerminalReceived;
        }
        let events = decoded?;
        // A validated terminal is known even if a preceding synthetic start cannot be delivered.
        for event in &events {
            if let ProviderEvent::ResponseFinished { response } = event {
                *upstream = UpstreamOutcome::TerminalReceived;
                wire.observe_terminal(response);
            }
        }
        for event in events {
            lifecycle.observe(&event)?;
            match event {
                ProviderEvent::ResponseFinished { response } => {
                    // Reject contradictions before they enter continuation history or reach callers.
                    lifecycle.validate(&response)?;
                    state.settle(full_input, &response)?;
                    wire.end_response();
                    return Ok((response, seq));
                }
                event => sink.emit(request_id, seq, event, cancel).await?,
            }
        }
    }
}
