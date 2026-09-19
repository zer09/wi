use super::*;
use std::sync::atomic::AtomicBool;
use tokio::sync::Notify;

async fn cancel(f: &Fixture, sid: &ApplicationSessionId, run: &RunId, status: u16) -> Value {
    let value = json_response(
        f.post(&format!("/v1/sessions/{sid}/runs/{run}/cancel"), &json!({})),
        status,
    )
    .await;
    assert_eq!(
        value["disposition"],
        if status == 202 {
            "requested"
        } else {
            "not_tracked"
        }
    );
    assert!(value.get("outcome").is_none());
    value
}

async fn dropped_callers(transport: Transport) {
    for before_acceptance in [true, false] {
        let mut f = Fixture::new(transport).await;
        let sid = f.create("a").await;
        let body = command(RAW);
        let path = format!("/v1/sessions/{sid}/runs");
        if before_acceptance {
            let acceptance = f.pause(Record::Acceptance, Point::BeforeCommit);
            let mut socket = TcpStream::connect(f.address).await.unwrap();
            let encoded = body.to_string();
            socket.write_all(format!("POST {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {OWNER}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{encoded}", f.address, encoded.len()).as_bytes()).await.unwrap();
            watch(acceptance.reached.notified()).await;
            assert_eq!(f.records(&sid).await.len(), 1);
            f.auth.assert_loads(0);
            // Closing the caller drops its acceptance waiter/ticket, not the host or owned SQL.
            drop(socket);
            acceptance.release.notify_one();
        } else {
            let client = http();
            let response = watch(
                client
                    .post(format!("http://{}{path}", f.address))
                    .bearer_auth(OWNER)
                    .json(&body)
                    .send(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), 202);
            drop(response); // Deliberately do not read the acceptance body.
            drop(client);
        }
        let wire = f.wire.receive().await;
        let input = f.input(&sid, &body).await;
        assert_request(
            &wire,
            &[user(&input.prepared_request().prompt)],
            None,
            &input,
        );
        let stream = Browser::open(&f, &sid, 0).await;
        let intent = f.pause(Record::ToolIntent, Point::AfterCommit);
        let calls = vec![call("add", "add_numbers", "{\"a\":17,\"b\":25}")];
        f.wire
            .reply(
                events("tools", calls.clone(), false),
                Some("text/event-stream"),
            )
            .await;
        watch(intent.reached.notified()).await;
        drop(stream);
        assert!(
            !f.records(&sid)
                .await
                .iter()
                .any(|r| matches!(r.payload(), StoredEventPayload::ToolResultRecorded(_)))
        );
        let result = f.pause(Record::ToolResult, Point::BeforeCommit);
        intent.release.notify_one();
        watch(result.reached.notified()).await;
        let prefix = f.records(&sid).await;
        assert!(
            !prefix
                .iter()
                .any(|r| matches!(r.payload(), StoredEventPayload::ToolResultRecorded(_)))
        );
        assert_eq!(f.wire.requests, 1);
        // Actual AddNumbers has returned, but its admitted SQL still owns the output.
        result.release.notify_one();
        let continued = f.wire.receive().await;
        let mut expected = vec![output("add", "{\"sum\":42}")];
        if transport == Transport::Sse {
            expected = vec![user(&input.prepared_request().prompt)];
            expected.extend(calls);
            expected.push(output("add", "{\"sum\":42}"));
        }
        assert_request(
            &continued,
            &expected,
            (transport == Transport::WebSocket).then_some("tools"),
            &input,
        );
        let final_result = f.pause(Record::FinalResult, Point::BeforeCommit);
        f.wire
            .reply(
                events("done", final_items(), false),
                Some("text/event-stream"),
            )
            .await;
        watch(final_result.reached.notified()).await;
        let records = f.records(&sid).await;
        assert!(records.iter().any(|r| matches!(r.payload(), StoredEventPayload::RuntimeObserved(e) if matches!(e.event, RunEvent::RunFinished { .. }))));
        assert!(
            !records
                .iter()
                .any(|r| matches!(r.payload(), StoredEventPayload::RunResultRecorded(_)))
        );
        final_result.release.notify_one();
        let run = f.finished(&sid, &body).await;
        assert_eq!(run["state"], "completed");
        assert_eq!(run["result"]["summary"]["new_tool_dispatches"], "1");
        assert_eq!(run["result"]["summary"]["model_requests_admitted"], "2");
        let receipt = f.submit(&sid, &body).await;
        assert_eq!(receipt["duplicate"], true);
        assert_eq!(receipt["receipt"]["operation_id"], body["operation_id"]);
        assert_eq!(receipt["receipt"]["first_sequence"], "2");
        assert_eq!(receipt["receipt"]["last_sequence"], "3");
        let history = f.history(&sid).await;
        assert_eq!(
            history
                .iter()
                .filter(|e| e["kind"] == "run.accepted")
                .count(),
            1
        );
        let results: Vec<_> = history
            .iter()
            .filter(|e| e["kind"] == "tool.result")
            .collect();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["data"]["output"], "{\"sum\":42}");
        assert_eq!(results[0]["data"]["is_error"], false);
        let mut stream = Browser::open(&f, &sid, 0).await;
        for (index, event) in history.iter().enumerate() {
            assert_eq!(stream.event(&sid, index as u64 + 1).await, *event);
        }
        drop(stream);
        f.finish().await;
    }
}

struct GatedCredentials {
    source: Arc<CountedAuth>,
    armed: AtomicBool,
    reached: Notify,
    release: Notify,
}
#[async_trait]
impl CredentialSource for GatedCredentials {
    async fn prepare_submission(&self) -> Result<()> {
        self.source.prepare_submission().await
    }
    async fn load(&self) -> Result<SubscriptionCredentials> {
        if self.armed.swap(false, Ordering::SeqCst) {
            self.reached.notify_one();
            self.release.notified().await;
        }
        self.source.load().await
    }
}

async fn cancellation(transport: Transport) {
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let credentials = Arc::new(GatedCredentials {
        source: auth.clone(),
        armed: AtomicBool::new(false),
        reached: Notify::new(),
        release: Notify::new(),
    });
    let mut f = Fixture::with_auth(transport, auth.clone(), credentials.clone()).await;
    let sid = f.create("a").await;
    complete_add(&mut f, &sid).await;
    let before = f.records(&sid).await;
    let loads = auth.loads.load(Ordering::SeqCst);
    let other = f.create("b").await;
    credentials.armed.store(true, Ordering::SeqCst);
    let body = command("cancel before provider identity");
    let receipt = f.submit(&sid, &body).await;
    watch(credentials.reached.notified()).await;
    cancel(&f, &other, &rid(&body), 200).await;
    cancel(&f, &sid, &RunId::new(), 200).await;
    assert_eq!(f.run(&sid, &body).await["result_recorded"], false);
    cancel(&f, &sid, &rid(&body), 202).await;
    let run = f.finished(&sid, &body).await;
    assert_eq!(run["state"], "cancelled_locally");
    assert_eq!(run["result"]["summary"]["model_requests_attempted"], "0");
    assert_eq!(
        run["result"]["summary"]["last_upstream_outcome"],
        Value::Null
    );
    assert_eq!(auth.loads.load(Ordering::SeqCst), loads);
    assert_eq!(auth.prepares.load(Ordering::SeqCst), loads + 1);
    f.wire.no_request();
    let after = f.records(&sid).await;
    assert_eq!(
        serde_json::to_value(&after[..before.len()]).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    assert!(!after.iter().any(|e| e.run_id() == Some(&rid(&body))
        && matches!(e.payload(), StoredEventPayload::RunProviderBound(_))));
    assert_eq!(f.submit(&sid, &body).await["receipt"], receipt["receipt"]);
    cancel(&f, &sid, &rid(&body), 200).await;
    // Cancellation is addressed. A second session still traverses the adapter and real tools.
    complete_add(&mut f, &other).await;
    f.finish().await;

    let mut f = Fixture::new(transport).await;
    let sid = f.create("a").await;
    let other = f.create("b").await;
    let body = command("cancel while actual tool-result SQL is admitted");
    f.submit(&sid, &body).await;
    f.wire.receive().await;
    let result = f.pause(Record::ToolResult, Point::BeforeCommit);
    f.wire
        .reply(
            events(
                "tools",
                vec![
                    call("add", "add_numbers", "{\"a\":17,\"b\":25}"),
                    call("later", "add_numbers", "{\"a\":1,\"b\":2}"),
                ],
                false,
            ),
            Some("text/event-stream"),
        )
        .await;
    watch(result.reached.notified()).await;
    cancel(&f, &other, &rid(&body), 200).await;
    cancel(&f, &sid, &RunId::new(), 200).await;
    cancel(&f, &sid, &rid(&body), 202).await;
    let before = f.records(&sid).await;
    assert!(!before.iter().any(|e| matches!(
        e.payload(),
        StoredEventPayload::ToolResultRecorded(_) | StoredEventPayload::RunResultRecorded(_)
    )));
    result.release.notify_one();
    let run = f.finished(&sid, &body).await;
    assert_eq!(run["state"], "cancelled_locally");
    assert_eq!(run["result"]["summary"]["new_tool_dispatches"], "1");
    assert_eq!(run["result"]["summary"]["tool_results_prepared"], "1");
    assert_eq!(
        run["result"]["summary"]["last_upstream_outcome"],
        "terminal_received"
    );
    assert_eq!(f.wire.requests, 1);
    let history = f.history(&sid).await;
    let tools: Vec<_> = history
        .iter()
        .filter(|e| e["kind"] == "tool.result")
        .collect();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["data"]["output"], "{\"sum\":42}");
    assert_eq!(tools[0]["data"]["is_error"], false);
    assert!(
        !history
            .iter()
            .any(|e| e["kind"] == "tool.started" && e["data"]["call_id"] == "later")
    );
    let mut stream = Browser::open(&f, &sid, 0).await;
    for (index, event) in history.iter().enumerate() {
        assert_eq!(stream.event(&sid, index as u64 + 1).await, *event);
    }
    drop(stream);
    cancel(&f, &sid, &rid(&body), 200).await;
    f.finish().await;
}

#[tokio::test]
async fn v1b_26_http_websocket_caller_response_and_observer_loss_drain_model_tools_sql() {
    dropped_callers(Transport::WebSocket).await;
}
#[tokio::test]
async fn v1b_27_http_sse_caller_response_and_observer_loss_drain_model_tools_sql() {
    dropped_callers(Transport::Sse).await;
}
#[tokio::test]
async fn v1b_26_http_websocket_addressed_cancel_before_identity_and_during_tool_commit() {
    cancellation(Transport::WebSocket).await;
}
#[tokio::test]
async fn v1b_27_http_sse_addressed_cancel_before_identity_and_during_tool_commit() {
    cancellation(Transport::Sse).await;
}
