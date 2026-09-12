use super::super::{consistency::Lifecycle, state::Conversation};
use super::*;
use crate::{InputItem, OutputProvenance, SessionOptions, Transport};
use serde_json::json;

const TERMINALS: [(&str, &str); 5] = [
    ("response.completed", "completed"),
    ("response.done", "completed"),
    ("response.incomplete", "incomplete"),
    ("response.failed", "failed"),
    ("response.cancelled", "cancelled"),
];

#[test]
fn r1_a05_empty_created_identity_is_not_published_or_assigned() {
    let mut decoder = ResponseDecoder::default();
    let result = decoder.apply(json!({"type":"response.created","response":{"id":""}}));
    assert!(
        matches!(
            &result,
            Err(GatewayError::Protocol("empty response identity"))
        ),
        "empty created identity must be rejected: event_count={:?}; assigned={:?}",
        result.as_ref().map(Vec::len),
        decoder.response_id
    );
    assert_eq!(result.err().unwrap().code(), "protocol_error");
    assert_eq!(decoder.response_id, None);
    assert!(!decoder.terminal_received && !decoder.finished);
}

#[test]
fn r1_a05_created_missing_or_non_string_identity_keeps_required_string_error() {
    for id in [
        None,
        Some(json!(null)),
        Some(json!(12)),
        Some(json!({})),
        Some(json!([])),
        Some(json!(false)),
    ] {
        let mut response = json!({});
        if let Some(id) = &id {
            response["id"] = id.clone();
        }
        let mut decoder = ResponseDecoder::default();
        let result = decoder.apply(json!({"type":"response.created","response":response}));
        assert!(
            matches!(
                result,
                Err(GatewayError::Protocol("required string missing"))
            ),
            "required created id {id:?}: {:?}",
            result.as_ref().err()
        );
        assert_eq!(decoder.response_id, None);
        assert!(!decoder.terminal_received && !decoder.finished);
    }
}

#[test]
fn r1_a05_parse_response_rejects_empty_terminal_identity() {
    for (kind, status) in TERMINALS {
        let result = parse_response(json!({"id":"","status":status,"output":[]}));
        assert!(
            matches!(
                &result,
                Err(GatewayError::Protocol("empty response identity"))
            ),
            "{kind} must reject empty terminal identity: {result:?}"
        );
        assert_eq!(result.unwrap_err().code(), "protocol_error");
    }
}

#[test]
fn r1_a05_empty_terminal_only_identity_is_not_started_finished_or_received() {
    for (kind, status) in TERMINALS {
        let mut decoder = ResponseDecoder::default();
        let result =
            decoder.apply(json!({"type":kind,"response":{"id":"","status":status,"output":[]}}));
        assert!(
            matches!(
                &result,
                Err(GatewayError::Protocol("empty response identity"))
            ),
            "{kind} must reject empty terminal identity: event_count={:?}; assigned={:?}, terminal_received={}, finished={}",
            result.as_ref().map(Vec::len),
            decoder.response_id,
            decoder.terminal_received,
            decoder.finished
        );
        assert_eq!(result.err().unwrap().code(), "protocol_error");
        assert_eq!(decoder.response_id, None);
        assert!(!decoder.terminal_received && !decoder.finished);
    }
}

#[test]
fn r1_a05_empty_terminal_after_valid_start_keeps_only_prior_identity() {
    for (kind, status) in TERMINALS {
        let mut decoder = ResponseDecoder::default();
        let start = decoder
            .apply(json!({"type":"response.created","response":{"id":"r"}}))
            .unwrap();
        assert!(
            matches!(start.as_slice(), [ProviderEvent::ResponseStarted { response_id }] if response_id == "r")
        );
        let result =
            decoder.apply(json!({"type":kind,"response":{"id":"","status":status,"output":[]}}));
        assert!(
            matches!(
                result,
                Err(GatewayError::Protocol("empty response identity"))
            ),
            "{kind} after valid start: {:?}",
            result.as_ref().err()
        );
        assert_eq!(decoder.response_id.as_deref(), Some("r"));
        assert!(!decoder.terminal_received && !decoder.finished);
    }
}

#[test]
fn r1_a05_terminal_missing_or_non_string_identity_keeps_required_string_error() {
    for (kind, status) in TERMINALS {
        for id in [
            None,
            Some(json!(null)),
            Some(json!(12)),
            Some(json!({})),
            Some(json!([])),
            Some(json!(false)),
        ] {
            let mut native = json!({"status":status,"output":[]});
            if let Some(id) = &id {
                native["id"] = id.clone();
            }
            let parsed = parse_response(native.clone());
            assert!(
                matches!(
                    parsed,
                    Err(GatewayError::Protocol("required string missing"))
                ),
                "{kind} required id {id:?}: {parsed:?}"
            );
            for started in [false, true] {
                let mut decoder = ResponseDecoder::default();
                if started {
                    decoder
                        .apply(json!({"type":"response.created","response":{"id":"r"}}))
                        .unwrap();
                }
                let result = decoder.apply(json!({"type":kind,"response":native}));
                assert!(
                    matches!(
                        result,
                        Err(GatewayError::Protocol("required string missing"))
                    ),
                    "{kind} required id {id:?}, started={started}: {:?}",
                    result.as_ref().err()
                );
                assert_eq!(
                    decoder.response_id.as_deref(),
                    if started { Some("r") } else { None }
                );
                assert!(!decoder.terminal_received && !decoder.finished);
            }
        }
    }
}

#[test]
fn r1_a05_nonempty_terminal_only_and_matching_created_ids_remain_opaque() {
    for id in [
        "r".to_owned(),
        " \t\r\n ".to_owned(),
        "非 ASCII/\0opaque".to_owned(),
        "x".repeat(513),
    ] {
        for (kind, status) in TERMINALS {
            for started in [false, true] {
                let mut decoder = ResponseDecoder::default();
                if started {
                    let events = decoder
                        .apply(json!({"type":"response.created","response":{"id":id}}))
                        .unwrap();
                    assert!(
                        matches!(events.as_slice(), [ProviderEvent::ResponseStarted { response_id }] if response_id == &id)
                    );
                }
                let native =
                    json!({"id":id,"status":status,"output":[],"future_metadata":{"opaque":true}});
                let parsed = parse_response(native.clone()).unwrap();
                assert_eq!(parsed.id, id);
                assert_eq!(parsed.native, native);
                let events = decoder
                    .apply(json!({"type":kind,"response":native}))
                    .unwrap();
                assert_eq!(events.len(), if started { 1 } else { 2 });
                if !started {
                    assert!(
                        matches!(&events[0], ProviderEvent::ResponseStarted { response_id } if response_id == &id)
                    );
                }
                let ProviderEvent::ResponseFinished { response } = events.last().unwrap() else {
                    panic!("missing terminal response");
                };
                assert_eq!(response.id, id);
                assert_eq!(response.native, native);
                let expected = match status {
                    "completed" => ResponseOutcome::Completed,
                    "incomplete" => ResponseOutcome::Incomplete { reason: None },
                    "failed" => ResponseOutcome::Failed,
                    "cancelled" => ResponseOutcome::Cancelled,
                    _ => unreachable!(),
                };
                assert_eq!(response.outcome, expected);
                assert_eq!(decoder.response_id.as_deref(), Some(id.as_str()));
                assert!(decoder.terminal_received && decoder.finished);
            }
        }
    }
}

#[test]
fn r1_a05_empty_content_deltas_and_initial_arguments_remain_valid() {
    for (event_type, expected_kind) in [
        ("response.output_text.delta", DeltaKind::Text),
        ("response.refusal.delta", DeltaKind::Refusal),
        (
            "response.reasoning_summary_text.delta",
            DeltaKind::ReasoningSummary,
        ),
        ("response.reasoning_text.delta", DeltaKind::ReasoningText),
        (
            "response.function_call_arguments.delta",
            DeltaKind::FunctionArguments,
        ),
        (
            "response.custom_tool_call_input.delta",
            DeltaKind::CustomToolInput,
        ),
    ] {
        let mut decoder = ResponseDecoder::default();
        decoder
            .apply(json!({"type":"response.created","response":{"id":"r"}}))
            .unwrap();
        let events = decoder.apply(json!({"type":event_type,"response_id":"r","item_id":"i","output_index":0,"content_index":0,"summary_index":0,"delta":""})).unwrap();
        assert!(
            matches!(events.as_slice(), [ProviderEvent::OutputItemUpdated { response_id, kind, delta, .. }]
            if response_id == "r" && *kind == expected_kind && delta.is_empty())
        );
        assert!(!decoder.terminal_received && !decoder.finished);
    }
    let native = json!({"id":"r","status":"completed","output":[{"id":"m","type":"message","content":[{"type":"output_text","text":""},{"type":"refusal","refusal":""}]}]});
    let mut decoder = ResponseDecoder::default();
    let events = decoder
        .apply(json!({"type":"response.completed","response":native}))
        .unwrap();
    let ProviderEvent::ResponseFinished { response } = events.last().unwrap() else {
        panic!("missing terminal response");
    };
    assert_eq!(response.text, "");
    assert_eq!(response.native, native);
    assert!(decoder.terminal_received && decoder.finished);

    let mut decoder = ResponseDecoder::default();
    decoder
        .apply(json!({"type":"response.created","response":{"id":"r"}}))
        .unwrap();
    let events = decoder.apply(json!({"type":"response.output_item.added","output_index":0,"item":{"id":"i","type":"function_call","call_id":"c","name":"add_numbers","arguments":"","status":"in_progress"}})).unwrap();
    let [ProviderEvent::OutputItemStarted { item, .. }] = events.as_slice() else {
        panic!("missing initial function item");
    };
    // Initial arguments and delta fragments are observed, never executed here.
    let call = item.function_call.as_ref().unwrap();
    assert_eq!(call.arguments, "");
    assert!(!call.complete);
}

#[test]
fn r1_a05_identity_rejection_precedes_terminal_only_recovery_failure() {
    for (id, expected_error, received) in [
        ("", "empty response identity", false),
        ("r", "invalid finalized output recovery", true),
    ] {
        let mut decoder = ResponseDecoder::default();
        let extension = json!({"type":"response.future_item","item_id":"m","opaque":{"id":""}});
        let events = decoder.apply(extension.clone()).unwrap();
        assert!(
            matches!(events.as_slice(), [ProviderEvent::ProviderExtension { payload, .. }] if payload == &extension)
        );
        let result = decoder.apply(json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[]}}));
        assert!(
            matches!(result, Err(GatewayError::Protocol(message)) if message == expected_error)
        );
        assert_eq!(decoder.terminal_received, received);
        assert_eq!(
            decoder.response_id.as_deref(),
            if received { Some(id) } else { None }
        );
        assert!(!decoder.finished);
    }
}

#[test]
fn r1_a05_empty_terminal_does_not_consume_finalized_items() {
    for kind in ["response.completed", "response.done"] {
        let mut decoder = ResponseDecoder::default();
        decoder
            .apply(json!({"type":"response.created","response":{"id":"r"}}))
            .unwrap();
        let item =
            json!({"id":"m","type":"message","content":[{"type":"output_text","text":"answer"}]});
        decoder.apply(json!({"type":"response.output_item.done","response_id":"r","output_index":0,"item":item})).unwrap();
        let result = decoder
            .apply(json!({"type":kind,"response":{"id":"","status":"completed","output":[]}}));
        assert!(matches!(
            result,
            Err(GatewayError::Protocol("empty response identity"))
        ));
        assert_eq!(decoder.response_id.as_deref(), Some("r"));
        assert!(!decoder.terminal_received && !decoder.finished);
        // Recovery consumes its evidence, so retained items prove it did not run.
        assert_eq!(decoder.finalized.recover("r").unwrap(), vec![item]);
    }
}

#[test]
fn r1_a05_recovered_output_preserves_opaque_identity_and_state_continuation() {
    let id = " \t\n ";
    let message = json!({"id":"m","type":"message","content":[{"type":"output_text","text":"answer"}],"future_metadata":{"opaque":true}});
    let call = json!({"id":"i","type":"function_call","call_id":"c","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"});
    for kind in ["response.completed", "response.done"] {
        for transport in [Transport::WebSocket, Transport::Sse] {
            let mut decoder = ResponseDecoder::default();
            let mut lifecycle = Lifecycle::default();
            for native in [
                json!({"type":"response.created","response":{"id":id}}),
                json!({"type":"response.future_metadata","opaque":{"id":""}}),
                json!({"type":"response.output_item.done","response_id":id,"output_index":0,"item":message}),
                json!({"type":"response.output_item.done","response_id":id,"output_index":1,"item":call}),
            ] {
                for event in decoder.apply(native).unwrap() {
                    lifecycle.observe(&event).unwrap();
                }
            }
            let native =
                json!({"id":id,"status":"completed","output":[],"future_metadata":{"opaque":true}});
            let events = decoder
                .apply(json!({"type":kind,"response":native}))
                .unwrap();
            let [ProviderEvent::ResponseFinished { response }] = events.as_slice() else {
                panic!("missing recovered response");
            };
            lifecycle.observe(&events[0]).unwrap();
            lifecycle.validate(response).unwrap();
            assert_eq!(response.id, id);
            assert_eq!(response.text, "answer");
            assert_eq!(response.native, native);
            assert_eq!(
                response.output_provenance,
                OutputProvenance::ValidatedOutputItemDone
            );
            assert_eq!(response.output.len(), 2);
            assert_eq!(response.output[0].native, message);
            assert_eq!(response.output[1].native, call);
            assert!(response.output[1].function_call.as_ref().unwrap().complete);
            assert!(decoder.terminal_received && decoder.finished);

            let mut options = SessionOptions::new("synthetic");
            options.transport = transport;
            let mut conversation = Conversation::default();
            let (_, full) = conversation
                .prepare(&options, &[InputItem::user("add")])
                .unwrap();
            conversation.settle(full, response).unwrap();
            assert!(
                conversation
                    .prepare(&options, &[InputItem::user("skip results")])
                    .is_err()
            );
            let (body, full) = conversation
                .prepare(
                    &options,
                    &[InputItem::ToolResult {
                        call_id: "c".into(),
                        output: "{\"sum\":42}".into(),
                    }],
                )
                .unwrap();
            assert_eq!(full.len(), 4);
            assert_eq!(full[1], message);
            assert_eq!(full[2], call);
            if transport == Transport::WebSocket {
                assert_eq!(body["previous_response_id"], id);
                assert_eq!(body["input"], json!([full[3]]));
            } else {
                assert!(body.get("previous_response_id").is_none());
                assert_eq!(body["input"], json!(full));
            }
        }
    }
}

#[test]
fn r1_a05_valid_terminal_keeps_received_after_consistency_rejection() {
    let mut decoder = ResponseDecoder::default();
    let mut lifecycle = Lifecycle::default();
    for native in [
        json!({"type":"response.created","response":{"id":"r"}}),
        json!({"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"before"}),
    ] {
        for event in decoder.apply(native).unwrap() {
            lifecycle.observe(&event).unwrap();
        }
    }
    let events = decoder.apply(json!({"type":"response.completed","response":{"id":"r","status":"completed","output":[{"id":"m","type":"message","content":[{"type":"output_text","text":"after"}]}]}})).unwrap();
    let [ProviderEvent::ResponseFinished { response }] = events.as_slice() else {
        panic!("missing decoded response");
    };
    lifecycle.observe(&events[0]).unwrap();
    assert!(matches!(
        lifecycle.validate(response),
        Err(GatewayError::Protocol(_))
    ));
    assert_eq!(decoder.response_id.as_deref(), Some("r"));
    assert!(decoder.terminal_received && decoder.finished);
}
