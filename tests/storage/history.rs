use super::{
    capture::input,
    fixtures::connect,
    recording::{append, result, runtime, session, turn_finished, value},
};
use serde_json::{Value, json};
use sqlx::Connection;
use wi::{
    DeltaKind, EventEnvelope, ItemKind, ModelResponse, OutputItem, OutputProvenance, ProviderEvent,
    ResponseOutcome, UpstreamOutcome, Usage,
    run::{RunEvent, RunOutcome, RunSummary},
    storage::{AppendRunRecord, OperationId, StoredEvent, StoredEventPayload},
};

pub(super) fn response() -> ModelResponse {
    ModelResponse {
        output_provenance: OutputProvenance::ValidatedOutputItemDone,
        id: "response canary\r\n".into(),
        model: Some("model".into()),
        outcome: ResponseOutcome::Completed,
        output: vec![OutputItem {
            id: Some("item".into()),
            kind: ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: json!({"type":"message","content":[{"text":"effective canary\n雪"}]}),
        }],
        text: "effective canary\n雪".into(),
        usage: Some(Usage {
            input_tokens: 7,
            output_tokens: 3,
            total_tokens: 10,
            cached_input_tokens: Some(2),
            reasoning_tokens: Some(1),
        }),
        native: json!({"id":"response canary\r\n","output":[],"unknown":{"z":1.0,"a":["\u{0000}\u{001b}\\n"]}}),
    }
}

pub(super) fn provider(event: ProviderEvent, sequence: u64) -> RunEvent {
    RunEvent::ProviderEvent {
        event: Box::new(EventEnvelope {
            schema_version: 1,
            sequence,
            event_id: format!("provider {sequence}"),
            session_id: "opaque provider session".into(),
            request_id: Some("original request".into()),
            provider: "synthetic-unregistered-provider".into(),
            provider_sequence: Some(999 + sequence),
            event,
        }),
    }
}

#[tokio::test]
async fn p1a13_partial_native_response_and_unknown_extension_exact_roundtrip() {
    let (_fixture, store, handle, run) = session().await;
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    let delta = "canary\0\u{001b}[31m\n雪  {\"a\":\\\"";
    let mut events = vec![
        runtime(&run, 1, RunEvent::RunStarted),
        runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
    ];
    for (index, kind) in [
        DeltaKind::Text,
        DeltaKind::Refusal,
        DeltaKind::ReasoningSummary,
        DeltaKind::ReasoningText,
        DeltaKind::FunctionArguments,
        DeltaKind::CustomToolInput,
    ]
    .into_iter()
    .enumerate()
    {
        events.push(runtime(
            &run,
            index as u64 + 3,
            provider(
                ProviderEvent::OutputItemUpdated {
                    response_id: "response".into(),
                    item_id: "item".into(),
                    output_index: 17,
                    content_index: Some(3),
                    summary_index: Some(5),
                    kind,
                    delta: delta.into(),
                },
                index as u64 + 1,
            ),
        ));
    }
    events.push(runtime(
        &run,
        9,
        provider(
            ProviderEvent::ProviderExtension {
                event_type: "future.native.extension".into(),
                payload: json!({"opaque":"canary\n雪","output":[],"other":{"float":1.0}}),
            },
            7,
        ),
    ));
    let response = response();
    events.push(runtime(
        &run,
        10,
        provider(
            ProviderEvent::ResponseFinished {
                response: response.clone(),
            },
            8,
        ),
    ));
    let summary = RunSummary {
        turns_started: 1,
        turns_finished: 1,
        model_requests_attempted: 1,
        model_requests_admitted: 1,
        last_request_id: Some("original request".into()),
        last_upstream_outcome: Some(UpstreamOutcome::Unknown),
        ..RunSummary::default()
    };
    events.push(runtime(&run, 11, turn_finished(1)));
    events.push(runtime(
        &run,
        12,
        RunEvent::RunFinished {
            outcome: RunOutcome::Completed,
            summary: summary.clone(),
        },
    ));
    let mut final_result = result(&run, RunOutcome::Completed);
    final_result.summary = summary;
    final_result.last_response = Some(response);
    let mut records: Vec<_> = events
        .iter()
        .cloned()
        .map(AppendRunRecord::Runtime)
        .collect();
    records.push(AppendRunRecord::Result(final_result.clone()));
    append(&handle, &run, records).await;
    let page = handle.history_page(2, None, 20).await.unwrap();
    for (stored, original) in page.records().iter().zip(&events) {
        let StoredEventPayload::RuntimeObserved(event) = stored.payload() else {
            panic!("wrong event");
        };
        assert_eq!(value(event), value(original));
        assert_eq!(stored.schema_version(), 1);
        assert_eq!(stored.event_version(), 1);
        let serialized = value(stored);
        let decoded: StoredEvent = serde_json::from_value(serialized.clone()).unwrap();
        assert_eq!(value(&decoded), serialized);
        assert!(!format!("{stored:?} {:?}", stored.payload()).contains("canary"));
        for (field, invalid) in [
            ("unexpected", json!(true)),
            ("sequence", json!(1)),
            ("schema_version", json!(2)),
            ("event_version", json!(2)),
            ("created_at_ms", json!(-1)),
            ("run_id", json!(null)),
        ] {
            let mut unknown = serialized.clone();
            unknown[field] = invalid;
            assert!(serde_json::from_value::<StoredEvent>(unknown).is_err());
        }
    }
    let recorded = handle.run_record(run).await.unwrap().unwrap();
    let actual = recorded.result().unwrap();
    assert_eq!(value(actual), value(&final_result));
    assert_eq!(
        actual.last_response.as_ref().unwrap().native["output"],
        json!([])
    );
    assert!(!actual.last_response.as_ref().unwrap().output.is_empty());
    assert_eq!(
        actual.summary.last_upstream_outcome,
        Some(UpstreamOutcome::Unknown)
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1a20_immutable_snapshot_pages_with_appends_and_cursor_edges() {
    let (_fixture, store, handle, _run) = session().await;
    for n in 0..5 {
        handle
            .rename(OperationId::new(), format!("title {n}"))
            .await
            .unwrap();
    }
    let original = handle.history_page(0, None, 6).await.unwrap();
    assert!(!original.has_more());
    let first = handle.history_page(0, None, 2).await.unwrap();
    let head = first.through_sequence();
    assert_eq!(head, 6);
    assert!(first.has_more());
    let mut observed = first.records().to_vec();
    let mut after = first.next_after();
    loop {
        // Concurrent writes above H cannot change the page's immutable range.
        let (renamed, page) = tokio::join!(
            handle.rename(OperationId::new(), "above H".into()),
            handle.history_page(after, Some(head), 2),
        );
        renamed.unwrap();
        let page = page.unwrap();
        assert_eq!(page.through_sequence(), head);
        after = page.next_after();
        observed.extend_from_slice(page.records());
        if !page.has_more() {
            break;
        }
    }
    assert_eq!(value(&observed), value(&original.records()));
    assert_eq!(after, head);
    let empty = handle.history_page(head, Some(head), 1).await.unwrap();
    assert!(empty.records().is_empty());
    assert!(!empty.has_more());
    assert_eq!(empty.next_after(), head);
    assert!(
        handle
            .history_page(0, Some(0), 1)
            .await
            .unwrap()
            .records()
            .is_empty()
    );
    for (after, through, size) in [
        (7, Some(6), 1),
        (100, None, 1),
        (0, Some(100), 1),
        (0, None, 0),
        (0, None, u64::MAX),
        (0, None, i64::MAX as u64),
        (u64::MAX, None, 1),
        (0, Some(u64::MAX), 1),
    ] {
        assert_eq!(
            handle
                .history_page(after, through, size)
                .await
                .unwrap_err()
                .code(),
            "storage.invalid_input"
        );
    }
    let all = handle.history_page(0, None, 100).await.unwrap();
    assert_eq!(all.through_sequence(), 8);
    assert!(all.records().len() > observed.len());
    store.close().await.unwrap();
}

#[tokio::test]
async fn history_decode_corruption_is_static_integrity() {
    for fault in 0..7 {
        let (fixture, store, handle, run) = session().await;
        handle
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        let started = runtime(&run, 1, RunEvent::RunStarted);
        let mut broken = value(&started);
        match fault {
            0 => broken["schema_version"] = json!(3),
            1 => broken["type"] = json!("arbitrary-canary"),
            2 => broken = Value::Null,
            3 => broken["sequence"] = json!(0),
            4 => broken["event_id"] = json!("conflicting-canary"),
            5 => broken["run_id"] = json!(wi::storage::RunId::new().as_str()),
            6 => {
                broken = value(&runtime(
                    &run,
                    1,
                    provider(
                        ProviderEvent::ProviderExtension {
                            event_type: "future".into(),
                            payload: Value::Null,
                        },
                        1,
                    ),
                ));
                broken["event"]["schema_version"] = json!(2);
            }
            _ => unreachable!(),
        }
        append(&handle, &run, vec![AppendRunRecord::Runtime(started)]).await;
        handle
            .rename(OperationId::new(), "keep corruption away from head".into())
            .await
            .unwrap();
        let id = handle.session_id().as_str();
        let path = fixture
            .root
            .join("sessions")
            .join(&id[..2])
            .join(id)
            .join("session.sqlite3");
        let mut connection = connect(&path).await;
        sqlx::query("DROP TRIGGER events_no_update")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("UPDATE events SET payload_json=? WHERE sequence=3")
            .bind(broken.to_string())
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END;").execute(&mut connection).await.unwrap();
        connection.close().await.unwrap();
        let error = handle.history_page(0, None, 10).await.unwrap_err();
        assert_eq!(error.code(), "storage.integrity");
        assert!(!format!("{error:?} {error}").contains("canary"));
        store.close().await.unwrap();
    }
}
