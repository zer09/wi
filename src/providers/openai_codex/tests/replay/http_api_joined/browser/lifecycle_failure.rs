//! One native-WS failure and one rolled-back final append. No success-fixture relaxation.
use super::*;
use crate::{run::RunResult, service::RunClient, storage::AppendRunRecord};

#[path = "lifecycle_failure/tests.rs"]
mod tests;

fn data() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/lifecycle-failure.json"
    )))
    .unwrap()
}
fn text(key: &str) -> String {
    data()[key].as_str().unwrap().to_owned()
}
#[track_caller]
fn checked<T, E>(value: std::result::Result<T, E>) -> T {
    match value {
        Ok(value) => value,
        Err(_) => panic!("lifecycle evidence rejected"),
    }
}
fn value(value: &impl serde::Serialize) -> Value {
    checked(serde_json::to_value(value))
}
fn calls() -> Vec<Value> {
    vec![call(&text("call_id"), "add_numbers", &text("arguments"))]
}

async fn gate(proof: &Mutex<Proof>, drive: &mut mpsc::Receiver<usize>, number: usize) {
    proof.lock().unwrap().gate = Some(number);
    emit(json!({"event":"model_paused","gate":number}));
    assert!(
        watch(drive.recv()).await == Some(number),
        "lifecycle gate rejected"
    );
}

pub(super) async fn provider(
    mut wire: Wire,
    db: Database,
    proof: Arc<Mutex<Proof>>,
    mut drive: mpsc::Receiver<usize>,
) {
    let body = wire.receive().await;
    let records = db.records().await;
    let accepted: Vec<_> = records
        .iter()
        .filter_map(|r| match r.payload() {
            StoredEventPayload::RunAccepted(a) => Some(a),
            _ => None,
        })
        .collect();
    assert!(accepted.len() == 1, "lifecycle acceptance rejected");
    let input = accepted[0].input();
    let prompt: Value = checked(serde_json::from_str(&input.prepared_request().prompt));
    assert!(input.user_text() == text("task") && prompt["task"] == text("task"));
    // Boolean assertions never put prepared/native bytes in a panic.
    let request_ok = |body: &Value, items: Vec<Value>, parent: Option<String>| {
        let tools: Vec<_> = input.tool_definitions().iter().map(|d| json!({"type":"function","name":d.name,"description":d.description,"parameters":d.parameters,"strict":d.strict})).collect();
        assert!(
            body["input"] == json!(items)
                && body["previous_response_id"] == json!(parent)
                && body["model"] == MODEL
                && body["store"] == false
                && body["type"] == "response.create"
                && body["instructions"] == input.prepared_request().options.instructions
                && body["tools"] == json!(tools)
                && body.get("stream").is_none(),
            "lifecycle request rejected"
        );
    };
    request_ok(&body, vec![user(&input.prepared_request().prompt)], None);
    assert!(body.get("previous_response_id").is_none() && body["prompt_cache_key"].is_string());
    let key = body["prompt_cache_key"].clone();
    {
        let mut p = proof.lock().unwrap();
        p.connections = 1;
        p.requests = 1;
        p.prepared_exact = 1;
        p.fresh_empty = true;
    }
    wire.reply(events(&text("first_response"), calls(), false), None)
        .await;
    let body = wire.receive().await;
    request_ok(
        &body,
        vec![output(&text("call_id"), &text("output"))],
        Some(text("first_response")),
    );
    assert!(body["prompt_cache_key"] == key && wire.requests == 2);
    {
        let mut p = proof.lock().unwrap();
        p.requests = 2;
        p.prepared_exact = 2;
    }
    // Request two can only arrive after the real tool result and first turn finish commit.
    let before = snapshot(&db).await;
    assert!(
        before.records.len() == 13
            && before.runs[0]["state"] == "running"
            && before.runs[0]["result_sequence"].is_null()
            && before.tools.len() == 1
    );
    gate(&proof, &mut drive, 1).await;
    wire.reply(vec![
        json!({"type":"response.created","response":{"id":text("second_response")}}),
        json!({"type":"response.output_item.added","response_id":text("second_response"),"output_index":0,
            "item":{"id":text("item_id"),"type":"message","role":"assistant","status":"in_progress","content":[]}}),
        json!({"type":"response.output_text.delta","response_id":text("second_response"),"item_id":text("item_id"),
            "output_index":0,"content_index":0,"delta":text("partial")}),
    ], None).await;
    watch(async {
        loop {
            if db.records().await.len() == 16 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    gate(&proof, &mut drive, 2).await;
    let socket = wire.websocket.as_mut().unwrap();
    checked(socket.send(Message::Close(None)).await);
    wire.closed().await;
    proof.lock().unwrap().completed = 1;
    // Keep detecting extra connections, including fallback, until fixture shutdown.
    let _ = wire.listener.accept().await;
    proof.lock().unwrap().connections += 1;
    panic!("lifecycle unexpected provider connection");
}

#[derive(Clone)]
struct Snapshot {
    records: Vec<StoredEvent>,
    runs: Vec<Value>,
    tools: Vec<Value>,
    commands: Vec<Value>,
    head: i64,
}
async fn snapshot(db: &Database) -> Snapshot {
    let records = db.records().await;
    let mut reader = db.reader.lock().await;
    let mut sql = checked(reader.as_mut().unwrap().begin().await);
    let mut rows = Vec::new();
    for query in [
        "SELECT json_object('run_id',run_id,'state',state,'accepted_sequence',accepted_sequence,'terminal_sequence',terminal_sequence,'result_sequence',result_sequence,'provider_session_id',provider_session_id) FROM runs ORDER BY accepted_sequence",
        "SELECT json_object('run_id',run_id,'call_id',call_id,'tool_name',tool_name,'request_id',request_id,'started_sequence',started_sequence,'result_sequence',result_sequence,'finished_sequence',finished_sequence,'is_error',is_error,'output',output) FROM tool_results ORDER BY started_sequence",
        "SELECT json_object('operation_id',operation_id,'method',method,'first_sequence',first_sequence,'last_sequence',last_sequence,'receipt',json(receipt_json),'hash',hex(payload_hash)) FROM commands ORDER BY first_sequence",
    ] {
        let raw: Vec<String> = checked(sqlx::query_scalar(query).fetch_all(&mut *sql).await);
        rows.push(
            raw.iter()
                .map(|s| checked(serde_json::from_str(s)))
                .collect(),
        );
    }
    let head = checked(
        sqlx::query_scalar("SELECT head_sequence FROM manifest WHERE singleton=1")
            .fetch_one(&mut *sql)
            .await,
    );
    checked(sql.rollback().await);
    let commands = rows.pop().unwrap();
    let tools = rows.pop().unwrap();
    let runs = rows.pop().unwrap();
    Snapshot {
        records,
        runs,
        tools,
        commands,
        head,
    }
}
fn unchanged(before: &Snapshot, after: &Snapshot) {
    assert!(
        value(&before.records) == value(&after.records)
            && before.runs == after.runs
            && before.tools == after.tools
            && before.commands == after.commands
            && before.head == after.head,
        "lifecycle prefix changed"
    );
}

#[derive(Clone)]
struct Fault {
    session: ApplicationSessionId,
    run: RunId,
    acceptance: OperationId,
    final_operation: OperationId,
    attempt: RunResult,
    hits: usize,
    rollback: bool,
}
fn audit(s: &Snapshot, f: &Fault) {
    assert!(
        s.head == 19
            && s.records.len() == 19
            && s.runs.len() == 1
            && s.tools.len() == 1
            && s.commands.len() == 17,
        "lifecycle counts rejected"
    );
    assert!(
        f.hits == 1
            && f.rollback
            && f.final_operation != f.acceptance
            && f.attempt.run_id == f.run.as_str(),
        "lifecycle fault identity rejected"
    );
    let views: Vec<_> = s
        .records
        .iter()
        .map(|r| value(&crate::http_api::dto::EventView::from(r)))
        .collect();
    let mut ids = std::collections::HashSet::new();
    let mut runtime_ids = std::collections::HashSet::new();
    let mut runtime = Vec::new();
    for (index, record) in s.records.iter().enumerate() {
        assert!(
            record.sequence() == index as u64 + 1
                && record.application_session_id() == &f.session
                && ids.insert(record.event_id())
                && views[index]["kind"] == data()["kinds"][index]
        );
        assert!(record.run_id() == if index == 0 { None } else { Some(&f.run) });
        if let StoredEventPayload::RuntimeObserved(e) = record.payload() {
            assert!(
                e.run_id == f.run.as_str()
                    && e.sequence == runtime.len() as u64 + 1
                    && runtime_ids.insert(&e.event_id)
            );
            runtime.push(e);
        }
    }
    let StoredEventPayload::RunAccepted(a) = s.records[1].payload() else {
        panic!("lifecycle acceptance missing")
    };
    assert!(a.run_id() == &f.run && a.input().user_text() == text("task"));
    let StoredEventPayload::RunHistorySelected(selection) = s.records[2].payload() else {
        panic!("lifecycle selection missing")
    };
    assert!(
        selection.run_id() == &f.run
            && selection.selection().through_sequence() == 1
            && selection.selection().expected_identity().is_none()
            && selection.selection().provider_id() == PROVIDER_ID
            && selection.selection().requested_model() == MODEL
    );
    let StoredEventPayload::RunProviderBound(binding) = s.records[4].payload() else {
        panic!("lifecycle binding missing")
    };
    let provider_session = binding.provider_session_id();
    assert!(f.attempt.session_id.as_deref() == Some(provider_session));
    for e in runtime.iter().skip(1) {
        assert!(e.session_id.as_deref() == Some(provider_session));
    }
    let first = &views[7]["data"];
    assert!(
        first["response_id"] == text("first_response")
            && first["outcome"]["status"] == "completed"
            && first["output_provenance"] == "native_terminal"
            && first["text"] == ""
            && first["items"].as_array().unwrap().len() == 1
            && first["items"][0]["function_call"]
                == json!({"call_id":text("call_id"),"name":"add_numbers","arguments":text("arguments"),"complete":true,"namespace":null,"origin":"direct"})
    );
    let StoredEventPayload::RuntimeObserved(envelope) = s.records[7].payload() else {
        unreachable!()
    };
    let RunEvent::ProviderEvent { event } = &envelope.event else {
        unreachable!()
    };
    let ProviderEvent::ResponseFinished { response } = &event.event else {
        unreachable!()
    };
    assert!(
        response.native
            == events(&text("first_response"), calls(), false)
                .last()
                .unwrap()["response"]
            && response
                .output
                .iter()
                .map(|i| i.native.clone())
                .collect::<Vec<_>>()
                == calls()
            && value(f.attempt.last_response.as_ref().unwrap()) == value(response)
    );
    let request = envelope.request_id.as_ref().unwrap();
    let second_request = runtime.last().unwrap().request_id.as_ref().unwrap();
    assert!(request != second_request);
    for (index, record) in s.records.iter().enumerate() {
        if let StoredEventPayload::RuntimeObserved(e) = record.payload() {
            if index == 3 {
                assert!(e.turn_id.is_none() && e.request_id.is_none());
                continue;
            }
            let turn = if index < 12 {
                &views[5]["data"]["turn_id"]
            } else {
                &views[12]["data"]["turn_id"]
            };
            if index == 18 {
                assert!(e.turn_id.is_none());
            } else {
                assert!(value(&e.turn_id) == *turn);
            }
            if [5, 12].contains(&index) {
                assert!(e.request_id.is_none());
            } else {
                assert!(
                    e.request_id.as_ref()
                        == Some(if index < 12 { request } else { second_request })
                );
            }
            if let RunEvent::ProviderEvent { event } = &e.event {
                assert!(
                    event.request_id == e.request_id
                        && event.session_id == provider_session
                        && event.provider == PROVIDER_ID
                );
            }
        }
    }
    for index in [8, 9, 10] {
        assert!(
            views[index]["data"]["request_id"] == *request
                && views[index]["data"]["call_id"] == text("call_id")
        );
    }
    assert!(
        views[8]["data"]["tool_name"] == "add_numbers"
            && views[10]["data"]["tool_name"] == "add_numbers"
            && views[9]["data"]["output"] == text("output")
            && views[9]["data"]["is_error"] == false
            && views[10]["data"]["is_error"] == false
    );
    assert!(
        s.tools[0]
            == json!({"run_id":f.run,"call_id":text("call_id"),"tool_name":"add_numbers","request_id":request,
        "started_sequence":9,"result_sequence":10,"finished_sequence":11,"is_error":0,"output":text("output")})
    );
    for (start, finish, number, response, outcome, upstream) in [
        (
            5,
            11,
            "1",
            text("first_response"),
            json!({"type":"tools_prepared"}),
            "terminal_received",
        ),
        (
            12,
            17,
            "2",
            text("second_response"),
            json!({"type":"stopped","reason":{"type":"failed","code":"provider_request_failed"}}),
            "unknown",
        ),
    ] {
        assert!(
            views[start]["data"]["number"] == number
                && views[finish]["data"]
                    == json!({"turn_id":views[start]["data"]["turn_id"],"number":number,
            "response_id":response,"outcome":outcome,"upstream_outcome":upstream})
        );
    }
    assert!(views[5]["data"]["turn_id"] != views[12]["data"]["turn_id"]);
    assert!(
        views[6]["data"] == json!({"response_id":text("first_response")})
            && views[13]["data"] == json!({"response_id":text("second_response")})
    );
    assert!(
        views[14]["data"]
            == json!({"response_id":text("second_response"),"output_index":"0","item":{
        "item_id":text("item_id"),"kind":"message","function_call":null,"content":[],"unsupported_content":false}})
    );
    assert!(
        views[15]["data"]
            == json!({"response_id":text("second_response"),"item_id":text("item_id"),"output_index":"0","content_index":"0","summary_index":null,"kind":"text","delta":text("partial")})
    );
    assert!(views[16]["data"] == json!({"code":"unexpected_end","upstream_outcome":"unknown"}));
    let summary = json!({"turns_started":"2","turns_finished":"2","model_requests_attempted":"2","model_requests_admitted":"2",
        "new_tool_dispatches":"1","tool_results_prepared":"1","reused_results":"0","last_request_id":second_request,"last_upstream_outcome":"unknown"});
    let outcome = json!({"type":"failed","code":"provider_request_failed"});
    assert!(
        views[18]["data"] == json!({"outcome":outcome,"summary":summary})
            && value(&crate::http_api::dto::SummaryView::from(&f.attempt.summary)) == summary
            && value(&crate::http_api::dto::OutcomeView::from(&f.attempt.outcome)) == outcome
            && f.attempt.events_complete
            && f.attempt.sink_error.is_none()
    );
    assert!(
        s.runs[0]
            == json!({"run_id":f.run,"state":"failed","accepted_sequence":2,"terminal_sequence":19,"result_sequence":null,"provider_session_id":provider_session})
    );
    let mut operations = std::collections::HashSet::new();
    for (index, command) in s.commands.iter().enumerate() {
        let first = if index == 0 { 2 } else { index + 3 };
        let last = if index == 0 { 3 } else { first };
        let operation: OperationId = checked(command["operation_id"].as_str().unwrap().parse());
        assert!(operations.insert(operation));
        let mut request = json!({"session_id":f.session,"run_id":f.run,"method":command["method"]});
        if index == 0 {
            request["input"] = value(a.input());
            request["selection"] = value(selection.selection());
        } else {
            let record = match s.records[first - 1].payload() {
                StoredEventPayload::RuntimeObserved(e) => AppendRunRecord::Runtime(e.clone()),
                StoredEventPayload::RunProviderBound(b) => {
                    AppendRunRecord::ProviderBinding(b.clone())
                }
                StoredEventPayload::ToolResultRecorded(t) => AppendRunRecord::ToolResult {
                    request_id: t.request_id().map(str::to_owned),
                    call_id: t.call_id().into(),
                    output: t.output().into(),
                    is_error: t.is_error(),
                },
                _ => panic!("lifecycle command rejected"),
            };
            request["records"] = json!([record]);
        }
        let digest = ring::digest::digest(&ring::digest::SHA256, request.to_string().as_bytes());
        let hex: String = digest.as_ref().iter().map(|b| format!("{b:02X}")).collect();
        assert!(command["hash"] == hex);
        assert!(
            command["first_sequence"] == first
                && command["last_sequence"] == last
                && command["method"]
                    == if index == 0 {
                        "accept_history_run"
                    } else {
                        "append_run_records"
                    }
                && command["operation_id"] != value(&f.final_operation)
                && command["receipt"]
                    == json!({"operation_id":command["operation_id"],"session_id":f.session,"run_id":f.run,"first_sequence":first,"last_sequence":last})
        );
    }
    assert!(s.commands[0]["operation_id"] == value(&f.acceptance));
}

async fn seed_snapshot(
    root: &Path,
    seed: &ApplicationSessionId,
    selected: &ApplicationSessionId,
) -> Vec<String> {
    let options = SqliteConnectOptions::new()
        .read_only(true)
        .busy_timeout(Duration::ZERO)
        .disable_statement_logging();
    let mut catalog = checked(
        options
            .clone()
            .filename(root.join("catalog.sqlite3"))
            .connect()
            .await,
    );
    let sessions: Vec<String> = checked(
        sqlx::query_scalar("SELECT session_id FROM sessions ORDER BY session_id")
            .fetch_all(&mut catalog)
            .await,
    );
    assert!(
        sessions.len() == 2
            && sessions.contains(&seed.to_string())
            && sessions.contains(&selected.to_string())
    );
    let creations: i64 = checked(
        sqlx::query_scalar("SELECT count(*) FROM creation_commands WHERE state='accepted'")
            .fetch_one(&mut catalog)
            .await,
    );
    let total: i64 = checked(
        sqlx::query_scalar("SELECT count(*) FROM creation_commands")
            .fetch_one(&mut catalog)
            .await,
    );
    assert!(creations == 2 && total == 2);
    checked(catalog.close().await);
    let mut reader = checked(
        options
            .filename(
                root.join("sessions")
                    .join(&seed.as_str()[..2])
                    .join(seed.as_str())
                    .join("session.sqlite3"),
            )
            .connect()
            .await,
    );
    let manifest: String = checked(sqlx::query_scalar("SELECT json_object('session_id',session_id,'title',title,'workspace_json',workspace_json,'created_at_ms',created_at_ms,'updated_at_ms',updated_at_ms,'head_sequence',head_sequence,'creation_provenance_json',creation_provenance_json) FROM manifest WHERE singleton=1").fetch_one(&mut reader).await);
    let event: String = checked(sqlx::query_scalar("SELECT json_object('sequence',sequence,'event_id',event_id,'event_type',event_type,'created_at_ms',created_at_ms,'payload',payload_json) FROM events WHERE sequence=1").fetch_one(&mut reader).await);
    checked(reader.close().await);
    acceptance_warning::inspect_seed(root, seed).await;
    vec![manifest, event]
}

#[derive(Default)]
pub(super) struct Audit {
    stage: usize,
    selected: Option<ApplicationSessionId>,
    pause: Option<Arc<Pause>>,
    fault: Option<Fault>,
    prefix: Option<Snapshot>,
    fresh: Option<StoredEvent>,
    seed_evidence: Option<Vec<String>>,
    retired: bool,
}
impl Audit {
    pub(super) fn check_control(&mut self, command: &Control) {
        match command {
            Control::Select { session_id, .. } if self.stage == 0 => {
                self.selected = Some(checked(session_id.parse()));
                self.stage = 1;
            }
            Control::ArmLifecycleFailure { .. } if self.stage == 1 => self.stage = 2,
            Control::Drive { gate: 1, .. } if self.stage == 2 => self.stage = 3,
            Control::Drive { gate: 2, .. } if self.stage == 3 => self.stage = 4,
            Control::WaitLifecycleFailure {
                session_id,
                run_id,
                operation_id,
                ..
            } if self.stage == 4 => {
                assert!(
                    Some(session_id) == self.selected.as_ref()
                        && run_id.as_str() != operation_id.as_str(),
                    "lifecycle control rejected"
                );
                self.stage = 5;
            }
            Control::ReleaseLifecycleFailure {
                final_operation_id, ..
            } if self.stage == 5 => {
                assert!(
                    self.fault
                        .as_ref()
                        .is_some_and(|f| &f.final_operation == final_operation_id),
                    "lifecycle control rejected"
                );
                self.stage = 6;
            }
            Control::InspectLifecycleFailure { .. } if (6..=7).contains(&self.stage) => {
                self.stage += 1
            }
            Control::Stop { .. } => (),
            _ => panic!("lifecycle control rejected"),
        }
    }
    pub(super) async fn arm(
        &mut self,
        db: &Database,
        hooks: &Arc<Hooks>,
        seed: &ApplicationSessionId,
    ) {
        let records = db.records().await;
        assert!(
            self.pause.is_none()
                && records.len() == 1
                && self.selected.as_ref() != Some(seed)
                && matches!(records[0].payload(), StoredEventPayload::SessionCreated(_))
        );
        self.fresh = Some(records[0].clone());
        self.seed_evidence =
            Some(seed_snapshot(&db.root, seed, self.selected.as_ref().unwrap()).await);
        let pause = Arc::new(Pause {
            rollback: true,
            ..Pause::default()
        });
        hooks.arm_record(
            Record::FinalResult,
            Point::BeforeCommit,
            Action::Pause(pause.clone()),
        );
        self.pause = Some(pause);
    }
    pub(super) async fn wait(
        &mut self,
        db: &Database,
        client: &RunClient,
        id: u32,
        session: ApplicationSessionId,
        run: RunId,
        acceptance: OperationId,
    ) -> Value {
        let pause = self.pause.as_ref().unwrap();
        watch(pause.reached.notified()).await;
        let fault = Fault {
            session,
            run,
            acceptance,
            final_operation: pause.operation_id.lock().unwrap().clone().unwrap(),
            attempt: pause.final_attempt.lock().unwrap().clone().unwrap(),
            hits: pause.hits.load(Ordering::SeqCst),
            rollback: pause.rollback,
        };
        assert!(
            client.has_other_active_operation(&fault.session, &fault.final_operation),
            "lifecycle operation not active"
        );
        let prefix = snapshot(db).await;
        audit(&prefix, &fault);
        assert!(value(&prefix.records[0]) == value(self.fresh.as_ref().unwrap()));
        let reply = json!({"id":id,"event":"lifecycle_failure_paused","session_id":fault.session,"run_id":fault.run,
            "operation_id":fault.acceptance,"final_operation_id":fault.final_operation,"hits":fault.hits,"exact":true});
        self.fault = Some(fault);
        self.prefix = Some(prefix);
        reply
    }
    pub(super) async fn release(&mut self, client: &RunClient) {
        let f = self.fault.as_ref().unwrap();
        assert!(!self.retired && client.has_other_active_operation(&f.session, &f.final_operation));
        self.pause.as_ref().unwrap().release.notify_one();
        // Entry retirement follows append completion, rollback, and explicit connection close.
        // Using the distinct final operation observes the acceptance entry without cancellation.
        watch(async {
            while client.has_other_active_operation(&f.session, &f.final_operation) {
                tokio::task::yield_now().await;
            }
        })
        .await;
        self.retired = true;
    }
    pub(super) async fn inspect(
        &self,
        db: &Database,
        proof: &Mutex<Proof>,
        auth: &CountedAuth,
        seed: &ApplicationSessionId,
        id: u32,
    ) -> Value {
        assert!(
            self.retired && (7..=8).contains(&self.stage),
            "lifecycle retirement missing"
        );
        let s = snapshot(db).await;
        let f = self.fault.as_ref().unwrap();
        audit(&s, f);
        unchanged(self.prefix.as_ref().unwrap(), &s);
        assert!(self.pause.as_ref().unwrap().hits.load(Ordering::SeqCst) == 1);
        assert!(
            self.seed_evidence.as_ref().unwrap()
                == &seed_snapshot(&db.root, seed, &f.session).await
        );
        let p = proof.lock().unwrap();
        assert!(
            p.connections == 1
                && p.requests == 2
                && p.prepared_exact == 2
                && p.completed == 1
                && p.gate.is_none()
                && !p.provider_failed
                && p.fresh_empty
        );
        auth.assert_loads(1);
        json!({"id":id,"event":"lifecycle_failure_inspect","session_id":f.session,"run_id":f.run,"operation_id":f.acceptance,
            "final_operation_id":f.final_operation,"sequence_count":"19","connections":1,"requests":2,"dispatches":1,
            "prepared_results":1,"result_rows":1,"reused":0,"hits":1,"retired":true,"exact":true,"prior_unchanged":true})
    }
}
impl Drop for Audit {
    fn drop(&mut self) {
        if let Some(pause) = &self.pause {
            pause.release.notify_one();
        }
    }
}
