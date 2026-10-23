use super::*;
use crate::conversation::{ConversationChanges, LiveCursor};
use std::{collections::BTreeSet, sync::atomic::Ordering};

mod lifecycle;
mod parity;

struct Reader {
    response: reqwest::Response,
    pending: Vec<u8>,
}
impl Reader {
    async fn new(request: reqwest::RequestBuilder) -> Self {
        // A multi-batch SSE body can outlive the fixture's ordinary 10-second response timeout.
        let response = watchdog(request.timeout(Duration::from_secs(60)).send())
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        for (name, value) in [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::VARY, "Origin"),
        ] {
            assert_eq!(response.headers()[name], value);
        }
        Self {
            response,
            pending: vec![],
        }
    }
    async fn frame(&mut self) -> Option<String> {
        watchdog(async {
            loop {
                if let Some(end) = self.pending.windows(2).position(|s| s == b"\n\n") {
                    return Some(
                        String::from_utf8(self.pending.drain(..end + 2).collect()).unwrap(),
                    );
                }
                match self.response.chunk().await.unwrap() {
                    Some(chunk) => self.pending.extend_from_slice(&chunk),
                    None => {
                        assert!(self.pending.is_empty());
                        return None;
                    }
                }
            }
        })
        .await
    }
    async fn exact(&mut self, batch: &ConversationChanges) -> Value {
        let bytes = DisplayJson::Changes(batch).encode().unwrap();
        let frame = self.frame().await.unwrap();
        assert_eq!(
            frame,
            format!(
                "event: wi.conversation\nid: {}\ndata: {}\n\n",
                batch.next_after(),
                std::str::from_utf8(&bytes).unwrap()
            )
        );
        assert!(bytes.len() <= PAGE_BYTES);
        assert!(batch.changes().len() <= 64);
        for canary in [
            TOKEN,
            "private-prepared-prompt-canary",
            "private-native-canary",
            "private-provider-session-canary",
            "private-response-canary",
            "private-item-",
        ] {
            assert!(!frame.contains(canary));
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert!(value.get("has_more").is_none());
        if batch.has_more() {
            let last = value["changes"].as_array().unwrap().last().unwrap();
            if last["kind"] == "entry.upsert" {
                assert_eq!(batch.next_after().rank(), 2);
                assert_eq!(
                    batch.next_after().sequence().to_string(),
                    last["entry"]["revision"]
                );
                assert_eq!(
                    batch.next_after().run_id().unwrap().as_str(),
                    last["entry"]["run_id"]
                );
                assert_eq!(
                    batch.next_after().entry_id().unwrap().to_string(),
                    last["entry"]["entry_id"]
                );
            } else if last["kind"] == "block.upsert" {
                assert_eq!(batch.next_after().rank(), 1);
                assert_eq!(
                    batch.next_after().sequence().to_string(),
                    last["block"]["revision"]
                );
                assert_eq!(
                    batch.next_after().run_id().unwrap().as_str(),
                    last["block"]["run_id"]
                );
            }
        }
        for change in &value["changes"].as_array().unwrap()[..] {
            if change["kind"] == "entry.upsert" {
                assert!(serde_json::to_vec(&change["entry"]).unwrap().len() <= ENTRY_BYTES);
                assert!(
                    serde_json::to_vec(&change["block"]["human"]).unwrap().len() <= ENTRY_BYTES
                );
            }
        }
        println!(
            "b2 H changes={} bytes={} head={} rank={}",
            batch.changes().len(),
            bytes.len(),
            batch.observed_head(),
            batch.next_after().rank()
        );
        value
    }
}
fn path(session: &SessionHandle, after: &LiveCursor) -> String {
    format!("{}/events?after={after}", base(session))
}
async fn latest(server: &Server, session: &SessionHandle) -> (Value, LiveCursor) {
    let value = response(server.get(&base(session)), 200).await;
    let cursor = value["live_after"].as_str().unwrap().parse().unwrap();
    (value, cursor)
}
fn cursor(
    session: &SessionHandle,
    sequence: u64,
    rank: u8,
    run: Option<RunId>,
    entry: Option<crate::conversation::EntryId>,
) -> LiveCursor {
    LiveCursor::new(session.session_id().clone(), sequence, rank, run, entry).unwrap()
}

#[tokio::test]
async fn b2_strict_display_route_boundary_before_storage_and_exact_header() {
    let server = Server::new().await;
    let session = server.session().await;
    let (_, after) = latest(&server, &session).await;
    let url = path(&session, &after);
    let bare = format!("{}/events", base(&session));
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    error(server.http.get(server.url(&url)), 401, "api.unauthorized").await;
    error(
        server.get(&url).header(header::HOST, "wrong.test"),
        421,
        "api.authority_invalid",
    )
    .await;
    error(
        server
            .get(&url)
            .header(header::ORIGIN, "https://wrong.test"),
        403,
        "api.origin_forbidden",
    )
    .await;
    for suffix in [
        "",
        "?after=x&after=x",
        "?after=x&%61fter=x",
        "?through=1",
        "?after=x&extra=x",
        "?after=%GG",
    ] {
        error(
            server.get(&format!("{bare}{suffix}")),
            400,
            "api.invalid_request",
        )
        .await;
    }
    error(
        server.get(&bare).header("Last-Event-ID", after.to_string()),
        400,
        "api.invalid_request",
    )
    .await;
    for bad in ["", "bad", "g11b.bad", "g11l.bad"] {
        error(
            server.get(&format!("{bare}?after={bad}")),
            400,
            "api.conversation_cursor_invalid",
        )
        .await;
    }
    error(
        server.get(&url).header("Last-Event-ID", "different"),
        400,
        "api.conversation_cursor_invalid",
    )
    .await;
    error(
        server
            .get(&url)
            .header("Last-Event-ID", after.to_string())
            .header("Last-Event-ID", after.to_string()),
        400,
        "api.conversation_cursor_invalid",
    )
    .await;
    error(
        server
            .get(&url)
            .header("Last-Event-ID", HeaderValue::from_bytes(&[0xff]).unwrap()),
        400,
        "api.conversation_cursor_invalid",
    )
    .await;
    error(server.get(&url).body(" "), 400, "api.invalid_request").await;
    error(
        server.get(&url).header(header::CONTENT_ENCODING, "gzip"),
        415,
        "api.unsupported_media",
    )
    .await;
    error(
        server
            .get(&url)
            .body(vec![b'x'; crate::MAX_INPUT_BYTES + 1]),
        413,
        "api.body_too_large",
    )
    .await;
    error(
        server.get("/v1/sessions/not-uuid/conversation/events?after=x"),
        400,
        "api.invalid_request",
    )
    .await;
    for method in [Method::POST, Method::HEAD, Method::PUT, Method::DELETE] {
        let reply = server
            .http
            .request(method, server.url(&url))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 405);
        assert_eq!(reply.headers()[header::ALLOW], "GET, OPTIONS");
    }
    let reply = server
        .http
        .request(Method::OPTIONS, server.url(&bare))
        .header(header::ORIGIN, ORIGIN)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization, content-type, last-event-id",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(reply.status(), 204);
    assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
    error(server.get(&url), 503, "storage.io").await;
    session
        .rename(OperationId::new(), "exact header 雪\0".into())
        .await
        .unwrap();
    let batch = session.conversation_changes(after.clone()).await.unwrap();
    let mut reader = Reader::new(
        server
            .get(&url)
            .header("Last-Event-ID", after.to_string())
            .header(header::ORIGIN, ORIGIN),
    )
    .await;
    assert_eq!(
        reader.response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        ORIGIN
    );
    reader.exact(&batch).await;
    drop(reader);
    server.finish().await;
}

#[tokio::test]
async fn b2_resource_future_owner_missing_and_corrupt_boundaries_are_non200() {
    let server = Server::new().await;
    let session = server.session().await;
    let writer = Writer::accept(&session, "anchor").await;
    let page = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let head = page.snapshot_head();
    let human = *page.block().unwrap().human().entry_id();
    let other = server.session().await;
    let (_, wrong) = latest(&server, &other).await;
    for after in [
        wrong,
        cursor(&session, head + 1, 3, None, None),
        cursor(&session, head, 0, None, None),
        cursor(
            &session,
            head,
            2,
            Some(writer.run.clone()),
            Some("e:1:0".parse().unwrap()),
        ),
    ] {
        error(
            server.get(&path(&session, &after)),
            400,
            "api.conversation_cursor_invalid",
        )
        .await;
    }
    for after in [
        cursor(&session, head, 1, Some(RunId::new()), None),
        cursor(
            &session,
            head,
            2,
            Some(writer.run.clone()),
            Some("e:2:99".parse().unwrap()),
        ),
    ] {
        error(
            server.get(&path(&session, &after)),
            404,
            "storage.not_found",
        )
        .await;
    }
    let missing = ApplicationSessionId::new();
    let after = LiveCursor::new(missing.clone(), 1, 3, None, None).unwrap();
    error(
        server.get(&format!(
            "/v1/sessions/{missing}/conversation/events?after={after}"
        )),
        404,
        "storage.not_found",
    )
    .await;
    let mut sql = sql(&server, &session).await;
    sqlx::query("UPDATE conversation_entries SET source_key=zeroblob(32) WHERE entry_id=?")
        .bind(human.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let after = cursor(&session, head, 2, Some(writer.run), Some(human));
    error(
        server.get(&path(&session, &after)),
        500,
        "storage.integrity",
    )
    .await;
    server.finish().await;
}

#[tokio::test]
async fn b2_snapshot_attachment_and_private_only_watermark_are_exact_and_warm() {
    let server = Server::new().await;
    let session = server.session().await;
    let mut a = Writer::accept(&session, "Task A").await;
    a.start().await;
    let (snapshot_h, after) = latest(&server, &session).await;
    assert_eq!(snapshot_h["snapshot_head"], after.sequence().to_string());
    a.delta(0, "雪\0\"\\\r\nevent: forged").await;
    a.runtime(RunEvent::ToolEvent {
        event: ToolExecutionEvent::ToolExecutionStarted {
            call_id: "call".into(),
            tool_name: "synthetic".into(),
        },
    })
    .await;
    a.session
        .append_run_records(
            OperationId::new(),
            a.run.clone(),
            vec![AppendRunRecord::ToolResult {
                call_id: "call".into(),
                request_id: Some(REQUEST.into()),
                output: "actual output\0雪".into(),
                is_error: false,
            }],
        )
        .await
        .unwrap();
    session
        .rename(OperationId::new(), "renamed 雪".into())
        .await
        .unwrap();
    a.result().await;
    let _b = Writer::accept(&session, "Task B").await;
    let before = snapshot(&server, &session).await;
    let batch = session.conversation_changes(after.clone()).await.unwrap();
    let mut reader = Reader::new(server.get(&path(&session, &after))).await;
    let value = reader.exact(&batch).await;
    let text = value.to_string();
    assert!(text.contains("Task B") && text.contains("actual output") && text.contains("renamed"));
    assert!(
        value["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entry"]["is_error"] == false)
    );
    assert_eq!(snapshot(&server, &session).await, before);
    drop(reader);
    // A separate session permits private-only advancement without any visible row change.
    let private = server.session().await;
    let run = RunId::new();
    let selection = crate::storage::StoredHistorySelection::new(
        1,
        "a".repeat(64),
        "synthetic".into(),
        "synthetic-model".into(),
        None,
    )
    .unwrap();
    private
        .accept_history_run(OperationId::new(), run.clone(), input("anchor"), selection)
        .await
        .unwrap();
    let mut writer = Writer {
        session: private.clone(),
        run: run.clone(),
        sequence: 0,
    };
    writer.runtime(RunEvent::RunStarted).await;
    let (_, after) = latest(&server, &private).await;
    let binding = crate::storage::RecordedProviderBinding::new(
        run.clone(),
        "private-provider-session-canary".into(),
        "synthetic-model".into(),
        crate::ReplayIdentity::new(
            "synthetic".into(),
            "private-format-canary".into(),
            "a".repeat(64),
        )
        .unwrap(),
    )
    .unwrap();
    private
        .append_run_records(
            OperationId::new(),
            run,
            vec![AppendRunRecord::ProviderBinding(binding)],
        )
        .await
        .unwrap();
    let before = snapshot(&server, &private).await;
    let batch = private.conversation_changes(after.clone()).await.unwrap();
    assert!(batch.changes().is_empty());
    assert!(batch.next_after().sequence() > after.sequence());
    let mut reader = Reader::new(server.get(&path(&private, &after))).await;
    assert_eq!(reader.exact(&batch).await["changes"], json!([]));
    assert!(
        tokio::time::timeout(Duration::from_millis(600), reader.frame())
            .await
            .is_err()
    );
    assert_eq!(snapshot(&server, &private).await, before);
    drop(reader);
    server.finish().await;
}

async fn tool(writer: &mut Writer, index: usize, output: Option<&str>) {
    let call = format!("call-{index}");
    writer
        .runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: call.clone(),
                tool_name: "synthetic".into(),
            },
        })
        .await;
    if let Some(output) = output {
        writer
            .session
            .append_run_records(
                OperationId::new(),
                writer.run.clone(),
                vec![AppendRunRecord::ToolResult {
                    call_id: call,
                    request_id: Some(REQUEST.into()),
                    output: output.into(),
                    is_error: false,
                }],
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn b2_count_size_ties_exact_prefixes_and_moving_revision_converge() {
    for large in [false, true] {
        let server = Server::new().await;
        let session = server.session().await;
        let text = "\0\"\\雪🦀".repeat(18000);
        let mut writer = Writer::accept(&session, if large { &text } else { "anchor" }).await;
        writer.start().await;
        let (_, mut after) = latest(&server, &session).await;
        if large {
            writer.delta(0, "initial revision").await;
        }
        let count = if large { 25 } else { 145 };
        for index in 0..count {
            tool(&mut writer, index, large.then_some(text.as_str())).await;
        }
        if !large {
            writer
                .runtime(RunEvent::TurnFinished {
                    number: 1,
                    response_id: None,
                    outcome: crate::run::TurnOutcome::Stopped {
                        reason: RunOutcome::CancelledLocally,
                    },
                    upstream_outcome: None,
                })
                .await;
            writer
                .runtime(RunEvent::RunFinished {
                    outcome: RunOutcome::CancelledLocally,
                    summary: RunSummary::default(),
                })
                .await;
        }
        let head = session.manifest().await.unwrap().head_sequence();
        let mut batch = session.conversation_changes(after.clone()).await.unwrap();
        assert!(batch.has_more());
        let pause = Arc::new(Pause::default());
        server.display_hooks.arm(2, pause.clone());
        let mut reader = Reader::new(server.get(&path(&session, &after))).await;
        let first = reader.exact(&batch).await;
        let mut ids = BTreeSet::new();
        let collect = |value: &Value, ids: &mut BTreeSet<String>| {
            for c in value["changes"].as_array().unwrap() {
                if c["kind"] == "entry.upsert" {
                    ids.insert(c["entry"]["entry_id"].as_str().unwrap().into());
                }
            }
        };
        collect(&first, &mut ids);
        after = batch.next_after().clone();
        assert_ne!(after.rank(), 3);
        batch = session.conversation_changes(after).await.unwrap();
        watchdog(pause.reached.notified()).await;
        let retired = server.display_hooks.last.lock().unwrap().clone().unwrap();
        assert!(retired.1 == *batch.next_after());
        assert_eq!(retired.2, batch.observed_head());
        // The next batch is retired. Move a previously returned entry before another read.
        if large {
            writer.delta(0, "newer final revision").await;
        }
        pause.release.notify_one();
        let mut batches = 1;
        let mut final_revision_seen = false;
        loop {
            let value = reader.exact(&batch).await;
            collect(&value, &mut ids);
            if value.to_string().contains("newer final revision") {
                final_revision_seen = true;
                assert!(batch.observed_head() > head);
            }
            batches += 1;
            let more = batch.has_more();
            after = batch.next_after().clone();
            if more {
                assert_ne!(after.rank(), 3);
            }
            if !more && (!large || batch.observed_head() > head) {
                break;
            }
            batch = session.conversation_changes(after.clone()).await.unwrap();
        }
        assert_eq!(ids.len(), count + 1);
        if large {
            assert!(final_revision_seen);
        }
        let mut sql = sql(&server, &session).await;
        let expected: Vec<String> = sqlx::query_scalar(
            "SELECT entry_id FROM conversation_entries WHERE kind!='human' ORDER BY entry_id",
        )
        .fetch_all(&mut sql)
        .await
        .unwrap();
        sql.close().await.unwrap();
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), expected);
        assert!(batches >= 2);
        if !large {
            assert_eq!(batches, 3);
        }
        assert_eq!(after.rank(), 3);
        println!(
            "b2 prefix traversal large={large} batches={batches} unique_entries={}",
            expected.len()
        );
        drop(reader);
        server.finish().await;
    }
}
