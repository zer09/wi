use super::*;

#[derive(Clone, Copy)]
enum Fault {
    Disconnect,
    EmptyIdentity,
    WrongMime,
}

async fn failed_after_tool(transport: Transport, fault: Fault, mime: Option<&str>, code: &str) {
    let mut f = Fixture::new(transport).await;
    let sid = f.create("a").await;
    let (_, mut context) = complete_add(&mut f, &sid).await;
    let prefix = f.records(&sid).await;
    let body = command("later task fails only after the real tool executes");
    let receipt = f.submit(&sid, &body).await;
    let first = f.wire.receive().await;
    let input = f.input(&sid, &body).await;
    context.push(user(&input.prepared_request().prompt));
    assert_request(&first, &context, None, &input);
    let calls = vec![call("add", "add_numbers", "{\"a\":42, \"b\":8}")];
    f.wire
        .reply(
            events("b-tools", calls.clone(), false),
            Some("text/event-stream"),
        )
        .await;
    let continued = f.wire.receive().await;
    context.extend(calls);
    context.push(output("add", "{\"sum\":50}"));
    let expected = if transport == Transport::WebSocket {
        vec![output("add", "{\"sum\":50}")]
    } else {
        context
    };
    assert_request(
        &continued,
        &expected,
        (transport == Transport::WebSocket).then_some("b-tools"),
        &input,
    );
    let before_error = f.records(&sid).await;
    assert!(before_error.iter().any(|e| e.run_id() == Some(&rid(&body)) && matches!(e.payload(), StoredEventPayload::ToolResultRecorded(r) if r.output() == "{\"sum\":50}" && !r.is_error())));
    match fault {
        Fault::Disconnect => {
            if let Some(mut socket) = f.wire.websocket.take() {
                send(
                    &mut socket,
                    json!({"type":"response.created","response":{"id":"b-broken"}}),
                )
                .await;
                socket.close(None).await.unwrap();
            } else {
                // An actual provider SSE response ends after creation, with no terminal frame.
                f.wire
                    .reply(
                        vec![json!({"type":"response.created","response":{"id":"b-broken"}})],
                        mime,
                    )
                    .await;
            }
        }
        Fault::EmptyIdentity => f.wire.reply(events("", final_items(), false), mime).await,
        Fault::WrongMime => {
            f.wire
                .reply(events("not-admitted", final_items(), false), mime)
                .await
        }
    }
    let run = f.finished(&sid, &body).await;
    assert_eq!(run["state"], "failed");
    assert_eq!(
        run["result"]["outcome"],
        json!({"type":"failed","code":"provider_request_failed"})
    );
    assert_eq!(run["result"]["events_complete"], true);
    assert_eq!(run["result"]["sink_error"], Value::Null);
    for counter in ["model_requests_attempted", "model_requests_admitted"] {
        assert_eq!(run["result"]["summary"][counter], "2");
    }
    assert_eq!(run["result"]["summary"]["new_tool_dispatches"], "1");
    assert_eq!(run["result"]["summary"]["last_upstream_outcome"], "unknown");
    let after = f.records(&sid).await;
    assert_eq!(
        serde_json::to_value(&after[..prefix.len()]).unwrap(),
        serde_json::to_value(&prefix).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&after[..before_error.len()]).unwrap(),
        serde_json::to_value(&before_error).unwrap()
    );
    let failures: Vec<_> = after
        .iter()
        .filter_map(|e| {
            if e.run_id() == Some(&rid(&body))
                && let StoredEventPayload::RuntimeObserved(runtime) = e.payload()
                && let RunEvent::ProviderEvent { event } = &runtime.event
                && let ProviderEvent::RequestFailed {
                    code,
                    upstream_outcome,
                    ..
                } = &event.event
            {
                Some((code.as_str(), *upstream_outcome))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(failures, [(code, UpstreamOutcome::Unknown)]);
    let history = f.history(&sid).await;
    let failures: Vec<_> = history
        .iter()
        .filter(|e| e["kind"] == "response.failed" && e["run_id"] == body["run_id"])
        .collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(
        failures[0]["data"],
        json!({"code":code,"upstream_outcome":"unknown"})
    );
    let tools: Vec<_> = history
        .iter()
        .filter(|e| e["kind"] == "tool.result" && e["run_id"] == body["run_id"])
        .collect();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["data"]["output"], "{\"sum\":50}");
    assert_eq!(tools[0]["data"]["is_error"], false);
    let mut browser = Browser::open(&f, &sid, 0).await;
    for (index, event) in history.iter().enumerate() {
        assert_eq!(browser.event(&sid, index as u64 + 1).await, *event);
    }
    drop(browser);
    let loads = f.auth.loads.load(Ordering::SeqCst);
    assert_eq!(f.submit(&sid, &body).await["receipt"], receipt["receipt"]);
    f.auth.assert_loads(loads);
    assert_eq!(f.wire.requests, 4);
    // No retry, fallback or automatic replay of the now-incomplete exchange.
    f.finish().await;
}

#[tokio::test]
async fn v1b_26_http_websocket_disconnect_and_protocol_error_preserve_executed_tools() {
    for (fault, code) in [
        (Fault::Disconnect, "unexpected_end"),
        (Fault::EmptyIdentity, "protocol_error"),
    ] {
        failed_after_tool(Transport::WebSocket, fault, Some("text/event-stream"), code).await;
    }
}
#[tokio::test]
async fn v1b_27_http_sse_disconnect_and_protocol_error_preserve_executed_tools() {
    for (fault, code) in [
        (Fault::Disconnect, "unexpected_end"),
        (Fault::EmptyIdentity, "protocol_error"),
    ] {
        failed_after_tool(Transport::Sse, fault, Some("text/event-stream"), code).await;
    }
}
#[tokio::test]
async fn v1b_27_http_sse_wrong_mime_and_missing_mime_empty_id_keep_unknown_without_fallback() {
    for (fault, mime) in [
        (Fault::WrongMime, Some("application/json")),
        (Fault::EmptyIdentity, None),
    ] {
        failed_after_tool(Transport::Sse, fault, mime, "unexpected_content_type").await;
    }
}

#[test]
fn v1b_26_27_http_worker_loss_before_acceptance_keeps_unknown_and_never_redispatches() {
    use crate::execution::tests::process::harness::Process;
    // Quarantine intentionally retains the lease until process exit, including on Windows.
    for transport in [Transport::WebSocket, Transport::Sse] {
        let sandbox = tempfile::tempdir().unwrap();
        Process::start_test(sandbox.path(), &transport,
            "providers::openai_codex::tests::replay_loopback_tests::http_api_joined::failures::worker_loss_child").finish(0);
    }
}

#[test]
#[ignore = "isolated quarantine helper invoked by the joined HTTP worker-loss test"]
fn worker_loss_child() {
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    let transport: Transport = serde_json::from_str(&input).unwrap();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let mut f = Fixture::new(transport).await;
        let sid = f.create("a").await;
        complete_add(&mut f, &sid).await;
        let prefix = f.records(&sid).await;
        let loads = f.auth.loads.load(Ordering::SeqCst);
        let body = command("lose worker before second task acceptance");
        let first_lookup = Arc::new(Pause::default());
        f.hooks.arm(Point::ReceiptLookupComplete, Action::Pause(first_lookup.clone()));
        let request = f.post(&format!("/v1/sessions/{sid}/runs"), &body);
        let pending = tokio::spawn(async move { json_response(request, 503).await });
        watch(first_lookup.reached.notified()).await;
        // The handler has read the absent receipt. The next lookup is in the host worker.
        f.hooks.arm(Point::ReceiptLookupComplete, Action::Panic);
        first_lookup.release.notify_one();
        let error = watch(pending).await.unwrap();
        assert_eq!(error["code"], "api.worker_lost");
        assert_eq!(error["certainty"], "unknown");
        assert_eq!(error["acceptance"], Value::Null);
        f.auth.assert_loads(loads);
        assert_eq!(f.wire.requests, 2);
        f.wire.no_request();
        let after = f.records(&sid).await;
        assert_eq!(serde_json::to_value(&after).unwrap(), serde_json::to_value(&prefix).unwrap());
        let mut reader = f.reader(&sid).await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?").bind(body["operation_id"].as_str().unwrap()).fetch_one(&mut reader).await.unwrap();
        assert_eq!(count, 0); // An independent observation, not the API's rollback certainty.
        reader.close().await.unwrap();
        let retry = json_response(f.post(&format!("/v1/sessions/{sid}/runs"), &body), 503).await;
        assert_eq!(retry["code"], "storage.closed");
        f.auth.assert_loads(loads);
        f.wire.no_request();
        f.stop.cancel();
        let outcome = watch(f.server).await.unwrap();
        assert_eq!(outcome.http, Ok(()));
        assert!(matches!(&*outcome.shutdown, ShutdownOutcome::Incomplete { worker_lost: true, storage_error: Some(error) } if error.kind() == crate::storage::StorageErrorKind::Io));
        assert_eq!(SessionStore::open(f.temp.path().join("private-data")).await.err().unwrap().kind(), crate::storage::StorageErrorKind::Busy);
        println!("PROOF joined_http_worker_loss unknown=1 redispatch=0 fabricated_terminal=0 quarantine=1");
    });
}
