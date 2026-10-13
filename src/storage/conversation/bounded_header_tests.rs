use crate::{
    conversation::{
        BlockView, EntryId, EntryKind, EntryView, FieldFragment, FieldKind, OutcomeView,
        RecordedState, SummaryView,
        wire::{DisplayJson, PAGE_BYTES},
    },
    run::{RunEvent, RunOutcome, RunSummary},
    storage::{AppendRunRecord, OperationId, RecordedRunState, identifier_tests},
};
use sqlx::{ConnectOptions, Connection, sqlite::SqliteConnectOptions};

#[tokio::test]
async fn id2a_invalid_and_oversized_summary_rejects_before_runtime_or_result_commit() {
    let (_temp, store, session, run, path) = identifier_tests::setup().await;
    for request in ["x".repeat(36), "x".repeat(PAGE_BYTES + 1)] {
        for direct in [false, true] {
            let summary = RunSummary {
                last_request_id: Some(request.clone()),
                ..Default::default()
            };
            let records = if direct {
                vec![identifier_tests::result(&run, summary)]
            } else {
                let mut terminal = identifier_tests::runtime(
                    &run,
                    2,
                    RunEvent::RunFinished {
                        outcome: RunOutcome::Completed,
                        summary,
                    },
                );
                let AppendRunRecord::Runtime(event) = &mut terminal else {
                    unreachable!()
                };
                event.request_id = None;
                event.session_id = None;
                vec![
                    identifier_tests::runtime(&run, 1, RunEvent::RunStarted),
                    terminal,
                ]
            };
            identifier_tests::rejected(&session, &run, &path, records, "storage.invalid_input")
                .await;
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn id2a_valid_uuid_summary_fits_block_wire_cap_for_runtime_and_direct_result() {
    for direct in [false, true] {
        let (_temp, store, session, run, path) = identifier_tests::setup().await;
        let summary = RunSummary {
            last_request_id: Some("01234567-89ab-1cde-8fab-0123456789ab".into()),
            ..Default::default()
        };
        let outcome = RunOutcome::Failed {
            code: "event_sink".into(),
        };
        let records = if direct {
            vec![identifier_tests::result(&run, summary.clone())]
        } else {
            let mut terminal = identifier_tests::runtime(
                &run,
                2,
                RunEvent::RunFinished {
                    outcome: outcome.clone(),
                    summary: summary.clone(),
                },
            );
            let AppendRunRecord::Runtime(event) = &mut terminal else {
                unreachable!()
            };
            event.request_id = None;
            event.session_id = None;
            vec![
                identifier_tests::runtime(&run, 1, RunEvent::RunStarted),
                terminal,
            ]
        };
        session
            .append_run_records(OperationId::new(), run.clone(), records)
            .await
            .unwrap();
        let head = session.manifest().await.unwrap().head_sequence();
        assert_eq!(head, if direct { 3 } else { 4 });
        let mut sql = SqliteConnectOptions::new()
            .filename(&path)
            .read_only(true)
            .disable_statement_logging()
            .connect()
            .await
            .unwrap();
        let header: String =
            sqlx::query_scalar("SELECT header_json FROM conversation_blocks WHERE run_id=?")
                .bind(run.as_str())
                .fetch_one(&mut sql)
                .await
                .unwrap();
        let header: serde_json::Value = serde_json::from_str(&header).unwrap();
        assert_eq!(
            header["summary"]["last_request_id"].as_str(),
            summary.last_request_id.as_deref()
        );
        assert_eq!(header["result_recorded"], direct);
        let id: EntryId = header["human"].as_str().unwrap().parse().unwrap();
        let human = EntryView::new(
            run.clone(),
            id,
            2,
            2,
            EntryKind::Human,
            RecordedState::Accepted,
            false,
            None,
            None,
            None,
            None,
            vec![
                FieldFragment::new(
                    "text".into(),
                    "0".into(),
                    FieldKind::Text,
                    2,
                    9,
                    0,
                    9,
                    "synthetic".into(),
                )
                .unwrap(),
            ],
            None,
            true,
        )
        .unwrap();
        let block = BlockView::new(
            run,
            2,
            head,
            RecordedRunState::Failed,
            direct,
            Some(OutcomeView::from(&outcome)),
            Some(SummaryView::from(&summary)),
            direct.then_some(false),
            None,
            human,
        )
        .unwrap();
        assert!(DisplayJson::Entry(block.human()).json_size().is_ok());
        let encoded = DisplayJson::Block(&block).encode().unwrap();
        assert!(encoded.len() <= PAGE_BYTES);
        assert_eq!(
            DisplayJson::Block(&block).json_size().unwrap(),
            encoded.len()
        );
        sql.close().await.unwrap();
        store.close().await.unwrap();
    }
}
