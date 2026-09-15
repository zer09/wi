use super::{
    fixtures::connect,
    history::provider,
    recording::{append, result, runtime, session},
    tools::{Mode, execute, registry, tool_event, with_tools},
};
use sqlx::{Connection, Row};
use std::sync::atomic::Ordering;
use wi::{
    DeltaKind, ProviderEvent,
    run::{RunEvent, RunOutcome},
    storage::{AppendRunRecord, OperationId, StoredEventPayload},
};

#[tokio::test]
async fn p1a26_finite_history_and_tool_results_exceed_old_context_thresholds() {
    // This finite test workload is not a storage limit or an infinite-execution claim.
    const DELTAS: u64 = 2100;
    const DELTA_BYTES: usize = 4096;
    const TOOLS: u64 = 129;
    let (fixture, store, handle, run) = session().await;
    let (mut tools, executions) = registry(Mode::Success);
    handle
        .accept_run(OperationId::new(), run.clone(), with_tools(&tools))
        .await
        .unwrap();
    let mut records = vec![
        AppendRunRecord::Runtime(runtime(&run, 1, RunEvent::RunStarted)),
        AppendRunRecord::Runtime(runtime(&run, 2, RunEvent::TurnStarted { number: 1 })),
    ];
    let mut sequence = 2;
    for n in 0..DELTAS {
        sequence += 1;
        records.push(AppendRunRecord::Runtime(runtime(
            &run,
            sequence,
            provider(
                ProviderEvent::OutputItemUpdated {
                    response_id: "response".into(),
                    item_id: "item".into(),
                    output_index: 0,
                    content_index: Some(0),
                    summary_index: None,
                    kind: DeltaKind::Text,
                    delta: "x".repeat(DELTA_BYTES),
                },
                n + 1,
            ),
        )));
    }
    for n in 0..TOOLS {
        let call = format!("call-{n}");
        // Each real registry response has one call; provider batch limits remain intact.
        let (events, output, is_error) = execute(&mut tools, &call).await;
        sequence += 1;
        records.push(tool_event(&run, sequence, events[0].clone()));
        records.push(AppendRunRecord::ToolResult {
            request_id: Some("original request".into()),
            call_id: call,
            output,
            is_error,
        });
        sequence += 1;
        records.push(tool_event(&run, sequence, events[1].clone()));
    }
    records.push(AppendRunRecord::Result(result(&run, RunOutcome::Completed)));
    append(&handle, &run, records).await;
    let mut after = 0;
    let mut through = None;
    let mut delta_count = 0;
    let mut bytes = 0;
    let mut results = 0;
    loop {
        let page = handle.history_page(after, through, 128).await.unwrap();
        for event in page.records() {
            match event.payload() {
                StoredEventPayload::RuntimeObserved(event) => {
                    if let RunEvent::ProviderEvent { event } = &event.event
                        && let ProviderEvent::OutputItemUpdated { delta, .. } = &event.event
                    {
                        delta_count += 1;
                        bytes += delta.len();
                        assert_eq!(delta, &"x".repeat(DELTA_BYTES));
                    }
                }
                StoredEventPayload::ToolResultRecorded(_) => results += 1,
                _ => {}
            }
        }
        through = Some(page.through_sequence());
        after = page.next_after();
        if !page.has_more() {
            break;
        }
    }
    assert_eq!(delta_count, DELTAS);
    assert_eq!(bytes, DELTAS as usize * DELTA_BYTES);
    assert!(bytes > 8 * 1024 * 1024);
    assert_eq!(results, TOOLS);
    assert_eq!(after, 2492);
    assert_eq!(executions.load(Ordering::SeqCst), TOOLS as usize);
    let id = handle.session_id().as_str();
    let path = fixture
        .root
        .join("sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    let mut connection = connect(&path).await;
    let row = sqlx::query("SELECT count(*), sum(length(CAST(payload_json AS BLOB))) FROM events")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    let count: i64 = row.try_get(0).unwrap();
    let payload_bytes: i64 = row.try_get(1).unwrap();
    assert_eq!(count, after as i64);
    assert!(payload_bytes > bytes as i64);
    let tool_count: i64 =
        sqlx::query("SELECT count(*) FROM tool_results WHERE result_sequence IS NOT NULL")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
    assert_eq!(tool_count, TOOLS as i64);
    println!(
        "P1A-26 finite workload: events={count}; deltas={delta_count}; exact_delta_bytes={bytes}; canonical_payload_bytes={payload_bytes}; saved_tool_results={tool_count}; registry_executions={TOOLS}"
    );
    connection.close().await.unwrap();
    store.close().await.unwrap();
}
