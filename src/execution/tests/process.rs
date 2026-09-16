use super::faults::watchdog;
use super::*;
use crate::storage::ApplicationSessionId;
use serde::Deserialize;
use std::{io::BufRead, path::PathBuf};

mod child;
mod harness;
mod prefixes;
mod reopen;
mod snapshots;

use harness::Process;
use snapshots::Snapshot;

#[derive(Clone, Serialize, Deserialize)]
struct Fixture {
    root: PathBuf,
    session: ApplicationSessionId,
    operation_id: OperationId,
    run_id: RunId,
    input: RecordedRunInput,
    terminals: Vec<(ApplicationSessionId, Snapshot)>,
    mode: Mode,
}
#[derive(Clone, Serialize, Deserialize)]
enum Mode {
    Retire { how: Retirement, tool: bool },
    Crash(Stage),
    Reopen(Box<Snapshot>),
    Duplicate(Box<Snapshot>),
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
enum Stage {
    Acceptance,
    PartialText,
    ToolIntent,
    ResultOk,
    ResultError,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
enum Retirement {
    Drop,
    Abort,
    Panic,
}

impl Fixture {
    fn from_rig(rig: &Rig, mode: Mode) -> Self {
        Self {
            root: rig.temp.path().join("root"),
            session: rig.session.session_id().clone(),
            operation_id: rig.operation_id.clone(),
            run_id: rig.run_id.clone(),
            input: rig.input.clone(),
            terminals: vec![],
            mode,
        }
    }
    fn request(&self) -> PersistentRunRequest {
        PersistentRunRequest {
            operation_id: self.operation_id.clone(),
            run_id: self.run_id.clone(),
            input: self.input.clone(),
        }
    }
}

fn runtime(
    fixture: &Fixture,
    session: &SessionHandle,
    steps: Vec<Step>,
    mode: ToolMode,
) -> (Gateway, ToolRegistry, Arc<Records>) {
    let records = Arc::new(Records::default());
    let binding = Binding {
        session: session.clone(),
        operation_id: fixture.operation_id.clone(),
        run_id: fixture.run_id.clone(),
    };
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(CountingTool {
            binding: binding.clone(),
            records: records.clone(),
            mode,
        }))
        .unwrap();
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(Script {
            source: SourceIds {
                session: "provider-session",
                request_prefix: "q",
                event_prefix: "source-",
            },
            binding,
            input: fixture.input.clone(),
            records: records.clone(),
            capabilities: Mutex::new(capabilities()),
            steps: Mutex::new(steps.into()),
            fail_open: false,
        }))
        .unwrap();
    (gateway, tools, records)
}

#[test]
#[ignore = "closed subprocess helper; parent supplies synthetic stdin roots"]
fn execution_child() {
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
        match &fixture.mode {
            Mode::Retire { how, tool } => child::retire(&fixture, *how, *tool, &mut input).await,
            Mode::Crash(stage) => prefixes::crash(&fixture, *stage, &mut input).await,
            Mode::Reopen(prefix) => {
                reopen::selected(&fixture, prefix).await;
                println!(
                    "PROOF storage_only_reopen constructors=0 requests=0 effects=0 interruptions=1"
                );
            }
            Mode::Duplicate(prefix) => prefixes::duplicate(&fixture, prefix).await,
        }
    });
}

#[tokio::test]
async fn never_polled_persisted_future_has_no_acceptance_or_effects() {
    let rig = Rig::new(vec![Step::Wait], ToolMode::Pending).await;
    let before = Snapshot::read(&rig.temp.path().join("root"), rig.session.session_id()).await;
    let future = run_persisted(
        &rig.gateway,
        &rig.session,
        rig.request(),
        &rig.tools,
        CancellationToken::new(),
    );
    drop(future);
    let after = Snapshot::read(&rig.temp.path().join("root"), rig.session.session_id()).await;
    assert!(before == after);
    assert_eq!(after.events.len(), 1);
    assert!(after.runs.is_empty() && after.tools.is_empty() && after.commands.is_empty());
    assert!(
        rig.session
            .lookup_receipt(rig.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&rig.script.records.capabilities), 0);
    assert_eq!(count(&rig.script.records.opens), 0);
    assert_eq!(count(&rig.script.records.closes), 0);
    assert_eq!(count(&rig.script.records.calls), 0);
    assert!(rig.script.records.inputs.lock().unwrap().is_empty());
    rig.close().await;
}

#[tokio::test]
async fn p1b1_19_process_actual_future_drop_abort_panic_retains_lease_and_drains_sql() {
    for how in [Retirement::Drop, Retirement::Abort, Retirement::Panic] {
        for tool in [false, true] {
            let rig = Rig::new(vec![], ToolMode::Pending).await;
            let fixture = Fixture::from_rig(&rig, Mode::Retire { how, tool });
            rig.store.close().await.unwrap();
            let mut child = Process::start(&rig.temp.path().join("child"), &fixture);
            child.ready();
            assert_eq!(
                SessionStore::open(fixture.root.clone())
                    .await
                    .unwrap_err()
                    .code(),
                "storage.busy"
            );
            let before = Snapshot::read(&fixture.root, &fixture.session).await;
            before.unfinished(&fixture);
            assert_eq!(before.events.len(), if tool { 7 } else { 4 });
            child.release();
            child.ready();
            assert_eq!(
                SessionStore::open(fixture.root.clone())
                    .await
                    .unwrap_err()
                    .code(),
                "storage.busy"
            );
            let drained = Snapshot::read(&fixture.root, &fixture.session).await;
            drained.unfinished(&fixture);
            assert_eq!(drained.events.len(), before.events.len() + 1);
            assert!(drained.events[..before.events.len()] == before.events);
            assert_eq!(drained.events.last().unwrap().2, "session.renamed");
            child.release();
            child.finish(0);
            reopen::selected(&fixture, &drained).await;
            // Only this parent's private TempDir is removed, after the child has been reaped.
        }
    }
}
