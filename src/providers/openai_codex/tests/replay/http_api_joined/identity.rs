use super::*;

async fn account_guard(transport: Transport) {
    let mut f = Fixture::new(transport).await;
    let sid = f.create("a").await;
    let (a, mut context) = complete_add(&mut f, &sid).await;
    let prefix = f.records(&sid).await;
    let loads = f.auth.loads.load(Ordering::SeqCst);
    f.auth.rotate(TOKEN_B, "synthetic-account-y");
    let b = command("account Y must not receive A");
    let receipt = f.submit(&sid, &b).await;
    assert_eq!(receipt["duplicate"], false);
    if transport == Transport::WebSocket {
        let mut socket = watch(accept_counted(
            &f.wire.listener,
            TOKEN_B,
            "synthetic-account-y",
        ))
        .await;
        // Identity equality is checked after opening WS, but before any history-bearing request.
        watch(drain_close(&mut socket)).await;
    }
    let failed = f.finished(&sid, &b).await;
    assert_eq!(failed["state"], "failed");
    assert_eq!(
        failed["result"]["outcome"],
        json!({"type":"failed","code":"history_identity"})
    );
    for counter in [
        "model_requests_attempted",
        "model_requests_admitted",
        "new_tool_dispatches",
    ] {
        assert_eq!(failed["result"]["summary"][counter], "0");
    }
    assert_eq!(
        failed["result"]["summary"]["last_upstream_outcome"],
        Value::Null
    );
    f.auth.assert_loads(loads + 1);
    assert_eq!(f.wire.requests, 2);
    f.wire.no_request();
    let after_b = f.records(&sid).await;
    assert_eq!(
        serde_json::to_value(&after_b[..prefix.len()]).unwrap(),
        serde_json::to_value(&prefix).unwrap()
    );
    let binding = |body: &Value| {
        after_b
            .iter()
            .find_map(|e| {
                if e.run_id() == Some(&rid(body))
                    && let StoredEventPayload::RunProviderBound(binding) = e.payload()
                {
                    Some(binding)
                } else {
                    None
                }
            })
            .unwrap()
    };
    assert_ne!(binding(&a).identity(), binding(&b).identity());
    let expected = ring::digest::digest(
        &ring::digest::SHA256,
        b"wi.openai-codex.account.v1\0synthetic-account-y",
    );
    let digest: String = expected
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(binding(&b).identity().principal_digest() == digest);
    let selected = after_b
        .iter()
        .find_map(|e| {
            if e.run_id() == Some(&rid(&b))
                && let StoredEventPayload::RunHistorySelected(s) = e.payload()
            {
                Some(s)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(
        selected.selection().expected_identity(),
        Some(binding(&a).identity())
    );
    assert_eq!(f.submit(&sid, &b).await["receipt"], receipt["receipt"]);
    f.auth.assert_loads(loads + 1);

    // Only a later explicit command with X can continue. The failed Y task is excluded.
    f.auth.rotate(TOKEN_A, ACCOUNT);
    let c = command("later explicit matching account X");
    f.submit(&sid, &c).await;
    let body = f.wire.receive().await;
    let input = f.input(&sid, &c).await;
    context.push(user(&input.prepared_request().prompt));
    assert_request(&body, &context, None, &input);
    assert!(
        !body["input"]
            .to_string()
            .contains(b["text"].as_str().unwrap())
    );
    let calls = vec![call("add", "add_numbers", "{\"a\":42,\"b\":8}")];
    f.wire
        .reply(
            events("c-parent", calls.clone(), false),
            Some("text/event-stream"),
        )
        .await;
    let body = f.wire.receive().await;
    context.extend(calls);
    context.push(output("add", "{\"sum\":50}"));
    let expected = if transport == Transport::WebSocket {
        vec![output("add", "{\"sum\":50}")]
    } else {
        context
    };
    assert_request(
        &body,
        &expected,
        (transport == Transport::WebSocket).then_some("c-parent"),
        &input,
    );
    f.wire
        .reply(
            events("c-final", final_items(), false),
            Some("text/event-stream"),
        )
        .await;
    assert_eq!(f.finished(&sid, &c).await["state"], "completed");
    let canonical = f.records(&sid).await;
    assert_eq!(
        serde_json::to_value(&canonical[..after_b.len()]).unwrap(),
        serde_json::to_value(&after_b).unwrap()
    );
    let history = f.history(&sid).await;
    assert!(!serde_json::to_string(&history).unwrap().contains(&digest));
    let mut stream = Browser::open(&f, &sid, 0).await;
    for event in history {
        let sequence = event["sequence"].as_str().unwrap().parse().unwrap();
        assert_eq!(stream.event(&sid, sequence).await, event);
    }
    drop(stream);
    assert_eq!(f.wire.requests, 4);
    f.finish().await;
}

#[tokio::test]
async fn v1b_28_http_websocket_account_x_y_x_records_mismatch_without_history_transmission() {
    account_guard(Transport::WebSocket).await;
}
#[tokio::test]
async fn v1b_28_http_sse_account_x_y_x_records_mismatch_without_history_transmission() {
    account_guard(Transport::Sse).await;
}
