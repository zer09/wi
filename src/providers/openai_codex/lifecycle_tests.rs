use super::super::observation::{
    MAX_DIAGNOSTIC_TEXT, Observation, SmokeCase, SmokeObserver, TextState,
};
use super::*;

#[tokio::test]
async fn decoder_done_only_material_never_authorizes_execution_or_result_delivery() {
    for transport in [Transport::WebSocket, Transport::Sse] {
        for status in [
            None,
            Some(json!("completed")),
            Some(Value::Null),
            Some(json!(false)),
            Some(json!({})),
        ] {
            let mut decoder = codec::ResponseDecoder::default();
            let mut events = decoder
                .apply(json!({"type":"response.created","response":{"id":"response"}}))
                .unwrap();
            events.extend(decoder.apply(json!({"type":"response.output_text.delta","item_id":"message","output_index":0,"content_index":0,"delta":"visible"})).unwrap());
            let message = json!({"id":"message","type":"message","content":[{"type":"output_text","text":"visible"}],"private-extra":"sentinel"});
            let mut call = json!({"id":"call-item","type":"function_call","call_id":"call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"});
            if let Some(status) = &status {
                call["status"] = status.clone();
            }
            for (index, item) in [message.clone(), call.clone()].into_iter().enumerate() {
                events.extend(decoder.apply(json!({"type":"response.output_item.done","output_index":index,"item":item})).unwrap());
            }
            let native = json!({"id":"response","status":"completed","output":[],"private-native":"unchanged"});
            let terminal = decoder.apply(json!({"type":"response.completed","response":native}));
            if status.is_some() && status != Some(json!("completed")) {
                assert!(terminal.is_err());
                assert!(decoder.terminal_received);
                assert!(!decoder.finished);
                continue;
            }
            // Intentional policy change: a complete validated done batch is effective output.
            events.extend(terminal.unwrap());
            let finished: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    ProviderEvent::OutputItemFinished { item, .. } => Some(item),
                    _ => None,
                })
                .collect();
            assert_eq!(finished.len(), 2);
            assert_eq!(finished[0].native, message);
            assert_eq!(finished[1].native, call);
            assert_eq!(
                finished[1].function_call.as_ref().unwrap().complete,
                status.is_none() || status == Some(json!("completed"))
            );
            let ProviderEvent::ResponseFinished { response } = events.last().unwrap() else {
                panic!("missing terminal")
            };
            assert!(decoder.finished);
            assert_eq!(response.outcome, ResponseOutcome::Completed);
            assert_eq!(response.output.len(), 2);
            assert_eq!(response.text, "visible");
            assert_eq!(
                response.output_provenance,
                crate::OutputProvenance::ValidatedOutputItemDone
            );
            assert_eq!(response.native, native);
            let mut registry = ToolRegistry::new();
            registry.register(Arc::new(AddNumbers)).unwrap();
            let mut execution_events = 0;
            let results = registry
                .execute_response(response, |_| execution_events += 1)
                .await
                .unwrap();
            assert_eq!(execution_events, 2);
            assert!(
                matches!(&results[0], InputItem::ToolResult { call_id, output } if call_id == "call" && output == "{\"sum\":42}")
            );
            let mut options = SessionOptions::new("synthetic");
            options.transport = transport;
            options.tools = registry.definitions();
            let mut conversation = state::Conversation::default();
            let (body, full) = conversation
                .prepare(&options, &[InputItem::user("synthetic")])
                .unwrap();
            assert_eq!(body["tool_choice"], "auto");
            conversation.settle(full, response).unwrap();
            assert!(
                conversation
                    .prepare(
                        &options,
                        &[InputItem::ToolResult {
                            call_id: "call".into(),
                            output: "{\"sum\":42}".into()
                        }]
                    )
                    .is_ok()
            );
            // Effective calls require their correlated result before continuation.
            assert!(
                conversation
                    .prepare(&options, &[InputItem::user("next")])
                    .is_err()
            );
        }
    }
}

#[test]
fn observer_terminal_shape_reasons_counts_and_reset_are_allowlisted() {
    for (output, expected) in [
        (None, TextState::MissingOrInvalidOutput),
        (Some(json!(null)), TextState::MissingOrInvalidOutput),
        (Some(json!([])), TextState::NoOrdinaryParts),
        (
            Some(json!([{"type":"message","content":[]}])),
            TextState::NoOrdinaryParts,
        ),
        (
            Some(json!([{"type":"message","content":null}])),
            TextState::MalformedContent,
        ),
        (
            Some(json!([{"type":"message","content":[{"type":"output_text","text":false}]}])),
            TextState::MalformedContent,
        ),
        (
            Some(
                json!([{"type":"message","content":[{"type":"refusal","refusal":"private-sentinel"}]}]),
            ),
            TextState::UnsupportedKindOrPart,
        ),
        (
            Some(json!([{"type":"private-sentinel"}])),
            TextState::UnsupportedKindOrPart,
        ),
        (
            Some(
                json!([{"type":"message","content":[{"type":"output_text","text":"x".repeat(MAX_DIAGNOSTIC_TEXT+1)}]}]),
            ),
            TextState::OverLimit,
        ),
        (
            Some(
                json!([{"type":"message","content":[{"type":"output_text","text":"private-sentinel"}]}]),
            ),
            TextState::Available,
        ),
    ] {
        let observer = SmokeObserver::default();
        let mut observation =
            Observation::new(observer.clone(), SmokeCase::Text, Transport::WebSocket);
        observation.send(&json!({"input":[]}));
        for kind in ["message", "function_call", "reasoning", "private-sentinel"] {
            observation.native(&json!({"type":"response.output_item.done","item":{"type":kind,"id":"private-sentinel"}}));
        }
        observation.native(&json!({"type":"response.output_item.done","item":null}));
        let mut response = json!({"id":"private-sentinel","status":"completed"});
        if let Some(output) = output {
            response["output"] = output;
        }
        observation.native(&json!({"type":"response.completed","response":response}));
        let snapshot = observer.snapshot();
        let record = &snapshot[0];
        assert_eq!(record.terminal_text_state, expected);
        assert!(!record.validated_terminal);
        assert_eq!(
            record.normalized_native_text_unavailable,
            Some(TextState::NotValidated)
        );
        assert_eq!(record.streamed_text_state, TextState::NoDeltas);
        if expected == TextState::Available {
            assert_eq!(record.native_expected_text_equal, Some(false));
            assert_eq!(record.native_expected_text_unavailable, None);
            assert_eq!(
                record.streamed_native_text_unavailable,
                Some(TextState::NoDeltas)
            );
        } else {
            assert_eq!(record.native_expected_text_equal, None);
            assert_eq!(record.native_expected_text_unavailable, Some(expected));
        }
        assert_eq!(record.finalized_items.total, 5);
        assert_eq!(record.finalized_items.message, 1);
        assert_eq!(record.finalized_items.function_call, 1);
        assert_eq!(record.finalized_items.reasoning, 1);
        assert_eq!(record.finalized_items.other, 1);
        assert_eq!(record.finalized_items.malformed, 1);
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("private-sentinel")
        );
        assert!(!format!("{snapshot:?}").contains("private-sentinel"));
        for _ in 0..4097 {
            observation
                .native(&json!({"type":"response.output_item.done","item":{"type":"message"}}));
        }
        assert_eq!(observer.snapshot()[0].finalized_items.total, 4096);
        assert_eq!(observer.snapshot()[0].finalized_items.message, 4096);
        assert!(observer.snapshot()[0].finalized_items.overflow);
        observation.send(&json!({"input":[]}));
        assert_eq!(observer.snapshot()[1].finalized_items.total, 0);
        assert_eq!(
            observer.snapshot()[1].terminal_text_state,
            TextState::NoTerminal
        );
        assert_eq!(snapshot[0].finalized_items.total, 5);
    }
}
