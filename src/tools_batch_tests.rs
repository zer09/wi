use super::*;
use crate::OutputItem;
use std::{
    cell::Cell,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

fn response(ids: &[&str]) -> ModelResponse {
    ModelResponse {
        output_provenance: Default::default(),
        id: "response".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output: ids
            .iter()
            .map(|id| OutputItem {
                id: Some(format!("item-{id}")),
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                function_call: Some(FunctionCall {
                    call_id: (*id).into(),
                    name: "add_numbers".into(),
                    arguments: json!({"a":2,"b":3}).to_string(),
                    origin: CallOrigin::Direct,
                    namespace: None,
                    complete: true,
                }),
                native: json!({"opaque_fixture":true}),
            })
            .collect(),
        text: String::new(),
        usage: None,
        native: Value::Null,
    }
}

struct RecordingTool {
    calls: Arc<Mutex<Vec<Value>>>,
    oversized: bool,
    name: &'static str,
}

#[async_trait]
impl Tool for RecordingTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = add_numbers_definition();
        definition.name = self.name.into();
        definition
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.calls.lock().unwrap().push(arguments.clone());
        if self.oversized {
            return Ok(json!("x".repeat(64 * 1024)));
        }
        AddNumbers.execute(arguments).await
    }
}

fn registry() -> (ToolRegistry, Arc<Mutex<Vec<Value>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut registry = ToolRegistry::new();
    for name in ["add_numbers", "other"] {
        registry
            .register(Arc::new(RecordingTool {
                calls: calls.clone(),
                oversized: false,
                name,
            }))
            .unwrap();
    }
    (registry, calls)
}

#[tokio::test]
async fn whole_batch_authority_rejects_before_dispatch_or_reuse() {
    // Status/caller native forms are normalized by the adapter. Its inherited
    // decoded_status_rejects_batch_without_execution_or_cache covers raw status.
    for cached_first in [false, true] {
        for variant in 0..22 {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let first = if cached_first { "saved" } else { "new" };
            let mut response = response(&[first, "bad"]);
            let item = &mut response.output[1];
            let call = item.function_call.as_mut().unwrap();
            match variant {
                0 => call.arguments = "{\"a\":".into(),
                1 => call.arguments = json!({"a":2,"b":3,"extra":4}).to_string(),
                2 => call.arguments = json!({"a":2.5,"b":3}).to_string(),
                3 => call.name = "unknown".into(),
                4 => call.call_id = first.into(),
                5 => {
                    call.call_id = "saved".into();
                    call.arguments = json!({"a":4,"b":3}).to_string();
                }
                6 => call.complete = false,
                7 => item.native = json!({"namespace":"unsupported"}),
                8 => item.native = json!({"namespace":{}}),
                9 => item.native = json!({"namespace":7}),
                10 => call.origin = CallOrigin::Programmatic,
                11 => call.origin = CallOrigin::Unknown,
                12 => item.kind = ItemKind::Unknown,
                13 => item.function_call = None,
                14 => call.call_id.clear(),
                15 => call.arguments = "[]".into(),
                16 => call.arguments = "null".into(),
                17 => call.arguments = " ".repeat(64 * 1024 + 1),
                18 => call.namespace = Some("namespace".into()),
                19 => {
                    call.call_id = "saved".into();
                    call.name = "other".into();
                }
                20 => call.arguments = json!({"a":2}).to_string(),
                21 => call.call_id = "x".repeat(513),
                _ => unreachable!(),
            }
            let result = registry
                .execute_response(&response, |_| panic!("rejected batch emitted an event"))
                .await;
            assert!(result.is_err(), "variant {variant}");
            assert_eq!(calls.lock().unwrap().len(), 1, "variant {variant}");
            assert_eq!(registry.results.len(), 1, "variant {variant}");
            assert!(registry.results.contains_key("saved"));
        }
    }
}

#[tokio::test]
async fn call_id_at_512_byte_boundary_produces_valid_input() {
    for call_id in ["x".repeat(512), "é".repeat(256)] {
        let (mut registry, calls) = registry();
        assert_eq!(call_id.len(), 512);
        let results = registry
            .execute_response(&response(&[&call_id]), |_| {})
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(matches!(
            &results[0],
            InputItem::ToolResult { call_id: result_id, .. } if result_id == &call_id
        ));
        crate::provider::validate_input(&results).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(registry.results.len(), 1);
        assert!(registry.results.contains_key(&call_id));
    }
}

#[tokio::test]
async fn cached_calls_still_require_authority_and_schema() {
    for variant in 0..5 {
        let (mut registry, calls) = registry();
        registry
            .execute_response(&response(&["saved"]), |_| {})
            .await
            .unwrap();
        let mut response = response(&["new", "saved"]);
        let item = &mut response.output[1];
        let call = item.function_call.as_mut().unwrap();
        match variant {
            0 => call.complete = false,
            1 => call.origin = CallOrigin::Unknown,
            2 => item.native = json!({"namespace":7}),
            3 => call.arguments = json!({"a":2,"b":3,"extra":4}).to_string(),
            4 => call.arguments = "{\"a\":".into(),
            _ => unreachable!(),
        }
        assert!(
            registry
                .execute_response(&response, |_| panic!())
                .await
                .is_err()
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(registry.results.len(), 1);
    }
}

#[tokio::test]
async fn noncompleted_responses_reject_entire_batch() {
    for outcome in [
        ResponseOutcome::Incomplete { reason: None },
        ResponseOutcome::Failed,
        ResponseOutcome::Cancelled,
    ] {
        let (mut registry, calls) = registry();
        let mut response = response(&["one", "two"]);
        response.outcome = outcome;
        assert!(
            registry
                .execute_response(&response, |_| panic!())
                .await
                .is_err()
        );
        assert!(registry.results.is_empty());
        assert!(calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn ordinary_noncall_items_and_null_namespace_are_ignored() {
    let (mut registry, calls) = registry();
    let mut response = response(&["one", "two", "three"]);
    response.output[0].kind = ItemKind::Message;
    response.output[0].function_call = None;
    response.output[1].kind = ItemKind::Reasoning;
    response.output[1].function_call = None;
    response.output[2].native = json!({"namespace":null});
    let results = registry.execute_response(&response, |_| {}).await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn nine_calls_and_input_capacity_batch_execute_in_order() {
    for size in [9, 128] {
        let (mut registry, calls) = registry();
        let ids: Vec<_> = (0..size).map(|i| format!("c{i}")).collect();
        let ids: Vec<_> = ids.iter().map(String::as_str).collect();
        let mut response = response(&ids);
        for (i, item) in response.output.iter_mut().enumerate() {
            item.function_call.as_mut().unwrap().arguments = json!({"a":i,"b":1}).to_string();
        }
        let mut events = Vec::new();
        let results = registry
            .execute_response(&response, |event| events.push(event))
            .await
            .unwrap();
        crate::provider::validate_input(&results).unwrap();
        assert_eq!(results.len(), size);
        assert_eq!(registry.results.len(), size);
        assert_eq!(events.len(), size * 2);
        assert_eq!(calls.lock().unwrap().len(), size);
        for (i, result) in results.iter().enumerate() {
            assert_eq!(calls.lock().unwrap()[i], json!({"a":i,"b":1}));
            assert!(matches!(
                &events[i * 2],
                ToolExecutionEvent::ToolExecutionStarted { call_id, .. } if call_id == ids[i]
            ));
            assert!(matches!(
                &events[i * 2 + 1],
                ToolExecutionEvent::ToolExecutionFinished { call_id, is_error: false, .. }
                    if call_id == ids[i]
            ));
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({"kind":"tool_result","call_id":ids[i],"output":json!({"sum":i+1}).to_string()})
            );
        }
    }
}

#[tokio::test]
async fn result_item_capacity_rejects_whole_batch_before_dispatch_or_reuse() {
    let (mut registry, calls) = registry();
    registry
        .execute_response(&response(&["c0"]), |_| {})
        .await
        .unwrap();
    let ids: Vec<_> = (0..129).map(|i| format!("c{i}")).collect();
    let ids: Vec<_> = ids.iter().map(String::as_str).collect();
    let error = registry
        .execute_response(&response(&ids), |_| {
            panic!("oversized batch emitted an event")
        })
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GatewayError::InvalidRequest("tool results exceed input item capacity")
    ));
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert_eq!(registry.results.len(), 1);
    assert!(registry.results.contains_key("c0"));
}

#[tokio::test]
async fn all_160_cached_results_survive_reuse_conflicts_and_fresh_scope() {
    let (mut registry, calls) = registry();
    let ids: Vec<_> = (0..160).map(|i| format!("c{i}")).collect();
    let ids: Vec<_> = ids.iter().map(String::as_str).collect();
    let mut original = Vec::new();
    for id in &ids {
        original.extend(
            registry
                .execute_response(&response(&[id]), |_| {})
                .await
                .unwrap(),
        );
    }
    assert_eq!(registry.results.len(), 160);
    let mut reused = Vec::new();
    let mut events = Vec::new();
    // Each replay fits one provider request, even though the cache is larger.
    for chunk in ids.chunks(128) {
        reused.extend(
            registry
                .execute_response(&response(chunk), |event| events.push(event))
                .await
                .unwrap(),
        );
    }
    assert_eq!(
        serde_json::to_value(&reused).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    assert_eq!(events.len(), 160);
    for (event, id) in events.iter().zip(&ids) {
        assert!(
            matches!(event, ToolExecutionEvent::ToolResultReused { call_id, .. } if call_id == id)
        );
    }
    for changed_name in [false, true] {
        let mut conflict = response(&["new", "c0"]);
        let call = conflict.output[1].function_call.as_mut().unwrap();
        if changed_name {
            call.name = "other".into();
        } else {
            call.arguments = json!({"a":4,"b":3}).to_string();
        }
        assert!(
            registry
                .execute_response(&conflict, |_| panic!("conflict emitted an event"))
                .await
                .is_err()
        );
    }
    assert_eq!(calls.lock().unwrap().len(), 160);
    assert_eq!(registry.results.len(), 160);
    let mut scope = registry.fresh_scope();
    assert!(scope.results.is_empty());
    for chunk in ids.chunks(128) {
        scope
            .execute_response(&response(chunk), |_| {})
            .await
            .unwrap();
    }
    assert_eq!(scope.results.len(), 160);
    assert_eq!(calls.lock().unwrap().len(), 320);
    drop(scope);
    assert_eq!(registry.results.len(), 160);
    registry
        .execute_response(&response(&["c0"]), |event| {
            assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }));
        })
        .await
        .unwrap();
    assert_eq!(calls.lock().unwrap().len(), 320);
}

#[tokio::test]
async fn dropping_prepared_batch_does_not_execute_or_cache() {
    let (mut registry, calls) = registry();
    for ids in [vec![], vec!["one"], vec!["one", "two"]] {
        let batch = registry.preflight(&response(&ids)).unwrap();
        assert_eq!(batch.calls.len(), ids.len());
        drop(batch);
        assert!(registry.results.is_empty());
        assert!(calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn fresh_scopes_share_tools_but_never_consume_or_mutate_template_cache() {
    let (mut template, calls) = registry();
    let response = response(&["same"]);
    let original = template.execute_response(&response, |_| {}).await.unwrap();
    for _ in 0..2 {
        let mut scope = template.fresh_scope();
        assert!(scope.results.is_empty());
        assert!(Arc::ptr_eq(
            &scope.tools["add_numbers"],
            &template.tools["add_numbers"]
        ));
        assert_eq!(scope.definitions().len(), template.definitions().len());
        scope.execute_response(&response, |_| {}).await.unwrap();
        scope
            .execute_response(&response, |event| {
                assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }))
            })
            .await
            .unwrap();
        assert_eq!(scope.results.len(), 1);
    }
    assert_eq!(calls.lock().unwrap().len(), 3);
    assert_eq!(template.results.len(), 1);
    let reused = template
        .execute_response(&response, |event| {
            assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }))
        })
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(original).unwrap(),
        serde_json::to_value(reused).unwrap()
    );
    assert_eq!(calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn mixed_batch_keeps_original_execution_event_and_result_order() {
    let (mut registry, calls) = registry();
    registry
        .execute_response(&response(&["saved"]), |_| {})
        .await
        .unwrap();
    let mut response = response(&["first", "saved", "last"]);
    response.output[2].function_call.as_mut().unwrap().arguments = json!({"a":7,"b":8}).to_string();
    let mut events = Vec::new();
    let results = registry
        .execute_response(&response, |event| events.push(event))
        .await
        .unwrap();
    let trace: Vec<_> = events
        .iter()
        .map(|event| match event {
            ToolExecutionEvent::ToolExecutionStarted { call_id, .. } => ("start", call_id.as_str()),
            ToolExecutionEvent::ToolExecutionFinished { call_id, .. } => {
                ("finish", call_id.as_str())
            }
            ToolExecutionEvent::ToolResultReused { call_id, .. } => ("reuse", call_id.as_str()),
        })
        .collect();
    assert_eq!(
        trace,
        [
            ("start", "first"),
            ("finish", "first"),
            ("reuse", "saved"),
            ("start", "last"),
            ("finish", "last")
        ]
    );
    let result_ids: Vec<_> = results
        .iter()
        .map(|item| match item {
            InputItem::ToolResult { call_id, .. } => call_id.as_str(),
            _ => panic!(),
        })
        .collect();
    assert_eq!(result_ids, ["first", "saved", "last"]);
    assert_eq!(
        *calls.lock().unwrap(),
        [
            json!({"a":2,"b":3}),
            json!({"a":2,"b":3}),
            json!({"a":7,"b":8})
        ]
    );
}

#[tokio::test]
async fn overflow_and_oversized_output_are_bounded_correlated_cached_results() {
    for oversized in [false, true] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(RecordingTool {
                calls: calls.clone(),
                oversized,
                name: "add_numbers",
            }))
            .unwrap();
        let mut response = response(&["error"]);
        response.output[0].function_call.as_mut().unwrap().arguments =
            json!({"a":i64::MAX,"b":1}).to_string();
        let mut events = Vec::new();
        let results = registry
            .execute_response(&response, |event| events.push(event))
            .await
            .unwrap();
        let InputItem::ToolResult { call_id, output } = &results[0] else {
            panic!()
        };
        assert_eq!(call_id, "error");
        assert!(output.len() <= 64 * 1024);
        let expected = if oversized {
            "tool_output_limit"
        } else {
            "gateway_error"
        };
        assert_eq!(
            serde_json::from_str::<Value>(output).unwrap(),
            json!({"error":{"code":expected}})
        );
        assert!(matches!(
            events[1],
            ToolExecutionEvent::ToolExecutionFinished { is_error: true, .. }
        ));
        assert_eq!(registry.results["error"].output, *output);
        registry
            .execute_response(&response, |event| {
                assert!(matches!(event, ToolExecutionEvent::ToolResultReused { .. }))
            })
            .await
            .unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Sink(&'static str),
    Cancelled,
    Gateway,
}
impl From<GatewayError> for Stop {
    fn from(_: GatewayError) -> Self {
        Self::Gateway
    }
}

#[tokio::test]
async fn observer_failure_at_each_start_finish_and_reuse_stops_remaining_batch() {
    for sink in ["full", "closed", "failed"] {
        for fail_at in 0..5 {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let mut batch = registry
                .preflight(&response(&["first", "saved", "last", "later"]))
                .unwrap();
            let mut observed = 0;
            loop {
                let result = batch
                    .execute_next(
                        || Ok(()),
                        pending::<Stop>(),
                        |_| {
                            let index = observed;
                            observed += 1;
                            if index == fail_at {
                                Err(Stop::Sink(sink))
                            } else {
                                Ok(())
                            }
                        },
                    )
                    .await;
                if let Err(error) = result {
                    assert_eq!(error, Stop::Sink(sink));
                    break;
                }
                assert!(result.unwrap().is_some());
            }
            assert_eq!(observed, fail_at + 1);
            assert!(
                batch
                    .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap()
                    .is_none()
            );
            drop(batch);
            let executed = match fail_at {
                0 => 0,
                1..=3 => 1,
                4 => 2,
                _ => unreachable!(),
            };
            assert_eq!(calls.lock().unwrap().len(), 1 + executed);
            // A failed finish observer does not erase an actual completed result.
            assert_eq!(registry.results.len(), 1 + executed);
            assert!(!registry.results.contains_key("later"));
        }
    }
}

#[tokio::test]
async fn checkpoint_failure_before_new_or_reused_call_emits_nothing() {
    for reuse in [false, true] {
        for reason in [Stop::Sink("failed"), Stop::Cancelled] {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let first = if reuse { "saved" } else { "new" };
            let mut batch = registry.preflight(&response(&[first, "later"])).unwrap();
            let mut reason = Some(reason);
            let error = batch
                .execute_next(
                    || Err(reason.take().unwrap()),
                    pending::<Stop>(),
                    |_| panic!(),
                )
                .await;
            assert!(error.is_err());
            assert!(
                batch
                    .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap()
                    .is_none()
            );
            drop(batch);
            assert_eq!(calls.lock().unwrap().len(), 1);
            assert_eq!(registry.results.len(), 1);
        }
    }
}

#[tokio::test]
async fn cancellation_after_start_or_between_calls_prevents_later_work() {
    for cancel_at_start in [true, false] {
        for reuse_next in [true, false] {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let next = if reuse_next { "saved" } else { "next" };
            let mut batch = registry.preflight(&response(&["first", next])).unwrap();
            let cancelled = Cell::new(false);
            let checkpoint = || {
                if cancelled.get() {
                    Err(Stop::Cancelled)
                } else {
                    Ok(())
                }
            };
            let mut observed = 0;
            let result = batch
                .execute_next(checkpoint, pending::<Stop>(), |event| {
                    observed += 1;
                    if cancel_at_start
                        || matches!(event, ToolExecutionEvent::ToolExecutionFinished { .. })
                    {
                        cancelled.set(true);
                    }
                    Ok(())
                })
                .await;
            if cancel_at_start {
                assert_eq!(result.unwrap_err(), Stop::Cancelled);
                assert_eq!(observed, 1);
            } else {
                assert!(result.unwrap().is_some());
                assert_eq!(observed, 2);
                assert_eq!(
                    batch
                        .execute_next(checkpoint, pending::<Stop>(), |_| panic!())
                        .await
                        .unwrap_err(),
                    Stop::Cancelled
                );
            }
            drop(batch);
            let completed = usize::from(!cancel_at_start);
            assert_eq!(calls.lock().unwrap().len(), 1 + completed);
            assert_eq!(registry.results.len(), 1 + completed);
        }
    }
}

struct DropProbe(Arc<AtomicUsize>);
impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
struct PendingTool {
    started: Mutex<Option<oneshot::Sender<()>>>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
    invoked: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}
#[async_trait]
impl Tool for PendingTool {
    fn definition(&self) -> ToolDefinition {
        add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, _: Value) -> Result<Value> {
        self.invoked.fetch_add(1, Ordering::SeqCst);
        let _probe = DropProbe(self.dropped.clone());
        let release = self.release.lock().unwrap().take().unwrap();
        self.started
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        release.await.unwrap();
        Ok(json!({"sum":5}))
    }
}

#[tokio::test]
async fn cooperative_pending_tool_is_dropped_on_cancel_or_future_drop() {
    for mode in ["cancel", "drop"] {
        let (started_tx, mut started_rx) = oneshot::channel();
        let (_release_tx, release_rx) = oneshot::channel();
        let invoked = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(PendingTool {
                started: Mutex::new(Some(started_tx)),
                release: Mutex::new(Some(release_rx)),
                invoked: invoked.clone(),
                dropped: dropped.clone(),
            }))
            .unwrap();
        let mut batch = registry
            .preflight(&response(&["pending", "later"]))
            .unwrap();
        let mut events = Vec::new();
        if mode == "drop" {
            let mut future = Box::pin(batch.execute_next(
                || Ok(()),
                pending::<Stop>(),
                |event| {
                    events.push(event);
                    Ok(())
                },
            ));
            assert!(futures_util::poll!(future.as_mut()).is_pending());
            started_rx.try_recv().unwrap();
            drop(future);
        } else {
            let stop = async {
                started_rx.await.unwrap();
                let cancel = CancellationToken::new();
                cancel.cancel();
                cancel.cancelled().await;
                Stop::Cancelled
            };
            let error = batch
                .execute_next(
                    || Ok(()),
                    stop,
                    |event| {
                        events.push(event);
                        Ok(())
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error, Stop::Cancelled);
            assert!(
                batch
                    .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        drop(batch);
        assert_eq!(invoked.load(Ordering::SeqCst), 1);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(registry.results.is_empty());
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0],
            ToolExecutionEvent::ToolExecutionStarted { .. }
        ));
    }
}

#[tokio::test]
async fn ready_stop_wins_over_ready_tool_without_fabricating_finish() {
    let (mut registry, calls) = registry();
    let mut batch = registry.preflight(&response(&["first", "later"])).unwrap();
    let mut events = Vec::new();
    let result = batch
        .execute_next(
            || Ok(()),
            std::future::ready(Stop::Cancelled),
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await;
    assert_eq!(result.unwrap_err(), Stop::Cancelled);
    drop(batch);
    assert!(calls.lock().unwrap().is_empty());
    assert!(registry.results.is_empty());
    assert_eq!(events.len(), 1);
}
