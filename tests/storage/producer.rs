use super::{
    history::response,
    recording::{append, session, value},
    tools::{Mode, call_response, registry, with_tools},
};
use async_trait::async_trait;
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;
use wi::{
    Capability, EventEnvelope, Gateway, GatewayError, InputItem, Provider, ProviderCapabilities,
    ProviderEvent, ProviderSession, RequestReceipt, SessionControl, SessionOptions,
    run::{RunEvent, RunOutcome, run},
    storage::{
        AppendRunRecord, CreateSession, OperationId, RunId, SessionStore, StoredEventPayload,
    },
    tools::ToolExecutionEvent,
};

#[derive(Clone, Copy)]
enum Script {
    Complete,
    RejectSecond,
    RejectFirst,
    FailOpen,
}
struct OfflineProvider {
    script: Script,
    inputs: Arc<Mutex<Vec<Vec<InputItem>>>>,
    closes: Arc<AtomicUsize>,
}
struct Control {
    script: Script,
    inputs: Arc<Mutex<Vec<Vec<InputItem>>>>,
    closes: Arc<AtomicUsize>,
    sender: tokio::sync::mpsc::UnboundedSender<EventEnvelope>,
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> wi::Result<RequestReceipt> {
        let mut inputs = self.inputs.lock().unwrap();
        inputs.push(input);
        let turn = inputs.len();
        if matches!(self.script, Script::RejectFirst)
            || (matches!(self.script, Script::RejectSecond) && turn == 2)
        {
            return Err(GatewayError::ProviderFailed);
        }
        assert!(turn <= 3);
        let request_id = format!("request-{turn}");
        let response = if turn < 3 {
            call_response("call")
        } else {
            response()
        };
        for (offset, event) in [
            ProviderEvent::ProviderExtension {
                event_type: "future.offline.extension".into(),
                payload: json!({"opaque":"雪\0\n"}),
            },
            ProviderEvent::ResponseFinished { response },
        ]
        .into_iter()
        .enumerate()
        {
            self.sender
                .send(EventEnvelope {
                    schema_version: 1,
                    sequence: (turn as u64 - 1) * 10 + offset as u64 * 3,
                    event_id: format!("provider-{turn}-{offset}"),
                    session_id: "offline-session".into(),
                    request_id: Some(request_id.clone()),
                    provider: "synthetic-unregistered-provider".into(),
                    provider_sequence: None,
                    event,
                })
                .unwrap();
        }
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Provider for OfflineProvider {
    fn id(&self) -> &'static str {
        "synthetic-unregistered-provider"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "synthetic offline".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    async fn open_session(&self, _: SessionOptions) -> wi::Result<ProviderSession> {
        if matches!(self.script, Script::FailOpen) {
            return Err(GatewayError::ProviderFailed);
        }
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        Ok(ProviderSession {
            id: "offline-session".into(),
            control: Arc::new(Control {
                script: self.script,
                inputs: self.inputs.clone(),
                closes: self.closes.clone(),
                sender,
            }),
            events: Box::pin(async_stream::stream! {
                while let Some(event) = receiver.recv().await { yield event; }
            }),
        })
    }
}

#[tokio::test]
async fn p1a14_correlation_public_run_complete_and_failure_traces_roundtrip() {
    for script in [
        Script::Complete,
        Script::RejectSecond,
        Script::RejectFirst,
        Script::FailOpen,
    ] {
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let closes = Arc::new(AtomicUsize::new(0));
        let mut gateway = Gateway::new();
        gateway
            .register(Arc::new(OfflineProvider {
                script,
                inputs: inputs.clone(),
                closes: closes.clone(),
            }))
            .unwrap();
        let (tools, executions) = registry(Mode::Success);
        let captured = with_tools(&tools);
        let mut events = Vec::new();
        let result = run(
            &gateway,
            captured.prepared_request().clone(),
            &tools,
            CancellationToken::new(),
            |event| {
                events.push(event.clone());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(result.events_complete);
        assert!(result.sink_error.is_none());
        assert_eq!(
            result.outcome == RunOutcome::Completed,
            matches!(script, Script::Complete)
        );
        assert_eq!(
            executions.load(Ordering::SeqCst),
            usize::from(matches!(script, Script::Complete | Script::RejectSecond))
        );
        assert_eq!(
            closes.load(Ordering::SeqCst),
            usize::from(!matches!(script, Script::FailOpen))
        );
        let first = &events[0];
        assert!(matches!(first.event, RunEvent::RunStarted));
        assert!(
            first.turn_id.is_none() && first.session_id.is_none() && first.request_id.is_none()
        );
        let last = events.last().unwrap();
        assert!(matches!(last.event, RunEvent::RunFinished { .. }));
        assert!(last.turn_id.is_none());
        if matches!(script, Script::RejectSecond) {
            assert_eq!(last.request_id, None);
            assert_eq!(result.summary.last_request_id.as_deref(), Some("request-1"));
        }
        if matches!(script, Script::Complete) {
            assert_eq!(result.summary.turns_started, 3);
            assert_eq!(result.summary.turns_finished, 3);
            assert_eq!(last.request_id.as_deref(), Some("request-3"));
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(
                        event.event,
                        RunEvent::ToolEvent {
                            event: ToolExecutionEvent::ToolResultReused { .. }
                        }
                    ))
                    .count(),
                1
            );
        }
        let inputs = inputs.lock().unwrap().clone();
        let mut records = Vec::new();
        for event in &events {
            records.push(AppendRunRecord::Runtime(event.clone()));
            if let RunEvent::ToolEvent {
                event:
                    ToolExecutionEvent::ToolExecutionFinished {
                        call_id, is_error, ..
                    },
            } = &event.event
            {
                // These are actual registry bytes captured by the next offline generate call.
                let InputItem::ToolResult {
                    call_id: original,
                    output,
                } = &inputs[1][0]
                else {
                    panic!("missing actual result")
                };
                assert_eq!(call_id, original);
                records.push(AppendRunRecord::ToolResult {
                    request_id: event.request_id.clone(),
                    call_id: call_id.clone(),
                    output: output.clone(),
                    is_error: *is_error,
                });
            }
        }
        records.push(AppendRunRecord::Result(result.clone()));
        let (fixture, store, first_handle, _) = session().await;
        let run_id: RunId = result.run_id.parse().unwrap();
        for batched in [false, true] {
            let handle = if batched {
                let created = store
                    .create_session(
                        CreateSession::new(OperationId::new(), "batch".into(), None).unwrap(),
                    )
                    .await
                    .unwrap();
                store
                    .open_session(created.session_id().clone())
                    .await
                    .unwrap()
            } else {
                first_handle.clone()
            };
            handle
                .accept_run(OperationId::new(), run_id.clone(), captured.clone())
                .await
                .unwrap();
            if batched {
                append(&handle, &run_id, records.clone()).await;
            } else {
                for record in &records {
                    append(&handle, &run_id, vec![record.clone()]).await;
                }
            }
            let stored = handle.run_record(run_id.clone()).await.unwrap().unwrap();
            assert_eq!(value(stored.result().unwrap()), value(&result));
            let page = handle.history_page(2, None, 100).await.unwrap();
            let runtime: Vec<_> = page
                .records()
                .iter()
                .filter_map(|event| {
                    if let StoredEventPayload::RuntimeObserved(event) = event.payload() {
                        Some(value(event))
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(runtime, events.iter().map(value).collect::<Vec<_>>());
            if matches!(script, Script::Complete | Script::RejectSecond) {
                let saved = handle
                    .tool_result(run_id.clone(), "call".into())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.request_id(), Some("request-1"));
                let InputItem::ToolResult { output, .. } = &inputs[1][0] else {
                    unreachable!()
                };
                assert_eq!(saved.output(), Some(output.as_str()));
                if matches!(script, Script::Complete) {
                    assert_eq!(value(&inputs[1]), value(&inputs[2]));
                }
            }
        }
        store.close().await.unwrap();
        let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
        let handle = reopened
            .open_session(first_handle.session_id().clone())
            .await
            .unwrap();
        assert_eq!(
            value(
                handle
                    .run_record(run_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .result()
                    .unwrap()
            ),
            value(&result)
        );
        reopened.close().await.unwrap();
    }
}
