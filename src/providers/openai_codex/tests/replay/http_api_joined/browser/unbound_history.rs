//! A real completed B1 run without B2 provenance. All private evidence stays in Rust.
use super::*;
use crate::{
    Capability, EventEnvelope, GatewayError, InputItem, ItemKind, ModelResponse, OutputItem,
    OutputProvenance, Provider, ProviderCapabilities, ProviderEvent, ProviderSession,
    RequestReceipt, ResponseOutcome, SessionControl,
    execution::{
        PersistentRunCause, PersistentRunRequest, PersistentRunResult, PersistentRunStage,
        prepare_session_replay, run_persisted,
    },
    run::RunRequest,
    storage::{AppendRunRecord, CommitReceipt, RecordedRunState, SessionHandle},
    tools::ToolRegistry,
};
use async_trait::async_trait;
use sqlx::{Column, TypeInfo, ValueRef, sqlite::SqliteRow};

const TITLE: &str = "Legacy completed conversation";
const HEAD: usize = 9;

fn checked<T, E>(value: std::result::Result<T, E>) -> T {
    value.unwrap_or_else(|_| panic!("unbound-history evidence rejected"))
}
fn value(input: &impl serde::Serialize) -> Value {
    checked(serde_json::to_value(input))
}
pub(super) fn check_control(control: &Control) {
    assert!(
        matches!(control, Control::Inspect { .. } | Control::Stop { .. }),
        "unbound-history control rejected"
    );
}

#[derive(Default)]
struct Counts {
    opens: AtomicUsize,
    requests: AtomicUsize,
    closes: AtomicUsize,
}
struct Script(Arc<Counts>);
struct ScriptControl {
    counts: Arc<Counts>,
    ready: mpsc::Sender<()>,
}
#[async_trait]
impl SessionControl for ScriptControl {
    async fn generate(&self, input: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        assert!(
            value(&input) == json!([{"kind":"user","text":TASKS[0]}]),
            "unbound-history input rejected"
        );
        assert!(self.counts.requests.fetch_add(1, Ordering::SeqCst) == 0);
        checked(self.ready.send(()).await);
        Ok(RequestReceipt {
            request_id: "legacy-request".into(),
        })
    }
    fn close(&self) {
        self.counts.closes.fetch_add(1, Ordering::SeqCst);
    }
}
fn response() -> ModelResponse {
    ModelResponse {
        id: "legacy-response".into(),
        model: Some(MODEL.into()),
        outcome: ResponseOutcome::Completed,
        text: ANSWERS[0].into(),
        output: vec![OutputItem {
            id: Some("answer".into()),
            kind: ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: answer(0).remove(0),
        }],
        usage: None,
        native: json!({"private-native":"legacy"}),
        output_provenance: OutputProvenance::NativeTerminal,
    }
}
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "private finite script".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    async fn open_session(&self, options: SessionOptions) -> crate::Result<ProviderSession> {
        assert!(
            value(&options) == value(&SessionOptions::new(MODEL)),
            "unbound-history options rejected"
        );
        assert!(self.0.opens.fetch_add(1, Ordering::SeqCst) == 0);
        let (ready, mut received) = mpsc::channel(1);
        Ok(ProviderSession {
            id: "legacy-session".into(),
            control: Arc::new(ScriptControl {
                counts: self.0.clone(),
                ready,
            }),
            events: Box::pin(async_stream::stream! {
                assert!(received.recv().await == Some(()));
                for (index, event) in [
                    ProviderEvent::ResponseStarted { response_id: "legacy-response".into() },
                    ProviderEvent::ResponseFinished { response: response() },
                ].into_iter().enumerate() {
                    yield EventEnvelope { schema_version: 1, sequence: (index + 1) as u64,
                        event_id: format!("legacy-event-{index}"), session_id: "legacy-session".into(),
                        request_id: Some("legacy-request".into()), provider: PROVIDER_ID.into(), provider_sequence: None, event };
                }
            }),
        })
    }
}

#[derive(Clone, PartialEq)]
struct Snapshot {
    events: Vec<Value>,
    commands: Vec<Value>,
    runs: Vec<Value>,
    tools: Vec<Value>,
    manifest: Vec<Value>,
}
fn rows(rows: Vec<SqliteRow>) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut fields = serde_json::Map::new();
            for column in row.columns() {
                let raw = checked(row.try_get_raw(column.ordinal()));
                let field = if raw.is_null() {
                    Value::Null
                } else {
                    match raw.type_info().name() {
                        "INTEGER" => json!(checked(row.try_get::<i64, _>(column.ordinal()))),
                        "TEXT" => json!(checked(row.try_get::<String, _>(column.ordinal()))),
                        "BLOB" => json!(checked(row.try_get::<Vec<u8>, _>(column.ordinal()))),
                        _ => panic!("unbound-history column rejected"),
                    }
                };
                fields.insert(column.name().into(), field);
            }
            Value::Object(fields)
        })
        .collect()
}
async fn snapshot(db: &Database) -> Snapshot {
    let mut reader = db.reader.lock().await;
    let mut sql = checked(reader.as_mut().unwrap().begin().await);
    let state = Snapshot {
        events: rows(checked(
            sqlx::query("SELECT * FROM events ORDER BY sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        commands: rows(checked(
            sqlx::query("SELECT * FROM commands ORDER BY first_sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        runs: rows(checked(
            sqlx::query("SELECT * FROM runs ORDER BY accepted_sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        tools: rows(checked(
            sqlx::query("SELECT * FROM tool_results ORDER BY started_sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        manifest: rows(checked(
            sqlx::query("SELECT * FROM manifest")
                .fetch_all(&mut *sql)
                .await,
        )),
    };
    checked(sql.rollback().await);
    state
}

pub(super) struct Audit {
    session: SessionHandle,
    seed: ApplicationSessionId,
    run: RunId,
    baseline: Snapshot,
}
impl Audit {
    pub(super) fn session_id(&self) -> &ApplicationSessionId {
        self.session.session_id()
    }
    pub(super) async fn seed(
        store: &SessionStore,
        db: &Database,
        workspace: &Path,
        seed: &ApplicationSessionId,
    ) -> Self {
        let created = checked(
            store
                .create_session(checked(CreateSession::new(
                    OperationId::new(),
                    TITLE.into(),
                    Some(workspace.to_str().unwrap().into()),
                )))
                .await,
        );
        let session = checked(store.open_session(created.session_id().clone()).await);
        db.open(created.session_id().clone()).await;
        let input = checked(RecordedRunInput::new(
            TASKS[0].into(),
            RunRequest {
                provider_id: PROVIDER_ID.into(),
                options: SessionOptions::new(MODEL),
                prompt: TASKS[0].into(),
            },
            vec![],
            vec![],
            vec![],
            None,
        ));
        let counts = Arc::new(Counts::default());
        let mut gateway = Gateway::new();
        checked(gateway.register(Arc::new(Script(counts.clone()))));
        let run = RunId::new();
        // B1 uses accept_run and the real PersistentObserver, not B2 selection or SQL inserts.
        let executed = checked(
            watch(run_persisted(
                &gateway,
                &session,
                PersistentRunRequest {
                    operation_id: OperationId::new(),
                    run_id: run.clone(),
                    input,
                },
                &ToolRegistry::new(),
                CancellationToken::new(),
            ))
            .await,
        );
        let PersistentRunResult::Executed {
            acceptance,
            final_record,
            result,
        } = executed
        else {
            panic!("unbound-history duplicate seed")
        };
        assert!(
            !acceptance.duplicate()
                && acceptance.cleanup_warning().is_none()
                && final_record.cleanup_warning().is_none()
        );
        assert!(
            acceptance.receipt().first_sequence() == 2 && acceptance.receipt().last_sequence() == 2
        );
        assert!(
            result.outcome == RunOutcome::Completed
                && result.events_complete
                && result.sink_error.is_none()
        );
        assert!(
            [&counts.opens, &counts.requests, &counts.closes].map(|c| c.load(Ordering::SeqCst))
                == [1, 1, 1]
        );
        let baseline = snapshot(db).await;
        audit(&baseline, &db.records().await);
        let audit = Self {
            session,
            seed: seed.clone(),
            run,
            baseline,
        };
        audit.readable_and_unbound().await;
        audit.unchanged(db).await;
        audit
    }
    async fn readable_and_unbound(&self) {
        let error = prepare_session_replay(&self.session, PROVIDER_ID, MODEL)
            .await
            .unwrap_err();
        assert!(
            error.stage() == PersistentRunStage::History
                && error.acceptance().is_none()
                && matches!(
                    error.cause(),
                    PersistentRunCause::Gateway(GatewayError::InvalidRequest(
                        "stored history has no replay provenance"
                    ))
                ),
            "unbound-history replay policy rejected"
        );
        let saved = checked(self.session.run_record(self.run.clone()).await).unwrap();
        assert!(
            saved.state() == RecordedRunState::Completed
                && saved
                    .result()
                    .is_some_and(|r| r.outcome == RunOutcome::Completed)
        );
        assert!(checked(self.session.history_selection(self.run.clone()).await).is_none());
    }
    async fn unchanged(&self, db: &Database) {
        let current = snapshot(db).await;
        // Compare raw TEXT/BLOB values, not normalized JSON: even whitespace changes fail.
        assert!(current == self.baseline, "unbound-history storage changed");
        audit(&current, &db.records().await);
        acceptance_warning::inspect_seed(&db.root, &self.seed).await;
    }
    pub(super) async fn inspect(
        &self,
        db: &Database,
        id: u32,
        proof: &Mutex<Proof>,
        auth: &CountedAuth,
    ) -> Value {
        self.readable_and_unbound().await;
        self.unchanged(db).await;
        let p = proof.lock().unwrap();
        assert!(
            p.connections == 0
                && p.requests == 0
                && p.completed == 0
                && p.prepared_exact == 0
                && p.fresh_parents == 0
                && p.continuations == 0
                && p.gate.is_none()
                && p.provider_stage.is_none()
                && !p.provider_failed
                && auth.loads.load(Ordering::SeqCst) == 0
                && auth.prepares.load(Ordering::SeqCst) == 0
        );
        assert!(db.read_failure.lock().unwrap().is_none());
        json!({"id":id,"event":"unbound_history_inspect","session_id":self.session_id(),
            "exact":true,"unchanged":true,"replay_rejected":true,"completed":true,"result_recorded":true,
            "sequence_count":HEAD.to_string(),"seed_head":"1","acceptances":1,"selections":0,"bindings":0,
            "runtime":6,"results":1,"tools":0,"connections":0,"requests":0,"auth_loads":0,"auth_prepares":0})
    }
}

fn audit(state: &Snapshot, records: &[StoredEvent]) {
    assert!(
        state.events.len() == HEAD
            && records.len() == HEAD
            && state.runs.len() == 1
            && state.tools.is_empty()
            && state.manifest.len() == 1,
        "unbound-history counts rejected"
    );
    let views: Vec<_> = records
        .iter()
        .map(|e| value(&crate::http_api::dto::EventView::from(e)))
        .collect();
    let kinds: Vec<_> = views.iter().map(|v| v["kind"].as_str().unwrap()).collect();
    assert!(
        kinds
            == [
                "session.created",
                "run.accepted",
                "run.started",
                "turn.started",
                "response.started",
                "response.finished",
                "turn.finished",
                "run.finished",
                "run.result"
            ],
        "unbound-history sequence rejected"
    );
    let StoredEventPayload::RunAccepted(accepted) = records[1].payload() else {
        unreachable!()
    };
    let StoredEventPayload::RuntimeObserved(finished) = records[7].payload() else {
        unreachable!()
    };
    let StoredEventPayload::RunResultRecorded(result) = records[8].payload() else {
        unreachable!()
    };
    let sid = records[0].application_session_id();
    let run = accepted.run_id();
    let input = accepted.input();
    assert!(
        input.user_text() == TASKS[0]
            && input.prepared_request().prompt == TASKS[0]
            && input.prepared_request().provider_id == PROVIDER_ID
            && value(&input.prepared_request().options) == value(&SessionOptions::new(MODEL))
            && input.tool_definitions().is_empty()
            && views[0]["data"]["title"] == TITLE,
        "unbound-history acceptance rejected"
    );
    assert!(
        result.run_id == run.as_str()
            && result.session_id.as_deref() == Some("legacy-session")
            && result.outcome == RunOutcome::Completed
            && result.events_complete
            && result.sink_error.is_none()
            && value(&result.last_response) == value(&Some(response()))
            && views[5]["data"] == value(&crate::http_api::dto::ResponseView::from(&response())),
        "unbound-history result rejected"
    );
    let turn = &views[3]["data"]["turn_id"];
    assert!(
        views[3]["data"]["number"] == "1"
            && turn.is_string()
            && views[6]["data"]["turn_id"] == *turn
            && views[6]["data"]["number"] == "1"
            && views[6]["data"]["response_id"] == "legacy-response"
            && views[6]["data"]["outcome"] == json!({"type":"model_completed"})
            && views[6]["data"]["upstream_outcome"] == "terminal_received",
        "unbound-history closed turn rejected"
    );
    let summary = &result.summary;
    assert!(
        [
            summary.turns_started,
            summary.turns_finished,
            summary.model_requests_attempted,
            summary.model_requests_admitted
        ] == [1; 4]
            && [
                summary.new_tool_dispatches,
                summary.tool_results_prepared,
                summary.reused_results
            ] == [0; 3]
            && summary.last_request_id.as_deref() == Some("legacy-request")
            && summary.last_upstream_outcome == Some(crate::UpstreamOutcome::TerminalReceived)
            && matches!(&finished.event, RunEvent::RunFinished { outcome, summary: s } if *outcome == RunOutcome::Completed && value(s) == value(summary)),
        "unbound-history exchange rejected"
    );
    let mut ids = std::collections::HashSet::new();
    for (index, (record, row)) in records.iter().zip(&state.events).enumerate() {
        assert!(
            record.sequence() == (index + 1) as u64
                && ids.insert(record.event_id())
                && record.application_session_id() == sid
                && row["sequence"] == record.sequence()
                && row["event_id"] == record.event_id().as_str()
                && row["event_type"] == record.event_type()
                && row["event_version"] == record.event_version()
                && row["created_at_ms"] == record.created_at_ms()
                && row["run_id"] == value(&record.run_id())
                && checked(serde_json::from_str::<Value>(
                    row["payload_json"].as_str().unwrap()
                )) == value(record)["payload"],
            "unbound-history envelope rejected"
        );
        assert!(
            index == 0 || record.run_id() == Some(run),
            "unbound-history run rejected"
        );
        if let StoredEventPayload::RuntimeObserved(runtime) = record.payload() {
            assert!(
                runtime.run_id == run.as_str()
                    && runtime.sequence == (index - 1) as u64
                    && row["source_event_id"] == runtime.event_id
                    && row["source_sequence"] == runtime.sequence,
                "unbound-history source rejected"
            );
        } else {
            assert!(row["source_event_id"].is_null() && row["source_sequence"].is_null());
        }
    }
    let saved = &state.runs[0];
    assert!(
        saved["run_id"] == run.as_str()
            && saved["owner_instance_id"] == accepted.owner_instance_id().as_str()
            && saved["state"] == "completed"
            && saved["accepted_sequence"] == 2
            && saved["terminal_sequence"] == 8
            && saved["result_sequence"] == 9
            && saved["last_runtime_sequence"] == 6
            && saved["provider_session_id"] == "legacy-session"
            && checked(serde_json::from_str::<Value>(
                saved["terminal_json"].as_str().unwrap()
            )) == value(finished)
            && state.manifest[0]["head_sequence"] == HEAD
            && state.manifest[0]["updated_at_ms"] == records[8].created_at_ms(),
        "unbound-history projection rejected"
    );
    let mut last = 1;
    let mut operations = std::collections::HashSet::new();
    for command in &state.commands {
        let receipt: CommitReceipt = checked(serde_json::from_str(
            command["receipt_json"].as_str().unwrap(),
        ));
        assert!(
            receipt.session_id() == sid
                && receipt.run_id() == Some(run)
                && operations.insert(receipt.operation_id().clone())
                && command["operation_id"] == receipt.operation_id().as_str()
                && command["first_sequence"] == receipt.first_sequence()
                && command["last_sequence"] == receipt.last_sequence()
                && receipt.first_sequence() == last + 1
                && receipt.last_sequence() >= receipt.first_sequence()
                && receipt.last_sequence() <= HEAD as u64,
            "unbound-history receipt rejected"
        );
        let batch = &records[last as usize..receipt.last_sequence() as usize];
        let canonical = if last == 1 {
            assert!(
                command["method"] == "accept_run" && receipt.last_sequence() == 2,
                "unbound-history legacy method rejected"
            );
            json!({"method":"accept_run","session_id":sid,"run_id":run,"input":input})
        } else {
            assert!(
                command["method"] == "append_run_records",
                "unbound-history command rejected"
            );
            let appended: Vec<_> = batch
                .iter()
                .map(|e| match e.payload() {
                    StoredEventPayload::RuntimeObserved(runtime) => {
                        AppendRunRecord::Runtime(runtime.clone())
                    }
                    StoredEventPayload::RunResultRecorded(result) => {
                        AppendRunRecord::Result(result.clone())
                    }
                    _ => panic!("unbound-history append rejected"),
                })
                .collect();
            json!({"method":"append_run_records","session_id":sid,"run_id":run,"records":appended})
        };
        assert!(
            batch
                .iter()
                .all(|e| e.created_at_ms() == batch[0].created_at_ms())
                && command["payload_hash"]
                    == json!(
                        ring::digest::digest(
                            &ring::digest::SHA256,
                            canonical.to_string().as_bytes()
                        )
                        .as_ref()
                    ),
            "unbound-history command bytes rejected"
        );
        last = receipt.last_sequence();
    }
    assert!(
        last == HEAD as u64,
        "unbound-history command coverage rejected"
    );
}

#[path = "unbound_history/tests.rs"]
mod tests;
