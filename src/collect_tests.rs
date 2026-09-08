use super::*;
use harness_gateway::{EventEnvelope, ItemKind, OutputItem, RequestReceipt, SessionControl};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Control(AtomicUsize);
#[async_trait::async_trait]
impl SessionControl for Control {
    async fn generate(&self, _: Vec<InputItem>) -> Result<RequestReceipt> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(RequestReceipt {
            request_id: "request".into(),
        })
    }
    fn close(&self) {}
}
fn message(text: &str) -> OutputItem {
    OutputItem {
        id: Some("message".into()),
        kind: ItemKind::Message,
        native_type: "message".into(),
        function_call: None,
        native: json!({"id":"message","type":"message","content":[{"type":"output_text","text":text}]}),
    }
}
fn function_call() -> OutputItem {
    OutputItem {
        id: Some("call-item".into()),
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(harness_gateway::FunctionCall {
            call_id: "call".into(),
            name: "add_numbers".into(),
            arguments: "{\"a\":17,\"b\":25}".into(),
            origin: harness_gateway::CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"type":"function_call","id":"call-item","call_id":"call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"}),
    }
}
fn final_event(output: Vec<OutputItem>, text: &str) -> ProviderEvent {
    ProviderEvent::ResponseFinished {
        response: ModelResponse {
            output_provenance: Default::default(),
            id: "response".into(),
            model: None,
            outcome: ResponseOutcome::Completed,
            native: json!({"id":"response","status":"completed","output":output.iter().map(|i| &i.native).collect::<Vec<_>>()}),
            output,
            text: text.into(),
            usage: None,
        },
    }
}
fn update(text: &str) -> ProviderEvent {
    ProviderEvent::OutputItemUpdated {
        response_id: "response".into(),
        item_id: "message".into(),
        output_index: 0,
        content_index: Some(0),
        summary_index: None,
        kind: DeltaKind::Text,
        delta: text.into(),
    }
}
fn done(item: OutputItem) -> ProviderEvent {
    ProviderEvent::OutputItemFinished {
        response_id: "response".into(),
        output_index: 0,
        item,
    }
}
fn session(events: Vec<ProviderEvent>) -> (ProviderSession, Arc<Control>) {
    let control = Arc::new(Control::default());
    let envelopes = events
        .into_iter()
        .enumerate()
        .map(|(sequence, event)| EventEnvelope {
            schema_version: 1,
            sequence: sequence as u64,
            event_id: "event".into(),
            session_id: "session".into(),
            request_id: Some("request".into()),
            provider: "synthetic".into(),
            provider_sequence: None,
            event,
        });
    (
        ProviderSession {
            id: "session".into(),
            control: control.clone(),
            events: Box::pin(futures_util::stream::iter(envelopes)),
        },
        control,
    )
}
#[tokio::test]
async fn collect_rejects_discarded_or_changed_stream_before_second_send_or_execution() {
    for json_mode in [false, true] {
        let call = function_call();
        for events in [
            vec![update("visible"), final_event(vec![], "")],
            vec![done(message("visible")), final_event(vec![], "")],
            vec![done(call), final_event(vec![], "")],
            vec![
                update("visible"),
                final_event(vec![message("different")], "different"),
            ],
            vec![
                done(message("visible")),
                final_event(vec![message("different")], "different"),
            ],
        ] {
            let (mut session, control) = session(events);
            let mut registry = ToolRegistry::new();
            registry.register(Arc::new(AddNumbers)).unwrap();
            let mut executions = 0;
            let result = async {
                let response = collect(&mut session, "request", json_mode).await?;
                registry
                    .execute_response(&response, |_| executions += 1)
                    .await?;
                control.generate(vec![InputItem::user("follow up")]).await?;
                Result::Ok(())
            }
            .await;
            assert!(result.is_err(), "discarded evidence must fail collect");
            assert_eq!(executions, 0);
            assert_eq!(control.0.load(Ordering::SeqCst), 0);
        }
    }
}
#[tokio::test]
async fn collect_accepts_recovered_effective_output_without_native_guard_false_failure() {
    for mode in [false, true] {
        let mut terminal = final_event(vec![message("visible")], "visible");
        if let ProviderEvent::ResponseFinished { response } = &mut terminal {
            response.native["output"] = json!([]);
            response.output_provenance = harness_gateway::OutputProvenance::ValidatedOutputItemDone;
        }
        let (mut session, _) = session(vec![update("vis"), done(message("visible")), terminal]);
        let response = collect(&mut session, "request", mode).await.unwrap();
        assert_eq!(response.text, "visible");
        assert_eq!(response.native["output"], json!([]));
    }
}

#[tokio::test]
async fn collect_bounds_duplicate_events_and_resets_each_request() {
    for mode in [false, true] {
        let mut events = vec![done(message(&"a".repeat(300_000))); 4];
        events.push(final_event(vec![], ""));
        let (mut bounded, _) = session(events);
        assert!(collect(&mut bounded, "request", mode).await.is_err());
        let mut events = vec![done(message("")); 513];
        events.push(final_event(vec![message("")], ""));
        let (mut bounded, _) = session(events);
        assert!(collect(&mut bounded, "request", mode).await.is_err());
        let mut events = vec![update(""); collect_lifecycle::MAX_EVENTS + 1];
        events.push(final_event(vec![], ""));
        let (mut bounded, _) = session(events);
        assert!(collect(&mut bounded, "request", mode).await.is_err());
        let (mut repeated, _) = session(vec![
            update("first"),
            final_event(vec![message("first")], "first"),
            final_event(vec![], ""),
        ]);
        collect(&mut repeated, "request", mode).await.unwrap();
        assert!(
            collect(&mut repeated, "request", mode)
                .await
                .unwrap()
                .text
                .is_empty()
        );
    }
}
#[tokio::test]
async fn collect_rejects_conflicting_ids_indexes_and_refusal_loss() {
    for mode in [false, true] {
        let mut refusal = update("refused");
        if let ProviderEvent::OutputItemUpdated { kind, .. } = &mut refusal {
            *kind = DeltaKind::Refusal;
        }
        let mut changed_id = message("answer");
        changed_id.id = Some("different".into());
        let mut changed_index = done(message("answer"));
        if let ProviderEvent::OutputItemFinished { output_index, .. } = &mut changed_index {
            *output_index = 1;
        }
        let mut no_id = message("answer");
        no_id.id = None;
        for events in [
            vec![refusal, final_event(vec![], "")],
            vec![
                done(changed_id),
                final_event(vec![message("answer")], "answer"),
            ],
            vec![
                update("ans"),
                changed_index,
                final_event(vec![message("answer")], "answer"),
            ],
            vec![done(no_id), final_event(vec![], "")],
        ] {
            let (mut session, _) = session(events);
            assert!(collect(&mut session, "request", mode).await.is_err());
        }
    }
}
#[tokio::test]
async fn collect_accepts_interleaved_parts_without_arrival_order_authority() {
    for mode in [false, true] {
        let mut second = message("BC");
        second.id = Some("second".into());
        second.native["id"] = json!("second");
        let mut b = update("B");
        if let ProviderEvent::OutputItemUpdated {
            output_index,
            item_id,
            ..
        } = &mut b
        {
            *output_index = 1;
            *item_id = "second".into();
        }
        let mut first = message("AD");
        first.native["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"output_text","text":"E"}));
        let mut e = update("E");
        if let ProviderEvent::OutputItemUpdated { content_index, .. } = &mut e {
            *content_index = Some(1);
        }
        let (mut session, _) = session(vec![
            b,
            e,
            update("A"),
            final_event(vec![first, second], "ADEBC"),
        ]);
        assert_eq!(
            collect(&mut session, "request", mode).await.unwrap().text,
            "ADEBC"
        );
    }
}

#[tokio::test]
async fn collect_rejects_type_conflicts_and_conservative_metadata_changes() {
    for mode in [false, true] {
        let mut wrong_type = message("answer");
        wrong_type.kind = ItemKind::Reasoning;
        let mut enriched = message("answer");
        enriched.native["metadata"] = json!({"extra":true});
        for events in [
            vec![
                update("ans"),
                final_event(vec![wrong_type.clone()], "answer"),
            ],
            vec![
                done(wrong_type),
                update("ans"),
                final_event(vec![message("answer")], "answer"),
            ],
            vec![
                done(message("answer")),
                final_event(vec![enriched], "answer"),
            ],
        ] {
            let (mut session, _) = session(events);
            assert!(collect(&mut session, "request", mode).await.is_err());
        }
    }
}

#[tokio::test]
async fn collect_preserves_terminal_only_matching_suffix_and_empty_streams() {
    for mode in [false, true] {
        for events in [
            vec![final_event(vec![], "")],
            vec![
                done(function_call()),
                final_event(vec![function_call()], ""),
            ],
            vec![
                done(message("answer")),
                final_event(vec![message("answer")], "answer"),
            ],
            vec![final_event(vec![message("answer")], "answer")],
            vec![
                update("ans"),
                final_event(vec![message("answer")], "answer"),
            ],
            vec![
                update("answer"),
                done(message("answer")),
                final_event(vec![message("answer")], "answer"),
            ],
            vec![update(""), final_event(vec![], "")],
        ] {
            let (mut session, _) = session(events);
            let response = collect(&mut session, "request", mode).await.unwrap();
            assert_eq!(
                response.native["output"].as_array().unwrap().len(),
                response.output.len()
            );
        }
    }
}
