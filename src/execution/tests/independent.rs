use super::*;
use crate::storage::{
    RecordedRun,
    test_hooks::{Action, Pause, Point},
};
use sqlx::Connection;
use std::{future::Future, time::Duration};

async fn watchdog<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("independent observation watchdog")
}

fn partial_step(model: ModelResponse) -> (Step, Arc<Barrier>) {
    let before = Arc::new(Barrier::default());
    before.release.notify_one();
    let after = Arc::new(Barrier::default());
    (
        Step::Partial {
            response: model,
            before,
            after: after.clone(),
        },
        after,
    )
}

async fn paged_history(session: &SessionHandle) -> Vec<StoredEvent> {
    let mut records = Vec::new();
    let mut after = 0;
    let mut through = None;
    loop {
        let page = session.history_page(after, through, 2).await.unwrap();
        if let Some(through) = through {
            assert_eq!(page.through_sequence(), through);
        }
        through = Some(page.through_sequence());
        assert!(page.records().len() <= 2);
        for record in page.records() {
            assert_eq!(record.sequence(), after + 1);
            assert!(record.application_session_id() == session.session_id());
            after = record.sequence();
            records.push(record.clone());
        }
        assert_eq!(page.next_after(), after);
        if !page.has_more() {
            assert_eq!(Some(after), through);
            return records;
        }
        assert_eq!(page.records().len(), 2);
    }
}

fn assert_trace(rig: &Rig, history: &[StoredEvent], model: &ModelResponse, complete: bool) {
    let mut kinds = Vec::new();
    let mut runtime = Vec::new();
    let mut provider = Vec::new();
    let mut turn_id = None;
    for (index, record) in history.iter().enumerate() {
        assert_eq!(record.sequence(), index as u64 + 1);
        assert!(record.application_session_id() == rig.session.session_id());
        match record.payload() {
            StoredEventPayload::SessionCreated(_) => {
                assert!(record.run_id().is_none());
                kinds.push("created");
            }
            StoredEventPayload::SessionRenamed { .. } => assert!(record.run_id().is_none()),
            StoredEventPayload::RunAccepted(accepted) => {
                assert!(record.run_id() == Some(&rig.run_id));
                assert!(accepted.run_id() == &rig.run_id);
                assert!(
                    value(accepted.input()) == value(&rig.input),
                    "accepted input differs"
                );
                kinds.push("accepted");
            }
            StoredEventPayload::RuntimeObserved(event) => {
                assert!(record.run_id() == Some(&rig.run_id));
                assert!(event.run_id == rig.run_id.as_str());
                assert_eq!(event.schema_version, 2);
                assert_eq!(event.sequence, runtime.len() as u64 + 1);
                assert!(Uuid::parse_str(&event.event_id).is_ok());
                assert!(!runtime.contains(&event.event_id));
                runtime.push(event.event_id.clone());
                if let Some(session) = &event.session_id {
                    assert!(session == rig.script.source.session);
                    assert!(session != rig.session.session_id().as_str());
                }
                match &event.event {
                    RunEvent::RunStarted => {
                        assert!(event.session_id.is_none());
                        assert!(event.turn_id.is_none());
                        assert!(event.request_id.is_none());
                        kinds.push("started");
                    }
                    RunEvent::TurnStarted { number } => {
                        assert_eq!(*number, 1);
                        assert!(Uuid::parse_str(event.turn_id.as_deref().unwrap()).is_ok());
                        turn_id = event.turn_id.clone();
                        assert!(event.request_id.is_none());
                        kinds.push("turn_started");
                    }
                    RunEvent::ProviderEvent { event: source } => {
                        assert_eq!(source.schema_version, 1);
                        assert_eq!(source.sequence, (provider.len() as u64 + 1) * 3);
                        assert_eq!(source.provider_sequence, Some(source.sequence + 1000));
                        assert!(source.session_id == rig.script.source.session);
                        assert!(source.provider == ID);
                        assert!(
                            source.event_id
                                == format!("{}{}", rig.script.source.event_prefix, source.sequence)
                        );
                        assert!(
                            source.request_id.as_deref()
                                == Some(&format!("{}1", rig.script.source.request_prefix))
                        );
                        assert!(event.session_id.as_deref() == Some(source.session_id.as_str()));
                        assert!(event.request_id == source.request_id);
                        assert!(event.turn_id == turn_id);
                        match &source.event {
                            ProviderEvent::ResponseStarted { response_id } => {
                                assert!(response_id == &model.id);
                                kinds.push("response_started");
                            }
                            ProviderEvent::OutputItemUpdated {
                                response_id,
                                item_id,
                                output_index,
                                content_index,
                                summary_index,
                                kind,
                                delta,
                            } => {
                                assert!(response_id == &model.id);
                                assert!(item_id == "message");
                                assert_eq!(*output_index, 0);
                                assert_eq!(*content_index, Some(0));
                                assert_eq!(*summary_index, None);
                                assert!(matches!(kind, DeltaKind::Text));
                                assert!(
                                    delta.as_bytes() == PARTIAL.as_bytes(),
                                    "partial bytes differ"
                                );
                                kinds.push("partial");
                            }
                            ProviderEvent::ResponseFinished { response } => {
                                assert!(complete);
                                assert!(
                                    value(response) == value(model),
                                    "terminal response differs"
                                );
                                kinds.push("response_finished");
                            }
                            _ => panic!("unexpected provider observation"),
                        }
                        provider.push(value(source));
                    }
                    RunEvent::TurnFinished {
                        number,
                        response_id,
                        ..
                    } => {
                        assert!(complete);
                        assert_eq!(*number, 1);
                        assert!(response_id.as_deref() == Some(model.id.as_str()));
                        assert!(event.turn_id == turn_id);
                        assert!(
                            event.request_id.as_deref()
                                == Some(&format!("{}1", rig.script.source.request_prefix))
                        );
                        kinds.push("turn_finished");
                    }
                    RunEvent::RunFinished { outcome, .. } => {
                        assert!(complete);
                        assert_eq!(*outcome, RunOutcome::Completed);
                        assert!(event.turn_id.is_none());
                        assert!(
                            event.request_id.as_deref()
                                == Some(&format!("{}1", rig.script.source.request_prefix))
                        );
                        kinds.push("finished");
                    }
                    RunEvent::ToolEvent { .. } => panic!("unexpected tool event"),
                }
            }
            StoredEventPayload::RunResultRecorded(_) => {
                assert!(complete);
                assert!(record.run_id() == Some(&rig.run_id));
                kinds.push("result");
            }
            _ => panic!("unexpected stored record"),
        }
    }
    let mut expected = vec![
        "created",
        "accepted",
        "started",
        "turn_started",
        "response_started",
        "partial",
    ];
    if complete {
        expected.extend(["response_finished", "turn_finished", "finished", "result"]);
    }
    assert_eq!(kinds, expected);
    let emitted = rig.script.records.events.lock().unwrap();
    assert!(
        provider
            == emitted[..provider.len()]
                .iter()
                .map(value)
                .collect::<Vec<_>>(),
        "provider source differs"
    );
}

fn assert_running(rig: &Rig, run: &RecordedRun) {
    assert!(run.run_id() == &rig.run_id);
    assert_eq!(run.state(), RecordedRunState::Running);
    assert_eq!(run.accepted_sequence(), 2);
    assert_eq!(run.last_runtime_sequence(), 4);
    assert!(run.provider_session_id() == Some(rig.script.source.session));
    assert!(
        value(run.input()) == value(&rig.input),
        "running input differs"
    );
    assert!(run.terminal().is_none());
    assert!(run.result_sequence().is_none());
    assert!(run.result().is_none());
}

async fn assert_completed(
    rig: &Rig,
    session: &SessionHandle,
    history: &[StoredEvent],
    outcome: &(CommitResult, CommitResult, RunResult),
    model: &ModelResponse,
) {
    let (acceptance, final_record, result) = outcome;
    assert_trace(rig, history, model, true);
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.run_id == rig.run_id.as_str());
    assert!(result.session_id.as_deref() == Some(rig.script.source.session));
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert!(
        value(result.last_response.as_ref().unwrap()) == value(model),
        "returned result differs"
    );
    assert_eq!(result.summary.turns_started, 1);
    assert_eq!(result.summary.turns_finished, 1);
    assert_eq!(result.summary.model_requests_admitted, 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    let StoredEventPayload::RunResultRecorded(saved) = history.last().unwrap().payload() else {
        panic!("missing final result")
    };
    assert!(value(saved) == value(result), "stored result differs");
    assert!(acceptance.receipt().operation_id() == &rig.operation_id);
    assert_eq!(acceptance.receipt().first_sequence(), 2);
    assert_eq!(
        final_record.receipt().first_sequence(),
        history.len() as u64
    );
    for commit in [acceptance, final_record] {
        assert!(!commit.duplicate());
        assert!(commit.cleanup_warning().is_none());
        let receipt = commit.receipt();
        assert!(receipt.session_id() == session.session_id());
        assert!(receipt.run_id() == Some(&rig.run_id));
        assert_eq!(receipt.first_sequence(), receipt.last_sequence());
        assert!(
            session
                .lookup_receipt(receipt.operation_id().clone())
                .await
                .unwrap()
                .as_ref()
                == Some(receipt)
        );
    }
    let run = session
        .run_record(rig.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.state(), RecordedRunState::Completed);
    assert_eq!(run.last_runtime_sequence(), 7);
    assert_eq!(run.terminal_sequence(), Some(history.len() as u64 - 1));
    assert_eq!(run.result_sequence(), Some(history.len() as u64));
    assert!(
        value(run.input()) == value(&rig.input),
        "final input differs"
    );
    assert!(
        value(run.result().unwrap()) == value(result),
        "projected result differs"
    );
    assert_eq!(count(&rig.script.records.opens), 1);
    assert_eq!(count(&rig.script.records.closes), 1);
    assert_eq!(count(&rig.script.records.calls), 0);
    let inputs = rig.script.records.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 1);
    assert!(
        value(&inputs[0])
            == value(&vec![InputItem::user(
                rig.input.prepared_request().prompt.clone()
            )]),
        "submitted input differs"
    );
}

async fn assert_only_own_run_and_no_tools(rig: &Rig) {
    let mut connection = lifecycle::independent_connection(rig).await;
    let runs: Vec<String> = sqlx::query_scalar("SELECT run_id FROM runs")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    assert!(
        runs == vec![rig.run_id.as_str().to_owned()],
        "unexpected run row"
    );
    let tools: i64 = sqlx::query_scalar("SELECT count(*) FROM tool_results")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(tools, 0);
    let receipts: Vec<String> = sqlx::query_scalar("SELECT receipt_json FROM commands")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    for receipt in receipts {
        let receipt: crate::storage::CommitReceipt = serde_json::from_str(&receipt).unwrap();
        assert!(receipt.session_id() == rig.session.session_id());
        assert!(receipt.run_id().is_none_or(|id| id == &rig.run_id));
    }
    connection.close().await.unwrap();
}

impl Rig {
    async fn sibling(&self, steps: Vec<Step>) -> Self {
        let created = self
            .store
            .create_session(
                CreateSession::new(OperationId::new(), "session B title 雪".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let session = self
            .store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let binding = Binding {
            session: session.clone(),
            operation_id: OperationId::new(),
            run_id: RunId::new(),
        };
        let records = Arc::new(Records::default());
        let mut tools = ToolRegistry::new();
        tools
            .register(Arc::new(CountingTool {
                binding: binding.clone(),
                records: records.clone(),
                mode: ToolMode::Add,
            }))
            .unwrap();
        let catalog = discover(ContextRoots {
            workspace: self.temp.path().join("workspace"),
            global_skills: self.temp.path().join("global"),
        })
        .unwrap();
        let original = "session B supplied task β\n\0";
        let prepared = prepare_run(
            RunRequest {
                provider_id: ID.into(),
                options: SessionOptions::new("synthetic"),
                prompt: original.into(),
            },
            &catalog,
            &["project:local".parse().unwrap()],
            &tools,
        )
        .unwrap();
        let input = RecordedRunInput::capture(original.into(), &prepared, &tools).unwrap();
        let script = Arc::new(Script {
            source: SourceIds {
                session: "provider-session-b",
                request_prefix: "b-q",
                event_prefix: "b-source-",
            },
            binding: binding.clone(),
            input: input.clone(),
            records,
            capabilities: Mutex::new(capabilities()),
            steps: Mutex::new(steps.into()),
            fail_open: false,
        });
        let mut gateway = Gateway::new();
        gateway.register(script.clone()).unwrap();
        Self {
            temp: self.temp.clone(),
            store: self.store.clone(),
            session,
            gateway: Arc::new(gateway),
            script,
            tools: Arc::new(tools),
            input,
            run_id: binding.run_id,
            operation_id: binding.operation_id,
        }
    }
}

#[tokio::test]
async fn p1b1_25_same_store_sessions_isolate_history_and_progress_during_provider_wait() {
    watchdog(async {
        let mut model_a = response("response-a", vec![], "session A final α\n\0");
        model_a.native = json!({"native_a": ["A-only 雪\n\0", 17]});
        let mut model_b = response("response-b", vec![], "session B final β\n\0");
        model_b.native = json!({"native_b": ["B-only λ\n\0", 25]});
        let (step_a, completion_a) = partial_step(model_a.clone());
        let (step_b, completion_b) = partial_step(model_b.clone());
        let a = Rig::new(vec![step_a], ToolMode::Add).await;
        let b = a.sibling(vec![step_b]).await;
        assert!(Arc::ptr_eq(&a.store, &b.store));
        assert!(Arc::ptr_eq(&a.temp, &b.temp));
        assert!(a.session.session_id() != b.session.session_id());
        assert!(a.run_id != b.run_id);
        assert!(a.operation_id != b.operation_id);
        assert!(a.input.prepared_request().prompt != b.input.prepared_request().prompt);
        assert!(a.script.source.session != b.script.source.session);
        assert!(a.script.source.request_prefix != b.script.source.request_prefix);
        assert!(a.script.source.event_prefix != b.script.source.event_prefix);
        let reader_a = a
            .store
            .open_session(a.session.session_id().clone())
            .await
            .unwrap();
        let reader_b = a
            .store
            .open_session(b.session.session_id().clone())
            .await
            .unwrap();
        let initial_a = reader_a.manifest().await.unwrap();
        let initial_b = reader_b.manifest().await.unwrap();
        let cancel_a = CancellationToken::new();
        let cancel_b = CancellationToken::new();
        let execution_a = a.start(cancel_a.clone());
        let execution_b = b.start(cancel_b.clone());
        tokio::join!(
            completion_a.reached.notified(),
            completion_b.reached.notified()
        );
        assert!(!execution_a.is_finished());
        assert!(!execution_b.is_finished());
        let (prefix_a, prefix_b) = tokio::join!(paged_history(&reader_a), paged_history(&reader_b));
        assert_trace(&a, &prefix_a, &model_a, false);
        assert_trace(&b, &prefix_b, &model_b, false);
        assert_running(
            &a,
            &reader_a
                .run_record(a.run_id.clone())
                .await
                .unwrap()
                .unwrap(),
        );
        assert_running(
            &b,
            &reader_b
                .run_record(b.run_id.clone())
                .await
                .unwrap()
                .unwrap(),
        );
        assert_only_own_run_and_no_tools(&a).await;
        assert_only_own_run_and_no_tools(&b).await;

        // Session B must commit its terminal writes before session A can leave the model wait.
        completion_b.release.notify_one();
        let outcome_b = executed(execution_b.await.unwrap().unwrap());
        assert!(!execution_a.is_finished());
        assert!(!cancel_a.is_cancelled());
        assert_eq!(count(&a.script.records.closes), 0);
        let (current_a, final_b) = tokio::join!(paged_history(&reader_a), paged_history(&reader_b));
        assert!(
            value(&current_a) == value(&prefix_a),
            "session A changed during its provider wait"
        );
        assert_running(
            &a,
            &reader_a
                .run_record(a.run_id.clone())
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(final_b.len(), 10);
        assert!(
            serde_json::to_value(&final_b[..6]).unwrap() == value(&prefix_b),
            "session B changed prior history"
        );
        assert_completed(&b, &reader_b, &final_b, &outcome_b, &model_b).await;
        assert!(
            reader_a
                .lookup_receipt(outcome_b.1.receipt().operation_id().clone())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            reader_a
                .lookup_receipt(b.operation_id.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            reader_b
                .lookup_receipt(a.operation_id.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            reader_a
                .run_record(b.run_id.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            reader_b
                .run_record(a.run_id.clone())
                .await
                .unwrap()
                .is_none()
        );
        assert!(reader_a.manifest().await.unwrap().title() == initial_a.title());
        assert!(reader_b.manifest().await.unwrap().title() == initial_b.title());

        completion_a.release.notify_one();
        let outcome_a = executed(execution_a.await.unwrap().unwrap());
        let (final_a, unchanged_b) =
            tokio::join!(paged_history(&reader_a), paged_history(&reader_b));
        assert_eq!(final_a.len(), 10);
        assert!(
            serde_json::to_value(&final_a[..6]).unwrap() == value(&prefix_a),
            "session A changed prior history"
        );
        assert!(
            value(&unchanged_b) == value(&final_b),
            "session A changed session B history"
        );
        assert_completed(&a, &reader_a, &final_a, &outcome_a, &model_a).await;
        assert_completed(&b, &reader_b, &unchanged_b, &outcome_b, &model_b).await;
        assert!(
            reader_b
                .lookup_receipt(outcome_a.1.receipt().operation_id().clone())
                .await
                .unwrap()
                .is_none()
        );
        for (rig, reader, initial, history) in [
            (&a, &reader_a, &initial_a, &final_a),
            (&b, &reader_b, &initial_b, &final_b),
        ] {
            assert_only_own_run_and_no_tools(rig).await;
            assert!(
                !history.iter().any(|event| matches!(
                    event.payload(),
                    StoredEventPayload::SessionRenamed { .. }
                ))
            );
            let manifest = reader.manifest().await.unwrap();
            assert!(manifest.title() == initial.title());
            assert_eq!(manifest.head_sequence(), 10);
        }
        assert!(!cancel_a.is_cancelled());
        assert!(!cancel_b.is_cancelled());
        a.close().await;
    })
    .await;
}

#[tokio::test]
async fn p1b1_25_dropped_admitted_reader_and_rename_do_not_cancel_owned_execution() {
    watchdog(async {
        let mut model = response("reader-response", vec![], "reader final 雪\n\0");
        model.native = json!({"reader_native": "opaque λ\n\0"});
        let (step, completion) = partial_step(model.clone());
        let rig = Rig::new(vec![step], ToolMode::Add).await;
        let cancel = CancellationToken::new();
        let execution = rig.start(cancel.clone());
        // The next stream poll happens only after the partial observation commits.
        completion.reached.notified().await;
        let observer = rig.store.open_session(rig.session.session_id().clone()).await.unwrap();
        let prefix = paged_history(&observer).await;
        assert_trace(&rig, &prefix, &model, false);
        assert_running(&rig, &observer.run_record(rig.run_id.clone()).await.unwrap().unwrap());

        let pause = Arc::new(Pause::default());
        rig.session.test_hooks().arm(Point::Open, Action::Pause(pause.clone()));
        let reader = tokio::spawn({
            let observer = observer.clone();
            async move { observer.history_page(0, None, 2).await }
        });
        pause.reached.notified().await;
        assert!(pause.operation_id.lock().unwrap().is_none());
        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        assert!(!execution.is_finished());
        assert!(!cancel.is_cancelled());
        assert_eq!(count(&rig.script.records.closes), 0);
        assert_eq!(count(&rig.script.records.opens), 1);
        assert_eq!(rig.script.records.inputs.lock().unwrap().len(), 1);
        assert_eq!(count(&rig.script.records.calls), 0);

        let started = Arc::new(Notify::new());
        let second_reader = tokio::spawn({
            let observer = observer.clone();
            let run_id = rig.run_id.clone();
            let started = started.clone();
            async move {
                started.notify_one();
                let history = paged_history(&observer).await;
                let current = observer.run_record(run_id).await.unwrap().unwrap();
                (history, current)
            }
        });
        started.notified().await;
        assert!(!second_reader.is_finished());
        // The first read keeps the session lock through connection cleanup despite waiter drop.
        pause.release.notify_one();
        let (recovered, current) = second_reader.await.unwrap();
        assert!(value(&recovered) == value(&prefix), "reader recovery differs");
        assert_trace(&rig, &recovered, &model, false);
        assert_running(&rig, &current);
        assert!(!execution.is_finished());
        assert!(!cancel.is_cancelled());
        assert_eq!(count(&rig.script.records.closes), 0);

        let rename_id = OperationId::new();
        let title = "renamed during execution λ\n";
        let rename = observer.rename(rename_id.clone(), title.into()).await.unwrap();
        assert!(!rename.duplicate());
        assert!(rename.cleanup_warning().is_none());
        assert!(rename.receipt().operation_id() == &rename_id);
        assert!(rename.receipt().session_id() == rig.session.session_id());
        assert!(rename.receipt().run_id().is_none());
        assert_eq!(rename.receipt().first_sequence(), 7);
        assert_eq!(rename.receipt().last_sequence(), 7);
        let duplicate = observer.rename(rename_id.clone(), title.into()).await.unwrap();
        assert!(duplicate.duplicate());
        assert!(duplicate.cleanup_warning().is_none());
        assert!(duplicate.receipt() == rename.receipt());
        let manifest = observer.manifest().await.unwrap();
        assert!(manifest.title() == title);
        assert_eq!(manifest.head_sequence(), 7);
        let renamed = paged_history(&observer).await;
        assert_eq!(renamed.len(), 7);
        assert!(serde_json::to_value(&renamed[..6]).unwrap() == value(&prefix), "rename changed prior history");
        assert!(matches!(renamed[6].payload(), StoredEventPayload::SessionRenamed { title: saved } if saved == title));
        assert!(renamed[6].run_id().is_none());
        assert_running(&rig, &observer.run_record(rig.run_id.clone()).await.unwrap().unwrap());
        assert!(!execution.is_finished());
        assert!(!cancel.is_cancelled());
        assert_eq!(count(&rig.script.records.closes), 0);

        completion.release.notify_one();
        let outcome = executed(execution.await.unwrap().unwrap());
        let final_history = paged_history(&observer).await;
        assert_eq!(final_history.len(), 11);
        assert!(serde_json::to_value(&final_history[..7]).unwrap() == value(&renamed), "completion changed prior history");
        assert_completed(&rig, &observer, &final_history, &outcome, &model).await;
        assert_only_own_run_and_no_tools(&rig).await;
        assert!(!cancel.is_cancelled());
        let manifest = observer.manifest().await.unwrap();
        assert!(manifest.title() == title);
        assert_eq!(manifest.head_sequence(), 11);

        rig.store.close().await.unwrap();
        let reopened = SessionStore::open(rig.temp.path().join("root")).await.unwrap();
        let selected = reopened.open_session(rig.session.session_id().clone()).await.unwrap();
        let reopened_history = paged_history(&selected).await;
        assert!(value(&reopened_history) == value(&final_history), "reopened history differs");
        assert_completed(&rig, &selected, &reopened_history, &outcome, &model).await;
        assert!(selected.manifest().await.unwrap().title() == title);
        assert!(selected.lookup_receipt(rename_id).await.unwrap().as_ref() == Some(rename.receipt()));
        reopened.close().await.unwrap();
    }).await;
}
