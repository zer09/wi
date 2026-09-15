use super::{
    capture::input,
    fixtures::{Fixture, connect},
    recording::{append, result, runtime, turn_finished, value},
};
use sqlx::Connection;
use std::{fs, path::PathBuf};
use wi::{
    run::{RunEvent, RunOutcome, RunSummary},
    storage::*,
    tools::ToolExecutionEvent,
};

fn path(fixture: &Fixture, id: &ApplicationSessionId) -> PathBuf {
    fixture.root.join(format!(
        "sessions/{}/{}/session.sqlite3",
        &id.as_str()[..2],
        id
    ))
}

async fn accepted(store: &SessionStore) -> (SessionHandle, RunId) {
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "repair".into(), None).unwrap())
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let run = RunId::new();
    handle
        .accept_run(OperationId::new(), run.clone(), input())
        .await
        .unwrap();
    (handle, run)
}

async fn running(handle: &SessionHandle, run: &RunId) {
    append(
        handle,
        run,
        vec![
            AppendRunRecord::Runtime(runtime(run, 3, RunEvent::RunStarted)),
            AppendRunRecord::Runtime(runtime(run, 9, RunEvent::TurnStarted { number: 1 })),
        ],
    )
    .await;
}

async fn finished(handle: &SessionHandle, run: &RunId) {
    append(
        handle,
        run,
        vec![
            AppendRunRecord::Runtime(runtime(run, 17, turn_finished(1))),
            AppendRunRecord::Runtime(runtime(
                run,
                31,
                RunEvent::RunFinished {
                    outcome: RunOutcome::Completed,
                    summary: RunSummary::default(),
                },
            )),
            AppendRunRecord::Result(result(run, RunOutcome::Completed)),
        ],
    )
    .await;
}

#[tokio::test]
async fn repair_integrity_run_projection_matches_full_replay() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mutations = [
        (false, "UPDATE runs SET state='accepted'"),
        (false, "UPDATE runs SET last_runtime_sequence=0"),
        (false, "UPDATE runs SET last_runtime_sequence=3"),
        (false, "UPDATE runs SET last_runtime_sequence=10"),
        (false, "UPDATE runs SET provider_session_id=NULL"),
        (false, "UPDATE runs SET provider_session_id='wrong'"),
        (true, "UPDATE runs SET last_runtime_sequence=9"),
        (true, "UPDATE runs SET result_sequence=NULL"),
    ];
    let mut damaged = Vec::new();
    for (terminal, mutation) in mutations {
        let (handle, run) = accepted(&store).await;
        running(&handle, &run).await;
        if terminal {
            finished(&handle, &run).await;
        }
        let file = path(&fixture, handle.session_id());
        let mut sql = connect(&file).await;
        sqlx::query(mutation).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        damaged.push((
            handle.session_id().clone(),
            fs::read(&file).unwrap(),
            mutation,
        ));
    }
    let mut healthy = Vec::new();
    for terminal in [false, true] {
        let (handle, run) = accepted(&store).await;
        running(&handle, &run).await;
        if terminal {
            finished(&handle, &run).await;
        }
        healthy.push((
            handle.clone(),
            value(&handle.history_page(0, None, 100).await.unwrap()),
        ));
    }
    for _ in 0..2 {
        let report = store.repair_catalog().await.unwrap();
        let page = store.list_sessions(None, 100).await.unwrap();
        let mut missed = Vec::new();
        for (id, bytes, mutation) in &damaged {
            let summary = page
                .sessions()
                .iter()
                .find(|s| s.session_id() == id)
                .unwrap();
            if summary.availability() != SessionAvailability::Unavailable
                || summary.fault_code() != Some("storage.integrity")
            {
                missed.push(*mutation);
            }
            assert_eq!(fs::read(path(&fixture, id)).unwrap(), *bytes, "{mutation}");
        }
        assert!(missed.is_empty(), "repair accepted mismatches: {missed:?}");
        assert_eq!(report.unavailable_sessions(), mutations.len() as u64);
        assert_eq!(report.ready_sessions(), healthy.len() as u64);
        for (handle, before) in &healthy {
            assert_eq!(
                value(&handle.history_page(0, None, 100).await.unwrap()),
                *before
            );
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn repair_integrity_replays_transition_and_correlation_rules() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mutations = [
        "UPDATE events SET source_sequence=10, payload_json=json_set(payload_json,'$.sequence',10) WHERE source_sequence=3",
        "UPDATE events SET payload_json=json_set(payload_json,'$.session_id','wrong') WHERE source_sequence=9",
        "UPDATE events SET payload_json=json_set(payload_json,'$.turn_id','wrong') WHERE source_sequence=17",
        "UPDATE events SET payload_json=json_set(payload_json,'$.number',2) WHERE source_sequence=17",
        "UPDATE events SET payload_json=json_remove(json_set(payload_json,'$.type','run_started'),'$.turn_id','$.session_id','$.request_id') WHERE source_sequence=9",
    ];
    let mut damaged = Vec::new();
    for mutation in mutations {
        let (handle, run) = accepted(&store).await;
        running(&handle, &run).await;
        append(
            &handle,
            &run,
            vec![AppendRunRecord::Runtime(runtime(
                &run,
                17,
                turn_finished(1),
            ))],
        )
        .await;
        let file = path(&fixture, handle.session_id());
        let mut sql = connect(&file).await;
        sqlx::query("DROP TRIGGER events_no_update")
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query(mutation).execute(&mut sql).await.unwrap();
        sqlx::query("CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END").execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        damaged.push((handle.session_id().clone(), fs::read(file).unwrap()));
    }
    for _ in 0..2 {
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.unavailable_sessions(), mutations.len() as u64);
        for summary in store.list_sessions(None, 100).await.unwrap().sessions() {
            assert_eq!(summary.fault_code(), Some("storage.integrity"));
        }
        for (id, bytes) in &damaged {
            assert_eq!(fs::read(path(&fixture, id)).unwrap(), *bytes);
        }
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn repair_integrity_run_partial_result_interruption_and_opaque_controls() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mut controls = Vec::new();
    for kind in 0..9 {
        let (handle, run) = accepted(&store).await;
        if kind != 0 && kind != 3 {
            append(
                &handle,
                &run,
                vec![AppendRunRecord::Runtime(runtime(
                    &run,
                    7,
                    RunEvent::RunStarted,
                ))],
            )
            .await;
        }
        match kind {
            2 => {
                let mut event = runtime(&run, 19, RunEvent::TurnStarted { number: 1 });
                event.session_id = Some("\0雪 opaque ".into());
                append(&handle, &run, vec![AppendRunRecord::Runtime(event)]).await;
            }
            3..=5 => {
                let outcome = match kind {
                    3 => RunOutcome::Completed,
                    4 => RunOutcome::Failed {
                        code: "gateway_error".into(),
                    },
                    _ => RunOutcome::CancelledLocally,
                };
                let mut final_result = result(&run, outcome);
                final_result.session_id = None;
                append(&handle, &run, vec![AppendRunRecord::Result(final_result)]).await;
            }
            6..=8 => {
                let outcome = match kind {
                    6 => RunOutcome::Completed,
                    7 => RunOutcome::Failed {
                        code: "gateway_error".into(),
                    },
                    _ => RunOutcome::CancelledLocally,
                };
                let mut event = runtime(
                    &run,
                    29,
                    RunEvent::RunFinished {
                        outcome: outcome.clone(),
                        summary: RunSummary::default(),
                    },
                );
                event.session_id = None;
                event.request_id = None;
                append(&handle, &run, vec![AppendRunRecord::Runtime(event)]).await;
                let mut final_result = result(&run, outcome);
                final_result.session_id = None;
                final_result.events_complete = true;
                final_result.sink_error = None;
                append(&handle, &run, vec![AppendRunRecord::Result(final_result)]).await;
            }
            _ => {}
        }
        controls.push((handle.session_id().clone(), run));
    }
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 9);
    store.close().await.unwrap();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mut saved = Vec::new();
    for (index, (id, run)) in controls.iter().enumerate() {
        let handle = store.open_session(id.clone()).await.unwrap();
        if index < 3 {
            assert_eq!(
                handle
                    .run_record(run.clone())
                    .await
                    .unwrap()
                    .unwrap()
                    .state(),
                RecordedRunState::Interrupted
            );
        }
        saved.push((
            handle.clone(),
            value(&handle.history_page(0, None, 100).await.unwrap()),
        ));
    }
    for _ in 0..2 {
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.ready_sessions(), 9);
        assert_eq!(report.unavailable_sessions(), 0);
        for (handle, before) in &saved {
            assert_eq!(
                value(&handle.history_page(0, None, 100).await.unwrap()),
                *before
            );
        }
    }
    store.close().await.unwrap();
}

fn tool(run: &RunId, sequence: u64, call: &str, finish: bool) -> AppendRunRecord {
    let event = if finish {
        ToolExecutionEvent::ToolExecutionFinished {
            call_id: call.into(),
            tool_name: "tool".into(),
            is_error: true,
        }
    } else {
        ToolExecutionEvent::ToolExecutionStarted {
            call_id: call.into(),
            tool_name: "tool".into(),
        }
    };
    AppendRunRecord::Runtime(runtime(run, sequence, RunEvent::ToolEvent { event }))
}

fn output(call: &str) -> AppendRunRecord {
    AppendRunRecord::ToolResult {
        request_id: Some("original request".into()),
        call_id: call.into(),
        output: "{ \"opaque\": \"\\n\" }\0\n雪".into(),
        is_error: true,
    }
}

#[tokio::test]
async fn repair_integrity_tool_projection_is_bidirectional_and_immutable() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mutations = [
        "DELETE FROM tool_results WHERE call_id='a'",
        "INSERT INTO tool_results SELECT run_id,'extra',tool_name,request_id,started_sequence,finished_sequence,result_sequence,is_error,output FROM tool_results WHERE call_id='a'",
        "UPDATE tool_results SET started_sequence=(SELECT started_sequence FROM tool_results WHERE call_id='b') WHERE call_id='a'",
        "UPDATE tool_results SET finished_sequence=(SELECT finished_sequence FROM tool_results WHERE call_id='b') WHERE call_id='a'",
        "UPDATE tool_results SET result_sequence=(SELECT result_sequence FROM tool_results WHERE call_id='b') WHERE call_id='a'",
        "UPDATE tool_results SET tool_name='wrong' WHERE call_id='a'",
        "UPDATE tool_results SET request_id='wrong' WHERE call_id='a'",
        "UPDATE tool_results SET request_id=NULL WHERE call_id='a'",
        "UPDATE tool_results SET output='wrong' WHERE call_id='a'",
        "UPDATE tool_results SET is_error=0 WHERE call_id='a'",
        "UPDATE tool_results SET finished_sequence=NULL WHERE call_id='a'",
        "UPDATE tool_results SET result_sequence=NULL, output=NULL WHERE call_id='a'",
        "UPDATE tool_results SET finished_sequence=NULL, result_sequence=NULL, output=NULL, is_error=NULL WHERE call_id='a'",
        "UPDATE tool_results SET run_id=(SELECT run_id FROM runs ORDER BY accepted_sequence DESC LIMIT 1) WHERE call_id='a'",
        "UPDATE tool_results SET call_id='redirected' WHERE call_id='a'",
    ];
    let mut damaged = Vec::new();
    for mutation in mutations {
        let (handle, run) = accepted(&store).await;
        running(&handle, &run).await;
        append(
            &handle,
            &run,
            vec![
                tool(&run, 11, "a", false),
                tool(&run, 12, "b", false),
                tool(&run, 13, "a", true),
                output("a"),
                output("b"),
                tool(&run, 14, "b", true),
                AppendRunRecord::Result(result(&run, RunOutcome::Completed)),
            ],
        )
        .await;
        handle
            .accept_run(OperationId::new(), RunId::new(), input())
            .await
            .unwrap();
        let file = path(&fixture, handle.session_id());
        let mut sql = connect(&file).await;
        sqlx::query(mutation).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        damaged.push((
            handle.session_id().clone(),
            fs::read(&file).unwrap(),
            mutation,
        ));
    }
    let (healthy, run) = accepted(&store).await;
    running(&healthy, &run).await;
    let before = value(&healthy.history_page(0, None, 100).await.unwrap());
    for _ in 0..2 {
        let report = store.repair_catalog().await.unwrap();
        let page = store.list_sessions(None, 100).await.unwrap();
        let mut missed = Vec::new();
        for (id, bytes, mutation) in &damaged {
            let summary = page
                .sessions()
                .iter()
                .find(|s| s.session_id() == id)
                .unwrap();
            if summary.availability() != SessionAvailability::Unavailable
                || summary.fault_code() != Some("storage.integrity")
            {
                missed.push(*mutation);
            }
            assert_eq!(fs::read(path(&fixture, id)).unwrap(), *bytes, "{mutation}");
        }
        assert!(missed.is_empty(), "repair accepted mismatches: {missed:?}");
        assert_eq!(report.unavailable_sessions(), mutations.len() as u64);
        assert_eq!(report.ready_sessions(), 1);
        assert_eq!(
            value(&healthy.history_page(0, None, 100).await.unwrap()),
            before
        );
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn repair_integrity_tool_partial_order_and_reuse_controls() {
    let fixture = Fixture::new();
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let mut controls = Vec::new();
    for kind in 0..5 {
        let (handle, run) = accepted(&store).await;
        running(&handle, &run).await;
        let mut records = vec![tool(&run, 11, "call", false)];
        match kind {
            1 => records.push(tool(&run, 13, "call", true)),
            2 => records.push(output("call")),
            3 => records.extend([output("call"), tool(&run, 13, "call", true)]),
            4 => records.extend([tool(&run, 13, "call", true), output("call")]),
            _ => {}
        }
        if kind >= 2 {
            records.push(AppendRunRecord::Runtime(runtime(
                &run,
                19,
                RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolResultReused {
                        call_id: "call".into(),
                        tool_name: "tool".into(),
                    },
                },
            )));
        }
        append(&handle, &run, records).await;
        controls.push((
            handle.clone(),
            run.clone(),
            value(&handle.history_page(0, None, 100).await.unwrap()),
            value(&handle.tool_result(run, "call".into()).await.unwrap()),
        ));
    }
    for _ in 0..2 {
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.ready_sessions(), 5);
        assert_eq!(report.unavailable_sessions(), 0);
        for (handle, run, history, tool) in &controls {
            assert_eq!(
                value(&handle.history_page(0, None, 100).await.unwrap()),
                *history
            );
            assert_eq!(
                value(
                    &handle
                        .tool_result(run.clone(), "call".into())
                        .await
                        .unwrap()
                ),
                *tool
            );
        }
    }
    store.close().await.unwrap();
}
