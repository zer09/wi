use super::*;
use crate::{
    conversation::{
        BlockCursor, EntryId, LiveCursor,
        primitives::{FieldRank, OrderKey, SourceKey},
    },
    tools::ToolExecutionEvent,
};

fn mixed_items() -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"reason","summary":[{"type":"summary_text","text":"reason 雪\r\n"}],"encrypted_content":"private-native-encrypted","signature":"private-native-signature"}),
        json!({"type":"message","id":"mixed","role":"assistant","status":"completed","content":[
            {"type":"output_text","text":"before tools 雪\r\n","annotations":[{"private-native":"annotation"}]},
            {"type":"refusal","refusal":"refusal 雪\r\n","future":"private-native-unknown"}]}),
        call("add", "add_numbers", "{\"a\":17, \"b\":25}"),
        call("skill", "load_skill", "{\"id\":\"project:same\"}"),
        call("gone", "load_skill", "{\"id\":\"project:vanish\"}"),
    ]
}
fn results() -> Vec<Value> {
    let loaded = json!({"id":"project:same","frontmatter":{"name":"same","description":"synthetic metadata"},"body":BODY}).to_string();
    vec![
        output("add", "{\"sum\":42}"),
        output("skill", &loaded),
        output("gone", "{\"error\":{\"code\":\"gateway_error\"}}"),
    ]
}
pub(super) fn assert_saved(
    records: &[StoredEvent],
    body: &Value,
    replies: &[(&str, Vec<Value>)],
    recovered: bool,
) {
    let run: Vec<_> = records
        .iter()
        .filter(|e| e.run_id() == Some(&rid(body)))
        .collect();
    let responses: Vec<_> = run
        .iter()
        .filter_map(|e| {
            if let StoredEventPayload::RuntimeObserved(envelope) = e.payload()
                && let RunEvent::ProviderEvent { event } = &envelope.event
                && let ProviderEvent::ResponseFinished { response } = &event.event
            {
                Some(response)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(responses.len(), replies.len());
    for (response, (id, items)) in responses.iter().zip(replies) {
        assert_eq!(response.id, *id);
        assert_eq!(
            response.native,
            events(id, items.clone(), recovered).last().unwrap()["response"]
        );
        assert_eq!(
            response
                .output
                .iter()
                .map(|i| i.native.clone())
                .collect::<Vec<_>>(),
            *items
        );
        assert_eq!(
            response.output_provenance,
            if recovered {
                OutputProvenance::ValidatedOutputItemDone
            } else {
                OutputProvenance::NativeTerminal
            }
        );
    }
    let StoredEventPayload::RunResultRecorded(result) = run.last().unwrap().payload() else {
        panic!("missing durable final result")
    };
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(result.events_complete);
    assert!(result.sink_error.is_none());
}

fn completed_tool(
    run: &RunId,
    sequences: [u64; 3],
    name: &str,
    text: &str,
    is_error: bool,
) -> Value {
    let [start, result, finish] = sequences;
    assert!(start < result && result < finish);
    let entry = EntryId::new(start, 0).unwrap();
    let fields: Vec<_> = [
        (FieldRank::ToolName, "tool_name", start, name),
        (FieldRank::ToolOutput, "tool_result", result, text),
    ]
    .into_iter()
    .map(|(rank, kind, generation, text)| {
        let order = OrderKey::new(None, rank, None, None);
        json!({"field_id":SourceKey::field(run, &entry, &order).unwrap().field_id(),
            "order_key":order.to_string(),"kind":kind,"generation":generation.to_string(),
            "total_bytes":text.len().to_string(),"from_byte":"0","to_byte":text.len().to_string(),
            "text":text,"has_earlier":false,"has_later":false})
    })
    .collect();
    let state = if is_error { "failed" } else { "completed" };
    json!({"run_id":run,"entry_id":entry.to_string(),
        "position":{"sequence":start.to_string(),"slot":"0"},"revision":finish.to_string(),
        "content_epoch":start.to_string(),"kind":"tool","recorded_state":state,
        "provisional":false,"reference":null,"result_recorded":true,"finish_recorded":true,
        "is_error":is_error,"fields":fields,"earlier_content":null,"content_complete":true})
}

fn saved_tools(records: &[StoredEvent], body: &Value) -> Vec<Value> {
    let run = rid(body);
    let records: Vec<_> = records
        .iter()
        .filter(|e| e.run_id() == Some(&run))
        .collect();
    let starts: Vec<_> = records
        .iter()
        .filter_map(|e| {
            if let StoredEventPayload::RuntimeObserved(envelope) = e.payload()
                && let RunEvent::ToolEvent {
                    event: ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name },
                } = &envelope.event
            {
                Some((e.sequence(), envelope, call_id, tool_name))
            } else {
                None
            }
        })
        .collect();
    let expected = results();
    assert_eq!(starts.len(), expected.len());
    assert_eq!(
        records
            .iter()
            .filter(|e| matches!(e.payload(), StoredEventPayload::ToolResultRecorded(_)))
            .count(),
        3
    );
    assert_eq!(records.iter().filter(|e| matches!(e.payload(), StoredEventPayload::RuntimeObserved(envelope)
        if matches!(envelope.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionFinished { .. } }))).count(), 3);
    starts
        .into_iter()
        .enumerate()
        .map(|(index, (start, envelope, call, name))| {
            assert_eq!(call, expected[index]["call_id"].as_str().unwrap());
            assert_eq!(name, ["add_numbers", "load_skill", "load_skill"][index]);
            let (result_sequence, result) = records
                .iter()
                .find_map(|e| {
                    if let StoredEventPayload::ToolResultRecorded(result) = e.payload()
                        && result.call_id() == call
                    {
                        Some((e.sequence(), result))
                    } else {
                        None
                    }
                })
                .unwrap();
            assert_eq!(result.request_id(), envelope.request_id.as_deref());
            assert_eq!(result.output(), expected[index]["output"].as_str().unwrap());
            assert_eq!(result.is_error(), index == 2);
            let finish = records
                .iter()
                .find_map(|e| {
                    if let StoredEventPayload::RuntimeObserved(finished) = e.payload()
                        && let RunEvent::ToolEvent {
                            event:
                                ToolExecutionEvent::ToolExecutionFinished {
                                    call_id,
                                    tool_name,
                                    is_error,
                                },
                        } = &finished.event
                        && call_id == call
                    {
                        assert_eq!(tool_name, name);
                        assert_eq!(*is_error, result.is_error());
                        assert_eq!(finished.request_id, envelope.request_id);
                        assert_eq!(finished.turn_id, envelope.turn_id);
                        Some(e.sequence())
                    } else {
                        None
                    }
                })
                .unwrap();
            completed_tool(
                &run,
                [start, result_sequence, finish],
                name,
                result.output(),
                result.is_error(),
            )
        })
        .collect()
}

fn assert_complete_entry(entry: &Value) {
    assert_eq!(entry["earlier_content"], Value::Null);
    assert_eq!(entry["content_complete"], true);
    let fields = entry["fields"].as_array().unwrap();
    for field in fields {
        let text = field["text"].as_str().unwrap();
        assert_eq!(field["from_byte"], "0");
        assert_eq!(field["to_byte"], text.len().to_string());
        assert_eq!(field["total_bytes"], text.len().to_string());
        assert_eq!(field["has_earlier"], false);
        assert_eq!(field["has_later"], false);
    }
    for pair in fields.windows(2) {
        assert!(pair[0]["order_key"].as_str().unwrap() < pair[1]["order_key"].as_str().unwrap());
        assert_ne!(pair[0]["field_id"], pair[1]["field_id"]);
    }
}

fn assert_saved_tools(entries: &Value, expected: &[Value]) {
    let entries = entries.as_array().unwrap();
    let tools: Vec<_> = entries.iter().filter(|e| e["kind"] == "tool").collect();
    assert_eq!(tools.len(), expected.len());
    for (entry, expected) in tools.into_iter().zip(expected) {
        // Full equality protects bytes and metadata, not just a rendered preview or parsed JSON.
        assert_eq!(entry, expected);
        assert_complete_entry(entry);
    }
}

async fn addressed_tools(f: &Fixture, sid: &ApplicationSessionId, page: &Value, tools: &[Value]) {
    let records = f.records(sid).await;
    let loads = f.auth.loads.load(Ordering::SeqCst);
    let requests = f.wire.requests;
    f.wire.no_request();
    assert_eq!(page["conversation_version"], 1);
    assert_eq!(page["session_id"], sid.as_str());
    assert_eq!(
        page["snapshot_head"],
        records.last().unwrap().sequence().to_string()
    );
    assert_eq!(page["session"]["head_sequence"], page["snapshot_head"]);
    assert_saved_tools(&page["entries"], tools);
    assert_complete_entry(&page["block"]["human"]);
    for entry in page["entries"].as_array().unwrap() {
        assert_complete_entry(entry);
    }
    for tool in tools {
        let entry = tool["entry_id"].as_str().unwrap().replace(':', "%3A");
        let addressed = json_response(
            f.get(&format!(
                "/v1/sessions/{sid}/conversation/entries/{}/{entry}",
                tool["run_id"].as_str().unwrap()
            )),
            200,
        )
        .await;
        assert_eq!(
            addressed,
            json!({"api_version":1,"conversation_version":1,"session_id":sid,
            "snapshot_head":page["snapshot_head"],"block":page["block"],"entry":tool})
        );
        // Use the same exact-entry assertion for Latest, addressed and historical reads.
        assert_saved_tools(&json!([addressed["entry"]]), std::slice::from_ref(tool));
    }
    assert_eq!(
        serde_json::to_value(f.records(sid).await).unwrap(),
        serde_json::to_value(records).unwrap()
    );
    f.auth.assert_loads(loads);
    assert_eq!(f.wire.requests, requests);
    f.wire.no_request();
}

async fn roundtrip(transport: Transport, mime: Option<&str>, recovered: bool) {
    let mut f = Fixture::new(transport).await;
    let owned_root = f.temp.path().to_owned();
    let sid = f.create("a").await;
    let a = command(RAW);
    let path = format!("/v1/sessions/{sid}/runs");
    // Real security checks must reject before opening storage or starting the adapter.
    json_response(
        http().post(format!("http://{}{path}", f.address)).json(&a),
        401,
    )
    .await;
    json_response(
        f.post(&path, &a)
            .header("Origin", "https://foreign.example"),
        403,
    )
    .await;
    assert_eq!(f.records(&sid).await.len(), 1);
    f.auth.assert_loads(0);

    let accepted = f.pause(Record::Acceptance, Point::BeforeCommit);
    let request = f.post(&path, &a);
    let pending = tokio::spawn(async move { json_response(request, 202).await });
    watch(accepted.reached.notified()).await;
    assert!(
        !pending.is_finished(),
        "dispatch admission is not HTTP acceptance"
    );
    // Independent read-only WAL connection, not a reader waiting behind the held writer.
    let mut reader = f.reader(&sid).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
        .bind(a["operation_id"].as_str().unwrap())
        .fetch_one(&mut reader)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(f.records(&sid).await.len(), 1);
    reader.close().await.unwrap();
    f.auth.assert_loads(0);
    f.wire.no_request();
    accepted.release.notify_one();
    let receipt = watch(pending).await.unwrap();
    assert_eq!(receipt["duplicate"], false);
    assert_eq!(receipt["receipt"]["operation_id"], a["operation_id"]);
    assert_eq!(receipt["receipt"]["run_id"], a["run_id"]);
    assert_eq!(receipt["receipt"]["first_sequence"], "2");
    assert_eq!(receipt["receipt"]["last_sequence"], "3");
    assert!(
        receipt["notices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "excluded.invalid_frontmatter")
    );
    assert_eq!(f.run(&sid, &a).await["result_recorded"], false);
    let first = f.wire.receive().await;
    let input_a = f.input(&sid, &a).await;
    assert_eq!(input_a.user_text(), RAW);
    assert_eq!(
        input_a.available_skills(),
        ["global:same", "project:same", "project:vanish"]
    );
    assert!(input_a.active_skills().is_empty());
    assert!(input_a.prepared_request().options.tools.is_empty());
    let prompt: Value = serde_json::from_str(&input_a.prepared_request().prompt).unwrap();
    assert_eq!(prompt["task"], RAW);
    assert_eq!(
        prompt["project_instructions"]["text"],
        "private-project-a\r\n"
    );
    assert!(!input_a.prepared_request().prompt.contains(BODY));
    let mut context = vec![user(&input_a.prepared_request().prompt)];
    assert_request(&first, &context, None, &input_a);
    let selected = f.records(&sid).await;
    let StoredEventPayload::RunHistorySelected(selected) = selected[2].payload() else {
        panic!("not B2 acceptance")
    };
    assert_eq!(selected.selection().through_sequence(), 1);
    assert!(selected.selection().expected_identity().is_none());

    // The catalog advertised this entry. Its actual load now fails, producing is_error=true.
    std::fs::remove_file(f.temp.path().join("a/.agents/skills/vanish/SKILL.md")).unwrap();
    let mixed = mixed_items();
    f.wire
        .reply(events("a-parent", mixed.clone(), recovered), mime)
        .await;
    let continued = f.wire.receive().await;
    context.extend(mixed.clone());
    context.extend(results());
    let expected = if transport == Transport::WebSocket {
        results()
    } else {
        context.clone()
    };
    let parent = (transport == Transport::WebSocket).then_some("a-parent");
    assert_request(&continued, &expected, parent, &input_a);
    assert_eq!(continued["prompt_cache_key"], first["prompt_cache_key"]);

    // Capture H while the model is pending. Final records commit between page reads and attach.
    let first_page =
        json_response(f.get(&format!("/v1/sessions/{sid}/history?limit=2")), 200).await;
    let head: u64 = first_page["through_sequence"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let mut observer = Browser::open(&f, &sid, 0).await;
    let unread = Browser::open(&f, &sid, 0).await;
    let prefix = f.records(&sid).await;
    for sequence in 1..=head {
        observer.event(&sid, sequence).await;
    }
    drop(unread);
    f.wire
        .reply(events("a-final", final_items(), recovered), mime)
        .await;
    let run_a = f.finished(&sid, &a).await;
    assert_eq!(run_a["result"]["outcome"]["type"], "completed");
    assert_eq!(run_a["result"]["summary"]["new_tool_dispatches"], "3");
    assert_eq!(run_a["result"]["summary"]["tool_results_prepared"], "3");
    assert_eq!(run_a["result"]["summary"]["reused_results"], "0");
    f.wire.closed().await;
    context.extend(final_items());
    let fixed = f.pages(&sid, first_page).await;
    assert_eq!(fixed.len() as u64, head);
    let boundary = observer.event(&sid, head + 1).await;
    drop(observer);
    // Reconnect at the last applied event, not at the server's current head.
    let mut observer = Browser::open(&f, &sid, head + 1).await;
    let mut seen = fixed;
    seen.push(boundary);

    let a_records = f.records(&sid).await;
    assert_eq!(
        serde_json::to_value(&a_records[..prefix.len()]).unwrap(),
        serde_json::to_value(&prefix).unwrap()
    );
    assert_saved(
        &a_records,
        &a,
        &[("a-parent", mixed), ("a-final", final_items())],
        recovered,
    );
    let saved_results: Vec<_> = a_records
        .iter()
        .filter_map(|e| match e.payload() {
            StoredEventPayload::ToolResultRecorded(r) => {
                Some((r.call_id(), r.output(), r.is_error()))
            }
            _ => None,
        })
        .collect();
    let expected_results = results();
    assert_eq!(saved_results.len(), 3);
    for (index, (id, text, error)) in saved_results.iter().enumerate() {
        assert_eq!(*id, expected_results[index]["call_id"].as_str().unwrap());
        assert_eq!(*text, expected_results[index]["output"].as_str().unwrap());
        assert_eq!(*error, index == 2);
    }

    let tools_a = saved_tools(&a_records, &a);
    let display_path = format!("/v1/sessions/{sid}/conversation");
    let loads_before_display = f.auth.loads.load(Ordering::SeqCst);
    f.wire.no_request();
    let display_a = json_response(f.get(&display_path), 200).await;
    assert_eq!(display_a["block"]["run_id"], a["run_id"]);
    assert_eq!(
        display_a["block"]["accepted_sequence"],
        receipt["receipt"]["first_sequence"]
    );
    assert_eq!(display_a["block"]["revision"], run_a["result_sequence"]);
    assert_eq!(display_a["block"]["state"], "completed");
    assert_eq!(display_a["block"]["result_recorded"], true);
    for field in ["outcome", "summary", "events_complete", "sink_error"] {
        assert_eq!(display_a["block"][field], run_a["result"][field]);
    }
    assert_eq!(display_a["previous_block"], Value::Null);
    assert_eq!(display_a["earlier_activity"], Value::Null);
    assert_eq!(
        display_a["live_after"],
        LiveCursor::new(
            sid.clone(),
            a_records.last().unwrap().sequence(),
            3,
            None,
            None
        )
        .unwrap()
        .to_string()
    );
    let accepted_sequence = a_records
        .iter()
        .find(|e| matches!(e.payload(), StoredEventPayload::RunAccepted(_)))
        .unwrap()
        .sequence();
    assert_eq!(
        display_a["block"]["human"],
        json!({"run_id":rid(&a),
        "entry_id":format!("e:{accepted_sequence}:0"),"position":{"sequence":accepted_sequence.to_string(),"slot":"0"},
        "revision":accepted_sequence.to_string(),"content_epoch":accepted_sequence.to_string(),"kind":"human",
        "recorded_state":"accepted","provisional":false,"reference":null,"result_recorded":null,
        "finish_recorded":null,"is_error":null,"earlier_content":null,"content_complete":true,
        "fields":[{"field_id":"text","order_key":"0","kind":"text","generation":accepted_sequence.to_string(),
            "total_bytes":RAW.len().to_string(),"from_byte":"0","to_byte":RAW.len().to_string(),"text":input_a.user_text(),
            "has_earlier":false,"has_later":false}]})
    );
    let positions: Vec<_> = a_records
        .iter()
        .filter_map(|e| {
            if let StoredEventPayload::RuntimeObserved(envelope) = e.payload()
                && (matches!(&envelope.event, RunEvent::ProviderEvent { event }
                if matches!(event.event, ProviderEvent::ResponseStarted { .. }))
                    || matches!(
                        &envelope.event,
                        RunEvent::ToolEvent {
                            event: ToolExecutionEvent::ToolExecutionStarted { .. }
                        }
                    ))
            {
                Some(e.sequence())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(positions.len(), 5);
    for (entry, sequence) in display_a["entries"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&positions)
    {
        assert_eq!(entry["run_id"], a["run_id"]);
        assert_eq!(entry["entry_id"], format!("e:{sequence}:0"));
        assert_eq!(
            entry["position"],
            json!({"sequence":sequence.to_string(),"slot":"0"})
        );
    }
    assert_eq!(
        display_a["entries"].as_array().unwrap().len(),
        positions.len()
    );
    assert_eq!(
        display_a["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["assistant", "tool", "tool", "tool", "assistant"]
    );
    addressed_tools(&f, &sid, &display_a, &tools_a).await;
    f.auth.assert_loads(loads_before_display);
    assert_eq!(f.wire.requests, 2);
    assert_eq!(
        serde_json::to_value(f.records(&sid).await).unwrap(),
        serde_json::to_value(&a_records).unwrap()
    );

    // Historical skill content must come from SQLite, even after source deletion/change.
    let source = f.temp.path().join("a/.agents/skills/same/SKILL.md");
    if recovered {
        std::fs::remove_file(source).unwrap();
    } else {
        skill(
            &f.temp.path().join("a/.agents/skills/same"),
            "same",
            "changed current body\n",
        );
    }
    std::fs::write(
        f.temp.path().join("a/AGENTS.md"),
        "private-project-current\r\n",
    )
    .unwrap();
    let loads = f.auth.loads.load(Ordering::SeqCst);
    let after_source = json_response(f.get(&display_path), 200).await;
    assert_eq!(after_source, display_a);
    addressed_tools(&f, &sid, &after_source, &tools_a).await;
    assert_eq!(f.run(&sid, &a).await, run_a);
    assert_eq!(
        serde_json::to_value(f.records(&sid).await).unwrap(),
        serde_json::to_value(&a_records).unwrap()
    );
    f.auth.assert_loads(loads);
    assert_eq!(f.wire.requests, 2);
    f.wire.no_request();
    let duplicate = f.submit(&sid, &a).await;
    assert_eq!(duplicate["receipt"], receipt["receipt"]);
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["notices"], json!([]));
    f.auth.assert_loads(loads);
    let mut changed_text = a.clone();
    changed_text["text"] = json!(format!("{RAW} "));
    let mut changed_run = a.clone();
    changed_run["run_id"] = json!(RunId::new());
    for changed in [changed_text, changed_run] {
        let error = json_response(f.post(&path, &changed), 409).await;
        assert_eq!(error["code"], "storage.command_conflict");
    }
    let operation = json_response(
        f.get(&format!(
            "/v1/sessions/{sid}/operations/{}",
            a["operation_id"].as_str().unwrap()
        )),
        200,
    )
    .await;
    for (field, value) in receipt["receipt"].as_object().unwrap() {
        assert_eq!(&operation[field], value);
    }

    // A different application session has its own current roots and no A replay.
    let other = f.create("b").await;
    let isolated = command("other workspace task");
    f.submit(&other, &isolated).await;
    let wire = f.wire.receive().await;
    let input = f.input(&other, &isolated).await;
    assert!(
        input
            .prepared_request()
            .prompt
            .contains("private-project-b")
    );
    assert_request(
        &wire,
        &[user(&input.prepared_request().prompt)],
        None,
        &input,
    );
    f.wire
        .reply(events("isolated", final_items(), recovered), mime)
        .await;
    f.finished(&other, &isolated).await;
    f.wire.closed().await;

    let b = command("later explicit task 雪\r\n");
    let receipt_b = f.submit(&sid, &b).await;
    let restored = f.wire.receive().await;
    let input_b = f.input(&sid, &b).await;
    let prepared: Value = serde_json::from_str(&input_b.prepared_request().prompt).unwrap();
    assert_eq!(
        prepared["project_instructions"]["text"],
        "private-project-current\r\n"
    );
    assert!(!input_b.prepared_request().prompt.contains(BODY));
    assert!(
        !input_b
            .available_skills()
            .iter()
            .any(|s| s == "project:vanish")
    );
    assert_eq!(
        input_b
            .available_skills()
            .iter()
            .any(|s| s == "project:same"),
        !recovered
    );
    context.push(user(&input_b.prepared_request().prompt));
    assert_request(&restored, &context, None, &input_b);
    assert_ne!(restored["prompt_cache_key"], first["prompt_cache_key"]);
    let b_calls = vec![call("add", "add_numbers", "{\"a\":42, \"b\":8}")];
    f.wire
        .reply(events("b-parent", b_calls.clone(), recovered), mime)
        .await;
    let continued = f.wire.receive().await;
    context.extend(b_calls.clone());
    context.push(output("add", "{\"sum\":50}"));
    let expected = if transport == Transport::WebSocket {
        vec![output("add", "{\"sum\":50}")]
    } else {
        context
    };
    assert_request(
        &continued,
        &expected,
        (transport == Transport::WebSocket).then_some("b-parent"),
        &input_b,
    );
    f.wire
        .reply(events("b-final", final_items(), recovered), mime)
        .await;
    let run_b = f.finished(&sid, &b).await;
    assert_eq!(run_b["result"]["summary"]["new_tool_dispatches"], "1");
    assert_eq!(run_b["result"]["summary"]["reused_results"], "0");
    let canonical = f.records(&sid).await;
    assert_eq!(
        serde_json::to_value(&canonical[..a_records.len()]).unwrap(),
        serde_json::to_value(&a_records).unwrap()
    );
    assert_saved(
        &canonical,
        &b,
        &[("b-parent", b_calls), ("b-final", final_items())],
        recovered,
    );
    let loads_before_history = f.auth.loads.load(Ordering::SeqCst);
    f.wire.no_request();
    let latest_b = json_response(f.get(&display_path), 200).await;
    assert_eq!(
        latest_b["snapshot_head"],
        canonical.last().unwrap().sequence().to_string()
    );
    assert_eq!(latest_b["block"]["run_id"], b["run_id"]);
    assert_eq!(
        latest_b["block"]["accepted_sequence"],
        receipt_b["receipt"]["first_sequence"]
    );
    assert_eq!(latest_b["block"]["revision"], run_b["result_sequence"]);
    assert_eq!(latest_b["block"]["state"], "completed");
    assert_eq!(latest_b["block"]["result_recorded"], true);
    assert_ne!(latest_b["snapshot_head"], display_a["snapshot_head"]);
    let previous = latest_b["previous_block"].as_str().unwrap();
    let cursor: BlockCursor = previous.parse().unwrap();
    assert_eq!(cursor.session_id(), &sid);
    assert_eq!(
        cursor.before_accepted_sequence().to_string(),
        receipt_b["receipt"]["first_sequence"]
    );
    assert_eq!(
        latest_b["live_after"],
        LiveCursor::new(
            sid.clone(),
            canonical.last().unwrap().sequence(),
            3,
            None,
            None
        )
        .unwrap()
        .to_string()
    );
    let historical_a =
        json_response(f.get(&format!("{display_path}?before={previous}")), 200).await;
    assert_eq!(historical_a["snapshot_head"], latest_b["snapshot_head"]);
    assert_eq!(historical_a["block"], display_a["block"]);
    assert_eq!(historical_a["entries"], display_a["entries"]);
    assert_eq!(historical_a["earlier_activity"], Value::Null);
    assert_eq!(historical_a["previous_block"], Value::Null);
    assert_eq!(historical_a["live_after"], Value::Null);
    addressed_tools(&f, &sid, &historical_a, &tools_a).await;
    assert_eq!(f.run(&sid, &a).await, run_a);
    assert_eq!(
        json_response(
            f.get(&format!(
                "/v1/sessions/{sid}/operations/{}",
                a["operation_id"].as_str().unwrap()
            )),
            200
        )
        .await,
        operation
    );
    assert_eq!(
        serde_json::to_value(f.records(&sid).await).unwrap(),
        serde_json::to_value(&canonical).unwrap()
    );
    f.auth.assert_loads(loads_before_history);
    assert_eq!(f.wire.requests, 5);
    f.wire.no_request();
    for sequence in head + 2..=canonical.len() as u64 {
        seen.push(observer.event(&sid, sequence).await);
    }
    assert_eq!(seen, f.history(&sid).await);
    assert_eq!(seen.len(), canonical.len());
    for (event, record) in seen.iter().zip(&canonical) {
        assert_eq!(event["sequence"], record.sequence().to_string());
        assert_eq!(event["event_id"], record.event_id().as_str());
    }
    let response = seen
        .iter()
        .find(|e| e["kind"] == "response.finished" && e["data"]["response_id"] == "a-parent")
        .unwrap();
    assert_eq!(
        response["data"]["items"][0]["content"][0]["text"],
        "reason 雪\r\n"
    );
    assert_eq!(
        response["data"]["items"][1]["content"],
        json!([{"kind":"text","text":"before tools 雪\r\n"},{"kind":"refusal","text":"refusal 雪\r\n"}])
    );
    assert_eq!(response["data"]["items"][1]["unsupported_content"], false);
    assert_eq!(
        response["data"]["items"][2]["function_call"]["arguments"],
        "{\"a\":17, \"b\":25}"
    );
    assert_eq!(response["data"]["usage"]["total_tokens"], "11");
    let tools: Vec<_> = seen
        .iter()
        .filter(|e| e["kind"] == "tool.result" && e["run_id"] == a["run_id"])
        .collect();
    for (index, tool) in tools.iter().enumerate() {
        assert_eq!(tool["data"]["output"], expected_results[index]["output"]);
        assert_eq!(tool["data"]["is_error"], index == 2);
        let id = &tool["data"]["call_id"];
        let started = seen
            .iter()
            .position(|e| {
                e["kind"] == "tool.started"
                    && e["run_id"] == a["run_id"]
                    && e["data"]["call_id"] == *id
            })
            .unwrap();
        let finished = seen
            .iter()
            .position(|e| {
                e["kind"] == "tool.finished"
                    && e["run_id"] == a["run_id"]
                    && e["data"]["call_id"] == *id
            })
            .unwrap();
        let seq = tool["sequence"].as_str().unwrap().parse::<usize>().unwrap() - 1;
        assert!(started < seq && seq < finished);
        assert_eq!(seen[finished]["data"]["is_error"], index == 2);
    }
    assert_eq!(tools.len(), 3);
    assert!(
        seen.iter()
            .filter(|e| e["kind"] == "run.result")
            .all(|e| e["data"].get("last_response").is_none())
    );
    assert_eq!(
        seen.iter().filter(|e| e["kind"] == "run.accepted").count(),
        2
    );
    assert_eq!(f.wire.requests, 5);
    drop(observer);
    f.finish().await;
    assert!(
        !owned_root.try_exists().unwrap(),
        "owned joined root survived normal shutdown"
    );
    eprintln!(
        "c48_s2_display_verified {}",
        json!({
            "transport":if transport == Transport::WebSocket { "websocket" } else { "sse" },
            "mime":mime,"recovered":recovered,"source_deleted":recovered,
            "a_head":display_a["snapshot_head"],"b_head":historical_a["snapshot_head"],
            "saved_tools":tools_a.len(),"previous_block_reads":1,"owned_root":owned_root,"root_absent":true
        })
    );
}

#[test]
fn saved_s2_display_assertion_rejects_mutated_tool_facts() {
    // These DTOs test the shared assertion only. Positive producer evidence comes from roundtrip.
    let run: RunId = "11111111-1111-4111-8111-111111111111".parse().unwrap();
    let expected: Vec<_> = results()
        .iter()
        .enumerate()
        .map(|(index, result)| {
            let start = 10 + index as u64 * 3;
            completed_tool(
                &run,
                [start, start + 1, start + 2],
                ["add_numbers", "load_skill", "load_skill"][index],
                result["output"].as_str().unwrap(),
                index == 2,
            )
        })
        .collect();
    let original = json!(expected);
    assert_saved_tools(&original, &expected);
    let changed_body = json!({"id":"project:same","frontmatter":{"name":"same","description":"synthetic metadata"},"body":"changed current body\n"}).to_string();
    let rewritten = serde_json::to_string_pretty(
        &serde_json::from_str::<Value>(expected[1]["fields"][1]["text"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&rewritten).unwrap(),
        serde_json::from_str::<Value>(expected[1]["fields"][1]["text"].as_str().unwrap()).unwrap()
    );
    let mutations = [
        ("/1/fields/1/text", json!("")),
        ("/1/fields/1/text", json!("changed")),
        ("/1/fields/1/text", json!(rewritten)),
        ("/1/fields/1/text", json!(changed_body)),
        ("/0/fields/1/text", json!("{\"sum\":50}")),
        (
            "/2/fields/1/text",
            json!("{\"error\":{\"code\":\"other\"}}"),
        ),
        ("/1/is_error", json!(true)),
        ("/2/is_error", json!(false)),
        ("/1/result_recorded", json!(false)),
        ("/1/finish_recorded", json!(false)),
        ("/1/recorded_state", json!("in_progress")),
        ("/2/recorded_state", json!("completed")),
        ("/1/provisional", json!(true)),
        ("/1/reference", json!({"run_id":run,"entry_id":"e:10:0"})),
        ("/1/run_id", json!("22222222-2222-4222-8222-222222222222")),
        ("/1/entry_id", json!("e:14:0")),
        ("/1/position/sequence", json!("14")),
        ("/1/position/slot", json!("1")),
        ("/1/revision", json!("16")),
        ("/1/content_epoch", json!("14")),
        ("/1/kind", json!("assistant")),
        ("/1/fields/0/text", json!("add_numbers")),
        ("/1/fields/1/field_id", json!("a".repeat(64))),
        ("/1/fields/1/order_key", json!("0")),
        ("/1/fields/1/kind", json!("text")),
        ("/1/fields/1/generation", json!("15")),
        ("/1/fields/1/from_byte", json!("1")),
        ("/1/fields/1/to_byte", json!("1")),
        ("/1/fields/1/total_bytes", json!("1")),
        ("/1/fields/1/has_earlier", json!(true)),
        ("/1/fields/1/has_later", json!(true)),
        ("/1/earlier_content", json!("g11c.synthetic")),
        ("/1/content_complete", json!(false)),
        ("/1/fields", json!([])),
    ];
    for (pointer, value) in mutations {
        let mut changed = original.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        if let Some(field_pointer) = pointer.strip_suffix("/text") {
            let field = changed.pointer_mut(field_pointer).unwrap();
            let length = field["text"].as_str().unwrap().len().to_string();
            field["to_byte"] = json!(length);
            field["total_bytes"] = json!(length);
        }
        assert!(
            std::panic::catch_unwind(|| assert_saved_tools(&changed, &expected)).is_err(),
            "accepted mutation: {pointer}"
        );
    }
    let mut missing = original.clone();
    missing.as_array_mut().unwrap().remove(1);
    let mut reordered = original.clone();
    reordered.as_array_mut().unwrap().swap(1, 2);
    let mut reordered_fields = original.clone();
    reordered_fields[1]["fields"]
        .as_array_mut()
        .unwrap()
        .swap(0, 1);
    let mut missing_field = original.clone();
    missing_field[1]["fields"].as_array_mut().unwrap().remove(1);
    for changed in [missing, reordered, reordered_fields, missing_field] {
        assert!(std::panic::catch_unwind(|| assert_saved_tools(&changed, &expected)).is_err());
    }
}

#[tokio::test]
async fn v1b_26_29_http_websocket_native_recovered_s2_replay_and_reconnect() {
    for recovered in [false, true] {
        roundtrip(Transport::WebSocket, Some("text/event-stream"), recovered).await;
    }
}
#[tokio::test]
async fn v1b_27_29_http_labelled_sse_native_recovered_s2_replay_and_reconnect() {
    for recovered in [false, true] {
        roundtrip(Transport::Sse, Some("text/event-stream"), recovered).await;
    }
}
#[tokio::test]
async fn v1b_27_29_http_missing_mime_sse_native_recovered_s2_replay_and_reconnect() {
    for recovered in [false, true] {
        roundtrip(Transport::Sse, None, recovered).await;
    }
}
