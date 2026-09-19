use super::*;

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
fn assert_saved(
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

async fn roundtrip(transport: Transport, mime: Option<&str>, recovered: bool) {
    let mut f = Fixture::new(transport).await;
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
    f.submit(&sid, &b).await;
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
