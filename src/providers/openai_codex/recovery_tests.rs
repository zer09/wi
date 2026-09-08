use super::*;
use crate::OutputProvenance;
use serde_json::json;

fn message(id: &str) -> Value {
    json!({"id":id,"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"answer"}]})
}
fn call(id: &str) -> Value {
    json!({"id":id,"type":"function_call","call_id":id,"name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"})
}
fn decoder() -> ResponseDecoder {
    let mut d = ResponseDecoder::default();
    d.apply(json!({"type":"response.created","response":{"id":"r"}}))
        .unwrap();
    d
}
fn done(d: &mut ResponseDecoder, index: usize, item: Value) {
    d.apply(json!({"type":"response.output_item.done","output_index":index,"item":item}))
        .unwrap();
}
fn terminal(d: &mut ResponseDecoder) -> Result<ModelResponse> {
    let events = d.apply(
        json!({"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}),
    )?;
    match events.into_iter().last().unwrap() {
        ProviderEvent::ResponseFinished { response } => Ok(response),
        _ => panic!("missing terminal"),
    }
}
#[test]
fn recovery_terminal_trigger_table() {
    for kind in [
        "response.completed",
        "response.done",
        "response.failed",
        "response.cancelled",
        "response.incomplete",
    ] {
        for status in [
            None,
            Some(json!(null)),
            Some(json!(false)),
            Some(json!("completed")),
            Some(json!("failed")),
            Some(json!("cancelled")),
            Some(json!("incomplete")),
            Some(json!("in_progress")),
        ] {
            for output in [
                None,
                Some(json!(null)),
                Some(json!([])),
                Some(json!([message("native")])),
                Some(json!({})),
            ] {
                let mut d = decoder();
                done(&mut d, 0, message("done"));
                let mut native = json!({"id":"r"});
                if let Some(status) = &status {
                    native["status"] = status.clone();
                }
                if let Some(output) = &output {
                    native["output"] = output.clone();
                }
                let parsed = parse_response(native.clone());
                let valid = parsed.as_ref().is_ok_and(|r| {
                    matches!(kind, "response.completed" | "response.done")
                        || r.outcome != ResponseOutcome::Completed
                });
                let result = d.apply(json!({"type":kind,"response":native}));
                assert_eq!(result.is_ok(), valid);
                assert_eq!(d.terminal_received, valid);
                if let Ok(events) = result {
                    let ProviderEvent::ResponseFinished { response } = events.last().unwrap()
                    else {
                        panic!("terminal")
                    };
                    assert_eq!(response.native, native);
                    let recovered = status == Some(json!("completed")) && output == Some(json!([]));
                    assert_eq!(
                        response.output_provenance == OutputProvenance::ValidatedOutputItemDone,
                        recovered
                    );
                    if !recovered {
                        assert_eq!(response.output_provenance, OutputProvenance::NativeTerminal);
                    }
                }
            }
        }
    }
}
#[test]
fn recovery_empty_done_only_and_orphan_evidence() {
    let mut empty = decoder();
    assert_eq!(
        terminal(&mut empty).unwrap().output_provenance,
        OutputProvenance::NativeTerminal
    );
    for event in [
        json!({"type":"response.output_item.added","output_index":0,"item":message("m")}),
        json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","content_index":0,"delta":"a"}),
        json!({"type":"response.output_text.done","output_index":0,"item_id":"m","content_index":0,"text":"answer"}),
        json!({"type":"response.future","item_id":"m"}),
    ] {
        let mut d = decoder();
        d.apply(event).unwrap();
        assert!(terminal(&mut d).is_err());
        assert!(d.terminal_received && !d.finished);
    }
    let mut d = decoder();
    d.apply(json!({"type":"response.future_metadata","opaque":"private"}))
        .unwrap();
    done(&mut d, 1, call("c"));
    done(&mut d, 0, message("m"));
    let response = terminal(&mut d).unwrap();
    assert_eq!(response.output[0].id.as_deref(), Some("m"));
    assert_eq!(response.text, "answer");
    assert_eq!(response.native["output"], json!([]));
}
#[test]
fn recovery_rejects_entire_malformed_or_advanced_batch() {
    let mut invalid = vec![];
    for field in [
        "arguments",
        "status",
        "namespace",
        "caller",
        "call_id",
        "name",
        "id",
    ] {
        for value in [
            json!(null),
            json!(false),
            json!(12),
            json!({}),
            json!(""),
            json!("x".repeat(513)),
        ] {
            if ["namespace", "caller"].contains(&field) && value.is_null() {
                continue;
            }
            let mut item = call("c");
            item[field] = value;
            invalid.push(item);
        }
    }
    for args in ["[]", "null", "17", "{", "\"text\""] {
        let mut item = call("c");
        item["arguments"] = json!(args);
        invalid.push(item);
    }
    for status in ["in_progress", "failed", "cancelled", "incomplete"] {
        let mut item = call("c");
        item["status"] = json!(status);
        invalid.push(item);
    }
    for kind in [
        "custom_tool_call",
        "tool_search_call",
        "tool_search_output",
        "program",
        "program_output",
        "future",
    ] {
        let mut item = call("c");
        item["type"] = json!(kind);
        invalid.push(item);
    }
    for content in [
        json!(null),
        json!([{"type":"output_text","text":false}]),
        json!([{"type":"future","text":"a"}]),
        json!([{"type":"refusal"}]),
    ] {
        let mut item = message("m2");
        item["content"] = content;
        invalid.push(item);
    }
    let mut wrong_role = message("m2");
    wrong_role["role"] = json!("user");
    invalid.push(wrong_role);
    for item in invalid {
        let mut d = decoder();
        done(&mut d, 0, message("m"));
        // Some malformed native fields retain their existing immediate codec error.
        let applied =
            d.apply(json!({"type":"response.output_item.done","output_index":1,"item":item}));
        if applied.is_ok() {
            assert!(terminal(&mut d).is_err());
            assert!(d.terminal_received);
        }
        assert!(!d.finished);
    }
}
#[test]
fn recovery_identity_dense_bounds_and_native_authority() {
    for n in [1, 512, 513] {
        let mut d = decoder();
        for i in (0..n).rev() {
            done(&mut d, i, message(&format!("m{i}")));
        }
        assert_eq!(terminal(&mut d).is_ok(), n <= 512);
    }
    for items in [
        vec![(511, message("m"))],
        vec![(512, message("m"))],
        vec![(0, message("m")), (0, message("m"))],
        vec![(0, message("m")), (1, message("m"))],
        vec![
            (0, call("c")),
            (1, {
                let mut c = call("other");
                c["call_id"] = json!("c");
                c
            }),
        ],
    ] {
        let mut d = decoder();
        for (i, item) in items {
            done(&mut d, i, item);
        }
        assert!(terminal(&mut d).is_err());
    }
    let mut d = decoder();
    done(&mut d, 512, message("discarded"));
    let native = json!({"id":"r","status":"completed","output":[message("authoritative")]});
    let events = d
        .apply(json!({"type":"response.completed","response":native}))
        .unwrap();
    let ProviderEvent::ResponseFinished { response } = &events[0] else {
        panic!("terminal")
    };
    assert_eq!(response.native, native);
    assert_eq!(response.output_provenance, OutputProvenance::NativeTerminal);
}
#[test]
fn recovery_known_parts_fields_prefixes_and_lifecycle() {
    let events = vec![
        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"m","type":"message","status":"in_progress","content":[]}}),
        json!({"type":"response.content_part.added","output_index":0,"item_id":"m","content_index":0,"part":{"type":"output_text","text":""}}),
        json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","content_index":0,"delta":"ans"}),
        json!({"type":"response.output_text.done","output_index":0,"item_id":"m","content_index":0,"text":"answer"}),
        json!({"type":"response.content_part.done","output_index":0,"item_id":"m","content_index":0,"part":{"type":"output_text","text":"answer"}}),
    ];
    let mut d = decoder();
    for event in &events {
        d.apply(event.clone()).unwrap();
    }
    done(&mut d, 0, message("m"));
    assert!(terminal(&mut d).is_ok());
    for event in events.iter().skip(1) {
        for field in ["item_id", "content_index", "text", "delta", "part"] {
            if event.get(field).is_none() {
                continue;
            }
            let mut bad = event.clone();
            bad[field] = if field == "content_index" {
                json!(1)
            } else {
                json!("wrong")
            };
            let mut d = decoder();
            d.apply(bad).unwrap();
            done(&mut d, 0, message("m"));
            assert!(terminal(&mut d).is_err());
        }
    }
    let mut d = decoder();
    done(&mut d, 0, message("m"));
    d.apply(events[2].clone()).unwrap();
    assert!(terminal(&mut d).is_err());
    for field in ["call_id", "name", "caller", "namespace"] {
        let mut added = call("c");
        added[field] = json!("wrong");
        let mut d = decoder();
        d.apply(json!({"type":"response.output_item.added","output_index":0,"item":added}))
            .unwrap();
        done(&mut d, 0, call("c"));
        assert!(terminal(&mut d).is_err());
    }
    for text in ["{\"a\":", "wrong"] {
        let mut d = decoder();
        d.apply(json!({"type":"response.function_call_arguments.delta","output_index":0,"item_id":"c","delta":text})).unwrap();
        done(&mut d, 0, call("c"));
        assert_eq!(terminal(&mut d).is_ok(), text != "wrong");
    }
}
#[test]
fn recovery_reasoning_refusal_and_serde_privacy() {
    let mut d = decoder();
    done(
        &mut d,
        0,
        json!({"id":"reason","type":"reasoning","summary":[{"type":"summary_text","text":"private"}],"content":[{"type":"reasoning_text","text":"private"}],"encrypted_content":"private","unknown":{"secret":"private"}}),
    );
    done(
        &mut d,
        1,
        json!({"id":"refusal","type":"message","content":[{"type":"refusal","refusal":"private"}]}),
    );
    let response = terminal(&mut d).unwrap();
    assert_eq!(response.text, "private");
    assert!(!format!("{response:?}").contains("private"));
    assert!(format!("{response:?}").contains("ValidatedOutputItemDone"));
    let mut value = serde_json::to_value(&response).unwrap();
    assert_eq!(value["output_provenance"], "validated_output_item_done");
    assert_eq!(
        serde_json::from_value::<ModelResponse>(value.clone())
            .unwrap()
            .output_provenance,
        response.output_provenance
    );
    value.as_object_mut().unwrap().remove("output_provenance");
    assert_eq!(
        serde_json::from_value::<ModelResponse>(value)
            .unwrap()
            .output_provenance,
        OutputProvenance::NativeTerminal
    );
}
#[test]
fn recovery_event_and_serialized_byte_boundaries() {
    for extra in [4093, 4094] {
        let mut d = decoder();
        for _ in 0..extra {
            d.apply(json!({"type":"response.metadata"})).unwrap();
        }
        done(&mut d, 0, message("m"));
        assert_eq!(terminal(&mut d).is_ok(), extra == 4093);
    }
    for over in [0, 1] {
        let mut item = message("m");
        item["padding"] = json!("");
        let mut event = json!({"type":"response.output_item.done","output_index":0,"item":item});
        let size = serde_json::to_vec(&event).unwrap().len();
        event["item"]["padding"] = json!("x".repeat(1024 * 1024 - size + over));
        let mut d = decoder();
        d.apply(event).unwrap();
        assert_eq!(terminal(&mut d).is_ok(), over == 0);
    }
}
#[test]
fn recovery_final_arguments_reasoning_parts_and_duplicate_fields() {
    for valid in [false, true] {
        let mut d = decoder();
        d.apply(json!({"type":"response.function_call_arguments.done","output_index":0,"item_id":"c","arguments":if valid { "{\"a\":17,\"b\":25}" } else { "{}" }})).unwrap();
        done(&mut d, 0, call("c"));
        assert_eq!(terminal(&mut d).is_ok(), valid);
    }
    for summary in [false, true] {
        let (family, index, item_field, part_type) = if summary {
            (
                "reasoning_summary",
                "summary_index",
                "summary",
                "summary_text",
            )
        } else {
            (
                "reasoning_text",
                "content_index",
                "content",
                "reasoning_text",
            )
        };
        let text_family = if summary {
            "reasoning_summary_text"
        } else {
            "reasoning_text"
        };
        let mut item = json!({"id":"reason","type":"reasoning"});
        item[item_field] = json!([{"type":part_type,"text":"answer"}]);
        let mut events = vec![];
        for (kind, field, value) in [
            (
                format!("response.{family}_part.added"),
                "part",
                json!({"type":part_type,"text":""}),
            ),
            (
                format!("response.{text_family}.delta"),
                "delta",
                json!("ans"),
            ),
            (
                format!("response.{text_family}.done"),
                "text",
                json!("answer"),
            ),
            (
                format!("response.{family}_part.done"),
                "part",
                json!({"type":part_type,"text":"answer"}),
            ),
        ] {
            let mut event = json!({"type":kind,"output_index":0,"item_id":"reason"});
            event[index] = json!(0);
            event[field] = value;
            events.push(event);
        }
        for duplicate in [false, true] {
            let mut d = decoder();
            for event in &events {
                d.apply(event.clone()).unwrap();
            }
            if duplicate {
                d.apply(events[2].clone()).unwrap();
            }
            done(&mut d, 0, item.clone());
            assert_eq!(terminal(&mut d).is_ok(), !duplicate);
        }
    }
    let mut d = decoder();
    let mut start = call("c");
    start["status"] = json!("in_progress");
    start["arguments"] = json!("");
    d.apply(json!({"type":"response.output_item.added","output_index":0,"item":start}))
        .unwrap();
    done(&mut d, 0, call("c"));
    assert!(terminal(&mut d).is_ok());
}

#[test]
fn recovery_rejects_schema_conflicts_before_item_shortcuts() {
    let mut bad_events = vec![];
    for kind in ["response.output_item.added", "response.output_item.done"] {
        for field in ["call_id", "name", "caller", "namespace", "arguments"] {
            let mut event = json!({"type":kind,"output_index":0,"item":message("m")});
            event[field] = json!("orphan");
            bad_events.push(event.clone());
            event.as_object_mut().unwrap().remove(field);
            event["item"][field] = json!("orphan");
            bad_events.push(event);
        }
        for field in ["content_index", "summary_index", "part"] {
            let mut event = json!({"type":kind,"output_index":0,"item":message("m")});
            event[field] = json!(0);
            bad_events.push(event);
        }
    }
    let mut start = message("m");
    start["role"] = json!("user");
    bad_events.push(json!({"type":"response.output_item.added","output_index":0,"item":start}));
    for suffix in ["added", "done"] {
        bad_events.push(json!({"type":format!("response.reasoning_text_part.{suffix}"),"output_index":0,"item_id":"m","content_index":0,"part":{"type":"output_text","text":"answer"}}));
    }
    let mut embedded = json!({"type":"response.output_text.done","output_index":0,"item_id":"m","content_index":0,"text":"answer"});
    embedded["item"] = message("other");
    bad_events.push(embedded);
    for event in bad_events {
        let is_done = event["type"] == "response.output_item.done";
        let mut d = decoder();
        d.apply(event.clone()).unwrap();
        done(&mut d, 1, call("c"));
        if !is_done {
            done(&mut d, 0, message("m"));
        }
        assert!(
            matches!(
                terminal(&mut d),
                Err(GatewayError::Protocol("invalid finalized output recovery"))
            ),
            "{event}"
        );
        assert!(d.terminal_received && !d.finished);
    }
}

#[test]
fn recovery_generic_parts_preserve_valid_schemas_and_mutable_starts() {
    for (item_kind, part_kind, field) in [
        ("message", "output_text", "text"),
        ("message", "refusal", "refusal"),
        ("reasoning", "reasoning_text", "text"),
    ] {
        let part = json!({"type":part_kind,field:"answer"});
        let mut item = json!({"id":"m","type":item_kind,"status":"completed","content":[part],"unknown_metadata":{"x":1}});
        if item_kind == "message" {
            item["role"] = json!("assistant");
        }
        let mut start = item.clone();
        start["status"] = json!("in_progress");
        start["content"] = json!([]);
        let mut d = decoder();
        d.apply(json!({"type":"response.output_item.added","output_index":0,"item":start}))
            .unwrap();
        for suffix in ["added", "done"] {
            d.apply(json!({"type":format!("response.content_part.{suffix}"),"output_index":0,"item_id":"m","content_index":0,"part":part})).unwrap();
        }
        done(&mut d, 1, call("c"));
        done(&mut d, 0, item.clone());
        let response = terminal(&mut d).unwrap();
        assert_eq!(response.output[0].native, item);
        assert_eq!(response.output[1].id.as_deref(), Some("c"));
        assert_eq!(
            response.output_provenance,
            OutputProvenance::ValidatedOutputItemDone
        );
    }
}

#[test]
fn recovery_added_arguments_must_be_string_prefixes() {
    for (arguments, valid) in [
        (None, true),
        (Some(json!("")), true),
        (Some(json!("{\"a\":")), true),
        (Some(call("c")["arguments"].clone()), true),
        (Some(json!("{\"a\":0,\"b\":0}")), false),
        (Some(json!("wrong")), false),
        (Some(json!(null)), false),
        (Some(json!(false)), false),
        (Some(json!(12)), false),
        (Some(json!({})), false),
        (Some(json!([])), false),
    ] {
        for native_authority in [false, true] {
            let mut start = call("c");
            start.as_object_mut().unwrap().remove("arguments");
            start["status"] = json!("in_progress");
            start["unrelated_metadata"] = json!({"added_only":true});
            if let Some(arguments) = &arguments {
                start["arguments"] = arguments.clone();
            }
            let mut d = decoder();
            d.apply(json!({"type":"response.output_item.added","output_index":0,"item":start}))
                .unwrap();
            done(&mut d, 0, call("c"));
            if native_authority {
                let events = d.apply(json!({"type":"response.completed","response":{"id":"r","status":"completed","output":[message("native")]}})).unwrap();
                let ProviderEvent::ResponseFinished { response } = &events[0] else {
                    panic!("terminal")
                };
                assert_eq!(response.output_provenance, OutputProvenance::NativeTerminal);
                assert_eq!(response.output[0].native, message("native"));
            } else {
                let result = terminal(&mut d);
                assert_eq!(result.is_ok(), valid, "arguments: {arguments:?}");
                assert!(d.terminal_received);
                assert_eq!(d.finished, valid);
                if let Ok(response) = result {
                    assert_eq!(response.output[0].native, call("c"));
                }
            }
        }
    }
}

#[test]
fn recovery_added_message_and_reasoning_parts_must_be_prefixes() {
    for (item_kind, array, part_kind, field) in [
        ("message", "content", "output_text", "text"),
        ("message", "content", "refusal", "refusal"),
        ("reasoning", "content", "reasoning_text", "text"),
        ("reasoning", "summary", "summary_text", "text"),
    ] {
        let first = json!({"type":part_kind,field:"answer"});
        let second = json!({"type":part_kind,field:"tail"});
        let item = json!({"id":"m","type":item_kind,array:[first,second]});
        for (provided, valid) in [
            (None, true),
            (Some(json!([])), true),
            (Some(json!([{"type":part_kind,field:""}])), true),
            (
                Some(json!([{"type":part_kind,field:"ans","unrelated_metadata":false}])),
                true,
            ),
            (Some(json!([first,{"type":part_kind,field:"tai"}])), true),
            (Some(item[array].clone()), true),
            (Some(json!(null)), false),
            (Some(json!(false)), false),
            (Some(json!({})), false),
            (Some(json!("answer")), false),
            (Some(json!([null])), false),
            (Some(json!([{"type":part_kind}])), false),
            (Some(json!([{"type":part_kind,field:12}])), false),
            (Some(json!([{"type":"future",field:"ans"}])), false),
            (
                Some(
                    json!([{"type":"summary_text","text":"ans"},{"type":"output_text","text":"tai"}]),
                ),
                false,
            ),
            (Some(json!([{"type":part_kind,field:"conflict"}])), false),
            (
                Some(json!([first,{"type":part_kind,field:"answer"}])),
                false,
            ),
            (Some(json!([first, second, second])), false),
        ] {
            let mut start =
                json!({"id":"m","type":item_kind,"status":"in_progress","unrelated_metadata":true});
            if let Some(provided) = &provided {
                start[array] = provided.clone();
            }
            let mut d = decoder();
            d.apply(json!({"type":"response.output_item.added","output_index":0,"item":start}))
                .unwrap();
            done(&mut d, 1, call("c"));
            done(&mut d, 0, item.clone());
            let result = terminal(&mut d);
            assert_eq!(
                result.is_ok(),
                valid,
                "{item_kind}/{array}/{part_kind}: {provided:?}"
            );
            assert!(d.terminal_received);
            assert_eq!(d.finished, valid);
            if let Ok(response) = result {
                assert_eq!(response.output[0].native, item);
                assert_eq!(response.output[1].native, call("c"));
                assert_eq!(
                    response.output_provenance,
                    OutputProvenance::ValidatedOutputItemDone
                );
            }
        }
    }
}

#[test]
fn recovery_terminal_identity_failure_is_not_received() {
    let mut d = decoder();
    done(&mut d, 0, message("m"));
    assert!(d.apply(json!({"type":"response.completed","response":{"id":"other","status":"completed","output":[]}})).is_err());
    assert!(!d.terminal_received);
}
