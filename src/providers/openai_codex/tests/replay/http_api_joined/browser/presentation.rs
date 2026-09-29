use super::*;

fn data() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/presentation.json"
    )))
    .unwrap()
}

pub(super) fn text(key: &str) -> String {
    data()[key].as_str().unwrap().to_owned()
}

pub(super) fn setup(workspace: &Path) {
    let path = workspace.join(".agents/skills/presentation");
    skill(&path, "presentation", &text("tool"));
    std::fs::write(path.join("script.sh"), "private-support-script").unwrap();
    std::fs::write(path.join("resource.txt"), "private-support-resource").unwrap();
}

pub(super) fn calls(task: usize) -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"reason","summary":[{"type":"summary_text","text":text("summary")}],
            "content":[{"type":"reasoning_text","text":text("reasoning")}],"encrypted_content":"private-native-encrypted"}),
        json!({"type":"message","id":"mixed","role":"assistant","status":"completed","content":[
            {"type":"output_text","text":text("text"),"annotations":[{"private-native":"annotation"}]},
            {"type":"refusal","refusal":text("refusal"),"future":"private-native-refusal"}]}),
        call("add-雪", "add_numbers", ARGUMENTS[task]),
        call("skill", "load_skill", "{\"id\":\"project:presentation\"}"),
        call(
            "overflow",
            "add_numbers",
            "{\"a\":9223372036854775807,\"b\":1}",
        ),
        // This supported replay item has no public text or executable call.
        json!({"type":"reasoning","id":"opaque-reason","encrypted_content":"private-native-encrypted-only"}),
    ]
}

pub(super) fn outputs(task: usize) -> Vec<(&'static str, String, bool)> {
    vec![
        ("add-雪", OUTPUTS[task].into(), false),
        ("skill", json!({"id":"project:presentation","frontmatter":{"name":"presentation","description":"synthetic metadata"},"body":text("tool")}).to_string(), false),
        ("overflow", "{\"error\":{\"code\":\"gateway_error\"}}".into(), true),
    ]
}

pub(super) fn answer_text(task: usize) -> String {
    format!("Final {}\r\n{}{}", task + 1, text("text"), "W".repeat(2048))
}

pub(super) fn answer(task: usize) -> Vec<Value> {
    vec![
        json!({"type":"message","id":"answer","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":answer_text(task),"annotations":[{"private-native":"hidden"}]}]}),
    ]
}

pub(super) fn partial(id: &str, task: usize, turn: usize) -> Vec<Value> {
    let mut frames = vec![];
    if turn == 0 {
        for (index, mut item) in calls(task).into_iter().enumerate() {
            match index {
                0 => {
                    item["summary"] = json!([]);
                    item["content"] = json!([]);
                }
                1 => {
                    item["content"] = json!([]);
                    item["status"] = json!("in_progress");
                }
                2 => {
                    // Partial arguments stay inert until the real completed call replaces them.
                    item["arguments"] = json!("");
                    item["status"] = json!("in_progress");
                }
                _ => {}
            }
            frames.push(json!({"type":"response.output_item.added","response_id":id,"output_index":index,"item":item}));
        }
        for (kind, item, output, content, summary, key) in [
            (
                "reasoning_summary_text",
                "reason",
                0,
                None,
                Some(0),
                "summary",
            ),
            ("reasoning_text", "reason", 0, Some(0), None, "reasoning"),
            ("output_text", "mixed", 1, Some(0), None, "text"),
            ("refusal", "mixed", 1, Some(1), None, "refusal"),
            (
                "function_call_arguments",
                "item-add-雪",
                2,
                None,
                None,
                "arguments",
            ),
        ] {
            let value = text(key);
            let split = value.find('\n').unwrap() + 1;
            for delta in [&value[..split], &value[split..]] {
                frames.push(json!({"type":format!("response.{kind}.delta"),"response_id":id,"item_id":item,
                    "output_index":output,"content_index":content,"summary_index":summary,"delta":delta}));
            }
        }
    } else {
        frames.push(json!({"type":"response.output_item.added","response_id":id,"output_index":0,
            "item":{"type":"message","id":"answer","role":"assistant","status":"in_progress","content":[]}}));
        // Enough real committed deltas to cross several page windows, not a history limit.
        let text = answer_text(task);
        let chars: Vec<_> = text.chars().collect();
        for chunk in chars.chunks(32) {
            frames.push(
                json!({"type":"response.output_text.delta","response_id":id,"item_id":"answer",
                "output_index":0,"content_index":0,"delta":chunk.iter().collect::<String>()}),
            );
        }
    }
    frames
}

pub(super) fn done(id: &str, items: &[Value]) -> Vec<Value> {
    items.iter().enumerate().map(|(index, item)| {
        json!({"type":"response.output_item.done","response_id":id,"output_index":index,"item":item})
    }).collect()
}

pub(super) async fn reply(wire: &mut Wire, db: &Database, id: &str, frames: Vec<Value>) {
    let mut deltas = 0;
    for frame in frames {
        let is_delta = frame.get("delta").is_some();
        wire.reply(vec![frame], None).await;
        if is_delta {
            deltas += 1;
            // Pace the synthetic burst against real commits, not Chromium consumption.
            // This preserves the adapter's existing queue and slow-consumer guard.
            watch(async {
                loop {
                    let committed = db.records().await.iter().filter(|record| {
                        matches!(record.payload(), StoredEventPayload::RuntimeObserved(event)
                            if matches!(&event.event, RunEvent::ProviderEvent { event }
                                if matches!(&event.event, ProviderEvent::OutputItemUpdated { response_id, .. } if response_id == id)))
                    }).count();
                    if committed == deltas {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await;
        }
    }
}

#[test]
fn presentation_canaries_and_real_tool_inputs_are_distinct() {
    let data = data();
    let mut seen = std::collections::HashSet::new();
    for value in data.as_object().unwrap().values() {
        let text = value.as_str().unwrap();
        assert!(seen.insert(text));
        for marker in [
            "<script>",
            "<img",
            "onerror=",
            "javascript:",
            "\u{1b}",
            "雪",
        ] {
            assert!(text.contains(marker));
        }
    }
    for task in 0..2 {
        let calls = calls(task);
        assert_eq!(calls[2]["arguments"], ARGUMENTS[task]);
        assert_eq!(outputs(task)[0].1, OUTPUTS[task]);
        assert!(!outputs(task)[1].2 && outputs(task)[2].2);
        assert!(partial("fixture", task, 1).len() > 32);
    }
}

#[test]
fn presentation_deltas_done_and_terminal_keep_exact_public_and_native_items() {
    use crate::http_api::dto::{ItemView, ResponseView};
    use crate::providers::openai_codex::{codec::ResponseDecoder, consistency::Lifecycle};

    for (task, arguments) in ARGUMENTS.iter().enumerate() {
        let rich = calls(task);
        assert_eq!(rich.len(), 6);
        assert_eq!(rich[0]["summary"][0]["text"], text("summary"));
        assert_eq!(rich[0]["content"][0]["text"], text("reasoning"));
        assert_eq!(rich[1]["content"][0]["text"], text("text"));
        assert_eq!(rich[1]["content"][1]["refusal"], text("refusal"));
        assert_eq!(rich[2], call("add-雪", "add_numbers", arguments));
        assert_eq!(
            rich[3],
            call("skill", "load_skill", "{\"id\":\"project:presentation\"}")
        );
        assert_eq!(
            rich[4],
            call(
                "overflow",
                "add_numbers",
                "{\"a\":9223372036854775807,\"b\":1}"
            )
        );
        assert_eq!(
            rich[5],
            json!({"type":"reasoning","id":"opaque-reason","encrypted_content":"private-native-encrypted-only"})
        );
        assert_eq!(
            outputs(task)
                .iter()
                .map(|(id, _, error)| (*id, *error))
                .collect::<Vec<_>>(),
            [("add-雪", false), ("skill", false), ("overflow", true)]
        );

        let partial = partial("fixture", task, 0);
        assert_eq!(partial.len(), 16);
        for (index, frame) in partial[..6].iter().enumerate() {
            assert_eq!(frame["type"], "response.output_item.added");
            assert_eq!(frame["response_id"], "fixture");
            assert_eq!(frame["output_index"], index);
            assert_eq!(frame["item"]["id"], rich[index]["id"]);
        }
        assert_eq!(partial[0]["item"]["summary"], json!([]));
        assert_eq!(partial[0]["item"]["content"], json!([]));
        assert_eq!(partial[1]["item"]["content"], json!([]));
        assert_eq!(partial[2]["item"]["arguments"], "");
        assert_eq!(partial[2]["item"]["status"], "in_progress");
        for (frames, (kind, item, output, content, summary, key)) in partial[6..].chunks(2).zip([
            (
                "reasoning_summary_text",
                "reason",
                0,
                None,
                Some(0),
                "summary",
            ),
            ("reasoning_text", "reason", 0, Some(0), None, "reasoning"),
            ("output_text", "mixed", 1, Some(0), None, "text"),
            ("refusal", "mixed", 1, Some(1), None, "refusal"),
            (
                "function_call_arguments",
                "item-add-雪",
                2,
                None,
                None,
                "arguments",
            ),
        ]) {
            let value = text(key);
            let split = value.find('\n').unwrap() + 1;
            for (frame, delta) in frames.iter().zip([&value[..split], &value[split..]]) {
                assert_eq!(frame["item_id"], rich[output as usize]["id"]);
                assert_eq!(
                    *frame,
                    json!({"type":format!("response.{kind}.delta"),"response_id":"fixture","item_id":item,
                    "output_index":output,"content_index":content,"summary_index":summary,"delta":delta})
                );
            }
        }
        for (turn, items) in [rich, answer(task)].into_iter().enumerate() {
            let mut terminal = events("fixture", items.clone(), false);
            let mut frames = vec![terminal.remove(0)];
            frames.extend(self::partial("fixture", task, turn));
            let finished = done("fixture", &items);
            assert_eq!(finished.len(), items.len());
            for (index, frame) in finished.iter().enumerate() {
                assert_eq!(
                    *frame,
                    json!({"type":"response.output_item.done","response_id":"fixture","output_index":index,"item":items[index]})
                );
            }
            frames.extend(finished);
            frames.extend(terminal);
            let mut decoder = ResponseDecoder::default();
            let mut lifecycle = Lifecycle::default();
            let mut snapshots = vec![];
            for frame in frames {
                for event in decoder.apply(frame).unwrap() {
                    lifecycle.observe(&event).unwrap();
                    match event {
                        ProviderEvent::OutputItemFinished { item, .. } => {
                            snapshots.push(item.native)
                        }
                        ProviderEvent::ResponseFinished { response } => {
                            lifecycle.validate(&response).unwrap();
                            assert_eq!(snapshots, items);
                            assert_eq!(response.native["output"], json!(items));
                            assert_eq!(
                                response.output_provenance,
                                crate::OutputProvenance::NativeTerminal
                            );
                            assert_eq!(
                                response.text,
                                if turn == 0 {
                                    text("text") + &text("refusal")
                                } else {
                                    answer_text(task)
                                }
                            );
                            assert!(
                                response
                                    .output
                                    .iter()
                                    .all(|item| item.kind != crate::ItemKind::Unknown)
                            );
                            if turn == 0 {
                                let marker = &response.output[5];
                                assert_eq!(marker.kind, crate::ItemKind::Reasoning);
                                assert!(marker.function_call.is_none());
                                assert_eq!(
                                    serde_json::to_value(ItemView::from(marker)).unwrap(),
                                    json!({
                                        "item_id":"opaque-reason","kind":"reasoning","function_call":null,"content":[],"unsupported_content":true
                                    })
                                );
                                assert_eq!(
                                    response
                                        .output
                                        .iter()
                                        .filter(|item| item.function_call.is_some())
                                        .count(),
                                    3
                                );
                            }
                            let public =
                                serde_json::to_string(&ResponseView::from(&response)).unwrap();
                            assert!(
                                !public.contains("private-native")
                                    && !public.contains("encrypted_content")
                                    && !public.contains("opaque_response")
                            );
                        }
                        _ => {}
                    }
                }
            }
            assert!(decoder.finished);
        }
    }
}
