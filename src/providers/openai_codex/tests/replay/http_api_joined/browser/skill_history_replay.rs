//! One real main-SKILL dispatch, then historical replay after an owned source change.
use super::*;
use crate::tools::ToolExecutionEvent;

fn data() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/skill-history-replay.json"
    )))
    .unwrap()
}
pub(super) fn setup(workspace: &std::path::Path) {
    skill(
        &workspace.join(".agents/skills/presentation"),
        "presentation",
        data()["body"].as_str().unwrap(),
    );
}
pub(super) fn calls(task: usize) -> Vec<Value> {
    if task == 0 {
        vec![call(
            data()["call_id"].as_str().unwrap(),
            "load_skill",
            data()["arguments"].as_str().unwrap(),
        )]
    } else {
        vec![call("add-雪", "add_numbers", ARGUMENTS[task])]
    }
}
pub(super) fn loaded() -> String {
    json!({"id":"project:presentation","frontmatter":{"name":"presentation","description":"synthetic metadata"},"body":data()["body"]}).to_string()
}

fn historical_pair(body: &Value) -> (Value, Value) {
    let input = body["input"]
        .as_array()
        .expect("skill replay input rejected");
    let calls: Vec<_> = input
        .iter()
        .filter(|v| v["type"] == "function_call")
        .collect();
    let results: Vec<_> = input
        .iter()
        .filter(|v| v["type"] == "function_call_output")
        .collect();
    assert!(
        calls.len() == 1 && results.len() == 1,
        "skill replay count rejected"
    );
    assert!(calls[0] == &self::calls(0)[0], "skill replay call rejected");
    assert!(
        results[0] == &output(data()["call_id"].as_str().unwrap(), &loaded()),
        "skill replay original output rejected"
    );
    let call_position = input.iter().position(|v| v == calls[0]).unwrap();
    let result_position = input.iter().position(|v| v == results[0]).unwrap();
    assert!(
        call_position < result_position,
        "skill replay order rejected"
    );
    (calls[0].clone(), results[0].clone())
}

#[derive(Default)]
pub(super) struct Audit {
    prefix: Option<Value>,
    prefix_len: usize,
    historical: Option<(Value, Value)>,
}
impl Audit {
    pub(super) fn completed_a(&mut self, records: &[StoredEvent]) {
        assert!(self.prefix.is_none());
        self.prefix = Some(serde_json::to_value(records).unwrap());
        self.prefix_len = records.len();
    }
    fn unchanged(&self, records: &[StoredEvent]) {
        assert!(records.len() >= self.prefix_len);
        assert!(
            Some(serde_json::to_value(&records[..self.prefix_len]).unwrap()) == self.prefix,
            "skill replay immutable prefix rejected"
        );
    }
    pub(super) fn request_b(&mut self, body: &Value, records: &[StoredEvent]) {
        assert!(self.prefix.is_some() && self.historical.is_none());
        self.unchanged(records);
        self.historical = Some(historical_pair(body));
    }
    pub(super) fn inspect(&self, records: &[StoredEvent], mut state: Value, id: u32) -> Value {
        // emit adds the outer protocol tag; the nested ordinary state needs its own tag.
        state["protocol"] = json!(1);
        self.unchanged(records);
        let mut starts = vec![];
        let mut finishes = vec![];
        let mut results = vec![];
        for record in records {
            match record.payload() {
                StoredEventPayload::RuntimeObserved(envelope) => match &envelope.event {
                    RunEvent::ToolEvent {
                        event: ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name },
                    } if tool_name == "load_skill" => starts.push((record, envelope, call_id)),
                    RunEvent::ToolEvent {
                        event:
                            ToolExecutionEvent::ToolExecutionFinished {
                                call_id,
                                tool_name,
                                is_error,
                            },
                    } if tool_name == "load_skill" => {
                        assert!(!is_error);
                        finishes.push((record, envelope, call_id));
                    }
                    _ => (),
                },
                StoredEventPayload::ToolResultRecorded(result)
                    if result.call_id() == data()["call_id"].as_str().unwrap() =>
                {
                    results.push((record, result))
                }
                _ => (),
            }
        }
        assert!(
            starts.len() == 1 && finishes.len() == 1 && results.len() == 1,
            "skill replay loader dispatch rejected"
        );
        let (start, envelope, call_id) = starts[0];
        let (finish, finished, finished_call) = finishes[0];
        let (record, result) = results[0];
        assert!(call_id == finished_call && call_id == result.call_id());
        assert!(start.run_id() == record.run_id() && record.run_id() == finish.run_id());
        assert!(
            envelope.request_id == finished.request_id
                && envelope.request_id.as_deref() == result.request_id()
        );
        assert!(
            envelope.turn_id == finished.turn_id
                && start.sequence() < record.sequence()
                && record.sequence() < finish.sequence()
        );
        assert!(
            result.output() == loaded() && !result.is_error(),
            "skill replay canonical original rejected"
        );
        let completed = state["completed"].as_u64().unwrap();
        assert!((1..=2).contains(&completed) && self.historical.is_some() == (completed == 2));
        json!({"id":id,"event":"skill_replay_inspect","state":state,"loader_dispatches":starts.len(),
            "canonical_original":true,"prefix_unchanged":true,"history_exact":self.historical.is_some(),
            "historical_call":self.historical.as_ref().map(|v| &v.0),
            "historical_result":self.historical.as_ref().map(|v| &v.1)})
    }
}

#[test]
fn skill_replay_start_requires_exclusive_native_websocket() {
    let base = json!({"id":1,"owner":"a".repeat(64),"transport":"web_socket","recovered":false,"mime":true,"skill_replay":true});
    serde_json::from_value::<Start>(base.clone())
        .unwrap()
        .validate();
    for (key, value) in [
        ("transport", json!("sse")),
        ("recovered", json!(true)),
        ("mime", json!(false)),
        ("presentation", json!(true)),
        ("mutations", json!(true)),
        ("tool_fidelity", json!(true)),
        ("cancellation", json!(true)),
        ("lifecycle_failure", json!(true)),
        ("unbound_history", json!(true)),
        ("fixed_head", json!(true)),
        ("gate11_diagnostics", json!(true)),
    ] {
        let mut input = base.clone();
        input[key] = value;
        assert!(
            std::panic::catch_unwind(|| serde_json::from_value::<Start>(input).unwrap().validate())
                .is_err()
        );
    }
}

#[test]
fn original_historical_pair_is_exact_and_correlated() {
    let original_call = calls(0).remove(0);
    let result = output(data()["call_id"].as_str().unwrap(), &loaded());
    let body = json!({"input":[user("A"),original_call,result,user("B")]});
    assert!(historical_pair(&body) == (original_call.clone(), result.clone()));
    let mutations = [
        json!([user("A"), original_call, user("B")]),
        json!([user("A"), result, user("B")]),
        json!([result, original_call, user("B")]),
        json!([original_call, result, result, user("B")]),
        json!([original_call, output("wrong-call", &loaded()), user("B")]),
        json!([
            original_call,
            output(data()["call_id"].as_str().unwrap(), "replacement"),
            user("B")
        ]),
        json!([
            call(
                "wrong-call",
                "load_skill",
                data()["arguments"].as_str().unwrap()
            ),
            result,
            user("B")
        ]),
    ];
    for input in mutations {
        assert!(std::panic::catch_unwind(|| historical_pair(&json!({"input":input}))).is_err());
    }
}
