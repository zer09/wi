use super::{
    run_store::{Mutation, RecordFault},
    *,
};
use crate::{
    SessionOptions,
    run::{RunEvent, RunEventEnvelope, RunRequest},
    tools::ToolExecutionEvent,
};
use sqlx::Row;

fn input() -> RecordedRunInput {
    RecordedRunInput::new(
        "original".into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic"),
            prompt: "prepared".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: StoredEventId::new().as_str().into(),
        run_id: run.as_str().into(),
        turn_id: if matches!(event, RunEvent::RunStarted) {
            None
        } else {
            Some("turn".into())
        },
        session_id: if matches!(event, RunEvent::RunStarted) {
            None
        } else {
            Some("session".into())
        },
        request_id: if matches!(event, RunEvent::ToolEvent { .. }) {
            Some("request".into())
        } else {
            None
        },
        event,
    })
}

#[tokio::test]
async fn p1a11_accept_append_faults_roll_back_events_projections_head_and_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "title".into(), None).unwrap())
        .await
        .unwrap();
    let id = created.session_id();
    let handle = store.open_session(id.clone()).await.unwrap();
    let run = RunId::new();
    let guard = store.inner.lifecycle.admit().unwrap();
    for fault in [RecordFault::AfterEvent, RecordFault::AfterProjection] {
        let operation = OperationId::new();
        let (mut connection, provenance) =
            session::connection(&store.inner, id, true).await.unwrap();
        let result = run_store::mutate(
            &mut connection,
            &provenance,
            &store.inner.instance_id,
            &operation,
            &run,
            &Mutation::Accept {
                input: Box::new(input()),
            },
            Some(fault),
        )
        .await;
        assert_eq!(
            result.unwrap_err().certainty(),
            CommitCertainty::NotCommitted
        );
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
        assert!(handle.lookup_receipt(operation).await.unwrap().is_none());
        assert!(handle.run_record(run.clone()).await.unwrap().is_none());
    }
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![
                runtime(&run, 1, RunEvent::RunStarted),
                runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
            ],
        )
        .await
        .unwrap();
    for fault in [RecordFault::AfterEvent, RecordFault::AfterProjection] {
        let operation = OperationId::new();
        let (mut connection, provenance) =
            session::connection(&store.inner, id, true).await.unwrap();
        let mutation = Mutation::Append {
            records: vec![runtime(
                &run,
                3,
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted {
                        call_id: "call".into(),
                        tool_name: "synthetic".into(),
                    },
                },
            )],
        };
        let result = run_store::mutate(
            &mut connection,
            &provenance,
            &store.inner.instance_id,
            &operation,
            &run,
            &mutation,
            Some(fault),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code(), "storage.io");
        assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
        let count: i64 = sqlx::query("SELECT count(*) FROM events")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        assert_eq!(count, 4);
        database::close(connection, &store.inner.lifecycle)
            .await
            .unwrap();
        assert_eq!(handle.manifest().await.unwrap().head_sequence(), 4);
        assert!(handle.lookup_receipt(operation).await.unwrap().is_none());
        assert_eq!(
            handle
                .run_record(run.clone())
                .await
                .unwrap()
                .unwrap()
                .last_runtime_sequence(),
            2
        );
        assert!(
            handle
                .tool_result(run.clone(), "call".into())
                .await
                .unwrap()
                .is_none()
        );
    }
    guard.finish();
    store.close().await.unwrap();
}

#[test]
fn p1a12_checked_batch_sequence_boundaries() {
    assert_eq!(run_store::sequence_range(1, 3).unwrap(), (2, 4));
    assert_eq!(
        run_store::sequence_range(i64::MAX as u64 - 2, 2).unwrap(),
        (i64::MAX - 1, i64::MAX)
    );
    for (head, count) in [
        (0, 0),
        (i64::MAX as u64, 1),
        (i64::MAX as u64 - 1, 2),
        (u64::MAX, 1),
        (1, usize::MAX),
    ] {
        assert_eq!(
            run_store::sequence_range(head, count).unwrap_err().code(),
            "storage.invalid_input"
        );
    }
}
