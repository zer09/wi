use super::b2::*;
use super::fixture::{Control, Script, count};
use super::*;
use crate::execution::tests::process::harness::Process;
use serde::{Deserialize, Serialize};
use sqlx::Connection;
use std::{fs, io::BufRead, path::PathBuf};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
enum Phase {
    Accepted,
    Model,
    Tool,
    Result,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
enum Mode {
    UnwindProvider,
    UnwindTool,
    UnwindSql,
    Unpolled,
    Runtime(Phase),
    Exit(Phase),
    Reopen(Phase),
}
#[derive(Serialize, Deserialize)]
struct ChildInput {
    root: PathBuf,
    snapshot: PathBuf,
    mode: Mode,
}
#[derive(Serialize, Deserialize)]
struct Snapshot {
    session: ApplicationSessionId,
    operation: OperationId,
    run: RunId,
    input: RecordedRunInput,
    prefix: Vec<(i64, String, String)>,
    effects: usize,
}

fn assert_no_terminal(rows: &[(i64, String, String)]) {
    for (_, kind, payload) in rows {
        assert_ne!(kind, "run.result.recorded");
        assert_ne!(kind, "run.interrupted");
        if kind == "runtime.observed" {
            let event: crate::run::RunEventEnvelope = serde_json::from_str(payload).unwrap();
            assert!(!matches!(event.event, RunEvent::RunFinished { .. }));
        }
    }
}

async fn unwind(input: &ChildInput) {
    let store = SessionStore::open(input.root.clone()).await.unwrap();
    let primary = session(&store).await;
    let sibling_session = session(&store).await;
    let gate = Arc::new(Barrier::default());
    let tool = Arc::new(ToolProbe {
        pause: matches!(input.mode, Mode::UnwindTool).then(|| gate.clone()),
        panic: matches!(input.mode, Mode::UnwindTool),
        ..Default::default()
    });
    let mut task = Task::new(
        &primary,
        tool.registry(),
        "unwind",
        Plan {
            open_pause: matches!(input.mode, Mode::UnwindProvider).then(|| gate.clone()),
            panic_open: matches!(input.mode, Mode::UnwindProvider),
            responses: vec![response("call", vec![call("one", 17, 25)], "")],
            ..Plan::default()
        },
    );
    let sibling_control = Arc::new(Control::default());
    let (_, script) = Script::gateway(vec![sibling_control.clone()]);
    Arc::get_mut(&mut task.gateway)
        .unwrap()
        .register(script.clone())
        .unwrap();
    let host = RunHost::new(store, task.gateway.clone()).unwrap();
    let sibling = host
        .client()
        .submit(
            sibling_session.session_id().clone(),
            request(),
            ToolRegistry::new(),
        )
        .unwrap();
    watchdog(sibling_control.waiting.notified()).await;
    let sql_gate = Arc::new(Pause::default());
    if matches!(input.mode, Mode::UnwindSql) {
        primary.test_hooks().arm(
            Point::ReceiptLookupComplete,
            Action::Pause(sql_gate.clone()),
        );
    }
    let ticket = submit(&host, &task);
    if matches!(input.mode, Mode::UnwindSql) {
        watchdog(sql_gate.reached.notified()).await;
        // The recheck runs in the host worker after real SQL, with its ExecutionHold still owned.
        primary
            .test_hooks()
            .arm(Point::ReceiptLookupComplete, Action::Panic);
        sql_gate.release.notify_one();
    } else {
        watchdog(gate.reached.notified()).await;
        assert!(ticket.accepted().await.is_ok());
        gate.release.notify_one();
    }
    let completion = watchdog(ticket.completion()).await;
    assert!(matches!(&*completion, RunCompletion::WorkerLost));
    if matches!(input.mode, Mode::UnwindSql) {
        assert!(Arc::ptr_eq(
            &completion,
            &ticket.accepted().await.unwrap_err()
        ));
    } else {
        assert!(ticket.accepted().await.is_ok());
    }
    assert_eq!(
        host.client()
            .submit(
                primary.session_id().clone(),
                task.request(),
                ToolRegistry::new()
            )
            .unwrap_err(),
        RunHostError::Closed
    );
    assert_eq!(
        host.client().cancel(sibling.session_id(), sibling.run_id()),
        CancelDisposition::Closed
    );
    let sibling_result = watchdog(sibling.completion()).await;
    // Quarantine closes storage; the sibling retains the real recording failure, not WorkerLost.
    let failure = failure(&sibling_result);
    assert!(
        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.kind() == StorageErrorKind::Closed)
    );
    assert!(failure.acceptance().is_some());
    assert!(!failure.observed_result().unwrap().events_complete);
    assert_eq!(count(&sibling_control.closes), 1);
    assert!(
        matches!(&*watchdog(host.begin_shutdown().wait()).await, ShutdownOutcome::Incomplete { worker_lost: true, storage_error: Some(error) } if error.kind() == StorageErrorKind::Io)
    );
    assert!(host.inner.gate().entries.is_empty());
    assert!(host.inner.tracker.is_empty());
    let mut reader = connection(&input.root, primary.session_id()).await;
    let rows = rows(&mut reader).await;
    assert_no_terminal(&rows);
    assert_eq!(
        rows.iter()
            .filter(|(_, kind, _)| kind == "run.accepted")
            .count(),
        usize::from(!matches!(input.mode, Mode::UnwindSql))
    );
    assert_eq!(count(&tool.effects), 0);
    assert!(
        !rows
            .iter()
            .any(|(_, kind, _)| kind == "tool.result.recorded")
    );
    reader.close().await.unwrap();
    drop(ticket);
    drop(sibling);
    drop(task);
    drop(primary);
    drop(sibling_session);
    let weak_host = Arc::downgrade(&host.inner);
    drop(host);
    watchdog(async {
        while weak_host.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    // Even all Rust owners disappearing cannot release an unfinished execution's quarantine.
    assert_eq!(
        SessionStore::open(input.root.clone())
            .await
            .err()
            .unwrap()
            .kind(),
        StorageErrorKind::Busy
    );
    println!(
        "PROOF host_worker_unwind worker_lost=1 sibling_cancelled=1 fabricated_terminal=0 quarantine=1"
    );
}

async fn interrupted(input: &ChildInput, phase: Phase) -> (RunHost, RunTicket) {
    let store = SessionStore::open(input.root.clone()).await.unwrap();
    let session = session(&store).await;
    let gate = Arc::new(Barrier::default());
    let tool = Arc::new(ToolProbe {
        pause: matches!(phase, Phase::Tool).then(|| gate.clone()),
        ..Default::default()
    });
    let task = Task::new(
        &session,
        tool.registry(),
        "interrupted work",
        Plan {
            response_pause: matches!(phase, Phase::Model).then(|| gate.clone()),
            responses: vec![response("call", vec![call("one", 17, 25)], "")],
            ..Plan::default()
        },
    );
    let sql_gate = match phase {
        Phase::Accepted => Some(pause(&session, Record::RunStarted, Point::BeforeCommit)),
        Phase::Result => Some(pause(&session, Record::ToolResult, Point::WriteClosed)),
        _ => None,
    };
    let host = RunHost::new(store, task.gateway.clone()).unwrap();
    let ticket = submit(&host, &task);
    if let Some(sql_gate) = sql_gate {
        watchdog(sql_gate.reached.notified()).await;
    } else {
        watchdog(gate.reached.notified()).await;
    }
    assert!(!ticket.accepted().await.unwrap().duplicate());
    assert!(futures_util::poll!(Box::pin(ticket.completion())).is_pending());
    let mut reader = connection(&input.root, session.session_id()).await;
    let prefix = rows(&mut reader).await;
    assert_no_terminal(&prefix);
    assert_eq!(
        count(&tool.effects),
        usize::from(matches!(phase, Phase::Result))
    );
    let saved = Snapshot {
        session: session.session_id().clone(),
        operation: task.operation_id.clone(),
        run: task.run_id.clone(),
        input: task.input.clone(),
        prefix,
        effects: count(&tool.effects),
    };
    fs::write(&input.snapshot, serde_json::to_vec(&saved).unwrap()).unwrap();
    reader.close().await.unwrap();
    (host, ticket)
}

async fn reopened(input: &ChildInput, phase: Phase) {
    let saved: Snapshot = serde_json::from_slice(&fs::read(&input.snapshot).unwrap()).unwrap();
    let store = SessionStore::open(input.root.clone()).await.unwrap();
    let (gateway, script) = Script::gateway(vec![]);
    let host = RunHost::new(store, gateway).unwrap();
    host.storage().list_sessions(None, 200).await.unwrap();
    let mut reader = connection(&input.root, &saved.session).await;
    assert_eq!(rows(&mut reader).await, saved.prefix);
    let session = host
        .storage()
        .open_session(saved.session.clone())
        .await
        .unwrap();
    let run = session
        .run_record(saved.run.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.state(), RecordedRunState::Interrupted);
    assert!(run.result().is_none());
    let prefix = rows(&mut reader).await;
    assert_eq!(&prefix[..saved.prefix.len()], saved.prefix);
    assert_eq!(prefix.len(), saved.prefix.len() + 1);
    assert_eq!(prefix.last().unwrap().1, "run.interrupted");
    let receipt = session
        .lookup_receipt(saved.operation.clone())
        .await
        .unwrap()
        .unwrap();
    let tool = Arc::new(ToolProbe::default());
    let tools = tool.registry();
    let definitions = count(&tool.definitions);
    let duplicate = host
        .client()
        .submit(
            saved.session.clone(),
            PersistentRunRequest {
                operation_id: saved.operation,
                run_id: saved.run.clone(),
                input: saved.input.clone(),
            },
            tools.fresh_scope(),
        )
        .unwrap();
    let duplicate_receipt = watchdog(duplicate.accepted()).await.unwrap();
    assert!(duplicate_receipt.duplicate());
    assert_eq!(duplicate_receipt.receipt(), &receipt);
    assert!(
        matches!(&*duplicate.completion().await, RunCompletion::Execution(Ok(PersistentRunResult::Duplicate { run, .. })) if run.state() == RecordedRunState::Interrupted && run.result().is_none())
    );
    assert_eq!(count(&tool.definitions), definitions);
    assert_eq!(count(&tool.calls), 0);
    let next = host
        .client()
        .submit(
            saved.session,
            PersistentRunRequest {
                operation_id: OperationId::new(),
                run_id: RunId::new(),
                input: saved.input,
            },
            tools.fresh_scope(),
        )
        .unwrap();
    let completion = watchdog(next.completion()).await;
    let failure = failure(&completion);
    if matches!(phase, Phase::Result) {
        // B2 permits an interrupted closed tool exchange. The deliberately absent provider
        // rejects only this explicit new task, after replay and current definitions validate.
        assert_eq!(failure.stage(), PersistentRunStage::Preflight);
        assert!(matches!(
            failure.cause(),
            PersistentRunCause::Gateway(GatewayError::UnknownProvider)
        ));
        assert_eq!(count(&tool.definitions), definitions + 1);
    } else {
        assert_eq!(failure.stage(), PersistentRunStage::History);
        assert!(matches!(
            failure.cause(),
            PersistentRunCause::Gateway(GatewayError::InvalidRequest(
                "stored history is incomplete for native replay"
            ))
        ));
        assert_eq!(count(&tool.definitions), definitions);
    }
    assert_eq!(count(&tool.calls), 0);
    assert_eq!(count(&tool.effects), 0);
    assert_eq!(count(&script.capabilities), 0);
    assert_eq!(count(&script.opens), 0);
    assert_eq!(count(&script.validations), 0);
    assert_eq!(rows(&mut reader).await, prefix);
    let result = session.tool_result(saved.run, "one".into()).await.unwrap();
    match phase {
        Phase::Accepted | Phase::Model => assert!(result.is_none()),
        Phase::Tool => {
            let result = result.unwrap();
            assert!(result.output().is_none());
            assert!(result.result_sequence().is_none());
            assert!(result.finished_sequence().is_none());
        }
        Phase::Result => {
            let result = result.unwrap();
            assert_eq!(result.output(), Some("{\"sum\":42}"));
            assert_eq!(result.is_error(), Some(false));
            assert!(result.result_sequence().is_some());
            assert!(result.finished_sequence().is_none());
        }
    }
    assert_eq!(saved.effects, usize::from(matches!(phase, Phase::Result)));
    reader.close().await.unwrap();
    closed(&host).await;
    println!(
        "PROOF host_reopen phase={phase:?} interrupted=1 preserved_prefix=1 opens=0 effects=0 duplicate_resumed=0"
    );
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
#[ignore = "closed child helper; parent supplies isolated synthetic roots on stdin"]
fn host_loss_child() {
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).unwrap();
    let input: ChildInput = serde_json::from_str(&line).unwrap();
    assert!(input.root.is_absolute());
    assert!(input.snapshot.is_absolute());
    let runtime = runtime();
    match input.mode {
        Mode::UnwindProvider | Mode::UnwindTool | Mode::UnwindSql => {
            runtime.block_on(unwind(&input))
        }
        Mode::Reopen(phase) => runtime.block_on(reopened(&input, phase)),
        Mode::Exit(phase) => {
            let (_host, _ticket) = runtime.block_on(interrupted(&input, phase));
            std::process::exit(73);
        }
        Mode::Runtime(phase) => {
            let (host, ticket) = runtime.block_on(interrupted(&input, phase));
            drop(runtime);
            let observer = self::runtime();
            observer.block_on(async {
                assert!(matches!(
                    &*watchdog(ticket.completion()).await,
                    RunCompletion::WorkerLost
                ));
                assert!(ticket.accepted().await.is_ok());
                assert!(matches!(
                    &*watchdog(host.begin_shutdown().wait()).await,
                    ShutdownOutcome::Incomplete {
                        worker_lost: true,
                        ..
                    }
                ));
                let weak_host = Arc::downgrade(&host.inner);
                drop(host);
                watchdog(async {
                    while weak_host.upgrade().is_some() {
                        tokio::task::yield_now().await;
                    }
                })
                .await;
                let saved: Snapshot =
                    serde_json::from_slice(&fs::read(&input.snapshot).unwrap()).unwrap();
                let mut reader = connection(&input.root, &saved.session).await;
                let persisted = rows(&mut reader).await;
                assert_no_terminal(&persisted);
                assert_eq!(persisted, saved.prefix);
                reader.close().await.unwrap();
                assert_eq!(
                    SessionStore::open(input.root.clone())
                        .await
                        .err()
                        .unwrap()
                        .kind(),
                    StorageErrorKind::Busy
                );
            });
            println!("PROOF host_runtime_drop phase={phase:?} worker_lost=1 quarantine=1");
        }
        Mode::Unpolled => {
            let (host, session) = runtime.block_on(async {
                let store = SessionStore::open(input.root.clone()).await.unwrap();
                let session = session(&store).await;
                (
                    RunHost::new(store, Arc::new(Gateway::new())).unwrap(),
                    session,
                )
            });
            let ticket = host
                .client()
                .submit(session.session_id().clone(), request(), ToolRegistry::new())
                .unwrap();
            drop(runtime);
            let observer = self::runtime();
            observer.block_on(async {
                let completion = watchdog(ticket.completion()).await;
                assert!(matches!(&*completion, RunCompletion::WorkerLost));
                assert!(Arc::ptr_eq(
                    &completion,
                    &ticket.accepted().await.unwrap_err()
                ));
                assert!(host.inner.gate().entries.is_empty());
                assert!(host.inner.tracker.is_empty());
                assert!(matches!(
                    &*watchdog(host.begin_shutdown().wait()).await,
                    ShutdownOutcome::Incomplete {
                        worker_lost: true,
                        storage_error: None
                    }
                ));
                let mut reader = connection(&input.root, session.session_id()).await;
                assert_eq!(rows(&mut reader).await.len(), 1);
                reader.close().await.unwrap();
                drop(session);
                drop(host);
                SessionStore::open(input.root.clone())
                    .await
                    .unwrap()
                    .close()
                    .await
                    .unwrap();
            });
            println!("PROOF host_unpolled worker_lost=1 durable_acceptance=0 hold_acquired=0");
        }
    }
}

const HELPER: &str = "service::tests::loss::host_loss_child";

#[test]
fn provider_tool_and_sql_worker_unwinds_and_unpolled_drop_are_isolated() {
    for mode in [
        Mode::UnwindProvider,
        Mode::UnwindTool,
        Mode::UnwindSql,
        Mode::Unpolled,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let input = ChildInput {
            root: temp.path().join("root"),
            snapshot: temp.path().join("snapshot.json"),
            mode,
        };
        Process::start_test(&temp.path().join("child"), &input, HELPER).finish(0);
    }
}

#[test]
fn runtime_destruction_preserves_accepted_model_tool_and_result_prefixes() {
    for phase in [Phase::Accepted, Phase::Model, Phase::Tool, Phase::Result] {
        let temp = tempfile::tempdir().unwrap();
        let mut input = ChildInput {
            root: temp.path().join("root"),
            snapshot: temp.path().join("snapshot.json"),
            mode: Mode::Runtime(phase),
        };
        Process::start_test(&temp.path().join("producer"), &input, HELPER).finish(0);
        input.mode = Mode::Reopen(phase);
        Process::start_test(&temp.path().join("reader"), &input, HELPER).finish(0);
    }
}

#[test]
fn process_exit_preserves_accepted_model_tool_and_result_prefixes() {
    for phase in [Phase::Accepted, Phase::Model, Phase::Tool, Phase::Result] {
        let temp = tempfile::tempdir().unwrap();
        let mut input = ChildInput {
            root: temp.path().join("root"),
            snapshot: temp.path().join("snapshot.json"),
            mode: Mode::Exit(phase),
        };
        Process::start_test(&temp.path().join("producer"), &input, HELPER).finish(73);
        input.mode = Mode::Reopen(phase);
        Process::start_test(&temp.path().join("reader"), &input, HELPER).finish(0);
    }
}
