//! Real process boundaries. Only the ignored helper reads an explicit stdin fixture.
use super::{
    test_hooks::{Action, Point},
    *,
};
use crate::{
    run::{RunEvent, RunEventEnvelope, RunRequest},
    tools::ToolExecutionEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{ConnectOptions, Connection, Row, sqlite::SqliteConnectOptions};
use std::{
    fs,
    io::{BufRead, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
struct Fixture {
    root: PathBuf,
    mode: Mode,
}
#[derive(Serialize, Deserialize)]
enum Mode {
    Hold,
    Retire(Retirement),
    OpenError(String),
    Create {
        input: CreateSession,
        stage: u8,
    },
    Rename {
        session: ApplicationSessionId,
        operation: OperationId,
        quarantine: bool,
    },
    Repair,
    Reopen {
        session: ApplicationSessionId,
        run: RunId,
        history: Value,
        tool: Value,
        receipt: CommitReceipt,
        terminal: ApplicationSessionId,
        terminal_history: Value,
    },
}

#[derive(Serialize, Deserialize)]
enum Retirement {
    Quarantine,
    OperationDrop,
    ExecutionDrop,
    ExecutionAbort,
    ExecutionPanic,
}

fn private_dir(path: &Path) {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).unwrap();
}
fn private_file(path: &Path, bytes: &[u8]) {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).unwrap().write_all(bytes).unwrap();
}

struct Process {
    child: Child,
    ready: mpsc::Receiver<()>,
    stdout: Option<thread::JoinHandle<String>>,
    stderr: Option<thread::JoinHandle<String>>,
}
impl Process {
    fn start(sandbox: &Path, fixture: &Fixture) -> Self {
        for name in ["home", "xdg", "codex", "tmp"] {
            private_dir(&sandbox.join(name));
        }
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "storage::process_tests::storage_child",
                "--ignored",
                "--nocapture",
            ])
            .current_dir(sandbox)
            .env_clear()
            .env("HOME", sandbox.join("home"))
            .env("XDG_CONFIG_HOME", sandbox.join("xdg"))
            .env("CODEX_HOME", sandbox.join("codex"))
            .env("TMPDIR", sandbox.join("tmp"))
            .env("TEMP", sandbox.join("tmp"))
            .env("TMP", sandbox.join("tmp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        if let Some(value) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", value);
        }
        let mut child = command.spawn().unwrap();
        writeln!(
            child.stdin.as_mut().unwrap(),
            "{}",
            serde_json::to_string(fixture).unwrap()
        )
        .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (notify, ready) = mpsc::channel();
        let stdout = thread::spawn(move || {
            let mut text = String::new();
            for line in std::io::BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if line == "READY" {
                    let _ = notify.send(());
                }
                text.push_str(&line);
                text.push('\n');
            }
            text
        });
        let mut stderr = child.stderr.take().unwrap();
        let stderr = thread::spawn(move || {
            let mut text = String::new();
            stderr.read_to_string(&mut text).unwrap();
            text
        });
        Self {
            child,
            ready,
            stdout: Some(stdout),
            stderr: Some(stderr),
        }
    }
    fn ready(&self) {
        self.ready
            .recv_timeout(Duration::from_secs(20))
            .expect("child readiness watchdog");
    }
    fn release(&mut self) {
        writeln!(self.child.stdin.as_mut().unwrap(), "release").unwrap();
    }
    fn finish(mut self, code: Option<i32>) {
        let start = Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "child exit watchdog, not rollback evidence"
            );
            thread::sleep(Duration::from_millis(5));
        };
        let stdout = self.stdout.take().unwrap().join().unwrap();
        let stderr = self.stderr.take().unwrap().join().unwrap();
        for text in [&stdout, &stderr] {
            for canary in [
                "canary",
                "SELECT",
                "INSERT",
                "BEGIN IMMEDIATE",
                "sqlite3",
                "sensitive",
            ] {
                assert!(
                    !text.contains(canary),
                    "child diagnostics must remain redacted"
                );
            }
        }
        if let Some(code) = code {
            assert_eq!(status.code(), Some(code));
        } else {
            assert!(!status.success());
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                assert_eq!(status.signal(), Some(9));
            }
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        // Reap even after a failed assertion; never leave a lease-owning child behind.
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(stdout) = self.stdout.take() {
            let _ = stdout.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

#[test]
#[ignore = "closed subprocess helper; parent tests supply synthetic stdin roots"]
fn storage_child() {
    let mut input = std::io::stdin().lock();
    let mut line = String::new();
    input.read_line(&mut line).unwrap();
    let fixture: Fixture = serde_json::from_str(&line).unwrap();
    assert!(fixture.root.is_absolute());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        if let Mode::OpenError(code) = &fixture.mode {
            let error = SessionStore::open(fixture.root).await.unwrap_err();
            assert_eq!(error.code(), code);
            assert_eq!(format!("{error}"), *code);
            assert!(!format!("{error:?}").contains("canary"));
            return;
        }
        let store = SessionStore::open(fixture.root).await.unwrap();
        match fixture.mode {
            Mode::Hold => {
                println!("READY");
                line.clear();
                input.read_line(&mut line).unwrap();
            }
            Mode::Retire(retirement) => {
                let created = store.create_session(create_input()).await.unwrap();
                let handle = store
                    .open_session(created.session_id().clone())
                    .await
                    .unwrap();
                let hold = handle.execution_hold().unwrap();
                let signal = hold.closing_token();
                let mut notified = Box::pin(signal.cancelled());
                assert!(futures_util::poll!(&mut notified).is_pending());
                match retirement {
                    Retirement::Quarantine => {
                        store.inner.lifecycle.quarantine();
                        assert!(signal.is_cancelled());
                        assert_eq!(store.inner.lifecycle.gauge().0, 1);
                        hold.finish();
                    }
                    Retirement::OperationDrop => {
                        drop(store.inner.lifecycle.admit().unwrap());
                        assert!(signal.is_cancelled());
                        assert_eq!(store.inner.lifecycle.gauge().0, 1);
                        hold.finish();
                    }
                    Retirement::ExecutionDrop => drop(hold),
                    Retirement::ExecutionAbort => {
                        let (ready, wait) = tokio::sync::oneshot::channel();
                        let task = tokio::spawn(async move {
                            let _hold = hold;
                            ready.send(()).unwrap();
                            std::future::pending::<()>().await;
                        });
                        wait.await.unwrap();
                        task.abort();
                        assert!(task.await.unwrap_err().is_cancelled());
                    }
                    Retirement::ExecutionPanic => {
                        let task = tokio::spawn(async move {
                            let _hold = hold;
                            panic!("unfinished execution hold");
                        });
                        assert!(task.await.unwrap_err().is_panic());
                    }
                }
                assert!(futures_util::poll!(&mut notified).is_ready());
                assert_eq!(
                    handle.execution_hold().err().unwrap().code(),
                    "storage.closed"
                );
                assert_eq!(
                    handle.manifest().await.unwrap_err().code(),
                    "storage.closed"
                );
                assert_eq!(store.close().await.unwrap_err().code(), "storage.io");
                let (admitted, opened, closed, closing) = store.inner.lifecycle.gauge();
                assert_eq!(admitted, 0);
                assert_eq!(opened, closed);
                assert!(closing);
                drop(handle);
                drop(store);
                // The parent checks ownership after every ordinary owner has gone away.
                println!("READY");
                line.clear();
                input.read_line(&mut line).unwrap();
                return;
            }
            Mode::Create { input, stage } => {
                let point = match stage {
                    0 => Point::Reserved,
                    1 => Point::Initializing,
                    2 => Point::Materialized,
                    3 => Point::CatalogAccepted,
                    _ => panic!("closed stage"),
                };
                store.inner.hooks.arm(point, Action::Exit);
                store.create_session(input).await.unwrap();
                panic!("creation exit point was not reached");
            }
            Mode::Rename {
                session,
                operation,
                quarantine,
            } => {
                let handle = store.open_session(session).await.unwrap();
                if quarantine {
                    store.inner.hooks.arm(
                        Point::UncertainWriteClose,
                        Action::Fail(StorageErrorKind::Io),
                    );
                    let result = handle.rename(operation, "changed".into()).await.unwrap();
                    assert_eq!(
                        result.cleanup_warning(),
                        Some(CleanupWarning::ConnectionCloseFailed)
                    );
                    assert_eq!(
                        handle.manifest().await.unwrap_err().code(),
                        "storage.closed"
                    );
                    assert_eq!(store.close().await.unwrap_err().code(), "storage.io");
                    drop(handle);
                    drop(store);
                    println!("READY");
                    line.clear();
                    input.read_line(&mut line).unwrap();
                    return;
                }
                store.inner.hooks.arm(Point::AfterCommit, Action::Exit);
                handle.rename(operation, "changed".into()).await.unwrap();
                panic!("commit exit point was not reached");
            }
            Mode::Repair => {
                store.inner.hooks.arm(Point::RepairCandidate, Action::Exit);
                store.repair_catalog().await.unwrap();
                panic!("repair exit point was not reached");
            }
            Mode::Reopen {
                session,
                run,
                history,
                tool,
                receipt,
                terminal,
                terminal_history,
            } => {
                // This helper has no Gateway, Provider, registry, context or credential reader.
                let handle = store.open_session(session.clone()).await.unwrap();
                let page = handle.history_page(0, None, 100).await.unwrap();
                let before = history.as_array().unwrap();
                assert_eq!(page.records().len(), before.len() + 1);
                assert_eq!(
                    serde_json::to_value(&page.records()[..before.len()]).unwrap(),
                    history
                );
                assert!(matches!(
                    page.records().last().unwrap().payload(),
                    StoredEventPayload::RunInterrupted(_)
                ));
                assert_eq!(
                    handle
                        .run_record(run.clone())
                        .await
                        .unwrap()
                        .unwrap()
                        .state(),
                    RecordedRunState::Interrupted
                );
                assert_eq!(
                    serde_json::to_value(
                        handle
                            .tool_result(run, "call".into())
                            .await
                            .unwrap()
                            .unwrap()
                    )
                    .unwrap(),
                    tool
                );
                assert_eq!(
                    handle
                        .lookup_receipt(receipt.operation_id().clone())
                        .await
                        .unwrap()
                        .as_ref(),
                    Some(&receipt)
                );
                let second = store.open_session(session).await.unwrap();
                assert_eq!(
                    second.manifest().await.unwrap().head_sequence(),
                    page.through_sequence()
                );
                let diagnostics = format!(
                    "{store:?} {handle:?} {page:?} {:?}",
                    handle.manifest().await.unwrap()
                );
                assert!(!diagnostics.contains("canary"));
                let terminal = store.open_session(terminal).await.unwrap();
                assert_eq!(
                    serde_json::to_value(terminal.history_page(0, None, 100).await.unwrap())
                        .unwrap(),
                    terminal_history
                );
            }
            Mode::OpenError(_) => unreachable!(),
        }
        store.close().await.unwrap();
    });
}

async fn raw(path: &Path) -> sqlx::SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}
fn create_input() -> CreateSession {
    CreateSession::new(OperationId::new(), "title-canary".into(), None).unwrap()
}

#[tokio::test]
async fn p1b1_execution_unfinished_retirement_signals_and_retains_lease_until_exit() {
    for retirement in [
        Retirement::Quarantine,
        Retirement::OperationDrop,
        Retirement::ExecutionDrop,
        Retirement::ExecutionAbort,
        Retirement::ExecutionPanic,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root-canary");
        let mut owner = Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::Retire(retirement),
            },
        );
        owner.ready();
        Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::OpenError("storage.busy".into()),
            },
        )
        .finish(Some(0));
        owner.release();
        owner.finish(Some(0));
        let reopened = SessionStore::open(root).await.unwrap();
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1a03_process_lease_canonical_alias_distinct_clean_exit_and_kill() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root-canary");
    for killed in [false, true] {
        let mut owner = Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::Hold,
            },
        );
        owner.ready();
        let catalog = root.join("catalog.sqlite3");
        let original = fs::read(&catalog).unwrap();
        // A corrupt catalog makes the busy-before-database-work ordering observable.
        fs::write(&catalog, b"foreign-canary").unwrap();
        Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::OpenError("storage.busy".into()),
            },
        )
        .finish(Some(0));
        #[cfg(unix)]
        {
            let alias = temp.path().join(format!("alias-{killed}"));
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            Process::start(
                temp.path(),
                &Fixture {
                    root: alias,
                    mode: Mode::OpenError("storage.busy".into()),
                },
            )
            .finish(Some(0));
        }
        assert_eq!(fs::read(&catalog).unwrap(), b"foreign-canary");
        let mut other = Process::start(
            temp.path(),
            &Fixture {
                root: temp.path().join(format!("distinct-{killed}")),
                mode: Mode::Hold,
            },
        );
        other.ready();
        other.release();
        other.finish(Some(0));
        if killed {
            owner.child.kill().unwrap();
            owner.finish(None);
        } else {
            owner.release();
            owner.finish(Some(0));
        }
        assert!(root.join("storage.lock").exists());
        fs::write(&catalog, original).unwrap();
        let store = SessionStore::open(root.clone()).await.unwrap();
        store.close().await.unwrap();
    }
    println!(
        "process lease: busy before DB; alias busy; distinct root succeeds; clean=0 and kill release ownership"
    );
}

#[tokio::test]
async fn p1a07_process_creation_four_exit_stages_retain_all_reserved_identities() {
    for stage in 0..4 {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root-canary");
        let input = create_input();
        Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::Create {
                    input: input.clone(),
                    stage,
                },
            },
        )
        .finish(Some(73));
        let store = SessionStore::open(root.clone()).await.unwrap();
        let page = store.list_sessions(None, 10).await.unwrap();
        assert_eq!(page.sessions().len(), 1);
        let id = page.sessions()[0].session_id().clone();
        let guard = store.inner.lifecycle.admit().unwrap();
        let reserved = catalog_ops::entry(&store.inner, &id)
            .await
            .unwrap()
            .reservation
            .provenance;
        guard.finish();
        assert_eq!(reserved.operation_id, *input.operation_id());
        let handle = store.open_session(id.clone()).await.unwrap();
        let retried = store.create_session(input.clone()).await.unwrap();
        assert!(retried.duplicate());
        assert_eq!(retried.session_id(), &id);
        assert_eq!(retried.receipt(), &reserved.receipt);
        let history = handle.history_page(0, None, 10).await.unwrap();
        assert_eq!(history.records().len(), 1);
        assert_eq!(history.records()[0].event_id(), &reserved.creation_event_id);
        let StoredEventPayload::SessionCreated(payload) = history.records()[0].payload() else {
            panic!("creation event")
        };
        assert_eq!(payload.creation_provenance(), &reserved);
        assert_eq!(
            store
                .list_sessions(None, 10)
                .await
                .unwrap()
                .sessions()
                .len(),
            1
        );
        store.close().await.unwrap();
        let reopened = SessionStore::open(root).await.unwrap();
        assert_eq!(
            reopened.create_session(input).await.unwrap().receipt(),
            &reserved.receipt
        );
        reopened.close().await.unwrap();
        println!(
            "process creation: stage={stage} exit=73 reserved identities and exact receipt retained"
        );
    }
}

#[tokio::test]
async fn p1a07_process_invalid_partial_is_preserved_failed_once_without_allocation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root-canary");
    let input = create_input();
    Process::start(
        temp.path(),
        &Fixture {
            root: root.clone(),
            mode: Mode::Create {
                input: input.clone(),
                stage: 0,
            },
        },
    )
    .finish(Some(73));
    let store = SessionStore::open(root.clone()).await.unwrap();
    let id = store.list_sessions(None, 1).await.unwrap().sessions()[0]
        .session_id()
        .clone();
    let path = filesystem::session_path(&root, &id, true).unwrap();
    private_file(&path, b"invalid-partial-canary");
    let before = fs::read(&path).unwrap();
    let error = store.create_session(input.clone()).await.unwrap_err();
    assert_eq!(error.code(), "storage.integrity");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(
        store.create_session(input.clone()).await.unwrap_err(),
        error
    );
    let page = store.list_sessions(None, 10).await.unwrap();
    assert_eq!(page.sessions().len(), 1);
    assert_eq!(
        page.sessions()[0].availability(),
        SessionAvailability::Unavailable
    );
    store.close().await.unwrap();
    let store = SessionStore::open(root).await.unwrap();
    assert_eq!(store.create_session(input).await.unwrap_err(), error);
    assert_eq!(fs::read(path).unwrap(), before);
    store.close().await.unwrap();
    println!("process invalid partial: exit=73; preserved unavailable; one reservation");
}

#[tokio::test]
async fn p1a19_process_commit_before_reply_and_uncertain_cleanup_quarantine() {
    for quarantine in [false, true] {
        let (temp, store, handle) = fault_tests::fixture().await;
        let id = handle.session_id().clone();
        let root = store.inner.root.clone();
        store.close().await.unwrap();
        let operation = OperationId::new();
        let mut child = Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::Rename {
                    session: id.clone(),
                    operation: operation.clone(),
                    quarantine,
                },
            },
        );
        if quarantine {
            child.ready();
            assert_eq!(
                SessionStore::open(root.clone()).await.unwrap_err().code(),
                "storage.busy"
            );
            child.child.kill().unwrap();
            child.finish(None);
        } else {
            child.finish(Some(73));
        }
        let mut connection = raw(&root.join(filesystem::session_relative_path(&id))).await;
        let receipt: String = sqlx::query("SELECT receipt_json FROM commands WHERE operation_id=?")
            .bind(operation.as_str())
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        let receipt: CommitReceipt = dto::decode(&receipt).unwrap();
        assert_eq!(receipt.first_sequence(), 2);
        assert_eq!(receipt.last_sequence(), 2);
        assert_eq!(receipt.operation_id(), &operation);
        let payload: String = sqlx::query("SELECT payload_json FROM events WHERE sequence=2")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        connection.close().await.unwrap();
        assert_eq!(payload, "{\"title\":\"changed\"}");
        let store = SessionStore::open(root).await.unwrap();
        let handle = store.open_session(id).await.unwrap();
        assert_eq!(
            handle.lookup_receipt(operation.clone()).await.unwrap(),
            Some(receipt.clone())
        );
        let page = serde_json::to_value(handle.history_page(0, None, 10).await.unwrap()).unwrap();
        let retry = handle.rename(operation, "changed".into()).await.unwrap();
        assert!(retry.duplicate());
        assert_eq!(retry.receipt(), &receipt);
        assert_eq!(
            serde_json::to_value(handle.history_page(0, None, 10).await.unwrap()).unwrap(),
            page
        );
        store.close().await.unwrap();
        println!(
            "process mutation: quarantine={quarantine} exact receipt/history survive lost reply; lease released only at safe close/death"
        );
    }
}

#[tokio::test]
async fn p1a24_process_repair_interruption_keeps_durable_intent_and_converges() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root-canary");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let mut snapshots = Vec::new();
    for _ in 0..3 {
        let input = create_input();
        let result = store.create_session(input.clone()).await.unwrap();
        let handle = store
            .open_session(result.session_id().clone())
            .await
            .unwrap();
        handle
            .rename(OperationId::new(), "renamed".into())
            .await
            .unwrap();
        snapshots.push((
            input,
            result,
            serde_json::to_value(handle.history_page(0, None, 10).await.unwrap()).unwrap(),
        ));
    }
    store.close().await.unwrap();
    Process::start(
        temp.path(),
        &Fixture {
            root: root.clone(),
            mode: Mode::Repair,
        },
    )
    .finish(Some(73));
    let mut connection = raw(&root.join("catalog.sqlite3")).await;
    let row = sqlx::query("SELECT repair_required, (SELECT count(*) FROM sessions WHERE seen_repair_id IS NOT NULL) FROM catalog_meta").fetch_one(&mut connection).await.unwrap();
    assert_eq!(row.try_get::<i64, _>(0).unwrap(), 1);
    assert_eq!(row.try_get::<i64, _>(1).unwrap(), 1);
    connection.close().await.unwrap();
    let store = SessionStore::open(root).await.unwrap();
    assert_eq!(
        store.list_sessions(None, 10).await.unwrap_err().code(),
        "storage.catalog_repair_required"
    );
    store.repair_catalog().await.unwrap();
    store.repair_catalog().await.unwrap();
    assert_eq!(
        store
            .list_sessions(None, 10)
            .await
            .unwrap()
            .sessions()
            .len(),
        3
    );
    for (input, result, history) in snapshots {
        let handle = store
            .open_session(result.session_id().clone())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(handle.history_page(0, None, 10).await.unwrap()).unwrap(),
            history
        );
        assert_eq!(
            store.create_session(input).await.unwrap().receipt(),
            result.receipt()
        );
    }
    store.close().await.unwrap();
    println!(
        "process repair: exit=73 after one candidate; intent=1; two repairs converge without canonical rewrite"
    );
}

fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    let started = matches!(event, RunEvent::RunStarted);
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: uuid::Uuid::new_v4().to_string(),
        run_id: run.as_str().into(),
        turn_id: if started { None } else { Some("turn".into()) },
        session_id: if started {
            None
        } else {
            Some("provider-session".into())
        },
        request_id: if started || matches!(event, RunEvent::TurnStarted { .. }) {
            None
        } else {
            Some("request".into())
        },
        event,
    })
}

#[tokio::test]
async fn p1a17_process_lazy_interruption_retains_partial_text_tool_and_receipt() {
    let (temp, store, handle) = fault_tests::fixture().await;
    let root = store.inner.root.clone();
    let run = RunId::new();
    let input = RecordedRunInput::new(
        "user-canary".into(),
        RunRequest {
            provider_id: "offline".into(),
            options: crate::SessionOptions::new("offline"),
            prompt: "prepared-canary".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    let accepted = handle
        .accept_run(OperationId::new(), run.clone(), input.clone())
        .await
        .unwrap();
    let nested = crate::EventEnvelope {
        schema_version: 1,
        sequence: 1,
        event_id: "provider-event".into(),
        session_id: "provider-session".into(),
        request_id: Some("request".into()),
        provider: "offline".into(),
        provider_sequence: None,
        event: crate::ProviderEvent::OutputItemUpdated {
            response_id: "response".into(),
            item_id: "item".into(),
            output_index: 0,
            content_index: Some(0),
            summary_index: None,
            kind: crate::DeltaKind::Text,
            delta: "partial-canary\n雪\0".into(),
        },
    };
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![
                runtime(&run, 1, RunEvent::RunStarted),
                runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
                runtime(
                    &run,
                    3,
                    RunEvent::ProviderEvent {
                        event: Box::new(nested),
                    },
                ),
                runtime(
                    &run,
                    4,
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted {
                            call_id: "call".into(),
                            tool_name: "recorded-tool".into(),
                        },
                    },
                ),
                AppendRunRecord::ToolResult {
                    request_id: Some("request".into()),
                    call_id: "call".into(),
                    output: "result-canary\n雪\0".into(),
                    is_error: false,
                },
            ],
        )
        .await
        .unwrap();
    let history =
        serde_json::to_value(handle.history_page(0, None, 100).await.unwrap().records()).unwrap();
    let tool = serde_json::to_value(
        handle
            .tool_result(run.clone(), "call".into())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let untouched = store.create_session(create_input()).await.unwrap();
    let other = store
        .open_session(untouched.session_id().clone())
        .await
        .unwrap();
    let other_run = RunId::new();
    other
        .accept_run(OperationId::new(), other_run.clone(), input.clone())
        .await
        .unwrap();
    let terminal = store.create_session(create_input()).await.unwrap();
    let terminal_handle = store
        .open_session(terminal.session_id().clone())
        .await
        .unwrap();
    let terminal_run = RunId::new();
    terminal_handle
        .accept_run(OperationId::new(), terminal_run.clone(), input)
        .await
        .unwrap();
    terminal_handle
        .append_run_records(
            OperationId::new(),
            terminal_run.clone(),
            vec![AppendRunRecord::Result(crate::run::RunResult {
                run_id: terminal_run.as_str().into(),
                session_id: None,
                outcome: crate::run::RunOutcome::Completed,
                summary: crate::run::RunSummary::default(),
                last_response: None,
                events_complete: false,
                sink_error: Some(crate::run::RunSinkError::Closed),
            })],
        )
        .await
        .unwrap();
    let terminal_history =
        serde_json::to_value(terminal_handle.history_page(0, None, 100).await.unwrap()).unwrap();
    store.close().await.unwrap();
    let fixture = Fixture {
        root: root.clone(),
        mode: Mode::Reopen {
            session: handle.session_id().clone(),
            run,
            history,
            tool,
            receipt: accepted.receipt().clone(),
            terminal: terminal.session_id().clone(),
            terminal_history,
        },
    };
    Process::start(temp.path(), &fixture).finish(Some(0));
    Process::start(temp.path(), &fixture).finish(Some(0));
    let mut connection =
        raw(&root.join(filesystem::session_relative_path(untouched.session_id()))).await;
    let state: String = sqlx::query("SELECT state FROM runs WHERE run_id=?")
        .bind(other_run.as_str())
        .fetch_one(&mut connection)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    assert_eq!(
        state, "accepted",
        "startup must not eagerly interrupt unselected sessions"
    );
    connection.close().await.unwrap();
    println!(
        "process restart: two fresh opens exit=0; one interruption; exact partial/tool bytes; unselected session remains accepted; helper calls storage only"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn p1a04_process_private_permissions_links_special_files_and_redaction() {
    use std::os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    };
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("sensitive-target-canary");
    private_file(&target, b"sensitive-content-canary");
    for kind in ["mode", "denied", "link", "socket", "hardlink"] {
        let root = temp.path().join(format!("root-{kind}-canary"));
        private_dir(&root);
        let lock = root.join("storage.lock");
        let socket = match kind {
            "mode" => {
                fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
                None
            }
            "denied" => {
                fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
                None
            }
            "link" => {
                symlink(&target, &lock).unwrap();
                None
            }
            "socket" => Some(UnixListener::bind(&lock).unwrap()),
            "hardlink" => {
                fs::hard_link(&target, &lock).unwrap();
                None
            }
            _ => unreachable!(),
        };
        let expected = if kind == "denied" {
            "storage.io"
        } else {
            "storage.unavailable"
        };
        // Root can write despite mode bits; report that gap rather than fake a denial.
        #[cfg(target_os = "linux")]
        if kind == "denied" && rustix::process::geteuid().is_root() {
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            println!("permission gap: root bypasses DAC denial");
            continue;
        }
        Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::OpenError(expected.into()),
            },
        )
        .finish(Some(0));
        assert!(!root.join("catalog.sqlite3").exists());
        assert_eq!(fs::read(&target).unwrap(), b"sensitive-content-canary");
        if kind == "mode" || kind == "denied" {
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                if kind == "mode" { 0o755 } else { 0o500 }
            );
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        } else {
            assert!(fs::symlink_metadata(&lock).is_ok());
        }
        drop(socket);
    }
    #[cfg(target_os = "linux")]
    for name in ["storage.lock", "catalog.sqlite3", "catalog.sqlite3-wal"] {
        let root = temp.path().join(format!("fifo-{name}-canary"));
        private_dir(&root);
        let fifo = root.join(name);
        rustix::fs::mkfifoat(
            rustix::fs::CWD,
            &fifo,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .unwrap();
        Process::start(
            temp.path(),
            &Fixture {
                root: root.clone(),
                mode: Mode::OpenError("storage.unavailable".into()),
            },
        )
        .finish(Some(0));
        use std::os::unix::fs::FileTypeExt;
        assert!(fs::symlink_metadata(fifo).unwrap().file_type().is_fifo());
    }
    println!(
        "process filesystem: insecure/denied/link/socket/hardlink/FIFO rejection; target and diagnostics preserved"
    );
}
