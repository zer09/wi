//! Private fixed-head evidence. Raw rows, hashes and identities never leave Rust.
use super::*;
use crate::storage::{AppendRunRecord, CommitReceipt, SessionHandle};
use sqlx::{Column, TypeInfo, ValueRef, sqlite::SqliteRow};

#[path = "fixed_head/tests.rs"]
mod tests;

const TITLE: &str = "Fixed head 65";
const RENAMED: &str = "Fixed head renamed 雪 <em>inert</em>";
fn checked<T, E>(value: std::result::Result<T, E>) -> T {
    value.unwrap_or_else(|_| panic!("fixed-head evidence rejected"))
}
fn value(input: &impl serde::Serialize) -> Value {
    checked(serde_json::to_value(input))
}
fn decode(raw: &Value) -> Value {
    checked(serde_json::from_str(
        raw.as_str().expect("fixed-head text rejected"),
    ))
}
fn hash(raw: &str) -> Value {
    value(&ring::digest::digest(&ring::digest::SHA256, raw.as_bytes()).as_ref())
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
                        _ => panic!("fixed-head column rejected"),
                    }
                };
                fields.insert(column.name().into(), field);
            }
            Value::Object(fields)
        })
        .collect()
}
#[derive(Clone, PartialEq)]
struct Snapshot {
    events: Vec<Value>,
    commands: Vec<Value>,
    runs: Vec<Value>,
    tools: Vec<Value>,
    manifest: Vec<Value>,
    creations: Vec<Value>,
    catalog: Vec<Value>,
}
async fn snapshot(db: &Database) -> Snapshot {
    let mut reader = db.reader.lock().await;
    let mut sql = checked(reader.as_mut().unwrap().begin().await);
    let mut state = Snapshot {
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
        creations: vec![],
        catalog: vec![],
    };
    checked(sql.rollback().await);
    let mut catalog = checked(
        SqliteConnectOptions::new()
            .filename(db.root.join("catalog.sqlite3"))
            .read_only(true)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging()
            .connect()
            .await,
    );
    state.creations = rows(checked(
        sqlx::query("SELECT * FROM creation_commands ORDER BY session_id")
            .fetch_all(&mut catalog)
            .await,
    ));
    state.catalog = rows(checked(
        sqlx::query("SELECT * FROM sessions ORDER BY session_id")
            .fetch_all(&mut catalog)
            .await,
    ));
    checked(catalog.close().await);
    state
}

pub(super) struct Audit {
    session: SessionHandle,
    seed: ApplicationSessionId,
    workspace: String,
    baseline: Snapshot,
    selected: bool,
    next_gate: usize,
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
        let workspace = checked(workspace.canonicalize())
            .to_str()
            .unwrap()
            .to_owned();
        let created = checked(
            store
                .create_session(checked(CreateSession::new(
                    OperationId::new(),
                    "Fixed head 0".into(),
                    Some(workspace.clone()),
                )))
                .await,
        );
        let session = checked(store.open_session(created.session_id().clone()).await);
        db.open(created.session_id().clone()).await;
        for index in 1..=65 {
            let renamed = checked(
                session
                    .rename(OperationId::new(), format!("Fixed head {index}"))
                    .await,
            );
            assert!(!renamed.duplicate() && renamed.cleanup_warning().is_none());
            assert!(
                renamed.receipt().first_sequence() == index + 1
                    && renamed.receipt().last_sequence() == index + 1
            );
        }
        checked(session.refresh_catalog().await);
        let baseline = snapshot(db).await;
        audit(&baseline, None, created.session_id(), &workspace, seed);
        acceptance_warning::inspect_seed(&db.root, seed).await;
        Self {
            session,
            seed: seed.clone(),
            workspace,
            baseline,
            selected: false,
            next_gate: 1,
        }
    }
    pub(super) fn check_control(&mut self, control: &Control) {
        match control {
            Control::Select { session_id, .. } => {
                assert!(
                    !self.selected && session_id == self.session_id().as_str(),
                    "fixed-head selection rejected"
                );
                self.selected = true;
            }
            Control::Drive { gate, .. } => {
                assert!(
                    self.selected && *gate == self.next_gate && *gate <= 3,
                    "fixed-head drive rejected"
                );
                self.next_gate += 1;
            }
            Control::Inspect { .. } | Control::Stop { .. } => (),
            _ => panic!("fixed-head control rejected"),
        }
    }
    pub(super) async fn inspect(
        &self,
        db: &Database,
        id: u32,
        proof: &Mutex<Proof>,
        auth: &CountedAuth,
    ) -> Value {
        let state = snapshot(db).await;
        let head = audit(
            &state,
            Some(&self.baseline),
            self.session_id(),
            &self.workspace,
            &self.seed,
        );
        acceptance_warning::inspect_seed(&db.root, &self.seed).await;
        let p = proof.lock().unwrap();
        assert!(
            !p.provider_failed && !p.mismatch_armed && db.read_failure.lock().unwrap().is_none()
        );
        let complete = state
            .runs
            .first()
            .is_some_and(|r| r["state"] == "completed");
        let phase = if head == 66 {
            "initial"
        } else if complete {
            "completed"
        } else {
            "interleaved"
        };
        if head == 66 {
            assert!(p.connections == 0 && p.requests == 0 && p.completed == 0 && p.gate.is_none());
        } else if complete {
            assert!(
                p.connections == 1
                    && p.requests == 2
                    && p.completed == 1
                    && p.fresh_empty
                    && !p.restored_history
                    && p.fresh_parents == 1
                    && p.continuations == 1
                    && p.prepared_exact == 2
            );
        } else {
            assert!(
                p.connections == 1
                    && p.requests == 1
                    && p.completed == 0
                    && p.gate == Some(1)
                    && head > 69
            );
        }
        let opened = usize::from(head > 66);
        assert!(
            auth.loads.load(Ordering::SeqCst) == opened
                && auth.prepares.load(Ordering::SeqCst) == opened
        );
        json!({"id":id,"event":"fixed_head_inspect","session_id":self.session_id(),"phase":phase,
            "exact":true,"prefix_unchanged":true,"sequence_count":head.to_string(),"seed_head":"1",
            "renames":if head == 66 {65} else {66},"acceptances":opened,"selections":opened,"bindings":opened,
            "connections":p.connections,"requests":p.requests,"tools":state.tools.len(),"completed":complete,
            "auth_loads":opened,"auth_prepares":opened})
    }
}

fn audit(
    s: &Snapshot,
    baseline: Option<&Snapshot>,
    sid: &ApplicationSessionId,
    workspace: &str,
    seed: &ApplicationSessionId,
) -> usize {
    let head = s.events.len();
    assert!(
        (66..=128).contains(&head)
            && s.manifest.len() == 1
            && s.creations.len() == 2
            && s.catalog.len() == 2,
        "fixed-head counts rejected"
    );
    if let Some(base) = baseline {
        assert!(
            s.events[..66] == base.events[..]
                && s.commands[..65] == base.commands[..]
                && s.creations == base.creations
                && s.catalog.iter().find(|r| r["session_id"] == seed.as_str())
                    == base
                        .catalog
                        .iter()
                        .find(|r| r["session_id"] == seed.as_str()),
            "fixed-head prefix changed"
        );
    }
    let manifest = &s.manifest[0];
    let mut ids = std::collections::HashSet::new();
    let records: Vec<StoredEvent> = s.events.iter().enumerate().map(|(index, row)| {
        let record: StoredEvent = checked(serde_json::from_value(json!({"schema_version":1,"application_session_id":sid,
            "sequence":row["sequence"],"event_id":row["event_id"],"event_type":row["event_type"],
            "event_version":row["event_version"],"created_at_ms":row["created_at_ms"],"run_id":row["run_id"],"payload":decode(&row["payload_json"])})));
        assert!(record.sequence() == (index + 1) as u64 && ids.insert(record.event_id().clone()), "fixed-head event rejected");
        match record.payload() {
            StoredEventPayload::RuntimeObserved(e) => assert!(row["source_event_id"] == e.event_id && row["source_sequence"] == e.sequence),
            _ => assert!(row["source_event_id"].is_null() && row["source_sequence"].is_null()),
        }
        record
    }).collect();
    let StoredEventPayload::SessionCreated(created) = records[0].payload() else {
        panic!("fixed-head creation rejected")
    };
    let provenance = created.creation_provenance();
    let creation = s
        .creations
        .iter()
        .find(|r| r["session_id"] == sid.as_str())
        .unwrap();
    let canonical =
        json!({"method":"create_session","title":"Fixed head 0","workspace":workspace}).to_string();
    assert!(
        created.title() == "Fixed head 0"
            && created.workspace() == Some(workspace)
            && provenance.request_json() == canonical
            && value(provenance.payload_hash()) == hash(&canonical)
            && provenance.session_id() == sid
            && provenance.receipt().session_id() == sid
            && provenance.receipt().run_id().is_none()
            && provenance.receipt().first_sequence() == 1
            && provenance.receipt().last_sequence() == 1
            && provenance.receipt().operation_id() == provenance.operation_id()
            && provenance.creation_event_id() == records[0].event_id()
            && provenance.created_at_ms() == records[0].created_at_ms()
            && creation["state"] == "accepted"
            && creation["command_id"] == value(provenance.operation_id())
            && creation["payload_hash"] == hash(&canonical)
            && creation["request_json"] == canonical
            && decode(&creation["receipt_json"]) == value(provenance.receipt())
            && creation["creation_event_id"] == value(records[0].event_id())
            && creation["created_at_ms"] == records[0].created_at_ms()
            && decode(&manifest["creation_provenance_json"]) == value(provenance),
        "fixed-head provenance rejected"
    );
    for (index, record) in records.iter().enumerate().take(head.min(67)).skip(1) {
        let title = if index == 66 {
            RENAMED.to_owned()
        } else {
            format!("Fixed head {index}")
        };
        assert!(
            record.event_type() == "session.renamed"
                && record.run_id().is_none()
                && decode(&s.events[index]["payload_json"]) == json!({"title":title}),
            "fixed-head rename rejected"
        );
    }
    let title = if head == 66 { TITLE } else { RENAMED };
    assert!(
        manifest["singleton"] == 1
            && manifest["schema_version"] == 2
            && manifest["format_version"] == 1
            && manifest["session_id"] == sid.as_str()
            && manifest["head_sequence"] == head
            && manifest["title"] == title
            && decode(&manifest["workspace_json"]) == workspace
            && manifest["created_at_ms"] == records[0].created_at_ms()
            && manifest["updated_at_ms"] == records[head - 1].created_at_ms(),
        "fixed-head manifest rejected"
    );
    let catalog = s
        .catalog
        .iter()
        .find(|r| r["session_id"] == sid.as_str())
        .unwrap();
    // Task writes do not refresh the catalog. The browser rename refreshes it at 67.
    assert!(
        catalog["title"] == title
            && catalog["head_sequence"] == head.min(67)
            && catalog["workspace_json"] == manifest["workspace_json"]
            && catalog["created_at_ms"] == manifest["created_at_ms"]
            && catalog["updated_at_ms"] == records[head.min(67) - 1].created_at_ms()
            && catalog["availability"] == "ready"
            && catalog["fault_code"].is_null()
            && catalog["last_run_id"].is_null()
            && catalog["last_run_state"].is_null(),
        "fixed-head catalog rejected"
    );
    assert!(
        s.catalog
            .iter()
            .filter(|r| r["session_id"] == seed.as_str()
                && r["head_sequence"] == 1
                && r["title"] == "Fixture barrier seed")
            .count()
            == 1
    );
    let mut operations = std::collections::HashSet::from([provenance.operation_id().clone()]);
    let mut last = 1usize;
    for command in &s.commands {
        let receipt: CommitReceipt =
            checked(serde_json::from_value(decode(&command["receipt_json"])));
        let first = receipt.first_sequence() as usize;
        let end = receipt.last_sequence() as usize;
        assert!(
            first == last + 1
                && end >= first
                && end <= head
                && receipt.session_id() == sid
                && value(receipt.operation_id()) == command["operation_id"]
                && operations.insert(receipt.operation_id().clone())
                && command["first_sequence"] == first
                && command["last_sequence"] == end,
            "fixed-head receipt rejected"
        );
        let batch = &records[first - 1..end];
        assert!(
            batch
                .iter()
                .all(|r| r.created_at_ms() == batch[0].created_at_ms())
        );
        let canonical = if first <= 67 {
            assert!(first == end && receipt.run_id().is_none() && command["method"] == "rename");
            json!({"method":"rename","session_id":sid,"title":decode(&s.events[first - 1]["payload_json"])["title"]})
        } else {
            let StoredEventPayload::RunAccepted(accepted) = records[67].payload() else { panic!("fixed-head acceptance rejected") };
            assert!(receipt.run_id() == Some(accepted.run_id()));
            if first == 68 {
                let StoredEventPayload::RunHistorySelected(selected) = records[68].payload() else { panic!("fixed-head selection rejected") };
                assert!(end == 69 && command["method"] == "accept_history_run");
                json!({"method":"accept_history_run","session_id":sid,"run_id":accepted.run_id(),"input":accepted.input(),"selection":selected.selection()})
            } else {
                assert!(command["method"] == "append_run_records");
                let appended: Vec<_> = batch.iter().map(|r| match r.payload() {
                    StoredEventPayload::RunProviderBound(v) => AppendRunRecord::ProviderBinding(v.clone()),
                    StoredEventPayload::RuntimeObserved(v) => AppendRunRecord::Runtime(v.clone()),
                    StoredEventPayload::ToolResultRecorded(v) => AppendRunRecord::ToolResult { request_id:v.request_id().map(str::to_owned),call_id:v.call_id().into(),output:v.output().into(),is_error:v.is_error() },
                    StoredEventPayload::RunResultRecorded(v) => AppendRunRecord::Result(v.clone()),
                    _ => panic!("fixed-head append rejected"),
                }).collect();
                json!({"method":"append_run_records","session_id":sid,"run_id":accepted.run_id(),"records":appended})
            }
        }.to_string();
        assert!(
            command["payload_hash"] == hash(&canonical),
            "fixed-head command hash rejected"
        );
        last = end;
    }
    assert!(last == head, "fixed-head command coverage rejected");
    if head == 66 {
        assert!(s.commands.len() == 65 && s.runs.is_empty() && s.tools.is_empty());
    } else {
        audit_run(s, &records);
    }
    head
}

fn audit_run(s: &Snapshot, records: &[StoredEvent]) {
    assert!(
        records.len() >= 72 && s.runs.len() == 1,
        "fixed-head run count rejected"
    );
    let StoredEventPayload::RunAccepted(accepted) = records[67].payload() else {
        panic!("fixed-head acceptance rejected")
    };
    let StoredEventPayload::RunHistorySelected(selected) = records[68].payload() else {
        panic!("fixed-head selection rejected")
    };
    let run = accepted.run_id();
    let selection = selected.selection();
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    digest.update(b"wi.history-prefix.v1\0");
    for row in &s.events[..67] {
        let mut raw = row.as_object().unwrap().clone();
        raw.remove("payload_json");
        raw.insert("payload".into(), decode(&row["payload_json"]));
        let bytes = Value::Object(raw).to_string().into_bytes();
        digest.update(&(bytes.len() as u64).to_be_bytes());
        digest.update(&bytes);
    }
    let digest: String = digest
        .finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(
        selected.run_id() == run
            && selection.through_sequence() == 67
            && selection.history_digest() == digest
            && selection.expected_identity().is_none()
            && selection.policy() == "closed-exchanges-v1"
            && selection.provider_id() == PROVIDER_ID
            && selection.requested_model() == MODEL
            && accepted.input().user_text() == TASKS[0]
            && accepted.input().prepared_request().provider_id == PROVIDER_ID
            && accepted.input().prepared_request().options.model == MODEL
            && records[67..].iter().all(|r| r.run_id() == Some(run)),
        "fixed-head private selection rejected"
    );
    let prompt: Value = checked(serde_json::from_str(
        &accepted.input().prepared_request().prompt,
    ));
    assert!(
        prompt["task"] == TASKS[0]
            && prompt["project_instructions"]["text"] == "private-project-browser\r\n"
    );
    let views: Vec<_> = records[67..]
        .iter()
        .map(|r| value(&crate::http_api::dto::EventView::from(r)))
        .collect();
    let kinds: Vec<_> = views.iter().map(|v| v["kind"].as_str().unwrap()).collect();
    let expected = [
        "run.accepted",
        "checkpoint",
        "run.started",
        "checkpoint",
        "turn.started",
        "response.started",
        "response.finished",
        "tool.started",
        "tool.result",
        "tool.finished",
        "turn.finished",
        "turn.started",
        "response.started",
        "response.item.started",
        "response.delta",
        "response.finished",
        "turn.finished",
        "run.finished",
        "run.result",
    ];
    assert!(
        kinds == expected[..kinds.len().min(expected.len())],
        "fixed-head runtime order rejected"
    );
    assert!(views[1]["data"] == json!({}) && views[3]["data"] == json!({}));
    let StoredEventPayload::RunProviderBound(binding) = records[70].payload() else {
        panic!("fixed-head binding rejected")
    };
    let credentials = checked(SubscriptionCredentials::from_access_token(
        TOKEN_A.into(),
        Some(ACCOUNT.into()),
        None,
    ));
    let identity = checked(crate::providers::openai_codex::replay::identity(
        &credentials,
    ));
    assert!(binding.identity() == &identity && binding.requested_model() == MODEL);
    let saved = &s.runs[0];
    let mut runtime_sequence = 0;
    let mut runtime_ids = std::collections::HashSet::new();
    let mut terminal = None;
    let mut result_sequence = None;
    for r in &records[69..] {
        if let StoredEventPayload::RuntimeObserved(e) = r.payload() {
            assert!(
                e.run_id == run.as_str()
                    && e.sequence == runtime_sequence + 1
                    && runtime_ids.insert(&e.event_id)
                    && (matches!(e.event, RunEvent::RunStarted)
                        || e.session_id.as_deref() == Some(binding.provider_session_id()))
            );
            runtime_sequence = e.sequence;
            if let RunEvent::RunFinished { outcome, .. } = &e.event {
                assert!(*outcome == RunOutcome::Completed);
                terminal = Some(r);
            }
        }
        if let StoredEventPayload::RunResultRecorded(result) = r.payload() {
            assert!(
                result_sequence.is_none()
                    && result.outcome == RunOutcome::Completed
                    && result.events_complete
                    && result.sink_error.is_none()
                    && result.run_id == run.as_str()
                    && result.session_id.as_deref() == Some(binding.provider_session_id())
            );
            let summary = &result.summary;
            assert!(
                [
                    summary.turns_started,
                    summary.turns_finished,
                    summary.model_requests_attempted,
                    summary.model_requests_admitted,
                    summary.new_tool_dispatches,
                    summary.tool_results_prepared,
                    summary.reused_results
                ] == [2, 2, 2, 2, 1, 1, 0]
            );
            let StoredEventPayload::RuntimeObserved(finished) = records[84].payload() else {
                panic!("fixed-head terminal rejected")
            };
            let RunEvent::RunFinished {
                summary: terminal_summary,
                ..
            } = &finished.event
            else {
                panic!("fixed-head terminal rejected")
            };
            let StoredEventPayload::RuntimeObserved(response) = records[82].payload() else {
                panic!("fixed-head response rejected")
            };
            let RunEvent::ProviderEvent { event } = &response.event else {
                panic!("fixed-head response rejected")
            };
            let ProviderEvent::ResponseFinished { response } = &event.event else {
                panic!("fixed-head response rejected")
            };
            assert!(
                value(terminal_summary) == value(summary)
                    && value(&result.last_response) == value(&Some(response)),
                "fixed-head result correlation rejected"
            );
            result_sequence = Some(r.sequence());
        }
    }
    let complete = result_sequence.is_some();
    assert!(
        saved["run_id"] == run.as_str()
            && saved["owner_instance_id"] == accepted.owner_instance_id().as_str()
            && saved["accepted_sequence"] == 68
            && saved["last_runtime_sequence"] == runtime_sequence
            && saved["provider_session_id"] == binding.provider_session_id()
            && saved["state"] == if complete { "completed" } else { "running" }
            && saved["terminal_sequence"] == value(&terminal.map(|r| r.sequence()))
            && saved["result_sequence"] == value(&result_sequence)
            && if let Some(r) = terminal {
                decode(&saved["terminal_json"]) == value(r)["payload"]
            } else {
                saved["terminal_json"].is_null()
            },
        "fixed-head run projection rejected"
    );
    if complete {
        assert!(kinds == expected && s.tools.len() == 1);
        let tool = &s.tools[0];
        let result = &records[75];
        let StoredEventPayload::ToolResultRecorded(output) = result.payload() else {
            panic!("fixed-head tool rejected")
        };
        assert!(
            output.call_id() == "add-雪" && output.output() == OUTPUTS[0] && !output.is_error()
        );
        assert!(
            tool["run_id"] == run.as_str()
                && tool["call_id"] == "add-雪"
                && tool["tool_name"] == "add_numbers"
                && tool["started_sequence"] == 75
                && tool["result_sequence"] == 76
                && tool["finished_sequence"] == 77
                && tool["request_id"] == value(&output.request_id())
                && tool["output"] == OUTPUTS[0]
                && tool["is_error"] == 0,
            "fixed-head tool projection rejected"
        );
        for (index, id, items, text) in [
            (
                73,
                "task-0-tools",
                vec![call("add-雪", "add_numbers", ARGUMENTS[0])],
                "",
            ),
            (82, "task-0-final", answer(0), ANSWERS[0]),
        ] {
            let StoredEventPayload::RuntimeObserved(envelope) = records[index].payload() else {
                panic!("fixed-head response rejected")
            };
            let RunEvent::ProviderEvent { event } = &envelope.event else {
                panic!("fixed-head response rejected")
            };
            let ProviderEvent::ResponseFinished { response } = &event.event else {
                panic!("fixed-head response rejected")
            };
            assert!(
                response.id == id
                    && response.text == text
                    && response.output_provenance == OutputProvenance::NativeTerminal
                    && response.native
                        == events(id, items.clone(), false).last().unwrap()["response"]
                    && response
                        .output
                        .iter()
                        .map(|item| item.native.clone())
                        .collect::<Vec<_>>()
                        == items,
                "fixed-head response fidelity rejected"
            );
        }
        assert!(
            views[6]["data"]["items"][0]["function_call"]["arguments"] == ARGUMENTS[0]
                && views[8]["data"]["request_id"] == views[7]["data"]["request_id"]
                && views[9]["data"]["request_id"] == views[7]["data"]["request_id"]
                && views[9]["data"]["is_error"] == false,
            "fixed-head tool correlation rejected"
        );
    } else {
        assert!(kinds.len() == 5 && s.tools.is_empty());
    }
}
