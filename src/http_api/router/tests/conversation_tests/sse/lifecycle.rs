use super::*;
use crate::{
    Capability, ConversationReplay, EventEnvelope, InputItem, ModelResponse, Provider,
    ProviderCapabilities, ProviderSession, ReplayIdentity, RequestReceipt, ResponseOutcome,
    SessionControl,
};
use async_trait::async_trait;
use std::sync::atomic::AtomicUsize;
use tokio::sync::Notify;

#[derive(Default)]
struct Control {
    generated: Notify,
    ready: Notify,
    partial: Notify,
    waiting: Notify,
    finish: Notify,
    closes: AtomicUsize,
}
struct Script(Arc<Control>);
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        "http-test"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "synthetic display H fixture".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    fn validate_replay(
        &self,
        _: &SessionOptions,
        replay: &ConversationReplay,
        _: &[InputItem],
    ) -> crate::Result<()> {
        assert!(replay.runs().is_empty());
        Ok(())
    }
    async fn open_session(&self, _: SessionOptions) -> crate::Result<ProviderSession> {
        let control = self.0.clone();
        Ok(ProviderSession {
            id: "private-provider-session-canary".into(),
            control: control.clone(),
            events: Box::pin(async_stream::stream! {
                control.generated.notified().await;
                yield envelope(1, ProviderEvent::ResponseStarted { response_id:"response".into() });
                control.ready.notify_one();
                control.partial.notified().await;
                yield envelope(2, ProviderEvent::OutputItemUpdated { response_id:"response".into(), item_id:"item".into(), output_index:0, content_index:Some(0), summary_index:None, kind:DeltaKind::Text, delta:"partial 雪\0".into() });
                control.waiting.notify_one();
                control.finish.notified().await;
                yield envelope(3, ProviderEvent::ResponseFinished { response:ModelResponse { id:"response".into(), model:None, outcome:ResponseOutcome::Completed, output:vec![], text:"authoritative answer".into(), usage:None, native:json!({"private":"private-native-canary"}), output_provenance:Default::default() } });
            }),
        })
    }
}
fn envelope(sequence: u64, event: ProviderEvent) -> EventEnvelope {
    EventEnvelope {
        schema_version: 1,
        sequence,
        event_id: format!("event-{sequence}"),
        session_id: "private-provider-session-canary".into(),
        request_id: Some(REQUEST.into()),
        provider: "http-test".into(),
        provider_sequence: None,
        event,
    }
}
#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        Some(
            ReplayIdentity::new(
                "http-test".into(),
                "private-format-canary".into(),
                "a".repeat(64),
            )
            .unwrap(),
        )
    }
    async fn install_replay(&self, replay: ConversationReplay) -> crate::Result<()> {
        assert!(replay.runs().is_empty());
        Ok(())
    }
    async fn generate(&self, _: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        self.generated.notify_one();
        Ok(RequestReceipt {
            request_id: REQUEST.into(),
        })
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}
async fn scripted() -> (Server, Arc<Control>) {
    let control = Arc::new(Control::default());
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(Script(control.clone()))).unwrap();
    (Server::gateway(Arc::new(gateway)).await, control)
}
async fn submit(server: &Server, session: &SessionHandle, control: &Control) -> RunId {
    let run = RunId::new();
    response(
        server.post(
            &format!("/v1/sessions/{}/runs", session.session_id()),
            &json!({"operation_id":OperationId::new(),"run_id":run,"text":"synthetic task"}),
        ),
        202,
    )
    .await;
    watchdog(control.ready.notified()).await;
    run
}
async fn completed(session: &SessionHandle, run: RunId) {
    watchdog(async {
        loop {
            let record = session.run_record(run.clone()).await.unwrap().unwrap();
            if let Some(result) = record.result() {
                assert!(matches!(result.outcome, RunOutcome::Completed));
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}
async fn active(server: &Server, count: usize) {
    watchdog(async {
        while server.display_hooks.active.load(Ordering::SeqCst) != count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}

async fn first_noncomment(frames: impl futures_util::Stream<Item = String>) -> String {
    use futures_util::StreamExt;
    watchdog(async {
        futures_util::pin_mut!(frames);
        // A queued heartbeat is transport-only. Never hide an unexpected application frame.
        for _ in 0..16 {
            let frame = frames.next().await.expect("error before EOF");
            if frame != ": keep-alive\n\n" {
                return frame;
            }
        }
        panic!("no noncomment within sixteen frames");
    })
    .await
}

#[tokio::test]
async fn b2_first_noncomment_accepts_error_with_or_without_heartbeat() {
    for frames in [
        vec!["event: wi.error\ndata: {}\n\n"],
        vec![": keep-alive\n\n", "event: wi.error\ndata: {}\n\n"],
    ] {
        assert_eq!(
            first_noncomment(futures_util::stream::iter(
                frames.into_iter().map(str::to_owned)
            ))
            .await,
            "event: wi.error\ndata: {}\n\n"
        );
    }
}

#[tokio::test]
async fn b2_first_noncomment_never_skips_application_mixed_or_malformed_frames() {
    use futures_util::StreamExt;
    for candidate in [
        "event: wi.conversation\ndata: {}\n\n",
        "event: wi.closed\ndata: {}\n\n",
        "data: {}\n\n",
        ": keep-alive\ndata: {}\n\n",
        ": keep-alive\nevent: wi.error\ndata: {}\n\n",
        ": keep-alive\n",
        "event: wi.error\ndata: not-json\n\n",
        "malformed\n\n",
        ": another-comment\n\n",
    ] {
        let mut frames = futures_util::stream::iter([
            ": keep-alive\n\n".to_owned(),
            candidate.to_owned(),
            "event: wi.error\ndata: {}\n\n".to_owned(),
        ]);
        assert_eq!(first_noncomment(&mut frames).await, candidate);
        assert_eq!(
            frames.next().await.unwrap(),
            "event: wi.error\ndata: {}\n\n"
        );
    }
}

#[tokio::test]
async fn b2_first_noncomment_exhausted_bound_and_eof_fail_without_scanning_later_error() {
    use futures_util::{FutureExt, StreamExt};
    let mut frames = futures_util::stream::iter(
        std::iter::repeat_n(": keep-alive\n\n".to_owned(), 16)
            .chain(std::iter::once("event: wi.error\ndata: {}\n\n".to_owned())),
    );
    assert!(
        std::panic::AssertUnwindSafe(first_noncomment(&mut frames))
            .catch_unwind()
            .await
            .is_err()
    );
    assert_eq!(
        frames.next().await.unwrap(),
        "event: wi.error\ndata: {}\n\n"
    );
    assert!(
        std::panic::AssertUnwindSafe(first_noncomment(futures_util::stream::empty()))
            .catch_unwind()
            .await
            .is_err()
    );
}

async fn error_read_retired(
    tracker: &crate::storage::test_hooks::read_retirement::Tracker,
    prefix: &crate::storage::test_hooks::read_retirement::ReadId,
) {
    let crate::storage::test_hooks::read_retirement::OpenFailure::Tracked(recipient) =
        tracker.open_failure()
    else {
        panic!("Open failure must be consumed by a tracked read")
    };
    assert!(recipient.newer_than(prefix));
    watchdog(tracker.wait_through(&recipient)).await.unwrap();
}

#[tokio::test]
async fn b2_owned_partial_commit_reader_drop_error_and_shutdown_never_cancel_host() {
    println!("C60 phase: setup");
    let (server, control) = scripted().await;
    let session = server.session().await;
    let tracker = session.test_hooks().track_reads();
    println!("C60 phase: submit");
    let run = submit(&server, &session, &control).await;
    println!("C60 phase: latest");
    let (_, after) = latest(&server, &session).await;
    println!("C60 phase: first_reader");
    let mut first = Reader::new(server.get(&path(&session, &after))).await;
    println!("C60 phase: second_reader");
    let mut second = Reader::new(server.get(&path(&session, &after))).await;
    let pause = Arc::new(Pause::default());
    session.test_hooks().arm_record(
        crate::storage::test_hooks::Record::PartialText,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    control.partial.notify_one();
    println!("C60 phase: precommit");
    watchdog(pause.reached.notified()).await;
    // A separate WAL connection observes only the old committed projection while the writer is paused.
    let mut sql = sql(&server, &session).await;
    let head: i64 = sqlx::query_scalar("SELECT applied_sequence FROM conversation_projection")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    assert_eq!(head as u64, after.sequence());
    sql.close().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), first.frame())
            .await
            .is_err()
    );
    pause.release.notify_one();
    println!("C60 phase: committed_partial");
    watchdog(control.waiting.notified()).await;
    let batch = session.conversation_changes(after.clone()).await.unwrap();
    println!("C60 phase: first_exact");
    let value = first.exact(&batch).await;
    assert!(value.to_string().contains("partial"));
    println!("C60 phase: second_exact");
    second.exact(&batch).await;
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    drop(first);
    println!("C60 phase: first_observer_retired");
    active(&server, 1).await;
    let prefix = tracker.watermark();
    println!("C60 phase: admitted_prefix_retired");
    watchdog(tracker.wait_through(&prefix)).await.unwrap();
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    println!("C60 phase: error_frame");
    let frame = first_noncomment(futures_util::stream::unfold(&mut second, |reader| async {
        reader.frame().await.map(|frame| (frame, reader))
    }))
    .await;
    println!("C60 phase: error_read_retired");
    error_read_retired(&tracker, &prefix).await;
    assert!(frame.starts_with("event: wi.error\ndata: "));
    assert!(!frame.contains("id:"));
    let error: Value = serde_json::from_str(
        frame
            .lines()
            .nth(1)
            .unwrap()
            .strip_prefix("data: ")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(error["code"], "storage.io");
    assert!(!frame.contains("private") && !frame.contains(TOKEN));
    assert!(second.frame().await.is_none());
    drop(second);
    println!("C60 phase: second_observer_retired");
    active(&server, 0).await;
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    println!("C60 phase: shutdown_reader");
    let mut last = Reader::new(server.get(&path(&session, batch.next_after()))).await;
    server.stop.cancel();
    if let Some(frame) = last.frame().await {
        assert_eq!(
            frame,
            "event: wi.closed\ndata: {\"api_version\":1,\"reason\":\"shutdown\"}\n\n"
        );
        assert!(last.frame().await.is_none());
    }
    drop(last);
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    control.finish.notify_one();
    println!("C60 phase: completed");
    completed(&session, run).await;
    println!("C60 phase: shutdown_drain");
    server.finish().await;
}

#[tokio::test]
async fn b2_queued_tcp_heartbeat_before_fault_selects_strict_error_and_host_completes() {
    error_after_partial(true).await;
}

#[tokio::test]
async fn b2_no_comment_before_fault_selects_strict_error_and_host_completes() {
    error_after_partial(false).await;
}

async fn error_after_partial(queued_heartbeat: bool) {
    use futures_util::StreamExt;
    let (server, control) = scripted().await;
    let session = server.session().await;
    let tracker = session.test_hooks().track_reads();
    let run = submit(&server, &session, &control).await;
    control.partial.notify_one();
    watchdog(control.waiting.notified()).await;
    let (_, after) = latest(&server, &session).await;
    if queued_heartbeat {
        server
            .display_hooks
            .set_heartbeat(Duration::from_millis(75));
    } else {
        // Keep comments outside the existing total watchdog for the no-comment control.
        server.display_hooks.set_heartbeat(Duration::from_secs(120));
    }
    let first = Reader::new(server.get(&path(&session, &after))).await;
    let mut second = Reader::new(server.get(&path(&session, &after))).await;
    drop(first);
    active(&server, 1).await;
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    if queued_heartbeat {
        // Retain actual TCP bytes before fault arming; do not invent a heartbeat frame.
        watchdog(async {
            for _ in 0..8 {
                if second.pending.windows(2).any(|bytes| bytes == b"\n\n") {
                    return;
                }
                let chunk = second
                    .response
                    .chunk()
                    .await
                    .unwrap()
                    .expect("idle stream open");
                second.pending.extend_from_slice(&chunk);
            }
            panic!("no complete frame within eight TCP chunks");
        })
        .await;
        let end = second
            .pending
            .windows(2)
            .position(|bytes| bytes == b"\n\n")
            .unwrap()
            + 2;
        assert_eq!(&second.pending[..end], b": keep-alive\n\n");
        println!("RB-B2-01 retained actual TCP heartbeat before fault arming");
    }
    let prefix = tracker.watermark();
    watchdog(tracker.wait_through(&prefix)).await.unwrap();
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let mut comments = 0;
    let frame = first_noncomment(
        futures_util::stream::unfold(&mut second, |reader| async {
            reader.frame().await.map(|frame| (frame, reader))
        })
        .inspect(|frame| {
            if frame == ": keep-alive\n\n" {
                comments += 1;
            }
        }),
    )
    .await;
    if queued_heartbeat {
        assert!(comments > 0);
    } else {
        assert_eq!(comments, 0);
    }
    error_read_retired(&tracker, &prefix).await;
    println!("RB-B2-01 first noncomment and retirement observed");
    assert!(frame.starts_with("event: wi.error\ndata: "));
    assert!(!frame.contains("id:"));
    let error: Value = serde_json::from_str(
        frame
            .lines()
            .nth(1)
            .unwrap()
            .strip_prefix("data: ")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        error,
        json!({"api_version":1,"code":"storage.io","stage":null,"certainty":"not_applicable","acceptance":null,"notices":[]})
    );
    assert!(!frame.contains("private") && !frame.contains(TOKEN));
    assert!(second.frame().await.is_none());
    assert_eq!(
        server
            .display_hooks
            .last
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .1,
        after
    );
    drop(second);
    active(&server, 0).await;
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    server.display_hooks.set_heartbeat(Duration::from_secs(15));
    let mut last = Reader::new(server.get(&path(&session, &after))).await;
    server.stop.cancel();
    if let Some(frame) = last.frame().await {
        assert_eq!(
            frame,
            "event: wi.closed\ndata: {\"api_version\":1,\"reason\":\"shutdown\"}\n\n"
        );
        assert!(last.frame().await.is_none());
    }
    drop(last);
    active(&server, 0).await;
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    control.finish.notify_one();
    completed(&session, run).await;
    server.finish().await;
    println!("RB-B2-01 EOF/cursor/provider-close/Completed/shutdown controls passed");
}

#[tokio::test]
async fn b2_idle_heartbeats_do_not_repeat_caught_up_frames_or_spin_reads() {
    let server = Server::new().await;
    let session = server.session().await;
    let (_, after) = latest(&server, &session).await;
    // Shorten only the heartbeat for TCP proof. The separate constants test fixes production intervals.
    server
        .display_hooks
        .set_heartbeat(Duration::from_millis(75));
    let mut reader = Reader::new(server.get(&path(&session, &after))).await;
    for _ in 0..3 {
        assert_eq!(reader.frame().await.unwrap(), ": keep-alive\n\n");
    }
    assert_eq!(server.display_hooks.reads.load(Ordering::SeqCst), 1);
    assert_eq!(reader.frame().await.unwrap(), ": keep-alive\n\n");
    assert_eq!(server.display_hooks.reads.load(Ordering::SeqCst), 2);
    drop(reader);
    server.finish().await;
}

#[cfg(unix)]
#[tokio::test]
async fn b2_actual_unread_tcp_observer_stops_pull_reads_while_writer_fast_client_and_host_progress()
{
    let (server, control) = scripted().await;
    let large = server.session().await;
    let mut writer = Writer::accept(&large, &"雪\0".repeat(20000)).await;
    writer.start().await;
    let (_, after) = latest(&server, &large).await;
    for index in 0..180 {
        tool(&mut writer, index, Some(&"雪\0".repeat(20000))).await;
    }
    let mut slow = TcpStream::connect(server.address).await.unwrap();
    slow.write_all(
        format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n",
            path(&large, &after),
            server.address
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut headers = vec![];
    watchdog(async {
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(slow.read_u8().await.unwrap());
        }
    })
    .await;
    assert!(
        String::from_utf8(headers)
            .unwrap()
            .starts_with("HTTP/1.1 200")
    );
    // No body consumption. The finite socket window stops this stream's bounded pull traversal.
    let reads = watchdog(async {
        let mut previous = server.display_hooks.reads.load(Ordering::SeqCst);
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let current = server.display_hooks.reads.load(Ordering::SeqCst);
            if current == previous {
                break current;
            }
            previous = current;
        }
    })
    .await;
    assert!(
        reads < 12,
        "only a prefix reached the stalled socket: {reads}"
    );
    watchdog(large.rename(OperationId::new(), "writer remains free".into()))
        .await
        .unwrap();
    let session = server.session().await;
    let (_, after) = latest(&server, &session).await;
    let run = submit(&server, &session, &control).await;
    let mut fast = Reader::new(server.get(&path(&session, &after))).await;
    let batch = session.conversation_changes(after.clone()).await.unwrap();
    fast.exact(&batch).await;
    control.partial.notify_one();
    watchdog(control.waiting.notified()).await;
    let next = session
        .conversation_changes(batch.next_after().clone())
        .await
        .unwrap();
    fast.exact(&next).await;
    drop(slow);
    active(&server, 1).await;
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    control.finish.notify_one();
    completed(&session, run).await;
    drop(fast);
    server.finish().await;
}

#[tokio::test]
async fn b2_retired_initial_batch_has_no_lock_and_dropped_admitted_sql_stays_owned() {
    let server = Server::new().await;
    let session = server.session().await;
    let (_, after) = latest(&server, &session).await;
    session
        .rename(OperationId::new(), "before".into())
        .await
        .unwrap();
    let batch = session.conversation_changes(after.clone()).await.unwrap();
    let pause = Arc::new(Pause::default());
    server.display_hooks.arm(1, pause.clone());
    let request = tokio::spawn(server.get(&path(&session, &after)).send());
    watchdog(pause.reached.notified()).await;
    watchdog(session.rename(OperationId::new(), "after retired read".into()))
        .await
        .unwrap();
    pause.release.notify_one();
    let reply = request.await.unwrap().unwrap();
    assert_eq!(reply.status(), 200);
    let mut reader = Reader {
        response: reply,
        pending: vec![],
    };
    reader.exact(&batch).await;
    drop(reader);
    active(&server, 0).await;
    let pause = Arc::new(Pause::default());
    session.test_hooks().arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let request = tokio::spawn(server.get(&path(&session, batch.next_after())).send());
    watchdog(pause.reached.notified()).await;
    server.stop.cancel();
    let result = watchdog(request).await.unwrap();
    if let Ok(reply) = result {
        assert_ne!(reply.status(), 200);
    }
    let shutdown = server.host.begin_shutdown();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), shutdown.wait())
            .await
            .is_err()
    );
    pause.release.notify_one();
    assert!(matches!(
        &*watchdog(shutdown.wait()).await,
        crate::service::ShutdownOutcome::Closed
    ));
    server.finish().await;
}
