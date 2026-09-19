use super::*;
use crate::{
    Capability, ConversationReplay, DeltaKind, EventEnvelope, InputItem, ModelResponse, Provider,
    ProviderCapabilities, ProviderEvent, ProviderSession, ReplayIdentity, RequestReceipt,
    ResponseOutcome, SessionControl,
    storage::test_hooks::{Action, Pause, Point, Record},
};
use async_trait::async_trait;
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

#[derive(Default)]
struct Partial {
    generated: Notify,
    ready: Notify,
    partial: Notify,
    waiting: Notify,
    finish: Notify,
    closes: AtomicUsize,
}
struct Script(Arc<Partial>);
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        "http-test"
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "synthetic SSE observer test".into(),
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
                yield envelope(1, ProviderEvent::ResponseStarted { response_id: "response".into() });
                control.ready.notify_one();
                control.partial.notified().await;
                yield envelope(2, ProviderEvent::OutputItemUpdated {
                    response_id: "response".into(), item_id: "item".into(), output_index: 0,
                    content_index: Some(0), summary_index: None, kind: DeltaKind::Text, delta: "partial 雪\r\n".into(),
                });
                control.waiting.notify_one();
                control.finish.notified().await;
                yield envelope(3, ProviderEvent::ResponseFinished { response: ModelResponse {
                    id: "response".into(), model: Some("synthetic-model".into()), outcome: ResponseOutcome::Completed,
                    output: vec![], text: "authoritative answer".into(), usage: None,
                    native: json!({"private":"private-native-canary"}), output_provenance: Default::default(),
                } });
            }),
        })
    }
}
fn envelope(sequence: u64, event: ProviderEvent) -> EventEnvelope {
    EventEnvelope {
        schema_version: 1,
        sequence,
        event_id: format!("provider-event-{sequence}"),
        session_id: "private-provider-session-canary".into(),
        request_id: Some("request".into()),
        provider: "http-test".into(),
        provider_sequence: None,
        event,
    }
}
#[async_trait]
impl SessionControl for Partial {
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
            request_id: "request".into(),
        })
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn sse_only_committed_partial_output_and_reader_loss_never_cancels_host() {
    let control = Arc::new(Partial::default());
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(Script(control.clone()))).unwrap();
    let server = Server::gateway(Arc::new(gateway)).await;
    let session = server.session().await;
    let sid = session.session_id();
    let rid = RunId::new();
    response(
        server.post(
            &format!("/v1/sessions/{sid}/runs"),
            &json!({"operation_id":OperationId::new(),"run_id":rid,"text":"visible raw text"}),
        ),
        202,
    )
    .await;
    watchdog(control.ready.notified()).await;
    let head = session.manifest().await.unwrap().head_sequence();
    let path = format!("/v1/sessions/{sid}/events");
    let mut first = Reader::new(server.get(&path)).await;
    let mut second = Reader::new(server.get(&path)).await;
    for sequence in 1..=head {
        assert_eq!(
            first.event(sid, sequence).await,
            second.event(sid, sequence).await
        );
    }
    let pause = Arc::new(Pause::default());
    session.test_hooks().arm_record(
        Record::PartialText,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    control.partial.notify_one();
    watchdog(pause.reached.notified()).await;
    // This independent WAL reader does not wait on the deliberately held session writer lock.
    let id = sid.as_str();
    let file = server
        .temp
        .path()
        .join("private-data-canary/sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    let mut sql = watchdog(SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(file)
            .read_only(true)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging(),
    ))
    .await
    .unwrap();
    let committed: i64 = watchdog(
        sqlx::query_scalar("SELECT head_sequence FROM manifest WHERE singleton=1")
            .fetch_one(&mut sql),
    )
    .await
    .unwrap();
    assert_eq!(committed as u64, head);
    sql.close().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), first.frame())
            .await
            .is_err()
    );
    pause.release.notify_one();
    watchdog(control.waiting.notified()).await;
    let partial = first.event(sid, head + 1).await;
    assert_eq!(partial["kind"], "response.delta");
    assert_eq!(partial["data"]["delta"], "partial 雪\r\n");
    assert_eq!(second.event(sid, head + 1).await, partial);
    let pending = session.run_record(rid.clone()).await.unwrap().unwrap();
    assert!(pending.result().is_none());
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    drop(first);
    watchdog(server.event_hooks.wait_active(1)).await;
    // Only this remaining observer can consume the injected read fault.
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let error = second.frame().await.unwrap();
    assert!(error.starts_with("event: wi.error\ndata: "));
    assert!(!error.contains("id:"));
    assert!(second.frame().await.is_none());
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    drop(second);
    let mut resumed = Reader::new(
        server
            .get(&path)
            .header("Last-Event-ID", format!("{sid}:{}", head + 1)),
    )
    .await;
    server.stop.cancel();
    if let Some(frame) = resumed.frame().await {
        assert!(frame.starts_with("event: wi.closed\n"));
        assert!(!frame.contains("id:"));
        assert!(resumed.frame().await.is_none());
    }
    drop(resumed);
    assert_eq!(control.closes.load(Ordering::SeqCst), 0);
    control.finish.notify_one();
    let final_record = watchdog(async {
        loop {
            let record = session.run_record(rid.clone()).await.unwrap().unwrap();
            if record.result().is_some() {
                break record;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(matches!(
        final_record.result().unwrap().outcome,
        crate::run::RunOutcome::Completed
    ));
    server.finish().await;
}

#[tokio::test]
async fn sse_unread_snapshot_and_live_clients_leave_writer_and_fast_client_free() {
    for live in [false, true] {
        let server = Server::new().await;
        let session = server.session().await;
        let sid = session.session_id();
        let title = "x".repeat(256 * 1024);
        if !live {
            for _ in 0..65 {
                session
                    .rename(OperationId::new(), title.clone())
                    .await
                    .unwrap();
            }
        }
        let mut slow = TcpStream::connect(server.address).await.unwrap();
        slow.write_all(format!("GET /v1/sessions/{sid}/events HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\n\r\n", server.address).as_bytes()).await.unwrap();
        let mut headers = Vec::new();
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
        if live {
            for _ in 0..65 {
                watchdog(session.rename(OperationId::new(), title.clone()))
                    .await
                    .unwrap();
            }
        }
        // Leave the TCP body unread. A bounded page must eventually stop its own next read.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let reads = server.event_hooks.reads.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(server.event_hooks.reads.lock().unwrap().len(), reads);
        assert!(
            server
                .event_hooks
                .reads
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .after
                < 66
        );
        let mut fast =
            Reader::new(server.get(&format!("/v1/sessions/{sid}/events?after={sid}:66"))).await;
        watchdog(session.rename(OperationId::new(), "fast and writer continue".into()))
            .await
            .unwrap();
        assert_eq!(
            fast.event(sid, 67).await["data"]["title"],
            "fast and writer continue"
        );
        drop(slow);
        watchdog(server.event_hooks.wait_active(1)).await;
        watchdog(session.rename(OperationId::new(), "after slow drop".into()))
            .await
            .unwrap();
        assert_eq!(
            fast.event(sid, 68).await["data"]["title"],
            "after slow drop"
        );
        drop(fast);
        server.finish().await;
    }
}
