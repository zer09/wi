//! One explicit cancel of a native request with no provider reply.
use super::*;
use crate::{service::RunClient, storage::AppendRunRecord};

#[path = "cancellation/tests.rs"]
mod tests;

fn data() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/cancellation.json"
    )))
    .unwrap()
}
fn text(key: &str) -> String {
    data()[key].as_str().unwrap().to_owned()
}
#[track_caller]
fn checked<T, E>(value: std::result::Result<T, E>) -> T {
    value.unwrap_or_else(|_| panic!("cancellation evidence rejected"))
}
fn value(value: &impl serde::Serialize) -> Value {
    checked(serde_json::to_value(value))
}

pub(super) async fn provider(mut wire: Wire, db: Database, proof: Arc<Mutex<Proof>>) {
    let body = wire.receive().await;
    let records = db.records().await;
    assert!(records.len() == 6, "cancellation pending prefix rejected");
    let StoredEventPayload::RunAccepted(a) = records[1].payload() else {
        panic!("cancellation acceptance missing")
    };
    let input = a.input();
    let prompt: Value = checked(serde_json::from_str(&input.prepared_request().prompt));
    let tools: Vec<_> = input.tool_definitions().iter().map(|d| json!({"type":"function","name":d.name,"description":d.description,"parameters":d.parameters,"strict":d.strict})).collect();
    // Compare privately. An assertion must not print the prepared prompt or headers.
    assert!(input.user_text() == text("task") && prompt["task"] == text("task"));
    assert!(
        body["input"] == json!([user(&input.prepared_request().prompt)])
            && body.get("previous_response_id").is_none()
            && body["model"] == MODEL
            && body["store"] == false
            && body["instructions"] == input.prepared_request().options.instructions
            && body["tools"] == json!(tools)
            && body["type"] == "response.create"
            && body["prompt_cache_key"].is_string()
            && wire.requests == 1
    );
    {
        let mut p = proof.lock().unwrap();
        p.connections = 1;
        p.requests = 1;
        p.prepared_exact = 1;
        p.fresh_empty = true;
    }
    let mut socket = wire.websocket.take().unwrap();
    // No terminal, delta, tool call or synthetic error is sent. Watch both sockets
    // so a retry/fallback cannot hide behind the pending original connection.
    watch(async {
        loop {
            tokio::select! {
                _ = wire.listener.accept() => {
                    proof.lock().unwrap().connections += 1;
                    panic!("cancellation unexpected provider connection");
                }
                frame = socket.next() => match frame {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(_))) => checked(socket.flush().await),
                    Some(Ok(Message::Pong(_))) => (),
                    _ => panic!("cancellation unexpected provider request"),
                }
            }
        }
    })
    .await;
    proof.lock().unwrap().completed = 1;
    let _ = wire.listener.accept().await;
    proof.lock().unwrap().connections += 1;
    panic!("cancellation unexpected provider connection");
}

#[derive(Clone)]
struct Snapshot {
    records: Vec<StoredEvent>,
    runs: Vec<Value>,
    commands: Vec<Value>,
    tools: i64,
    head: i64,
}
async fn snapshot(db: &Database) -> Snapshot {
    let records = db.records().await;
    let mut reader = db.reader.lock().await;
    let mut sql = checked(reader.as_mut().unwrap().begin().await);
    let mut rows = Vec::new();
    for query in [
        "SELECT json_object('run_id',run_id,'state',state,'accepted_sequence',accepted_sequence,'terminal_sequence',terminal_sequence,'result_sequence',result_sequence,'provider_session_id',provider_session_id) FROM runs ORDER BY accepted_sequence",
        "SELECT json_object('operation_id',operation_id,'method',method,'first_sequence',first_sequence,'last_sequence',last_sequence,'receipt',json(receipt_json),'hash',hex(payload_hash)) FROM commands ORDER BY first_sequence",
    ] {
        let raw: Vec<String> = checked(sqlx::query_scalar(query).fetch_all(&mut *sql).await);
        rows.push(
            raw.iter()
                .map(|s| checked(serde_json::from_str(s)))
                .collect(),
        );
    }
    let tools = checked(
        sqlx::query_scalar("SELECT count(*) FROM tool_results")
            .fetch_one(&mut *sql)
            .await,
    );
    let head = checked(
        sqlx::query_scalar("SELECT head_sequence FROM manifest WHERE singleton=1")
            .fetch_one(&mut *sql)
            .await,
    );
    checked(sql.rollback().await);
    Snapshot {
        records,
        commands: rows.pop().unwrap(),
        runs: rows.pop().unwrap(),
        tools,
        head,
    }
}
#[derive(Clone)]
struct Identity {
    session: ApplicationSessionId,
    run: RunId,
    acceptance: OperationId,
}
fn audit(s: &Snapshot, identity: &Identity, head: usize) {
    assert!(
        [6, 7, 9].contains(&head)
            && s.head == head as i64
            && s.records.len() == head
            && s.commands.len() == head - 2
            && s.runs.len() == 1
            && s.tools == 0,
        "cancellation shape rejected"
    );
    let mut ids = std::collections::HashSet::new();
    let mut runtime_ids = std::collections::HashSet::new();
    let mut runtime = Vec::new();
    let views: Vec<_> = s
        .records
        .iter()
        .map(|r| value(&crate::http_api::dto::EventView::from(r)))
        .collect();
    for (i, record) in s.records.iter().enumerate() {
        assert!(
            record.application_session_id() == &identity.session
                && record.sequence() == i as u64 + 1
                && ids.insert(record.event_id().clone())
                && views[i]["kind"] == data()["kinds"][i]
                && record.run_id() == if i == 0 { None } else { Some(&identity.run) }
        );
        if let StoredEventPayload::RuntimeObserved(e) = record.payload() {
            assert!(
                e.run_id == identity.run.as_str()
                    && e.sequence == runtime.len() as u64 + 1
                    && runtime_ids.insert(e.event_id.clone())
            );
            runtime.push(e);
        }
    }
    let StoredEventPayload::SessionCreated(created) = s.records[0].payload() else {
        unreachable!()
    };
    assert!(created.title() == text("title"));
    let StoredEventPayload::RunAccepted(a) = s.records[1].payload() else {
        unreachable!()
    };
    assert!(a.run_id() == &identity.run && a.input().user_text() == text("task"));
    let StoredEventPayload::RunHistorySelected(selection) = s.records[2].payload() else {
        unreachable!()
    };
    assert!(
        selection.run_id() == &identity.run
            && selection.selection().through_sequence() == 1
            && selection.selection().provider_id() == PROVIDER_ID
            && selection.selection().requested_model() == MODEL
    );
    let StoredEventPayload::RunProviderBound(binding) = s.records[4].payload() else {
        unreachable!()
    };
    let provider_session = binding.provider_session_id();
    assert!(binding.run_id() == &identity.run && binding.requested_model() == MODEL);
    assert!(
        runtime[0].session_id.is_none()
            && runtime[0].request_id.is_none()
            && runtime[0].turn_id.is_none()
    );
    let turn = runtime[1].turn_id.as_ref().unwrap();
    assert!(
        !turn.is_empty()
            && runtime[1].request_id.is_none()
            && views[5]["data"] == json!({"turn_id":turn,"number":"1"})
    );
    for e in runtime.iter().skip(1) {
        assert!(e.session_id.as_deref() == Some(provider_session));
    }
    let outcome = json!({"type":"cancelled_locally"});
    if head >= 7 {
        let request = runtime[2].request_id.as_ref().unwrap();
        assert!(!request.is_empty() && runtime[2].turn_id.as_ref() == Some(turn));
        assert!(
            views[6]["data"]
                == json!({"turn_id":turn,"number":"1","response_id":null,
            "outcome":{"type":"stopped","reason":outcome},"upstream_outcome":"unknown"})
        );
        if head == 9 {
            let summary = json!({"turns_started":"1","turns_finished":"1","model_requests_attempted":"1","model_requests_admitted":"1",
                "new_tool_dispatches":"0","tool_results_prepared":"0","reused_results":"0","last_request_id":request,"last_upstream_outcome":"unknown"});
            assert!(
                runtime[3].turn_id.is_none() && runtime[3].request_id.as_ref() == Some(request)
            );
            assert!(views[7]["data"] == json!({"outcome":outcome,"summary":summary}));
            let StoredEventPayload::RunResultRecorded(result) = s.records[8].payload() else {
                unreachable!()
            };
            assert!(
                result.run_id == identity.run.as_str()
                    && result.session_id.as_deref() == Some(provider_session)
                    && result.outcome == RunOutcome::CancelledLocally
                    && result.last_response.is_none()
                    && result.events_complete
                    && result.sink_error.is_none()
            );
            assert!(
                views[8]["data"]
                    == json!({"outcome":outcome,"summary":summary,"events_complete":true,"sink_error":null})
            );
        }
    }
    let (state, terminal, result) = if head == 9 {
        ("cancelled_locally", json!(8), json!(9))
    } else {
        ("running", Value::Null, Value::Null)
    };
    assert!(
        s.runs[0]
            == json!({"run_id":identity.run,"state":state,"accepted_sequence":2,
        "terminal_sequence":terminal,"result_sequence":result,"provider_session_id":provider_session})
    );
    let mut operations = std::collections::HashSet::new();
    for (i, command) in s.commands.iter().enumerate() {
        let first = if i == 0 { 2 } else { i + 3 };
        let last = if i == 0 { 3 } else { first };
        let operation: OperationId = checked(command["operation_id"].as_str().unwrap().parse());
        assert!(operations.insert(operation));
        let method = if i == 0 {
            "accept_history_run"
        } else {
            "append_run_records"
        };
        let mut request =
            json!({"session_id":identity.session,"run_id":identity.run,"method":method});
        if i == 0 {
            request["input"] = value(a.input());
            request["selection"] = value(selection.selection());
        } else {
            let record = match s.records[first - 1].payload() {
                StoredEventPayload::RuntimeObserved(e) => AppendRunRecord::Runtime(e.clone()),
                StoredEventPayload::RunProviderBound(b) => {
                    AppendRunRecord::ProviderBinding(b.clone())
                }
                StoredEventPayload::RunResultRecorded(r) => AppendRunRecord::Result(r.clone()),
                _ => panic!("cancellation command rejected"),
            };
            request["records"] = json!([record]);
        }
        let digest = ring::digest::digest(&ring::digest::SHA256, request.to_string().as_bytes());
        let hex: String = digest.as_ref().iter().map(|b| format!("{b:02X}")).collect();
        assert!(
            command["hash"] == hex
                && command["method"] == method
                && command["first_sequence"] == first
                && command["last_sequence"] == last
                && command["receipt"]
                    == json!({"operation_id":command["operation_id"],"session_id":identity.session,"run_id":identity.run,"first_sequence":first,"last_sequence":last})
        );
    }
    assert!(s.commands[0]["operation_id"] == value(&identity.acceptance));
}
fn prefix(before: &Snapshot, after: &Snapshot) {
    assert!(
        value(&before.records) == value(&after.records[..before.records.len()].to_vec())
            && before.commands == after.commands[..before.commands.len()],
        "cancellation prefix changed"
    );
}
fn counters(proof: &Mutex<Proof>, closed: usize) {
    let p = proof.lock().unwrap();
    assert!(
        p.connections == 1
            && p.requests == 1
            && p.prepared_exact == 1
            && p.completed == closed
            && p.fresh_empty
            && p.gate.is_none()
            && !p.provider_failed,
        "cancellation provider counters rejected"
    );
}

#[derive(Default)]
pub(super) struct Audit {
    stage: usize,
    selected: Option<ApplicationSessionId>,
    identity: Option<Identity>,
    terminal: Option<OperationId>,
    pause: Option<Arc<Pause>>,
    prefix: Option<Snapshot>,
    settled: Option<Snapshot>,
    retired: bool,
}
impl Audit {
    pub(super) fn check_control(&mut self, command: &Control) {
        match command {
            Control::Select { session_id, .. } if self.stage == 0 => {
                self.selected = Some(checked(session_id.parse()));
                self.stage = 1;
            }
            Control::ArmCancellation { .. } if self.stage == 1 => self.stage = 2,
            Control::WaitCancellationPending {
                session_id,
                run_id,
                operation_id,
                ..
            } if self.stage == 2 => {
                assert!(
                    self.selected.as_ref() == Some(session_id)
                        && session_id.as_str() != run_id.as_str()
                        && session_id.as_str() != operation_id.as_str()
                        && run_id.as_str() != operation_id.as_str()
                );
                self.identity = Some(Identity {
                    session: session_id.clone(),
                    run: run_id.clone(),
                    acceptance: operation_id.clone(),
                });
                self.stage = 3;
            }
            Control::WaitCancellation { .. } if self.stage == 3 => self.stage = 4,
            Control::ReleaseCancellation {
                terminal_operation_id,
                ..
            } if self.stage == 4 => {
                assert!(self.terminal.as_ref() == Some(terminal_operation_id));
                self.stage = 5;
            }
            Control::InspectCancellation { .. } if (5..=7).contains(&self.stage) => self.stage += 1,
            Control::Stop { .. } => (),
            _ => panic!("cancellation control rejected"),
        }
    }
    pub(super) async fn arm(
        &mut self,
        db: &Database,
        hooks: &Arc<Hooks>,
        seed: &ApplicationSessionId,
    ) {
        assert!(
            self.stage == 2
                && self.pause.is_none()
                && self.selected.as_ref() != Some(seed)
                && db.records().await.len() == 1
        );
        let pause = Arc::new(Pause::default());
        hooks.arm_record(
            Record::RunFinished,
            Point::BeforeCommit,
            Action::Pause(pause.clone()),
        );
        self.pause = Some(pause);
    }
    pub(super) async fn pending(
        &mut self,
        db: &Database,
        client: &RunClient,
        proof: &Mutex<Proof>,
        id: u32,
    ) -> Value {
        assert!(self.stage == 3 && self.prefix.is_none());
        watch(async {
            while proof.lock().unwrap().requests == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        counters(proof, 0);
        let identity = self.identity.as_ref().unwrap();
        assert!(client.has_other_active_operation(&identity.session, &OperationId::new()));
        let s = snapshot(db).await;
        audit(&s, identity, 6);
        assert!(self.pause.as_ref().unwrap().hits.load(Ordering::SeqCst) == 0);
        self.prefix = Some(s);
        json!({"id":id,"event":"cancellation_pending","session_id":identity.session,"run_id":identity.run,
            "operation_id":identity.acceptance,"sequence_count":"6","connections":1,"requests":1,"closed":false,"exact":true})
    }
    pub(super) async fn wait(
        &mut self,
        db: &Database,
        client: &RunClient,
        proof: &Mutex<Proof>,
        id: u32,
    ) -> Value {
        assert!(self.stage == 4 && self.terminal.is_none());
        let pause = self.pause.as_ref().unwrap();
        watch(pause.reached.notified()).await;
        watch(async {
            while proof.lock().unwrap().completed == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        counters(proof, 1);
        let terminal = pause.operation_id.lock().unwrap().clone().unwrap();
        let identity = self.identity.as_ref().unwrap();
        assert!(
            terminal != identity.acceptance
                && client.has_other_active_operation(&identity.session, &terminal)
                && pause.hits.load(Ordering::SeqCst) == 1
                && !pause.rollback
                && pause.final_attempt.lock().unwrap().is_none()
        );
        let s = snapshot(db).await;
        audit(&s, identity, 7);
        prefix(self.prefix.as_ref().unwrap(), &s);
        assert!(
            !s.commands
                .iter()
                .any(|c| c["operation_id"] == value(&terminal))
        );
        self.prefix = Some(s);
        self.terminal = Some(terminal.clone());
        json!({"id":id,"event":"cancellation_paused","session_id":identity.session,"run_id":identity.run,
            "operation_id":identity.acceptance,"terminal_operation_id":terminal,"sequence_count":"7","connections":1,"requests":1,"closed":true,"hits":1,"exact":true})
    }
    pub(super) async fn release(&mut self, client: &RunClient) {
        let identity = self.identity.as_ref().unwrap();
        let terminal = self.terminal.as_ref().unwrap();
        assert!(
            self.stage == 5
                && !self.retired
                && client.has_other_active_operation(&identity.session, terminal)
        );
        self.pause.as_ref().unwrap().release.notify_one();
        // Retirement follows both commits and writer cleanup, not just an SSE terminal.
        watch(async {
            while client.has_other_active_operation(&identity.session, terminal) {
                tokio::task::yield_now().await;
            }
        })
        .await;
        self.retired = true;
    }
    pub(super) async fn inspect(
        &mut self,
        db: &Database,
        proof: &Mutex<Proof>,
        auth: &CountedAuth,
        id: u32,
    ) -> Value {
        assert!(self.retired && (6..=8).contains(&self.stage));
        let identity = self.identity.as_ref().unwrap();
        let s = snapshot(db).await;
        audit(&s, identity, 9);
        prefix(self.prefix.as_ref().unwrap(), &s);
        assert!(
            s.commands[5]["operation_id"] == value(self.terminal.as_ref().unwrap())
                && self.pause.as_ref().unwrap().hits.load(Ordering::SeqCst) == 1
        );
        if let Some(settled) = &self.settled {
            prefix(settled, &s);
            assert!(settled.runs == s.runs);
        }
        self.settled = Some(s);
        counters(proof, 1);
        auth.assert_loads(1);
        json!({"id":id,"event":"cancellation_inspect","session_id":identity.session,"run_id":identity.run,
            "operation_id":identity.acceptance,"terminal_operation_id":self.terminal,"sequence_count":"9","connections":1,"requests":1,"closed":true,
            "hits":1,"exact":true,"retired":true,"dispatches":0,"prepared_results":0,"reused":0,"result_records":1,"prefix_unchanged":true})
    }
}
impl Drop for Audit {
    fn drop(&mut self) {
        if let Some(pause) = &self.pause {
            pause.release.notify_one();
        }
    }
}
