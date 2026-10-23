//! Exclusive native-WS tool fixture. Only checked identities and counts leave the audit.
use super::*;
use crate::{ToolDefinition, tools::Tool};
use std::sync::atomic::AtomicUsize;

#[path = "tool_fidelity/tests.rs"]
mod tests;

fn data() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/tool-fidelity.json"
    )))
    .unwrap()
}
fn text(key: &str) -> String {
    data()[key].as_str().unwrap().to_owned()
}
fn at(key: &str, index: usize) -> String {
    data()[key][index].as_str().unwrap().to_owned()
}
fn checked<T, E>(value: std::result::Result<T, E>) -> T {
    value.unwrap_or_else(|_| panic!("tool fidelity evidence rejected"))
}

#[derive(Default)]
pub(super) struct InertTool {
    executions: AtomicUsize,
}
#[async_trait::async_trait]
impl Tool for InertTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: text("name"),
            description: "Inert test-only successful JSON result.".into(),
            parameters: json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}),
            strict: true,
        }
    }
    fn validate(&self, arguments: &Value) -> crate::Result<()> {
        let expected: Value = checked(serde_json::from_str(&text("fixture_arguments")));
        if arguments != &expected {
            return Err(GatewayError::InvalidToolArguments);
        }
        Ok(())
    }
    async fn execute(&self, arguments: Value) -> crate::Result<Value> {
        self.validate(&arguments)?;
        self.executions.fetch_add(1, Ordering::SeqCst);
        Ok(data()["fixture_value"].clone())
    }
}

fn items(task: usize, turn: usize) -> Vec<Value> {
    if turn == 0 {
        let mut calls = vec![call(
            &text("shared_call"),
            "add_numbers",
            &at("arguments", if task == 0 { 0 } else { 2 }),
        )];
        if task == 0 {
            calls.push(call(
                &text("fixture_call"),
                &text("name"),
                &text("fixture_arguments"),
            ));
        }
        calls
    } else if task == 0 && turn == 1 {
        vec![call(
            &text("shared_call"),
            "add_numbers",
            &at("arguments", 1),
        )]
    } else {
        vec![
            json!({"type":"message","id":"fidelity-answer","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":at("answers",task)}]}),
        ]
    }
}
fn results(task: usize, turn: usize) -> Vec<Value> {
    let mut result = vec![output(&text("shared_call"), &at("sums", task))];
    if task == 0 && turn == 0 {
        result.push(output(&text("fixture_call"), &text("fixture_output")));
    }
    result
}
fn response_id(task: usize, turn: usize) -> String {
    format!("fidelity-{task}-{turn}")
}

fn check_request(body: &Value, input: &[Value], parent: Option<&str>, prepared: &RecordedRunInput) {
    let tools: Vec<_> = prepared.tool_definitions().iter().map(|d| json!({"type":"function","name":d.name,"description":d.description,"parameters":d.parameters,"strict":d.strict})).collect();
    // Boolean assertions keep task, tool and private preparation bytes out of failures.
    assert!(
        body["input"] == json!(input)
            && body["previous_response_id"] == json!(parent)
            && body["model"] == MODEL
            && body["store"] == false
            && body["instructions"] == prepared.prepared_request().options.instructions
            && body["tools"] == json!(tools)
            && body["type"] == "response.create"
            && body.get("stream").is_none(),
        "tool fidelity provider input rejected"
    );
}

pub(super) async fn provider(
    mut wire: Wire,
    db: Database,
    proof: Arc<Mutex<Proof>>,
    mut drive: mpsc::Receiver<usize>,
) {
    let mut prior = vec![];
    let mut old_key = Value::Null;
    let mut gate = 0;
    for task in 0..2 {
        let mut context = prior.clone();
        let mut key = Value::Null;
        let turns = if task == 0 { 3 } else { 2 };
        for turn in 0..turns {
            let body = wire.receive().await;
            {
                let mut p = proof.lock().unwrap();
                p.requests += 1;
                if turn == 0 {
                    p.connections += 1;
                }
            }
            let records = db.records().await;
            let accepted: Vec<_> = records
                .iter()
                .filter_map(|r| match r.payload() {
                    StoredEventPayload::RunAccepted(a) => Some(a),
                    _ => None,
                })
                .collect();
            assert!(
                accepted.len() == task + 1,
                "tool fidelity acceptance rejected"
            );
            let input = accepted[task].input();
            let prompt: Value = checked(serde_json::from_str(&input.prepared_request().prompt));
            assert!(input.user_text() == at("tasks", task) && prompt["task"] == at("tasks", task));
            assert!(
                input
                    .tool_definitions()
                    .iter()
                    .any(|d| d.name == text("name"))
            );
            if turn == 0 {
                context.push(user(&input.prepared_request().prompt));
                check_request(&body, &context, None, input);
                assert!(body.get("previous_response_id").is_none());
                key = body["prompt_cache_key"].clone();
                assert!(key.is_string() && key != old_key);
            } else {
                let outputs = results(task, turn - 1);
                check_request(&body, &outputs, Some(&response_id(task, turn - 1)), input);
                assert!(body["prompt_cache_key"] == key);
                // These are exact serialized strings, not parsed-and-reserialized output.
                context.extend(outputs);
            }
            gate += 1;
            {
                let mut p = proof.lock().unwrap();
                p.prepared_exact += 1;
                p.gate = Some(gate);
            }
            emit(json!({"event":"model_paused","gate":gate}));
            assert!(watch(drive.recv()).await == Some(gate));
            let reply = items(task, turn);
            wire.reply(events(&response_id(task, turn), reply.clone(), false), None)
                .await;
            context.extend(reply);
        }
        wire.closed().await;
        watch(async {
            loop {
                let count = db
                    .records()
                    .await
                    .iter()
                    .filter(|r| matches!(r.payload(), StoredEventPayload::RunResultRecorded(_)))
                    .count();
                if count == task + 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        prior = context;
        old_key = key;
        proof.lock().unwrap().completed += 1;
        emit(json!({"event":"task_finished","task":task + 1}));
    }
    let _ = wire.listener.accept().await;
    panic!("tool fidelity unexpected provider connection");
}

#[derive(Clone)]
struct Snapshot {
    records: Vec<StoredEvent>,
    tools: Vec<Value>,
    runs: Vec<Value>,
    receipts: Vec<Value>,
}
async fn snapshot(db: &Database) -> Snapshot {
    // Only called at a completed-task gate, before the browser may submit again.
    let records = db.records().await;
    let receipts = db.receipts().await;
    let mut reader = db.reader.lock().await;
    let mut sql = checked(reader.as_mut().unwrap().begin().await);
    let tools: Vec<String> = checked(sqlx::query_scalar("SELECT json_object('run_id',run_id,'call_id',call_id,'tool_name',tool_name,'request_id',request_id,'started_sequence',started_sequence,'result_sequence',result_sequence,'finished_sequence',finished_sequence,'is_error',is_error,'output',output) FROM tool_results ORDER BY started_sequence").fetch_all(&mut *sql).await);
    let runs: Vec<String> = checked(sqlx::query_scalar("SELECT json_object('run_id',run_id,'state',state,'accepted_sequence',accepted_sequence,'terminal_sequence',terminal_sequence,'result_sequence',result_sequence) FROM runs ORDER BY accepted_sequence").fetch_all(&mut *sql).await);
    let head: i64 = checked(
        sqlx::query_scalar("SELECT head_sequence FROM manifest WHERE singleton=1")
            .fetch_one(&mut *sql)
            .await,
    );
    assert!(
        head as usize == records.len(),
        "tool fidelity head rejected"
    );
    checked(sql.rollback().await);
    Snapshot {
        records,
        receipts,
        tools: tools
            .iter()
            .map(|s| checked(serde_json::from_str(s)))
            .collect(),
        runs: runs
            .iter()
            .map(|s| checked(serde_json::from_str(s)))
            .collect(),
    }
}

fn audit(s: &Snapshot, completed: usize, executions: usize) {
    assert!(
        (1..=2).contains(&completed) && executions == 1,
        "tool fidelity count rejected"
    );
    assert!(
        s.runs.len() == completed
            && s.receipts.len() == completed
            && s.tools.len() == completed + 1
    );
    let accepted: Vec<_> = s
        .records
        .iter()
        .filter(|r| matches!(r.payload(), StoredEventPayload::RunAccepted(_)))
        .collect();
    assert!(accepted.len() == completed);
    let mut identities = std::collections::HashSet::new();
    for (index, record) in s.records.iter().enumerate() {
        assert!(record.sequence() == index as u64 + 1 && identities.insert(record.event_id()));
        assert!(record.application_session_id() == s.records[0].application_session_id());
        assert!(index == 0 || accepted.iter().any(|a| a.run_id() == record.run_id()));
    }
    assert!(matches!(
        s.records[0].payload(),
        StoredEventPayload::SessionCreated(_)
    ));
    if completed == 2 {
        assert!(
            s.runs[0]["run_id"] != s.runs[1]["run_id"]
                && s.receipts[0]["operation_id"] != s.receipts[1]["operation_id"]
        );
    }
    for (task, accepted) in accepted.iter().enumerate() {
        let run = accepted.run_id().unwrap();
        let records: Vec<_> = s
            .records
            .iter()
            .filter(|r| r.run_id() == Some(run))
            .collect();
        let views: Vec<_> = records
            .iter()
            .map(|r| {
                checked(serde_json::to_value(crate::http_api::dto::EventView::from(
                    *r,
                )))
            })
            .collect();
        let turns = if task == 0 { 3 } else { 2 };
        let dispatches = if task == 0 { 2 } else { 1 };
        let reuse = usize::from(task == 0);
        let receipt = &s.receipts[task];
        let first_sequence = accepted.sequence().to_string();
        let last_sequence = (accepted.sequence() + 1).to_string();
        assert!(
            receipt["session_id"] == json!(accepted.application_session_id())
                && receipt["run_id"] == run.as_str()
                && receipt["first_sequence"] == first_sequence
                && receipt["last_sequence"] == last_sequence
        );
        assert!(views[0]["data"]["user_text"] == at("tasks", task));
        assert!(matches!(
            records[1].payload(),
            StoredEventPayload::RunHistorySelected(_)
        ));
        let responses: Vec<_> = records.iter().filter_map(|r| match r.payload() {
            StoredEventPayload::RuntimeObserved(e) if matches!(&e.event,RunEvent::ProviderEvent {event} if matches!(&event.event,ProviderEvent::ResponseFinished {..})) => Some((*r,e)), _ => None,
        }).collect();
        assert!(responses.len() == turns);
        for (turn, (_, envelope)) in responses.iter().enumerate() {
            let RunEvent::ProviderEvent { event } = &envelope.event else {
                unreachable!()
            };
            let ProviderEvent::ResponseFinished { response } = &event.event else {
                unreachable!()
            };
            assert!(
                response.id == response_id(task, turn)
                    && response.native
                        == events(&response_id(task, turn), items(task, turn), false)
                            .last()
                            .unwrap()["response"]
                    && response
                        .output
                        .iter()
                        .map(|i| i.native.clone())
                        .collect::<Vec<_>>()
                        == items(task, turn)
                    && response.output_provenance == OutputProvenance::NativeTerminal
            );
        }
        let requests: std::collections::HashSet<_> = responses
            .iter()
            .map(|(_, e)| e.request_id.as_ref().unwrap())
            .collect();
        assert!(requests.len() == turns);
        let count = |kind| views.iter().filter(|v| v["kind"] == kind).count();
        assert!(
            count("tool.started") == dispatches
                && count("tool.result") == dispatches
                && count("tool.finished") == dispatches
                && count("tool.reused") == reuse
                && count("run.finished") == 1
                && count("run.result") == 1
        );
        let calls = items(task, 0);
        for (slot, intent) in calls.iter().enumerate() {
            let call = &intent["call_id"];
            let find = |kind| {
                views
                    .iter()
                    .find(|v| v["kind"] == kind && &v["data"]["call_id"] == call)
                    .unwrap()
            };
            let start = find("tool.started");
            let result = find("tool.result");
            let finish = find("tool.finished");
            let request = responses[0].1.request_id.as_ref().unwrap();
            let output = if slot == 0 {
                at("sums", task)
            } else {
                text("fixture_output")
            };
            let sequence = |v: &Value| v["sequence"].as_str().unwrap().parse::<u64>().unwrap();
            assert!(
                responses[0].0.sequence() < sequence(start)
                    && sequence(start) < sequence(result)
                    && sequence(result) < sequence(finish)
            );
            for view in [start, result, finish] {
                assert!(view["data"]["request_id"] == *request);
            }
            assert!(
                start["data"]["tool_name"] == intent["name"]
                    && finish["data"]["tool_name"] == intent["name"]
            );
            assert!(
                result["data"]["output"] == output
                    && result["data"]["is_error"] == false
                    && finish["data"]["is_error"] == false
            );
            let row = s
                .tools
                .iter()
                .find(|r| r["run_id"] == run.as_str() && &r["call_id"] == call)
                .unwrap();
            assert!(
                *row == json!({"run_id":run,"call_id":call,"tool_name":intent["name"],"request_id":request,
                "started_sequence":sequence(start),"result_sequence":sequence(result),"finished_sequence":sequence(finish),"is_error":0,"output":output})
            );
            if task == 0 && slot == 0 {
                let reused = find("tool.reused");
                assert!(
                    responses[1].0.sequence() < sequence(reused)
                        && sequence(finish) < responses[1].0.sequence()
                );
                assert!(
                    reused["data"]
                        == json!({"call_id":call,"tool_name":"add_numbers","request_id":responses[1].1.request_id})
                );
            }
        }
        let StoredEventPayload::RunResultRecorded(result) = records.last().unwrap().payload()
        else {
            panic!("tool fidelity result missing")
        };
        assert!(
            result.outcome == RunOutcome::Completed
                && result.events_complete
                && result.sink_error.is_none()
                && result.last_response.as_ref().unwrap().text == at("answers", task)
        );
        let summary = &result.summary;
        assert!(
            summary.new_tool_dispatches == dispatches as u64
                && summary.reused_results == reuse as u64
                && summary.tool_results_prepared == (dispatches + reuse) as u64
                && summary.model_requests_attempted == turns as u64
                && summary.model_requests_admitted == turns as u64
                && summary.turns_started == turns as u64
                && summary.turns_finished == turns as u64
        );
        let terminal = records.iter().find(|r| matches!(r.payload(),StoredEventPayload::RuntimeObserved(e) if matches!(&e.event,RunEvent::RunFinished{..}))).unwrap();
        if let StoredEventPayload::RuntimeObserved(e) = terminal.payload()
            && let RunEvent::RunFinished {
                summary: saved,
                outcome,
            } = &e.event
        {
            assert!(
                checked(serde_json::to_value(saved)) == checked(serde_json::to_value(summary))
                    && *outcome == RunOutcome::Completed
            );
        }
        assert!(
            s.runs[task]
                == json!({"run_id":run,"state":"completed","accepted_sequence":accepted.sequence(),
            "terminal_sequence":terminal.sequence(),"result_sequence":records.last().unwrap().sequence()})
        );
    }
}
#[derive(Default)]
pub(super) struct Audit {
    selected: bool,
    audited: usize,
    first: Option<Snapshot>,
}
impl Audit {
    pub(super) fn check_control(&mut self, command: &Control) {
        match command {
            Control::Select { session_id, .. } if !self.selected => {
                let _: ApplicationSessionId = checked(session_id.parse());
                self.selected = true;
            }
            Control::Drive { gate, .. } if self.selected && (1..=5).contains(gate) => (),
            Control::InspectToolFidelity { .. } if self.selected => (),
            Control::Stop { .. } => (),
            _ => panic!("tool fidelity control rejected"),
        }
    }
    pub(super) async fn inspect(
        &mut self,
        db: &Database,
        id: u32,
        proof: &Mutex<Proof>,
        tool: &InertTool,
    ) -> Value {
        let completed = proof.lock().unwrap().completed;
        assert!(
            completed == self.audited + 1 && completed <= 2,
            "tool fidelity audit order rejected"
        );
        let s = snapshot(db).await;
        let executions = tool.executions.load(Ordering::SeqCst);
        audit(&s, completed, executions);
        if let Some(first) = &self.first {
            assert!(
                checked(serde_json::to_value(&s.records[..first.records.len()]))
                    == checked(serde_json::to_value(&first.records))
                    && s.tools[..2] == first.tools
                    && s.runs[..1] == first.runs
                    && s.receipts[..1] == first.receipts
            );
        }
        let p = proof.lock().unwrap();
        assert!(
            !p.provider_failed
                && p.connections == completed
                && p.requests == if completed == 1 { 3 } else { 5 }
                && p.prepared_exact == p.requests
                && p.gate.is_none()
        );
        let task = completed - 1;
        let evidence = json!({"id":id,"event":"tool_fidelity_inspect","session_id":s.records[0].application_session_id(),
            "run_id":s.runs[task]["run_id"],"operation_id":s.receipts[task]["operation_id"],"completed":completed,
            "sequence_count":s.records.len().to_string(),"requests":if task == 0 {3} else {2},
            "new_dispatches":if task == 0 {2} else {1},"reused":if task == 0 {1} else {0},
            "result_rows":if task == 0 {2} else {1},"prepared_results":if task == 0 {3} else {1},
            "executions":executions,"exact":true,"prior_unchanged":true});
        self.audited = completed;
        if self.first.is_none() {
            self.first = Some(s);
        }
        evidence
    }
}
