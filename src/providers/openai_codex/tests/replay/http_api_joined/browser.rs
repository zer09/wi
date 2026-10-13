//! Private child for real Chromium -> HTTP -> B2 -> SQLite -> provider -> tools tests.
use super::*;
use replay_head::Step;
use serde::Deserialize;
use std::{io::Write, num::NonZeroU32, panic::AssertUnwindSafe, path::PathBuf};
use tokio::{io::AsyncBufReadExt, sync::mpsc};

#[path = "browser/acceptance_unknown.rs"]
mod acceptance_unknown;
#[path = "browser/acceptance_warning.rs"]
mod acceptance_warning;
#[path = "browser/account_mismatch.rs"]
mod account_mismatch;
#[path = "browser/cancellation.rs"]
mod cancellation;
#[path = "browser/failure_tests.rs"]
mod failure_tests;
#[path = "browser/fixed_head.rs"]
mod fixed_head;
#[path = "browser/input_framing.rs"]
mod input_framing;
#[path = "browser/lifecycle_failure.rs"]
mod lifecycle_failure;
#[path = "browser/mutations.rs"]
mod mutations;
#[path = "browser/presentation.rs"]
mod presentation;
#[path = "browser/replay_head.rs"]
mod replay_head;
#[path = "browser/restart.rs"]
mod restart;
#[path = "browser/task.rs"]
mod task;
#[path = "browser/tool_fidelity.rs"]
mod tool_fidelity;
#[path = "browser/unbound_history.rs"]
mod unbound_history;

const TASKS: [&str; 2] = [
    "  Add 17 and 25. 雪\n<em>task & inert</em>\n",
    "Add 8 to the previous result. 雪\nSecond explicit task.\n",
];
const ANSWERS: [&str; 2] = [
    "42 雪\r\n<em>answer & inert</em>\n",
    "50 雪\r\nSecond answer.\n",
];
const ARGUMENTS: [&str; 2] = ["{\"a\":17,\r\n \"b\":25}", "{\"a\":42,\r\n \"b\":8}"];
const OUTPUTS: [&str; 2] = ["{\"sum\":42}", "{\"sum\":50}"];
const LIMIT: u64 = 4096;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FinalPolling {
    Baseline,
    Incremental,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    id: u32,
    transport: Transport,
    recovered: bool,
    mime: bool,
    #[serde(default)]
    presentation: bool,
    #[serde(default)]
    mutations: bool,
    #[serde(default)]
    unbound_history: bool,
    #[serde(default)]
    fixed_head: bool,
    #[serde(default)]
    tool_fidelity: bool,
    #[serde(default)]
    lifecycle_failure: bool,
    #[serde(default)]
    cancellation: bool,
    #[serde(default)]
    gate11_diagnostics: bool,
    #[serde(default)]
    native_latency: bool,
    #[serde(default, deserialize_with = "final_polling")]
    final_polling: Option<FinalPolling>,
    owner: String,
}

fn final_polling<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> std::result::Result<Option<FinalPolling>, D::Error> {
    FinalPolling::deserialize(input).map(Some)
}

impl Start {
    fn validate(&self) {
        assert!(
            self.final_polling.is_none() || (self.native_latency && self.gate11_diagnostics),
            "fixture polling mode rejected"
        );
        assert!(
            !self.native_latency || self.gate11_diagnostics,
            "fixture latency mode rejected"
        );
        assert!(
            !self.gate11_diagnostics
                || (self.presentation
                    && !self.mutations
                    && !self.unbound_history
                    && !self.fixed_head
                    && !self.tool_fidelity
                    && !self.lifecycle_failure
                    && !self.cancellation
                    && self.transport == Transport::WebSocket
                    && !self.recovered
                    && self.mime),
            "fixture diagnostic mode rejected"
        );
        assert!(
            self.id > 0
                && self.owner.len() == 64
                && self
                    .owner
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "fixture start rejected"
        );
        assert!(
            !self.cancellation
                || (!self.lifecycle_failure
                    && !self.tool_fidelity
                    && !self.mutations
                    && !self.presentation
                    && !self.unbound_history
                    && !self.fixed_head
                    && self.transport == Transport::WebSocket
                    && !self.recovered
                    && self.mime),
            "fixture start rejected"
        );
        assert!(
            !self.lifecycle_failure
                || (!self.tool_fidelity
                    && !self.mutations
                    && !self.presentation
                    && !self.unbound_history
                    && !self.fixed_head
                    && self.transport == Transport::WebSocket
                    && !self.recovered
                    && self.mime),
            "fixture start rejected"
        );
        assert!(
            !self.tool_fidelity
                || (!self.mutations
                    && !self.presentation
                    && !self.unbound_history
                    && !self.fixed_head
                    && self.transport == Transport::WebSocket
                    && !self.recovered
                    && self.mime),
            "fixture start rejected"
        );
        assert!(
            !(self.unbound_history && self.fixed_head)
                && (!(self.unbound_history || self.fixed_head)
                    || (self.mutations
                        && !self.presentation
                        && self.transport == Transport::WebSocket
                        && !self.recovered
                        && self.mime)),
            "fixture start rejected"
        );
    }
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Select {
        id: u32,
        session_id: String,
    },
    ArmAcceptance {
        id: u32,
    },
    ArmAcceptanceUnknown {
        id: NonZeroU32,
    },
    ArmAcceptanceWarning {
        id: NonZeroU32,
    },
    RotateAccount {
        id: NonZeroU32,
    },
    WaitAcceptance {
        id: u32,
    },
    ReleaseAcceptance {
        id: u32,
    },
    Drive {
        id: u32,
        gate: usize,
    },
    Inspect {
        id: u32,
    },
    Gate11Diagnostic {
        id: NonZeroU32,
    },
    Gate11Latency {
        id: NonZeroU32,
        page: u16,
    },
    InspectMutations {
        id: u32,
    },
    InspectTask {
        id: u32,
    },
    InspectToolFidelity {
        id: NonZeroU32,
    },
    ArmCancellation {
        id: NonZeroU32,
    },
    WaitCancellationPending {
        id: NonZeroU32,
        session_id: ApplicationSessionId,
        run_id: RunId,
        operation_id: OperationId,
    },
    WaitCancellation {
        id: NonZeroU32,
    },
    ReleaseCancellation {
        id: NonZeroU32,
        terminal_operation_id: OperationId,
    },
    InspectCancellation {
        id: NonZeroU32,
    },
    ArmLifecycleFailure {
        id: NonZeroU32,
    },
    WaitLifecycleFailure {
        id: NonZeroU32,
        session_id: ApplicationSessionId,
        run_id: RunId,
        operation_id: OperationId,
    },
    ReleaseLifecycleFailure {
        id: NonZeroU32,
        final_operation_id: OperationId,
    },
    InspectLifecycleFailure {
        id: NonZeroU32,
    },
    SeedInputFraming {
        id: u32,
    },
    ReplayHead {
        id: NonZeroU32,
        step: Step,
    },
    Stop {
        id: u32,
    },
}

impl Control {
    fn id(&self) -> u32 {
        match self {
            Self::ArmAcceptanceUnknown { id }
            | Self::ArmAcceptanceWarning { id }
            | Self::RotateAccount { id }
            | Self::InspectToolFidelity { id }
            | Self::ArmCancellation { id }
            | Self::WaitCancellationPending { id, .. }
            | Self::WaitCancellation { id }
            | Self::ReleaseCancellation { id, .. }
            | Self::InspectCancellation { id }
            | Self::ArmLifecycleFailure { id }
            | Self::WaitLifecycleFailure { id, .. }
            | Self::ReleaseLifecycleFailure { id, .. }
            | Self::InspectLifecycleFailure { id }
            | Self::ReplayHead { id, .. }
            | Self::Gate11Diagnostic { id }
            | Self::Gate11Latency { id, .. } => id.get(),
            Self::Select { id, .. }
            | Self::ArmAcceptance { id }
            | Self::WaitAcceptance { id }
            | Self::ReleaseAcceptance { id }
            | Self::Drive { id, .. }
            | Self::Inspect { id }
            | Self::InspectMutations { id }
            | Self::InspectTask { id }
            | Self::SeedInputFraming { id }
            | Self::Stop { id } => *id,
        }
    }
}

fn emit(mut value: Value) {
    value["protocol"] = json!(1);
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(bytes.len() <= LIMIT as usize);
    let mut out = std::io::stdout().lock();
    out.write_all(&bytes).unwrap();
    out.write_all(b"\n").unwrap();
    out.flush().unwrap();
}

// These labels are the entire terminal diagnostic vocabulary. Never send panic text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FixtureFailure {
    ConnectBusy,
    ConnectOther,
    EventsQueryBusy,
    EventsQueryOther,
    EventsDecode,
    ReceiptsQueryBusy,
    ReceiptsQueryOther,
    ReceiptsDecode,
    SelectionInvariant,
    ControlOther,
}
impl FixtureFailure {
    fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::ConnectBusy => ("connect", "connect_busy"),
            Self::ConnectOther => ("connect", "connect_other"),
            Self::EventsQueryBusy => ("events_query", "query_busy"),
            Self::EventsQueryOther => ("events_query", "query_other"),
            Self::EventsDecode => ("events_decode", "decode"),
            Self::ReceiptsQueryBusy => ("receipts_query", "query_busy"),
            Self::ReceiptsQueryOther => ("receipts_query", "query_other"),
            Self::ReceiptsDecode => ("receipts_decode", "decode"),
            Self::SelectionInvariant => ("selection", "invariant"),
            Self::ControlOther => ("unknown", "control_other"),
        }
    }
}

fn caught_failure(payload: &(dyn std::any::Any + Send)) -> FixtureFailure {
    payload
        .downcast_ref::<FixtureFailure>()
        .copied()
        .unwrap_or(FixtureFailure::ControlOther)
}

fn emit_failure(out: &mut impl Write, failure: FixtureFailure) {
    let (phase, category) = failure.labels();
    // A closed output pipe must not interrupt native teardown.
    if let Ok(bytes) = serde_json::to_vec(
        &json!({"protocol":1,"event":"fixture_failed","phase":phase,"category":category}),
    ) {
        let _ = out
            .write_all(&bytes)
            .and_then(|_| out.write_all(b"\n"))
            .and_then(|_| out.flush());
    }
}

async fn control<T: serde::de::DeserializeOwned>(
    reader: &mut tokio::io::BufReader<tokio::io::Stdin>,
) -> T {
    // Bound input before parsing, including a peer that never sends a delimiter.
    let mut line = Vec::new();
    let count = watch(reader.take(LIMIT + 1).read_until(b'\n', &mut line))
        .await
        .unwrap();
    assert!(count > 0 && count <= LIMIT as usize && line.last() == Some(&b'\n'));
    decode_control(&line)
}

fn decode_control<T: serde::de::DeserializeOwned>(line: &[u8]) -> T {
    // Control fields are ASCII identities and switches, never escaped text or payloads.
    assert!(!line.contains(&b'\\'), "fixture control rejected");
    serde_json::from_slice(line).unwrap_or_else(|_| panic!("fixture control rejected"))
}

#[derive(Default)]
struct Proof {
    connections: usize,
    requests: usize,
    gate: Option<usize>,
    completed: usize,
    fresh_empty: bool,
    restored_history: bool,
    fresh_parents: usize,
    continuations: usize,
    prepared_exact: usize,
    provider_stage: Option<&'static str>,
    provider_failed: bool,
    mismatch_armed: bool,
    mismatch_closed: bool,
    diagnostic: Option<Arc<presentation::Trace>>,
}

#[derive(Clone)]
struct Database {
    root: PathBuf,
    session: Arc<Mutex<Option<ApplicationSessionId>>>,
    read_failure: Arc<Mutex<Option<&'static str>>>,
    reader: Arc<tokio::sync::Mutex<Option<SqliteConnection>>>,
}
impl Database {
    async fn open(&self, sid: ApplicationSessionId) {
        let id = sid.as_str();
        // Keep the WAL connection open so short reads cannot race last-connection cleanup.
        // Each query ends its snapshot; this mutex is independent of the paused writer.
        let reader = SqliteConnectOptions::new()
            .filename(
                self.root
                    .join("sessions")
                    .join(&id[..2])
                    .join(id)
                    .join("session.sqlite3"),
            )
            .read_only(true)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging()
            .connect()
            .await
            .unwrap_or_else(|error| self.sql_failure(error, "connect"));
        if self.reader.lock().await.replace(reader).is_some()
            || self.session.lock().unwrap().replace(sid).is_some()
            || self.records().await.len() != 1
        {
            std::panic::panic_any(FixtureFailure::SelectionInvariant);
        }
    }

    async fn records(&self) -> Vec<StoredEvent> {
        let Some(sid) = self.session.lock().unwrap().clone() else {
            return vec![];
        };
        use crate::storage::test_hooks::latency::{self, Stage};
        let _lock_time = latency::span(Stage::ReaderLock);
        let mut reader = self.reader.lock().await;
        drop(_lock_time);
        let _fetch_time = latency::marker(latency::FETCH);
        let rows = sqlx::query("SELECT sequence,event_id,event_type,event_version,created_at_ms,run_id,payload_json FROM events ORDER BY sequence")
            .fetch_all(reader.as_mut().unwrap()).await.unwrap_or_else(|error| self.sql_failure(error, "events_query"));
        latency::work(latency::FETCHED_ROWS, rows.len() as u64);
        drop(_fetch_time);
        self.decode_rows(sid, rows)
    }

    async fn records_after(&self, after: u64) -> Vec<StoredEvent> {
        let sid = self.session.lock().unwrap().clone().unwrap();
        use crate::storage::test_hooks::latency::{self, Stage};
        let _lock_time = latency::span(Stage::ReaderLock);
        let mut reader = self.reader.lock().await;
        drop(_lock_time);
        let _fetch_time = latency::marker(latency::FETCH);
        let rows = sqlx::query("SELECT sequence,event_id,event_type,event_version,created_at_ms,run_id,payload_json FROM events WHERE sequence > ? ORDER BY sequence")
            .bind(i64::try_from(after).unwrap())
            .fetch_all(reader.as_mut().unwrap()).await.unwrap_or_else(|error| self.sql_failure(error, "events_query"));
        latency::work(latency::FETCHED_ROWS, rows.len() as u64);
        drop(_fetch_time);
        self.decode_rows(sid, rows)
    }

    fn decode_rows(
        &self,
        sid: ApplicationSessionId,
        rows: Vec<sqlx::sqlite::SqliteRow>,
    ) -> Vec<StoredEvent> {
        use crate::storage::test_hooks::latency;
        let _reconstruction_time = latency::marker(latency::RECONSTRUCT);
        rows.into_iter().map(|row| {
            let decoded = (|| -> std::result::Result<StoredEvent, Box<dyn std::error::Error>> {
                let payload: Value = serde_json::from_str(row.try_get::<&str,_>("payload_json")?)?;
                Ok(serde_json::from_value(json!({"schema_version":1,"application_session_id":sid,
                    "sequence":row.try_get::<i64,_>("sequence")?,"event_id":row.try_get::<String,_>("event_id")?,
                    "event_type":row.try_get::<String,_>("event_type")?,"event_version":row.try_get::<i64,_>("event_version")?,
                    "created_at_ms":row.try_get::<i64,_>("created_at_ms")?,"run_id":row.try_get::<Option<String>,_>("run_id")?,"payload":payload}))?)
            })();
            let record = decoded.unwrap_or_else(|_| {
                latency::fail();
                std::panic::panic_any(FixtureFailure::EventsDecode)
            });
            latency::work(latency::DECODED_ROWS, 1);
            record
        }).collect()
    }

    async fn receipts(&self) -> Vec<Value> {
        let mut reader = self.reader.lock().await;
        let Some(reader) = reader.as_mut() else {
            return vec![];
        };
        let rows: Vec<String> = sqlx::query_scalar("SELECT receipt_json FROM commands WHERE method='accept_history_run' ORDER BY first_sequence")
            .fetch_all(reader).await.unwrap_or_else(|error| self.sql_failure(error, "receipts_query"));
        rows.into_iter()
            .map(|row| {
                let receipt: crate::storage::CommitReceipt = serde_json::from_str(&row)
                    .unwrap_or_else(|_| std::panic::panic_any(FixtureFailure::ReceiptsDecode));
                serde_json::to_value(crate::http_api::dto::ReceiptView::from(&receipt))
                    .unwrap_or_else(|_| std::panic::panic_any(FixtureFailure::ReceiptsDecode))
            })
            .collect()
    }

    fn sql_failure(&self, error: sqlx::Error, phase: &'static str) -> ! {
        let busy = matches!(
            error.as_database_error().and_then(|e| e.code()).as_deref(),
            Some("5" | "6" | "261" | "517")
        );
        let failure = match (phase, busy) {
            ("connect", true) => FixtureFailure::ConnectBusy,
            ("connect", false) => FixtureFailure::ConnectOther,
            ("events_query", true) => FixtureFailure::EventsQueryBusy,
            ("events_query", false) => FixtureFailure::EventsQueryOther,
            ("receipts_query", true) => FixtureFailure::ReceiptsQueryBusy,
            ("receipts_query", false) => FixtureFailure::ReceiptsQueryOther,
            _ => unreachable!(),
        };
        *self.read_failure.lock().unwrap() = Some(failure.labels().1);
        // The marker travels with this unwind, independently of provider-task reads.
        std::panic::panic_any(failure);
    }

    async fn inspect(&self, id: u32, proof: &Mutex<Proof>, auth: &CountedAuth) -> Value {
        let records = self.records().await;
        let receipts = self.receipts().await;
        let mut accepted = vec![];
        let mut tools = 0;
        let mut terminals = 0;
        let mut results = 0;
        let mut response_finishes = vec![];
        let mut terminal_sequences = vec![];
        let mut result_sequences = vec![];
        for record in &records {
            match record.payload() {
                StoredEventPayload::RunAccepted(run) => accepted.push(json!({
                    "run_id":run.run_id(),"accepted_sequence":record.sequence().to_string()
                })),
                StoredEventPayload::ToolResultRecorded(_) => tools += 1,
                StoredEventPayload::RuntimeObserved(event) => match &event.event {
                    RunEvent::ProviderEvent { event } => {
                        if let ProviderEvent::ResponseFinished { response } = &event.event {
                            response_finishes.push(json!({
                                "sequence":record.sequence().to_string(),
                                "provenance":response.output_provenance
                            }));
                        }
                    }
                    RunEvent::RunFinished { outcome, .. } => {
                        assert!(
                            *outcome == RunOutcome::Completed
                                || (proof.lock().unwrap().mismatch_armed
                                    && account_mismatch::failed(outcome))
                        );
                        terminals += 1;
                        terminal_sequences.push(record.sequence().to_string());
                    }
                    _ => (),
                },
                StoredEventPayload::RunResultRecorded(_) => {
                    results += 1;
                    result_sequences.push(record.sequence().to_string());
                }
                _ => (),
            }
        }
        let p = proof.lock().unwrap();
        json!({"id":id,"event":"inspect","connections":p.connections,"requests":p.requests,
            "gate":p.gate,"completed":p.completed,"fresh_empty":p.fresh_empty,
            "restored_history":p.restored_history,"fresh_parents":p.fresh_parents,
            "continuations":p.continuations,"prepared_exact":p.prepared_exact,
            "auth_loads":auth.loads.load(Ordering::SeqCst),"auth_prepares":auth.prepares.load(Ordering::SeqCst),
            "sequence_count":records.len().to_string(),"accepted":accepted,"receipts":receipts,"tool_results":tools,
            "terminals":terminals,"results":results,"response_finishes":response_finishes,
            "terminal_sequences":terminal_sequences,"result_sequences":result_sequences,
            "provider_stage":p.provider_stage,"provider_failed":p.provider_failed,
            "read_failure":*self.read_failure.lock().unwrap()})
    }
}

fn answer(task: usize) -> Vec<Value> {
    vec![
        json!({"type":"message","id":"answer","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":ANSWERS[task],"annotations":[{"private-native":"hidden"}]}]}),
    ]
}

async fn provider(
    mut wire: Wire,
    db: Database,
    proof: Arc<Mutex<Proof>>,
    mut drive: mpsc::Receiver<usize>,
    recovered: bool,
    mime: bool,
    (presentation, mutations, fixed_head): (bool, bool, bool),
) {
    let diagnostic = proof.lock().unwrap().diagnostic.clone();
    let mut prior = vec![];
    let mut old_key = Value::Null;
    for task in 0..if mutations { 1 } else { 2 } {
        let mut context = prior.clone();
        let calls = if presentation {
            presentation::calls(task)
        } else {
            vec![call("add-雪", "add_numbers", ARGUMENTS[task])]
        };
        let answer = if presentation {
            presentation::answer(task)
        } else {
            answer(task)
        };
        let task_text = if presentation {
            presentation::text("user")
        } else {
            TASKS[task].into()
        };
        let parent = format!("task-{task}-tools");
        let final_id = format!("task-{task}-final");
        let mut key = Value::Null;
        let mut run_id = None;
        for turn in 0..2 {
            proof.lock().unwrap().provider_stage = Some("request");
            let body = wire.receive().await;
            {
                let mut p = proof.lock().unwrap();
                p.requests += 1;
                if turn == 0 || wire.transport == Transport::Sse {
                    p.connections += 1;
                }
            }
            proof.lock().unwrap().provider_stage = Some("request_records");
            let records = db.records().await;
            let runs: Vec<_> = records
                .iter()
                .filter_map(|e| {
                    if let StoredEventPayload::RunAccepted(run) = e.payload() {
                        Some(run)
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(runs.len(), task + 1);
            let run = runs[task];
            run_id = Some(run.run_id().clone());
            let prepared = run.input();
            let prompt: Value = serde_json::from_str(&prepared.prepared_request().prompt).unwrap();
            assert!(prepared.user_text() == task_text && prompt["task"] == task_text);
            assert!(prompt["project_instructions"]["text"] == "private-project-browser\r\n");
            assert!(prepared.active_skills().is_empty());
            assert!(
                prepared
                    .tool_definitions()
                    .iter()
                    .any(|d| d.name == "add_numbers")
            );
            if turn == 0 {
                context.push(user(&prepared.prepared_request().prompt));
                assert_request(&body, &context, None, prepared);
                assert!(body.get("previous_response_id").is_none());
                key = body["prompt_cache_key"].clone();
                assert!(key.is_string() && key != old_key);
                let selected = records
                    .iter()
                    .find_map(|e| match e.payload() {
                        StoredEventPayload::RunHistorySelected(s) if s.run_id() == run.run_id() => {
                            Some(s)
                        }
                        _ => None,
                    })
                    .unwrap();
                let mut p = proof.lock().unwrap();
                p.fresh_parents += 1;
                if task == 0 {
                    assert!(prior.is_empty() && selected.selection().expected_identity().is_none());
                    if !presentation {
                        assert_eq!(
                            selected.selection().through_sequence(),
                            if fixed_head { 67 } else { 1 }
                        );
                    }
                    assert!(selected.selection().through_sequence() >= 1);
                    p.fresh_empty = true;
                } else {
                    assert!(
                        !prior.is_empty() && selected.selection().expected_identity().is_some()
                    );
                    p.restored_history = true;
                }
            } else {
                assert!(body["prompt_cache_key"] == key);
                let tools: Vec<_> = records
                    .iter()
                    .filter_map(|e| match e.payload() {
                        StoredEventPayload::ToolResultRecorded(r)
                            if e.run_id() == Some(run.run_id()) =>
                        {
                            Some(r)
                        }
                        _ => None,
                    })
                    .collect();
                let expected_tools = if presentation {
                    presentation::outputs(task)
                } else {
                    vec![("add-雪", OUTPUTS[task].into(), false)]
                };
                assert_eq!(tools.len(), expected_tools.len());
                let mut results = vec![];
                for (tool, (id, text, is_error)) in tools.iter().zip(expected_tools) {
                    assert!(
                        tool.call_id() == id
                            && tool.output() == text
                            && tool.is_error() == is_error
                    );
                    results.push(output(tool.call_id(), tool.output()));
                }
                context.extend(calls.clone());
                context.extend(results.clone());
                let expected = if wire.transport == Transport::WebSocket {
                    results
                } else {
                    context.clone()
                };
                assert_request(
                    &body,
                    &expected,
                    (wire.transport == Transport::WebSocket).then_some(parent.as_str()),
                    prepared,
                );
                proof.lock().unwrap().continuations += 1;
            }
            let gate = if presentation {
                task * 6 + turn * 3 + 1
            } else {
                task * 2 + turn + 1
            };
            let cursor = if presentation {
                presentation::ordinary_cursor(gate, &records, diagnostic.as_deref())
            } else {
                None
            };
            if let Some(trace) = presentation::gate_trace(diagnostic.as_deref(), gate) {
                // Reuse the already validated request records, not a new gate10 history query.
                trace.bind_prefix(&records, &final_id);
            }
            {
                let mut p = proof.lock().unwrap();
                p.prepared_exact += 1;
                p.gate = Some(gate);
            }
            emit(json!({"event":"model_paused","gate":gate}));
            assert_eq!(watch(drive.recv()).await, Some(gate));
            let trace = presentation::gate_trace(diagnostic.as_deref(), gate);
            if let Some(trace) = trace {
                trace.consumed();
            }
            let (id, items) = if turn == 0 {
                (parent.as_str(), calls.clone())
            } else {
                (final_id.as_str(), answer.clone())
            };
            let mut reply = events(id, items.clone(), recovered);
            if presentation {
                let mut partial = vec![reply.remove(0)];
                partial.extend(presentation::partial(id, task, turn));
                presentation::reply(&mut wire, &db, id, partial, trace, cursor).await;
                proof.lock().unwrap().gate = Some(gate + 1);
                if let Some(collector) = trace.and_then(|t| t.latency.as_ref()) {
                    collector.freeze();
                }
                if let Some(trace) = trace {
                    trace.gate(0);
                    trace.gate(1);
                }
                emit(json!({"event":"model_paused","gate":gate + 1}));
                if let Some(trace) = trace {
                    trace.gate(2);
                }
                assert_eq!(watch(drive.recv()).await, Some(gate + 1));
                // Keep item replacement observable before response authority and tool execution.
                wire.reply(presentation::done(id, &items), None).await;
                proof.lock().unwrap().gate = Some(gate + 2);
                emit(json!({"event":"model_paused","gate":gate + 2}));
                assert_eq!(watch(drive.recv()).await, Some(gate + 2));
            } else if turn == 1 {
                // Real deltas precede the authoritative output. They are never a second answer.
                reply.insert(1, json!({"type":"response.output_item.added","response_id":id,"output_index":0,
                    "item":{"type":"message","id":"answer","role":"assistant","status":"in_progress","content":[]}}));
                reply.insert(2, json!({"type":"response.output_text.delta","response_id":id,"item_id":"answer",
                    "output_index":0,"content_index":0,"delta":ANSWERS[task].split('\r').next().unwrap()}));
                if mutations {
                    // Let Chromium apply the real provisional text before the final snapshot.
                    let terminal = reply.split_off(3);
                    presentation::reply(&mut wire, &db, id, reply, None, None).await;
                    reply = terminal;
                    proof.lock().unwrap().gate = Some(3);
                    emit(json!({"event":"model_paused","gate":3}));
                    assert_eq!(watch(drive.recv()).await, Some(3));
                }
            }
            proof.lock().unwrap().provider_stage = Some("reply");
            wire.reply(reply, mime.then_some("text/event-stream")).await;
        }
        proof.lock().unwrap().provider_stage = Some("close");
        wire.closed().await;
        proof.lock().unwrap().provider_stage = Some("final_records");
        let records = watch(async {
            loop {
                let records = db.records().await;
                if records.iter().any(|e| {
                    e.run_id() == run_id.as_ref()
                        && matches!(e.payload(), StoredEventPayload::RunResultRecorded(_))
                }) {
                    break records;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        proof.lock().unwrap().provider_stage = Some("saved_fidelity");
        let command = json!({"run_id":run_id.as_ref().unwrap()});
        super::fidelity::assert_saved(
            &records,
            &command,
            &[
                (parent.as_str(), calls),
                (final_id.as_str(), answer.clone()),
            ],
            recovered,
        );
        proof.lock().unwrap().provider_stage = Some("saved_summary");
        let result = records
            .iter()
            .find_map(|e| match e.payload() {
                StoredEventPayload::RunResultRecorded(result) if e.run_id() == run_id.as_ref() => {
                    Some(result)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(result.summary.model_requests_attempted, 2);
        assert_eq!(result.summary.model_requests_admitted, 2);
        let tool_count = if presentation { 3 } else { 1 };
        assert_eq!(result.summary.new_tool_dispatches, tool_count);
        assert_eq!(result.summary.tool_results_prepared, tool_count);
        assert_eq!(result.summary.reused_results, 0);
        let expected_text = if presentation {
            presentation::answer_text(task)
        } else {
            ANSWERS[task].into()
        };
        assert!(result.last_response.as_ref().unwrap().text == expected_text);
        context.extend(answer);
        prior = context;
        old_key = key;
        proof.lock().unwrap().completed += 1;
        emit(json!({"event":"task_finished","task":task + 1}));
    }
    // Keep the listener owned until Stop and reject an accidental new task/retry.
    proof.lock().unwrap().provider_stage = Some("finished");
    let (tcp, _) = wire.listener.accept().await.unwrap();
    assert!(
        proof.lock().unwrap().mismatch_armed,
        "unexpected provider connection"
    );
    account_mismatch::socket(tcp).await;
    {
        let mut p = proof.lock().unwrap();
        p.connections += 1;
        p.mismatch_closed = true;
    }
    let _ = wire.listener.accept().await;
    panic!("unexpected provider connection");
}

#[tokio::test]
async fn independent_reader_keeps_connection_not_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let created = store
        .create_session(
            CreateSession::new(OperationId::new(), "reader fixture".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let sid = created.session_id().clone();
    let session = store.open_session(sid.clone()).await.unwrap();
    let db = Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    db.open(sid).await;
    for sequence in 2..=4 {
        let pause = Arc::new(Pause::default());
        session
            .test_hooks()
            .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
        let writer = session.clone();
        let rename = tokio::spawn(async move {
            writer
                .rename(OperationId::new(), "next fixture title".into())
                .await
                .unwrap()
        });
        watch(pause.reached.notified()).await;
        assert_eq!(db.records().await.last().unwrap().sequence(), sequence - 1);
        assert!(db.receipts().await.is_empty());
        pause.release.notify_one();
        watch(rename).await.unwrap();
        assert_eq!(db.records().await.last().unwrap().sequence(), sequence);
    }
    assert!(db.read_failure.lock().unwrap().is_none());
    store.close().await.unwrap();
    let mut reader = db.reader.lock().await.take().unwrap();
    let busy: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(busy, 0);
    reader.close().await.unwrap();
    temp.close().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "private stdin-controlled Chromium fixture; not an ordinary test"]
async fn child() {
    // Even a failed wire assertion must never print request bodies or credentials.
    std::panic::set_hook(Box::new(|_| eprintln!("browser_fixture.failure")));
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());
    if restart::selected() {
        restart::child(&mut input).await;
        return;
    }
    let start: Start = control(&mut input).await;
    start.validate();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "private-project-browser\r\n").unwrap();
    skill(
        &workspace.join(".agents/skills/synthetic"),
        "synthetic",
        "private-skill-browser\r\n",
    );
    if start.presentation {
        assert!(start.transport == Transport::WebSocket && !start.recovered && start.mime);
        presentation::setup(&workspace);
    }
    std::fs::create_dir(temp.path().join("private-skills")).unwrap();
    let token = temp.path().join("owner");
    std::fs::write(&token, &start.owner).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let wire = Wire::new(start.transport).await;
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let mut adapter = OpenAiCodexProvider::loopback(
        auth.clone(),
        start.transport,
        wire.listener.local_addr().unwrap(),
    );
    // Keep an accidental fallback on loopback too; neither endpoint may contact a live provider.
    adapter.websocket_endpoint = format!(
        "ws://{}/codex/responses",
        wire.listener.local_addr().unwrap()
    );
    adapter.sse_endpoint = format!(
        "http://{}/codex/responses",
        wire.listener.local_addr().unwrap()
    );
    // Browser-controlled pauses need more time than the small adapter component tests.
    adapter.timeouts.idle = Duration::from_secs(30);
    adapter.timeouts.total = Duration::from_secs(60);
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(adapter)).unwrap();
    let root = temp.path().join("private-data");
    let store = SessionStore::open(root.clone()).await.unwrap();
    // An unrelated metadata-only seed exposes the existing store-wide private hook.
    // The browser creates its own session and all task/replay records through HTTP.
    let seed = store
        .create_session(
            CreateSession::new(OperationId::new(), "Fixture barrier seed".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let hooks = store
        .open_session(seed.session_id().clone())
        .await
        .unwrap()
        .test_hooks();
    let db = Database {
        root: root.clone(),
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    // Legacy seeding must finish before the store enters the host or HTTP starts.
    let unbound = if start.unbound_history {
        Some(unbound_history::Audit::seed(&store, &db, &workspace, seed.session_id()).await)
    } else {
        None
    };
    let mut fixed = if start.fixed_head {
        Some(fixed_head::Audit::seed(&store, &db, &workspace, seed.session_id()).await)
    } else {
        None
    };
    let host = RunHost::new(store, Arc::new(gateway)).unwrap();
    let lifecycle_client = host.client();
    let mut lifecycle_audit = start
        .lifecycle_failure
        .then(lifecycle_failure::Audit::default);
    let mut cancellation_audit = start.cancellation.then(cancellation::Audit::default);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut options = SessionOptions::new(MODEL);
    options.transport = start.transport;
    options.instructions = INSTRUCTIONS.into();
    let mut workspaces = vec![workspace.clone()];
    if start.mutations {
        assert!(
            !start.presentation
                && start.transport == Transport::WebSocket
                && !start.recovered
                && start.mime
        );
        let second = temp.path().join("workspace-other");
        std::fs::create_dir(&second).unwrap();
        workspaces.push(second);
    }
    let mut settings = ApiSettings::new(
        &origin,
        workspaces,
        temp.path().join("private-skills"),
        PROVIDER_ID.into(),
        options,
        true,
    )
    .unwrap();
    let inert_tool = Arc::new(tool_fidelity::InertTool::default());
    let mut tool_audit = start.tool_fidelity.then(tool_fidelity::Audit::default);
    if start.tool_fidelity {
        settings.set_test_tool(inert_tool.clone());
    }
    // Match the authenticated selector order, not the fixture's directory setup order.
    let mut mutation_audit = if start.mutations && !start.unbound_history && !start.fixed_head {
        Some(mutations::Audit::open(root.clone(), settings.workspaces().to_vec()).await)
    } else {
        None
    };
    let stop = CancellationToken::new();
    let config = ApiConfig::new(settings, OwnerToken::load(&token).unwrap());
    let server = tokio::spawn(serve(listener, host, config, stop.clone()));
    let proof = Arc::new(Mutex::new(Proof::default()));
    let mut diagnostic = presentation::new_trace(start.gate11_diagnostics);
    if let Some(trace) = diagnostic.as_mut() {
        Arc::get_mut(trace).unwrap().polling = start.final_polling;
    }
    if start.native_latency {
        Arc::get_mut(diagnostic.as_mut().unwrap()).unwrap().latency = Some(hooks.enable_latency());
    }
    proof.lock().unwrap().diagnostic = diagnostic.clone();
    let (drive, driven) = mpsc::channel(1);
    let provider_db = db.clone();
    let provider_proof = proof.clone();
    let mut provider = tokio::spawn(async move {
        if start.unbound_history {
            // Reject even a TCP connection, before an HTTP request or WebSocket upgrade.
            let _ = wire.listener.accept().await.unwrap();
            provider_proof.lock().unwrap().connections += 1;
            panic!("unbound-history unexpected provider connection");
        }
        if start.cancellation {
            cancellation::provider(wire, provider_db, provider_proof).await;
            return;
        }
        if start.lifecycle_failure {
            lifecycle_failure::provider(wire, provider_db, provider_proof, driven).await;
            return;
        }
        if start.tool_fidelity {
            tool_fidelity::provider(wire, provider_db, provider_proof, driven).await;
            return;
        }
        provider(
            wire,
            provider_db,
            provider_proof,
            driven,
            start.recovered,
            start.mime,
            (start.presentation, start.mutations, start.fixed_head),
        )
        .await;
    });
    let mut pause: Option<Arc<Pause>> = None;
    let mut provider_done = false;
    let mut framing_seeded = false;
    let mut replay_head = replay_head::Gate::default();
    let mut acceptance_unknown = acceptance_unknown::Gate::default();
    let mut acceptance_warning = acceptance_warning::Gate::default();
    let mut account_mismatch = account_mismatch::Gate::default();
    let mut incompatible_mismatch_control = false;
    let mut last_control_id = start.id;
    let mut latency_page = 0;
    let mut other_task_control = false;
    let mut ready = json!({"id":start.id,"event":"ready","origin":origin});
    if let Some(audit) = &unbound {
        ready["session_id"] = json!(audit.session_id());
    }
    if let Some(audit) = &fixed {
        ready["session_id"] = json!(audit.session_id());
    }
    emit(ready);
    let result = AssertUnwindSafe(async {
        loop {
            let command: Control = tokio::select! {
                command = control(&mut input) => command,
                _ = &mut provider, if !provider_done => {
                    // Keep inspection alive after failure; Stop still fails this fixture.
                    provider_done = true;
                    proof.lock().unwrap().provider_failed = true;
                    continue;
                },
            };
            assert!(
                command.id() > last_control_id,
                "fixture control order rejected"
            );
            last_control_id = command.id();
            if let Some(audit) = &mut cancellation_audit {
                audit.check_control(&command);
            } else {
                assert!(
                    !matches!(
                        command,
                        Control::ArmCancellation { .. }
                            | Control::WaitCancellationPending { .. }
                            | Control::WaitCancellation { .. }
                            | Control::ReleaseCancellation { .. }
                            | Control::InspectCancellation { .. }
                    ),
                    "fixture mode rejected"
                );
            }
            if let Some(audit) = &mut lifecycle_audit {
                audit.check_control(&command);
            } else {
                assert!(
                    !matches!(
                        command,
                        Control::ArmLifecycleFailure { .. }
                            | Control::WaitLifecycleFailure { .. }
                            | Control::ReleaseLifecycleFailure { .. }
                            | Control::InspectLifecycleFailure { .. }
                    ),
                    "fixture mode rejected"
                );
            }
            if let Some(audit) = &mut tool_audit {
                audit.check_control(&command);
            } else {
                assert!(
                    !matches!(command, Control::InspectToolFidelity { .. }),
                    "fixture mode rejected"
                );
            }
            if start.unbound_history {
                unbound_history::check_control(&command);
            }
            if let Some(audit) = &mut fixed {
                audit.check_control(&command);
            }
            account_mismatch.check_control(&command);
            if matches!(
                command,
                Control::ArmAcceptance { .. }
                    | Control::ArmAcceptanceUnknown { .. }
                    | Control::ArmAcceptanceWarning { .. }
                    | Control::ReplayHead { .. }
                    | Control::SeedInputFraming { .. }
            ) {
                incompatible_mismatch_control = true;
            }
            match command {
                Control::Select { id, session_id } => {
                    assert!(!acceptance_warning.armed);
                    let sid: ApplicationSessionId = session_id.parse().unwrap_or_else(|_| {
                        std::panic::panic_any(FixtureFailure::SelectionInvariant)
                    });
                    if fixed.is_none() {
                        db.open(sid).await;
                    }
                    emit(json!({"id":id,"event":"selected"}));
                }
                Control::ArmAcceptanceUnknown { id } => {
                    let selected = db.session.lock().unwrap().clone();
                    let selected_browser = selected
                        .as_ref()
                        .is_some_and(|sid| sid != seed.session_id())
                        && db.records().await.len() == 1;
                    acceptance_unknown.arm(
                        &hooks,
                        start.mutations,
                        selected_browser,
                        !other_task_control && !acceptance_warning.armed,
                    );
                    emit(json!({"id":id,"event":"acceptance_unknown_armed"}));
                }
                Control::ArmAcceptanceWarning { id } => {
                    let selected = db.session.lock().unwrap().clone();
                    let records = db.records().await;
                    let fresh = selected
                        .as_ref()
                        .is_some_and(|sid| sid != seed.session_id())
                        && records.len() == 1
                        && records[0].sequence() == 1
                        && matches!(records[0].payload(), StoredEventPayload::SessionCreated(_));
                    acceptance_warning.arm(
                        &hooks,
                        start.mutations,
                        fresh,
                        !other_task_control && !acceptance_unknown.armed,
                    );
                    emit(json!({"id":id,"event":"acceptance_warning_armed"}));
                }
                Control::RotateAccount { id } => {
                    account_mismatch
                        .arm(
                            &db,
                            &proof,
                            &auth,
                            start.mutations && !incompatible_mismatch_control,
                        )
                        .await;
                    emit(json!({"id":id,"event":"account_rotated"}));
                }
                Control::ArmAcceptance { id } => {
                    assert!(
                        pause.is_none() && !acceptance_unknown.armed && !acceptance_warning.armed
                    );
                    other_task_control = true;
                    let gate = Arc::new(Pause::default());
                    hooks.arm_record(
                        Record::Acceptance,
                        Point::BeforeCommit,
                        Action::Pause(gate.clone()),
                    );
                    pause = Some(gate);
                    emit(json!({"id":id,"event":"armed"}));
                }
                Control::WaitAcceptance { id } => {
                    assert!(!acceptance_warning.armed);
                    watch(pause.as_ref().unwrap().reached.notified()).await;
                    emit(json!({"id":id,"event":"acceptance_paused"}));
                }
                Control::ReleaseAcceptance { id } => {
                    assert!(!acceptance_warning.armed);
                    pause.take().unwrap().release.notify_one();
                    emit(json!({"id":id,"event":"released"}));
                }
                Control::Drive { id, gate } => {
                    assert!(!acceptance_warning.armed);
                    other_task_control = true;
                    assert_eq!(proof.lock().unwrap().gate.take(), Some(gate));
                    if let Some(trace) = presentation::gate_trace(diagnostic.as_deref(), gate) {
                        trace.admit();
                    }
                    drive.send(gate).await.unwrap();
                    emit(json!({"id":id,"event":"driven"}));
                }
                Control::Gate11Latency { id, page } => {
                    assert!(page <= 33 && usize::from(page) == latency_page);
                    latency_page += 1;
                    if let Some(collector) = diagnostic.as_ref().and_then(|t| t.latency.as_ref()) {
                        collector.freeze();
                        let state = collector.capture_state();
                        if state == "captured" {
                            let (pages, rows) = collector.page(usize::from(page)).expect("fixture latency page rejected");
                            emit(json!({"id":id.get(),"event":"gate11_latency","state":state,"page":page,"pages":pages,"rows":rows}));
                        } else {
                            emit(json!({"id":id.get(),"event":"gate11_latency","state":state,"page":page,"pages":0,"rows":[]}));
                        }
                    } else {
                        emit(json!({"id":id.get(),"event":"gate11_latency","state":"disabled","page":page,"pages":0,"rows":[]}));
                    }
                }
                Control::Gate11Diagnostic { id } => {
                    // In-memory only. A failed provider must not enter inspect's SQL/assertions.
                    if let Some(trace) = &diagnostic {
                        emit(trace.snapshot(id.get()));
                    } else {
                        emit(json!({"id":id.get(),"event":"gate11_diagnostic","state":"disabled","trace":null}));
                    }
                }
                Control::Inspect { id } => {
                    if let Some(audit) = &fixed {
                        emit(audit.inspect(&db, id, &proof, &auth).await);
                    } else if let Some(audit) = &unbound {
                        emit(audit.inspect(&db, id, &proof, &auth).await);
                    } else {
                        emit(db.inspect(id, &proof, &auth).await);
                    }
                }
                Control::ArmCancellation { id } => {
                    cancellation_audit
                        .as_mut()
                        .unwrap()
                        .arm(&db, &hooks, seed.session_id())
                        .await;
                    emit(json!({"id":id,"event":"cancellation_armed"}));
                }
                Control::WaitCancellationPending { id, .. } => {
                    emit(
                        cancellation_audit
                            .as_mut()
                            .unwrap()
                            .pending(&db, &lifecycle_client, &proof, id.get())
                            .await,
                    );
                }
                Control::WaitCancellation { id } => {
                    emit(
                        cancellation_audit
                            .as_mut()
                            .unwrap()
                            .wait(&db, &lifecycle_client, &proof, id.get())
                            .await,
                    );
                }
                Control::ReleaseCancellation { id, .. } => {
                    cancellation_audit
                        .as_mut()
                        .unwrap()
                        .release(&lifecycle_client)
                        .await;
                    emit(json!({"id":id,"event":"cancellation_released"}));
                }
                Control::InspectCancellation { id } => {
                    emit(
                        cancellation_audit
                            .as_mut()
                            .unwrap()
                            .inspect(&db, &proof, &auth, id.get())
                            .await,
                    );
                }
                Control::ArmLifecycleFailure { id } => {
                    lifecycle_audit
                        .as_mut()
                        .unwrap()
                        .arm(&db, &hooks, seed.session_id())
                        .await;
                    emit(json!({"id":id,"event":"lifecycle_failure_armed"}));
                }
                Control::WaitLifecycleFailure {
                    id,
                    session_id,
                    run_id,
                    operation_id,
                } => {
                    emit(
                        lifecycle_audit
                            .as_mut()
                            .unwrap()
                            .wait(
                                &db,
                                &lifecycle_client,
                                id.get(),
                                session_id,
                                run_id,
                                operation_id,
                            )
                            .await,
                    );
                }
                Control::ReleaseLifecycleFailure { id, .. } => {
                    lifecycle_audit
                        .as_mut()
                        .unwrap()
                        .release(&lifecycle_client)
                        .await;
                    emit(json!({"id":id,"event":"lifecycle_failure_released"}));
                }
                Control::InspectLifecycleFailure { id } => {
                    emit(
                        lifecycle_audit
                            .as_ref()
                            .unwrap()
                            .inspect(&db, &proof, &auth, seed.session_id(), id.get())
                            .await,
                    );
                }
                Control::InspectToolFidelity { id } => {
                    emit(
                        tool_audit
                            .as_mut()
                            .unwrap()
                            .inspect(&db, id.get(), &proof, &inert_tool)
                            .await,
                    );
                }
                Control::InspectMutations { id } => {
                    emit(mutation_audit.as_mut().unwrap().inspect(id).await);
                }
                Control::InspectTask { id } => {
                    assert!(start.mutations);
                    if acceptance_warning.armed {
                        acceptance_warning::inspect_seed(&db.root, seed.session_id()).await;
                    }
                    if account_mismatch.armed {
                        acceptance_warning::inspect_seed(&db.root, seed.session_id()).await;
                        emit(account_mismatch.inspect(&db, id, &proof, &auth).await);
                    } else {
                        let evidence = task::inspect(&db, id).await;
                        if evidence["run_state"] == "completed" && !incompatible_mismatch_control {
                            acceptance_warning::inspect_seed(&db.root, seed.session_id()).await;
                            account_mismatch.capture(&db).await;
                        }
                        emit(evidence);
                    }
                }
                Control::SeedInputFraming { id } => {
                    assert!(
                        start.mutations
                            && !framing_seeded
                            && !acceptance_warning.armed
                            && !acceptance_unknown.armed
                            && db.session.lock().unwrap().is_none()
                    );
                    emit(input_framing::seed(
                        &workspace,
                        temp.path().join("private-skills"),
                        id,
                    ));
                    framing_seeded = true;
                    other_task_control = true;
                }
                Control::ReplayHead { id, step } => {
                    assert!(
                        start.mutations
                            && pause.is_none()
                            && !acceptance_warning.armed
                            && !acceptance_unknown.armed
                            && db.session.lock().unwrap().is_some()
                    );
                    other_task_control = true;
                    let step = replay_head.apply(step, &hooks).await;
                    emit(json!({"id":id,"event":"replay_head","step":step}));
                }
                Control::Stop { id } => break id,
            }
        }
    })
    .catch_unwind()
    .await;
    if let Err(payload) = &result {
        emit_failure(
            &mut std::io::stdout().lock(),
            caught_failure(payload.as_ref()),
        );
    }
    if let Some(pause) = pause {
        pause.release.notify_one();
    }
    drop(replay_head);
    drop(lifecycle_audit);
    drop(cancellation_audit);
    if !provider_done {
        provider.abort();
        let _ = provider.await;
    }
    stop.cancel();
    let outcome = watch(server).await.unwrap();
    assert!(outcome.http.is_ok() && matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
    if let Some(reader) = db.reader.lock().await.take() {
        reader.close().await.unwrap();
    }
    if let Some(audit) = mutation_audit {
        audit.close().await;
    }
    temp.close().unwrap();
    assert!(!provider_done, "provider fixture stopped early");
    match result {
        Ok(id) => emit(json!({"id":id,"event":"stopped","cleaned":true})),
        Err(_) => panic!("browser fixture control failed"),
    }
}
