//! P1B1-21: the real bounded adapter queue drains into awaited SQLite observations.
use super::*;
use crate::{
    DeltaKind, EventEnvelope,
    storage::test_hooks::{Action, Pause, Point, Record},
};
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::future::Future;

// session::spawn uses 64 slots. This fixture asserts that boundary, not a new capacity.
const QUEUE: usize = 64;
const BURST: usize = QUEUE + 1;
const EXTENSION: usize = 32;

async fn guarded<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(20), future)
        .await
        .expect("pressure test watchdog")
}

fn fragment(index: usize) -> String {
    format!("{index:02}:雪\r\n\0\\\" ")
}

fn frame(index: usize) -> Value {
    let sequence = 1000 + index * 7;
    if index == EXTENSION {
        return json!({"type":"synthetic.pressure", "sequence_number":sequence,
            "response_id":"pressure", "opaque":{"keep":[3,1], "text":fragment(index)}});
    }
    json!({"type":"response.output_text.delta", "sequence_number":sequence,
        "response_id":"pressure", "item_id":"message", "output_index":0,
        "content_index":0, "summary_index":2, "delta":fragment(index)})
}

fn final_frame() -> Value {
    let text: String = (0..=BURST)
        .filter(|index| *index != EXTENSION)
        .map(fragment)
        .collect();
    json!({"type":"response.completed", "sequence_number":9000,
        "response":{"id":"pressure", "status":"completed", "model":"synthetic-model",
            "output":[{"type":"message", "id":"message", "status":"completed",
                "content":[{"type":"output_text", "text":text}],
                "metadata":{"opaque":"terminal 雪\u{0000}"}}],
            "usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5},
            "metadata":{"keep":[3,1],"text":"native\r\n"}}})
}

fn assert_frame(event: &EventEnvelope, index: usize) {
    assert_eq!(event.provider_sequence, Some((1000 + index * 7) as u64));
    let expected = if index == EXTENSION {
        ProviderEvent::ProviderExtension {
            event_type: "synthetic.pressure".into(),
            payload: frame(index),
        }
    } else {
        ProviderEvent::OutputItemUpdated {
            response_id: "pressure".into(),
            item_id: "message".into(),
            output_index: 0,
            content_index: Some(0),
            summary_index: Some(2),
            kind: DeltaKind::Text,
            delta: fragment(index),
        }
    };
    assert_eq!(value(&event.event), value(&expected));
}

fn pause_text(run: &PersistedRun) -> Arc<Pause> {
    let pause = Arc::new(Pause::default());
    run.capture.session.test_hooks().arm_record(
        Record::PartialText,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    pause
}

async fn reader(run: &PersistedRun) -> SqliteConnection {
    let id = run.capture.session.session_id().as_str();
    let path = run
        ._temp
        .path()
        .join("storage/sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    // Public same-session reads serialize behind the paused writer. This independent,
    // read-only test connection observes committed WAL data without releasing that writer.
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging(),
    )
    .await
    .unwrap()
}

async fn paused_prefix(reader: &mut SqliteConnection, pause: &Pause) -> Vec<(i64, String)> {
    let operation = pause.operation_id.lock().unwrap().clone().unwrap();
    let receipt: i64 = sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
        .bind(operation.as_str())
        .fetch_one(&mut *reader)
        .await
        .unwrap();
    assert_eq!(receipt, 0, "queue acceptance is not a commit");
    sqlx::query_as("SELECT sequence, payload_json FROM events ORDER BY sequence")
        .fetch_all(reader)
        .await
        .unwrap()
}

async fn pressure_case(slow_consumer: bool) {
    let run = Arc::new(PersistedRun::new(Transport::WebSocket).await);
    let pause = pause_text(&run);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let consumer = if slow_consumer {
        Duration::from_millis(50)
    } else {
        Timeouts::default().consumer
    };
    let (gateway, auth, opens) =
        setup_with_consumer_timeout(address, Transport::WebSocket, Some(consumer));
    let (burst, start_burst) = oneshot::channel();
    let (pressure, queue_full) = oneshot::channel();
    let (sent, burst_sent) = oneshot::channel();
    let (closed, socket_closed) = oneshot::channel();
    let (stop, stopped) = oneshot::channel();
    let capture = run.capture.clone();
    let server = tokio::spawn(async move {
        let mut socket = accept_ws(&listener).await;
        let request = incoming(&mut socket).await;
        capture.observe_request(0, &request, &request).await;
        send(
            &mut socket,
            json!({"type":"response.created", "sequence_number":11,
            "response":{"id":"pressure"}}),
        )
        .await;
        send(
            &mut socket,
            json!({"type":"response.output_item.added", "sequence_number":17,
            "output_index":0, "item":{"type":"message", "id":"message", "content":[],
                "metadata":{"opaque":"started 雪\u{0000}"}}}),
        )
        .await;
        send(&mut socket, frame(0)).await;
        start_burst.await.unwrap();
        for index in 1..=QUEUE {
            send(&mut socket, frame(index)).await;
        }
        socket
            .send(Message::Ping(b"queue-full".to_vec().into()))
            .await
            .unwrap();
        let pong = socket.next().await.unwrap().unwrap();
        assert!(matches!(pong, Message::Pong(bytes) if bytes.as_ref() == b"queue-full"));
        // wire::receive can Pong only after session::drive decoded and emitted all
        // 64 preceding events. The first delta is still paused, so all 64 slots are full.
        pressure.send(()).unwrap();
        send(&mut socket, frame(BURST)).await;
        send(&mut socket, final_frame()).await;
        sent.send(()).unwrap();
        // Neither branch releases its current SQL pause before observing this close.
        // Thus the core cannot have read a terminal and closed the provider itself.
        let close = socket.next().await.unwrap().unwrap();
        assert!(
            matches!(close, Message::Close(_)),
            "extra request or missing provider close"
        );
        // The worker drops its socket after sending Close. With an unread terminal,
        // TCP can reset a later close reply; the received Close is the required barrier.
        drop(socket);
        closed.send(()).unwrap();
        no_extra(listener, stopped).await;
    });
    let task = tokio::spawn({
        let run = run.clone();
        async move {
            run_persisted(
                &gateway,
                &run.capture.session,
                PersistentRunRequest {
                    operation_id: run.capture.operation_id.clone(),
                    run_id: run.capture.run_id.clone(),
                    input: run.capture.input.clone(),
                },
                &run.tools,
                CancellationToken::new(),
            )
            .await
        }
    });
    guarded(pause.reached.notified()).await;
    let mut reader = reader(&run).await;
    let prefix = paused_prefix(&mut reader, &pause).await;
    assert_eq!(prefix.len(), 6);
    let before_delta: RunEventEnvelope = serde_json::from_str(&prefix[5].1).unwrap();
    assert!(
        matches!(before_delta.event, RunEvent::ProviderEvent { event }
        if matches!(event.event, ProviderEvent::OutputItemStarted { .. }))
    );
    burst.send(()).unwrap();
    guarded(queue_full).await.unwrap();
    guarded(burst_sent).await.unwrap();
    assert_eq!(paused_prefix(&mut reader, &pause).await, prefix);
    assert!(!task.is_finished());
    assert_eq!(run.capture.executions.load(Ordering::SeqCst), 0);

    if slow_consumer {
        // No sleep proves failure. After the explicit full-queue Pong, keep SQL paused
        // until the real worker times out its unsent event and closes the socket.
        guarded(socket_closed).await.unwrap();
        assert_eq!(paused_prefix(&mut reader, &pause).await, prefix);
        assert!(!task.is_finished());
        pause.release.notify_one();
    } else {
        // Release exactly one slot, then pause the next actual delta commit. The last
        // burst event fills that slot; the terminal must use EventSink::terminal's
        // final slot and close the worker before this second commit can complete.
        let second = pause_text(&run);
        pause.release.notify_one();
        guarded(second.reached.notified()).await;
        guarded(socket_closed).await.unwrap();
        let partial = paused_prefix(&mut reader, &second).await;
        assert_eq!(partial.len(), 7);
        assert_eq!(&partial[..prefix.len()], prefix);
        let first: RunEventEnvelope = serde_json::from_str(&partial[6].1).unwrap();
        let RunEvent::ProviderEvent { event } = first.event else {
            panic!("missing committed first delta")
        };
        assert_frame(&event, 0);
        assert!(!task.is_finished());
        second.release.notify_one();
    }
    let PersistentRunResult::Executed {
        acceptance,
        final_record,
        result,
    } = guarded(task).await.unwrap().unwrap()
    else {
        panic!("new operation did not execute")
    };
    let upstream = if slow_consumer {
        UpstreamOutcome::Unknown
    } else {
        UpstreamOutcome::TerminalReceived
    };
    let outcome = if slow_consumer {
        RunOutcome::Failed {
            code: "provider_request_failed".into(),
        }
    } else {
        RunOutcome::Completed
    };
    assert_eq!(result.outcome, outcome);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(result.run_id, run.capture.run_id.as_str());
    assert_eq!(result.summary.last_upstream_outcome, Some(upstream));
    assert_eq!(result.summary.model_requests_attempted, 1);
    assert_eq!(result.summary.model_requests_admitted, 1);
    assert_eq!(result.summary.turns_started, 1);
    assert_eq!(result.summary.turns_finished, 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(run.capture.executions.load(Ordering::SeqCst), 0);
    assert_auth(&auth, &opens, 1);

    let history = run.capture.history().await;
    let delivered = if slow_consumer { QUEUE } else { BURST };
    // Start + item + first delta + delivered burst + provider terminal; four core events.
    assert_eq!(history.len(), delivered + 11);
    let mut provider = vec![];
    let mut runtime = vec![];
    let mut stored_ids = HashSet::new();
    let mut runtime_ids = HashSet::new();
    for (index, record) in history.iter().enumerate() {
        assert_eq!(record.sequence(), index as u64 + 1);
        assert!(stored_ids.insert(record.event_id().clone()));
        assert_eq!(
            record.application_session_id(),
            run.capture.session.session_id()
        );
        if index > 0 {
            assert_eq!(record.run_id(), Some(&run.capture.run_id));
        }
        if let StoredEventPayload::RuntimeObserved(event) = record.payload() {
            assert_eq!(event.schema_version, 2);
            assert_eq!(event.run_id, result.run_id);
            assert_eq!(event.sequence, runtime.len() as u64 + 1);
            assert!(runtime_ids.insert(event.event_id.clone()));
            if let RunEvent::ProviderEvent { event: nested } = &event.event {
                assert_eq!(nested.schema_version, 1);
                assert_eq!(nested.provider, PROVIDER_ID);
                assert_eq!(Some(&nested.session_id), result.session_id.as_ref());
                assert_eq!(event.session_id.as_ref(), Some(&nested.session_id));
                assert_ne!(nested.session_id, run.capture.session.session_id().as_str());
                assert_eq!(nested.request_id, result.summary.last_request_id);
                assert_eq!(event.request_id, nested.request_id);
                assert!(event.turn_id.is_some());
                assert_eq!(
                    nested.event_id,
                    format!("{}:{}", nested.session_id, nested.sequence)
                );
                provider.push(nested.as_ref());
            }
            runtime.push(event);
        }
    }
    assert_eq!(provider.len(), delivered + 4);
    for (index, event) in provider[..provider.len() - 1].iter().enumerate() {
        assert_eq!(event.sequence, index as u64 + 1);
    }
    assert!(
        provider
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence)
    );
    assert_eq!(provider[0].provider_sequence, Some(11));
    assert!(
        matches!(&provider[0].event, ProviderEvent::ResponseStarted { response_id } if response_id == "pressure")
    );
    assert_eq!(provider[1].provider_sequence, Some(17));
    let ProviderEvent::OutputItemStarted {
        response_id,
        output_index,
        item,
    } = &provider[1].event
    else {
        panic!("missing actual item start")
    };
    assert_eq!(response_id, "pressure");
    assert_eq!(*output_index, 0);
    assert_eq!(
        item.native,
        json!({"type":"message", "id":"message", "content":[],
        "metadata":{"opaque":"started 雪\u{0000}"}})
    );
    for index in 0..=delivered {
        assert_frame(provider[index + 2], index);
    }
    let terminal = provider.last().unwrap();
    assert_eq!(terminal.sequence, (BURST + 4) as u64);
    if slow_consumer {
        // The failed emit consumed source sequence 68, but never delivered its delta.
        // Only the 64 queued burst events and final-slot failure are claimed as history.
        assert_eq!(terminal.sequence - provider[provider.len() - 2].sequence, 2);
        assert_eq!(terminal.provider_sequence, None);
        assert!(
            matches!(&terminal.event, ProviderEvent::RequestFailed { code, message, upstream_outcome }
            if code == "slow_consumer" && message == &GatewayError::SlowConsumer.to_string()
                && *upstream_outcome == UpstreamOutcome::Unknown)
        );
        assert!(result.last_response.is_none());
        assert!(
            !provider
                .iter()
                .any(|event| matches!(event.event, ProviderEvent::ResponseFinished { .. }))
        );
    } else {
        assert_eq!(terminal.provider_sequence, Some(9000));
        let ProviderEvent::ResponseFinished { response } = &terminal.event else {
            panic!("missing final-slot completion")
        };
        assert_eq!(response.outcome, ResponseOutcome::Completed);
        assert_eq!(response.native, final_frame()["response"]);
        assert_eq!(response.output_provenance, OutputProvenance::NativeTerminal);
        assert_eq!(response.output.len(), 1);
        assert_eq!(
            response.output[0].native,
            final_frame()["response"]["output"][0]
        );
        assert_eq!(
            response.text,
            final_frame()["response"]["output"][0]["content"][0]["text"]
        );
        assert_eq!(
            value(response),
            value(result.last_response.as_ref().unwrap())
        );
    }
    assert_eq!(
        provider
            .iter()
            .filter(|event| matches!(
                event.event,
                ProviderEvent::RequestFailed { .. } | ProviderEvent::ResponseFinished { .. }
            ))
            .count(),
        1
    );
    assert_eq!(
        runtime
            .iter()
            .filter(|event| matches!(event.event, RunEvent::RunFinished { .. }))
            .count(),
        1
    );
    assert!(
        matches!(&runtime.last().unwrap().event, RunEvent::RunFinished { outcome: saved, summary }
        if saved == &outcome && value(summary) == value(&result.summary))
    );
    assert!(
        !runtime
            .iter()
            .any(|event| matches!(event.event, RunEvent::ToolEvent { .. }))
    );
    assert!(
        !history
            .iter()
            .any(|record| matches!(record.payload(), StoredEventPayload::ToolResultRecorded(_)))
    );
    assert_eq!(
        history
            .iter()
            .filter(|record| matches!(record.payload(), StoredEventPayload::RunResultRecorded(_)))
            .count(),
        1
    );
    assert!(
        matches!(history.last().unwrap().payload(), StoredEventPayload::RunResultRecorded(saved)
        if value(saved) == value(&result))
    );
    let saved = run
        .capture
        .session
        .run_record(run.capture.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    let state = if slow_consumer {
        RecordedRunState::Failed
    } else {
        RecordedRunState::Completed
    };
    assert_eq!(saved.state(), state);
    assert_eq!(value(saved.input()), value(&run.capture.input));
    assert_eq!(value(saved.result().unwrap()), value(&result));
    assert_eq!(saved.last_runtime_sequence(), runtime.len() as u64);
    assert_eq!(saved.result_sequence(), Some(history.len() as u64));
    for commit in [&acceptance, &final_record] {
        assert!(!commit.duplicate());
        assert_eq!(commit.cleanup_warning(), None);
        assert_eq!(
            run.capture
                .session
                .lookup_receipt(commit.receipt().operation_id().clone())
                .await
                .unwrap()
                .as_ref(),
            Some(commit.receipt())
        );
    }
    assert_eq!(
        acceptance.receipt().operation_id(),
        &run.capture.operation_id
    );
    assert_eq!(
        (
            acceptance.receipt().first_sequence(),
            acceptance.receipt().last_sequence()
        ),
        (2, 2)
    );
    assert_eq!(
        (
            final_record.receipt().first_sequence(),
            final_record.receipt().last_sequence()
        ),
        (history.len() as u64, history.len() as u64)
    );
    let first_operation = pause.operation_id.lock().unwrap().clone().unwrap();
    let first_commit = run
        .capture
        .session
        .lookup_receipt(first_operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (first_commit.first_sequence(), first_commit.last_sequence()),
        (7, 7)
    );
    let tool_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM tool_results")
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(tool_rows, 0);
    reader.close().await.unwrap();
    stop.send(()).unwrap();
    guarded(server).await.unwrap();
    guarded(run.store.close()).await.unwrap();
    // Healthy close unlocks even though the original handle/store remain retained.
    let reopened = SessionStore::open(run._temp.path().join("storage"))
        .await
        .unwrap();
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_21_persisted_ws_pressure_preserves_every_observation_and_final_slot() {
    guarded(pressure_case(false)).await;
}

#[tokio::test]
async fn p1b1_21_persisted_ws_slow_storage_records_final_slot_slow_consumer() {
    guarded(pressure_case(true)).await;
}
