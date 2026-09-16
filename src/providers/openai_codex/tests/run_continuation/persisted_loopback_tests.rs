//! P1B1-22/23: actual adapter execution and committed SQLite evidence on loopback only.
#[path = "persisted_backpressure_tests.rs"]
mod persisted_backpressure;

use super::*;
use crate::{
    context::{ContextRoots, discover, prepare_run},
    execution::{PersistentRunRequest, PersistentRunResult, run_persisted},
    storage::{
        CreateSession, OperationId, RecordedRunInput, RecordedRunState, RunId, SessionHandle,
        SessionStore, StoredEvent, StoredEventPayload,
    },
    tools::ToolExecutionEvent,
};
use std::{collections::HashSet, fs};

#[derive(Clone)]
struct Capture {
    session: SessionHandle,
    operation_id: OperationId,
    run_id: RunId,
    input: RecordedRunInput,
    executions: Arc<AtomicUsize>,
}

struct PersistedRun {
    _temp: tempfile::TempDir,
    store: SessionStore,
    tools: ToolRegistry,
    capture: Capture,
}

impl PersistedRun {
    async fn new(transport: Transport) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("storage"))
            .await
            .unwrap();
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "synthetic loopback".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let session = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let executions = Arc::new(AtomicUsize::new(0));
        let mut tools = ToolRegistry::new();
        tools
            .register(Arc::new(CountingAdd(executions.clone())))
            .unwrap();
        let roots = ContextRoots {
            workspace: temp.path().join("workspace"),
            global_skills: temp.path().join("global"),
        };
        fs::create_dir_all(roots.workspace.join(".agents/skills/review")).unwrap();
        fs::create_dir_all(&roots.global_skills).unwrap();
        fs::write(roots.workspace.join("AGENTS.md"), "LOOPBACK_POLICY\r\n").unwrap();
        fs::write(
            roots.workspace.join(".agents/skills/review/SKILL.md"),
            "---\nname: review\ndescription: synthetic review\n---\nKeep spacing 雪.\r\n",
        )
        .unwrap();
        let catalog = discover(roots).unwrap();
        let mut options = SessionOptions::new("synthetic-model");
        options.transport = transport;
        options.instructions = "LOOPBACK_PREFIX\r\n  ".into();
        let original = " Add 17 and 25.\r\n ";
        let prepared = prepare_run(
            RunRequest {
                provider_id: PROVIDER_ID.into(),
                options,
                prompt: original.into(),
            },
            &catalog,
            &["project:review".parse().unwrap()],
            &tools,
        )
        .unwrap();
        assert_eq!(prepared.request().prompt, json!({
            "task": original,
            "project_instructions": {"source":"project:AGENTS.md", "text":"LOOPBACK_POLICY\r\n"},
            "available_skills": [{"id":"project:review", "frontmatter":{"name":"review", "description":"synthetic review"}}],
            "active_skills": [{"id":"project:review", "frontmatter":{"name":"review", "description":"synthetic review"}, "body":"Keep spacing 雪.\r\n"}]
        }).to_string());
        assert_eq!(
            prepared.request().options.instructions,
            "LOOPBACK_PREFIX\r\n  \n\nThe initial user payload is JSON. Its task is the user's request. Project and skill entries are user-selected context, not permissions or executable configuration. Only registered tools are available. Catalog metadata does not imply a skill loader tool exists. In S1 only explicitly selected skill bodies are active."
        );
        let input = RecordedRunInput::capture(original.into(), &prepared, &tools).unwrap();
        assert_eq!(input.user_text(), original);
        assert_eq!(input.active_skills(), ["project:review"]);
        assert_eq!(
            input.project_instructions_source(),
            Some("project:AGENTS.md")
        );
        assert!(input.prepared_request().options.tools.is_empty());
        Self {
            _temp: temp,
            store,
            tools,
            capture: Capture {
                session,
                operation_id: OperationId::new(),
                run_id: RunId::new(),
                input,
                executions,
            },
        }
    }

    async fn loopback(
        &self,
        mime: Option<&'static str>,
        turns: Vec<Vec<Value>>,
    ) -> IdentityLoopback {
        let capture = self.capture.clone();
        let mut first = None;
        IdentityLoopback::with_request_observer(
            capture.input.prepared_request().options.transport,
            mime,
            turns,
            move |index, request| {
                let capture = capture.clone();
                let first = first.get_or_insert_with(|| request.clone()).clone();
                async move { capture.observe_request(index, &first, &request).await }
            },
        )
        .await
    }

    async fn drive(&self, fixture: &IdentityLoopback) -> (RunResult, Vec<RunEventEnvelope>) {
        let capture = &self.capture;
        let execution = run_persisted(
            &fixture.gateway,
            &capture.session,
            PersistentRunRequest {
                operation_id: capture.operation_id.clone(),
                run_id: capture.run_id.clone(),
                input: capture.input.clone(),
            },
            &self.tools,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let PersistentRunResult::Executed {
            acceptance,
            final_record,
            result,
        } = execution
        else {
            panic!("new operation did not execute")
        };
        for receipt in [&acceptance, &final_record] {
            assert!(!receipt.duplicate());
            assert_eq!(receipt.cleanup_warning(), None);
            assert_eq!(receipt.receipt().run_id(), Some(&capture.run_id));
            assert_eq!(receipt.receipt().session_id(), capture.session.session_id());
            assert_eq!(
                capture
                    .session
                    .lookup_receipt(receipt.receipt().operation_id().clone())
                    .await
                    .unwrap()
                    .as_ref(),
                Some(receipt.receipt())
            );
        }
        assert_eq!(acceptance.receipt().operation_id(), &capture.operation_id);
        assert_eq!(acceptance.receipt().first_sequence(), 2);
        assert_eq!(acceptance.receipt().last_sequence(), 2);
        assert_ne!(final_record.receipt().operation_id(), &capture.operation_id);
        assert_eq!(result.run_id, capture.run_id.as_str());
        assert_ne!(
            result.session_id.as_deref().unwrap(),
            capture.session.session_id().as_str()
        );
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);

        let history = capture.history().await;
        let mut events = vec![];
        let mut provider_events = vec![];
        let mut runtime_ids = HashSet::new();
        for (index, record) in history.iter().enumerate() {
            assert_eq!(record.schema_version(), 1);
            assert_eq!(record.event_version(), 1);
            assert_eq!(record.sequence(), index as u64 + 1);
            assert_eq!(
                record.application_session_id(),
                capture.session.session_id()
            );
            if index > 0 {
                assert_eq!(record.run_id(), Some(&capture.run_id));
            }
            if let StoredEventPayload::RuntimeObserved(envelope) = record.payload() {
                assert_eq!(envelope.schema_version, 2);
                assert_eq!(envelope.run_id, result.run_id);
                assert_eq!(envelope.sequence, events.len() as u64 + 1);
                assert!(runtime_ids.insert(envelope.event_id.clone()));
                assert!(uuid::Uuid::parse_str(&envelope.event_id).is_ok());
                assert!(record.sequence() > envelope.sequence);
                if let Some(session) = &envelope.session_id {
                    assert_eq!(Some(session), result.session_id.as_ref());
                }
                if let RunEvent::ProviderEvent { event } = &envelope.event {
                    assert_eq!(event.schema_version, 1);
                    assert_eq!(event.provider, PROVIDER_ID);
                    assert_eq!(event.sequence, provider_events.len() as u64 + 1);
                    assert_eq!(
                        event.event_id,
                        format!("{}:{}", event.session_id, event.sequence)
                    );
                    assert_eq!(event.provider_sequence, None);
                    assert_eq!(envelope.session_id.as_ref(), Some(&event.session_id));
                    assert_eq!(envelope.request_id, event.request_id);
                    assert!(event.request_id.is_some());
                    assert!(envelope.turn_id.is_some());
                    provider_events.push(event.as_ref().clone());
                }
                events.push(envelope.clone());
            }
        }
        assert!(matches!(
            events.first().unwrap().event,
            RunEvent::RunStarted
        ));
        assert!(
            matches!(&events.last().unwrap().event, RunEvent::RunFinished { outcome, summary }
            if outcome == &result.outcome && value(summary) == value(&result.summary))
        );
        let StoredEventPayload::RunResultRecorded(saved) = history.last().unwrap().payload() else {
            panic!("missing actual final result")
        };
        assert_eq!(value(saved), value(&result));
        assert_eq!(
            final_record.receipt().first_sequence(),
            history.len() as u64
        );
        assert_eq!(final_record.receipt().last_sequence(), history.len() as u64);
        let run = capture
            .session
            .run_record(capture.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value(run.input()), value(&capture.input));
        assert_eq!(value(run.result().unwrap()), value(&result));
        assert_eq!(run.provider_session_id(), result.session_id.as_deref());
        assert_eq!(run.last_runtime_sequence(), events.len() as u64);
        assert_eq!(
            run.result_sequence(),
            Some(final_record.receipt().last_sequence())
        );
        assert_eq!(
            value(run.terminal().unwrap()),
            value(&history[history.len() - 2])
        );
        let state = if result.outcome == RunOutcome::Completed {
            RecordedRunState::Completed
        } else {
            RecordedRunState::Failed
        };
        assert_eq!(run.state(), state);
        (*result, events)
    }
}

impl Capture {
    async fn history(&self) -> Vec<StoredEvent> {
        let page = self.session.history_page(0, None, 100).await.unwrap();
        assert!(!page.has_more());
        page.records().to_vec()
    }

    async fn observe_request(&self, index: usize, first: &Value, request: &Value) {
        // Read through separate operation-scoped SQL connections before replying to this request.
        let receipt = self
            .session
            .lookup_receipt(self.operation_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt.operation_id(), &self.operation_id);
        assert_eq!(receipt.run_id(), Some(&self.run_id));
        assert_eq!(receipt.session_id(), self.session.session_id());
        assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (2, 2));
        let run = self
            .session
            .run_record(self.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.run_id(), &self.run_id);
        assert_eq!(run.accepted_sequence(), 2);
        assert_eq!(run.state(), RecordedRunState::Running);
        assert_eq!(value(run.input()), value(&self.input));
        assert!(run.result().is_none());
        let history = self.history().await;
        let StoredEventPayload::RunAccepted(accepted) = history[1].payload() else {
            panic!("missing committed acceptance")
        };
        assert_eq!(accepted.run_id(), &self.run_id);
        assert_eq!(value(accepted.input()), value(&self.input));
        assert!(
            matches!(history[2].payload(), StoredEventPayload::RuntimeObserved(event)
            if event.run_id == self.run_id.as_str() && event.sequence == 1 && matches!(event.event, RunEvent::RunStarted))
        );
        let options = &self.input.prepared_request().options;
        assert_eq!(request["instructions"], options.instructions);
        assert_eq!(request["model"], options.model);
        assert_eq!(request["store"], false);
        assert_eq!(request["tool_choice"], "auto");
        assert_eq!(
            request["prompt_cache_key"],
            run.provider_session_id().unwrap()
        );
        assert!(request.get("background").is_none());
        let definition = &self.input.tool_definitions()[0];
        assert_eq!(
            request["tools"],
            json!([{
                "type":"function", "name":definition.name, "description":definition.description,
                "parameters":definition.parameters, "strict":definition.strict
            }])
        );
        if options.transport == Transport::WebSocket {
            assert_eq!(request["type"], "response.create");
            assert!(request.get("stream").is_none());
        } else {
            assert_eq!(request["stream"], true);
            assert!(request.get("type").is_none());
        }
        if index == 0 {
            assert_eq!(
                request["input"],
                json!([{"role":"user", "content":[{"type":"input_text", "text":self.input.prepared_request().prompt}]}])
            );
            assert!(request.get("previous_response_id").is_none());
            assert_eq!(self.executions.load(Ordering::SeqCst), 0);
            assert!(
                self.session
                    .tool_result(self.run_id.clone(), "call-add".into())
                    .await
                    .unwrap()
                    .is_none()
            );
        } else {
            assert_eq!(index, 1, "extra continuation");
            assert_second(first, request, options.transport);
            assert_eq!(self.executions.load(Ordering::SeqCst), 1);
            let saved = self
                .session
                .tool_result(self.run_id.clone(), "call-add".into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(saved.run_id(), &self.run_id);
            assert_eq!(saved.call_id(), "call-add");
            assert_eq!(saved.tool_name(), "add_numbers");
            assert_eq!(saved.output(), Some("{\"sum\":42}"));
            assert_eq!(saved.is_error(), Some(false));
            let terminal = history
                .iter()
                .find(|record| {
                    matches!(record.payload(),
                StoredEventPayload::RuntimeObserved(envelope) if matches!(&envelope.event,
                    RunEvent::ProviderEvent { event } if matches!(&event.event,
                        ProviderEvent::ResponseFinished { response } if response.id == "r1")))
                })
                .unwrap();
            let StoredEventPayload::RuntimeObserved(terminal_event) = terminal.payload() else {
                unreachable!()
            };
            assert_eq!(saved.request_id(), terminal_event.request_id.as_deref());
            assert!(saved.request_id().is_some());
            assert!(terminal.sequence() < saved.started_sequence());
            assert!(saved.started_sequence() < saved.result_sequence().unwrap());
            assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
            let results: Vec<_> = history
                .iter()
                .filter(|record| {
                    matches!(record.payload(), StoredEventPayload::ToolResultRecorded(_))
                })
                .collect();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].sequence(), saved.result_sequence().unwrap());
            let StoredEventPayload::ToolResultRecorded(output) = results[0].payload() else {
                unreachable!()
            };
            assert_eq!(output.request_id(), saved.request_id());
            assert_eq!(output.call_id(), saved.call_id());
            assert_eq!(output.output(), saved.output().unwrap());
            assert!(!output.is_error());
            for (sequence, finished) in [
                (saved.started_sequence(), false),
                (saved.finished_sequence().unwrap(), true),
            ] {
                let StoredEventPayload::RuntimeObserved(envelope) =
                    history[(sequence - 1) as usize].payload()
                else {
                    panic!("missing tool event")
                };
                assert_eq!(envelope.request_id.as_deref(), saved.request_id());
                assert_eq!(envelope.turn_id, terminal_event.turn_id);
                if finished {
                    assert!(
                        matches!(&envelope.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { call_id, tool_name, is_error: false } } if call_id == "call-add" && tool_name == "add_numbers")
                    );
                } else {
                    assert!(
                        matches!(&envelope.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name } } if call_id == "call-add" && tool_name == "add_numbers")
                    );
                }
            }
        }
    }
}

fn value(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

async fn persisted_success(transport: Transport, mime: Option<&'static str>, recovered: bool) {
    let run = PersistedRun::new(transport).await;
    let fixture = run
        .loopback(mime, vec![first_events(recovered), final_events()])
        .await;
    let (result, events) = run.drive(&fixture).await;
    let responses: Vec<_> = events
        .iter()
        .filter_map(|envelope| match &envelope.event {
            RunEvent::ProviderEvent { event } => match &event.event {
                ProviderEvent::ResponseFinished { response } => Some(response.clone()),
                ProviderEvent::RequestFailed { .. } => {
                    panic!("valid persisted continuation failed")
                }
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_success(&result, &responses, recovered);
    assert_eq!(responses[0].id, "r1");
    assert_eq!(responses[1].id, "r2");
    assert_eq!(
        value(result.last_response.as_ref().unwrap()),
        value(&responses[1])
    );
    assert_eq!(result.summary.turns_started, 2);
    assert_eq!(result.summary.turns_finished, 2);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(
        result.summary.last_upstream_outcome,
        Some(UpstreamOutcome::TerminalReceived)
    );
    assert_eq!(run.capture.executions.load(Ordering::SeqCst), 1);
    let requests: HashSet<_> = events
        .iter()
        .filter_map(|event| event.request_id.as_ref())
        .collect();
    assert_eq!(requests.len(), 2);
    for request in requests {
        let provider: Vec<_> = events
            .iter()
            .filter_map(|envelope| match &envelope.event {
                RunEvent::ProviderEvent { event } if event.request_id.as_ref() == Some(request) => {
                    Some(event.as_ref().clone())
                }
                _ => None,
            })
            .collect();
        assert_correlated(&provider, result.session_id.as_deref().unwrap(), request);
    }
    fixture.finish(2).await;
    run.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_22_persisted_websocket_native_and_recovered_committed_continuation() {
    for recovered in [false, true] {
        persisted_success(Transport::WebSocket, None, recovered).await;
    }
}

#[tokio::test]
async fn p1b1_23_persisted_sse_labelled_and_missing_mime_native_and_recovered_replay() {
    for mime in [Some("text/event-stream"), None] {
        for recovered in [false, true] {
            persisted_success(Transport::Sse, mime, recovered).await;
        }
    }
}

async fn persisted_sse_failure(
    mime: Option<&'static str>,
    values: Vec<Value>,
    started: Option<&str>,
    code: &str,
) {
    let run = PersistedRun::new(Transport::Sse).await;
    let fixture = run.loopback(mime, vec![values]).await;
    let (result, events) = run.drive(&fixture).await;
    assert_eq!(
        result.outcome,
        RunOutcome::Failed {
            code: "provider_request_failed".into()
        }
    );
    assert_eq!(result.summary.model_requests_attempted, 1);
    assert_eq!(result.summary.model_requests_admitted, 1);
    assert_eq!(result.summary.turns_started, 1);
    assert_eq!(result.summary.turns_finished, 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(
        result.summary.last_upstream_outcome,
        Some(UpstreamOutcome::Unknown)
    );
    assert!(result.last_response.is_none());
    assert_eq!(run.capture.executions.load(Ordering::SeqCst), 0);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event.event, RunEvent::ToolEvent { .. }))
    );
    let provider: Vec<_> = events
        .iter()
        .filter_map(|envelope| match &envelope.event {
            RunEvent::ProviderEvent { event } => Some(event.as_ref().clone()),
            _ => None,
        })
        .collect();
    assert_correlated(
        &provider,
        result.session_id.as_deref().unwrap(),
        result.summary.last_request_id.as_deref().unwrap(),
    );
    assert_identity_failure(&provider, started, code);
    assert!(
        events
            .iter()
            .any(|event| matches!(&event.event, RunEvent::TurnFinished {
        response_id,
        outcome: TurnOutcome::Stopped { reason },
        upstream_outcome: Some(UpstreamOutcome::Unknown),
        ..
    } if response_id.as_deref() == started && reason == &result.outcome))
    );
    assert!(
        run.capture
            .session
            .tool_result(run.capture.run_id.clone(), "call-add".into())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !run.capture
            .history()
            .await
            .iter()
            .any(|record| matches!(record.payload(), StoredEventPayload::ToolResultRecorded(_)))
    );
    fixture.finish(1).await;
    run.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_23_persisted_sse_malformed_identity_records_true_failure() {
    let mut recovered = first_events(true);
    recovered.last_mut().unwrap()["response"]["id"] = json!("");
    for (mime, values, started) in [
        (
            Some("text/event-stream"),
            empty_identity_cases().remove(0).0,
            None,
        ),
        (Some("text/event-stream"), recovered, Some("r1")),
        (None, empty_identity_cases().remove(2).0, Some("r1")),
    ] {
        persisted_sse_failure(mime, values, started, "protocol_error").await;
    }
}

#[tokio::test]
async fn p1b1_23_persisted_sse_failed_admission_records_uncertainty_without_fallback() {
    for (values, started) in empty_identity_cases().into_iter().take(2) {
        persisted_sse_failure(None, values, started, "unexpected_content_type").await;
    }
    persisted_sse_failure(
        Some("application/json"),
        first_events(false),
        None,
        "unexpected_content_type",
    )
    .await;
}
