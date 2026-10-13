use super::*;
use crate::{ConversationReplay, ReplayIdentity, providers::openai_codex::PROVIDER_ID};
use in_session::fixture::Fixture;

const SESSION: &str = "01234567-89ab-1cde-8fab-0123456789ab";
const REQUEST: &str = "01234567-89ab-5cde-8fab-0123456789ab";

#[derive(Default)]
struct Counts {
    opens: AtomicUsize,
    generates: AtomicUsize,
    polls: AtomicUsize,
    closes: AtomicUsize,
    identities: AtomicUsize,
    installs: AtomicUsize,
}
struct LocalScript {
    provider: &'static str,
    session: String,
    events: Vec<EventEnvelope>,
    counts: Arc<Counts>,
}
struct LocalControl {
    provider: &'static str,
    events: Mutex<Vec<EventEnvelope>>,
    sender: mpsc::UnboundedSender<EventEnvelope>,
    counts: Arc<Counts>,
}
#[async_trait]
impl Provider for LocalScript {
    fn id(&self) -> &'static str {
        self.provider
    }
    fn capabilities(&self) -> ProviderCapabilities {
        capabilities()
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
        self.counts.opens.fetch_add(1, Ordering::SeqCst);
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let counts = self.counts.clone();
        Ok(ProviderSession {
            id: self.session.clone(),
            control: Arc::new(LocalControl {
                provider: self.provider,
                events: Mutex::new(self.events.clone()),
                sender,
                counts: counts.clone(),
            }),
            events: Box::pin(futures_util::stream::poll_fn(move |cx| {
                counts.polls.fetch_add(1, Ordering::SeqCst);
                receiver.poll_recv(cx)
            })),
        })
    }
}
#[async_trait]
impl SessionControl for LocalControl {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        self.counts.identities.fetch_add(1, Ordering::SeqCst);
        Some(
            ReplayIdentity::new(self.provider.into(), "synthetic-v1".into(), "a".repeat(64))
                .unwrap(),
        )
    }
    async fn install_replay(&self, _: ConversationReplay) -> crate::Result<()> {
        self.counts.installs.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn generate(&self, _: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        assert_eq!(self.counts.generates.fetch_add(1, Ordering::SeqCst), 0);
        for event in self.events.lock().unwrap().drain(..) {
            self.sender.send(event).unwrap();
        }
        Ok(RequestReceipt {
            request_id: REQUEST.into(),
        })
    }
    fn close(&self) {
        self.counts.closes.fetch_add(1, Ordering::SeqCst);
    }
}
fn event(sequence: u64, provider_event: ProviderEvent) -> EventEnvelope {
    EventEnvelope {
        schema_version: 1,
        sequence,
        event_id: format!("{SESSION}:{sequence}"),
        session_id: SESSION.into(),
        request_id: Some(REQUEST.into()),
        provider: PROVIDER_ID.into(),
        // Deliberately unrelated to the local identity.
        provider_sequence: Some(0),
        event: provider_event,
    }
}
fn terminal(tools: bool) -> EventEnvelope {
    event(
        u64::MAX,
        ProviderEvent::ResponseFinished {
            response: response(
                "terminal",
                if tools {
                    vec![call("forbidden", 1, 2)]
                } else {
                    vec![]
                },
                "done",
            ),
        },
    )
}

async fn persist(
    provider: &'static str,
    session_id: String,
    events: Vec<EventEnvelope>,
    malformed_session: bool,
    failed: bool,
    polls: usize,
) {
    let fixture = Fixture::new().await;
    let counts = Arc::new(Counts::default());
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(LocalScript {
            provider,
            session: session_id.clone(),
            events,
            counts: counts.clone(),
        }))
        .unwrap();
    let input = RecordedRunInput::new(
        "synthetic".into(),
        RunRequest {
            provider_id: provider.into(),
            options: SessionOptions::new("synthetic"),
            prompt: "synthetic".into(),
        },
        fixture.tools.definitions(),
        vec![],
        vec![],
        None,
    )
    .unwrap();
    let run_id = RunId::new();
    let hooks = fixture.session.test_hooks();
    let pause = Arc::new(crate::storage::test_hooks::Pause::default());
    hooks.arm_record(
        crate::storage::test_hooks::Record::RunFinished,
        crate::storage::test_hooks::Point::BeforeCommit,
        crate::storage::test_hooks::Action::Pause(pause.clone()),
    );
    let running = hooks.scope(run_in_session(
        &gateway,
        &fixture.session,
        PersistentRunRequest {
            operation_id: OperationId::new(),
            run_id: run_id.clone(),
            input,
        },
        &fixture.tools,
        CancellationToken::new(),
    ));
    tokio::pin!(running);
    tokio::select! {
        _ = pause.reached.notified() => {},
        _ = &mut running => panic!("final event did not reach its commit barrier"),
    }
    // Cleanup must happen before healthy final delivery, even for an invalid open.
    assert_eq!(count(&counts.closes), 1);
    assert_eq!(count(&counts.polls), polls);
    assert_eq!(count(&fixture.counts.effects), 0);
    pause.release.notify_one();
    let (_, final_record, result) = executed(running.await.unwrap());
    assert_eq!(
        result.outcome,
        if failed {
            RunOutcome::Failed {
                code: "provider_correlation".into(),
            }
        } else {
            RunOutcome::Completed
        }
    );
    assert!(result.events_complete);
    assert!(result.sink_error.is_none());
    assert_eq!(
        result.session_id.as_deref(),
        (!malformed_session).then_some(session_id.as_str())
    );
    let work = u64::from(!malformed_session);
    assert_eq!(result.summary.model_requests_attempted, work);
    assert_eq!(result.summary.model_requests_admitted, work);
    assert_eq!(result.summary.turns_started, work);
    assert_eq!(result.summary.turns_finished, work);
    assert_eq!(
        result.summary.last_request_id.as_deref(),
        (!malformed_session).then_some(REQUEST)
    );
    assert_eq!(
        result.summary.last_upstream_outcome,
        if malformed_session {
            None
        } else if failed {
            Some(UpstreamOutcome::Unknown)
        } else {
            Some(UpstreamOutcome::TerminalReceived)
        }
    );
    assert_eq!(count(&counts.opens), 1);
    assert_eq!(count(&counts.generates), work as usize);
    assert_eq!(count(&counts.polls), polls);
    assert_eq!(count(&counts.closes), 1);
    assert_eq!(count(&counts.identities), work as usize);
    assert_eq!(count(&counts.installs), work as usize);
    assert_eq!(count(&fixture.counts.effects), 0);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.last_response.is_some(), !failed);
    assert!(final_record.cleanup_warning().is_none());
    assert_eq!(
        fixture
            .session
            .lookup_receipt(final_record.receipt().operation_id().clone())
            .await
            .unwrap()
            .as_ref(),
        Some(final_record.receipt())
    );
    let saved = fixture
        .session
        .run_record(run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(value(saved.result().unwrap()), value(&result));
    let records = history(&fixture.session).await;
    assert_eq!(records.iter().filter(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::ProviderEvent { .. }))).count(), if failed { polls.saturating_sub(1) } else { polls });
    assert_eq!(
        fixture
            .session
            .provider_binding(run_id.clone())
            .await
            .unwrap()
            .is_some(),
        !malformed_session
    );
    if malformed_session && !session_id.is_empty() {
        assert!(
            !serde_json::to_string(&records)
                .unwrap()
                .contains(&serde_json::to_string(&session_id).unwrap())
        );
    }
    fixture.store.close().await.unwrap();
    let reopened = SessionStore::open(fixture.temp.path().join("root"))
        .await
        .unwrap();
    let handle = reopened
        .open_session(fixture.session.session_id().clone())
        .await
        .unwrap();
    assert_eq!(value(&history(&handle).await), value(&records));
    assert_eq!(
        value(
            handle
                .run_record(run_id)
                .await
                .unwrap()
                .unwrap()
                .result()
                .unwrap()
        ),
        value(&result)
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn id2b_supported_malformed_session_closes_before_binding_turn_or_generation_and_persists() {
    for malformed in crate::identifiers::invalid_uuid_spellings() {
        persist(PROVIDER_ID, malformed, vec![terminal(true)], true, true, 0).await;
    }
}

#[tokio::test]
async fn id2b_supported_bad_event_cannot_publish_terminal_identity_or_dispatch_tools_and_persists()
{
    for (bad_id, sequence) in crate::identifiers::invalid_local_events(SESSION) {
        let mut bad = terminal(true);
        bad.event_id = bad_id;
        bad.sequence = sequence;
        persist(
            PROVIDER_ID,
            SESSION.into(),
            vec![bad, terminal(true)],
            false,
            true,
            1,
        )
        .await;
    }
    for field in ["session", "provider"] {
        let mut bad = terminal(true);
        if field == "session" {
            bad.session_id = "fake-session".into();
        } else {
            bad.provider = "generic-label".into();
        }
        persist(
            PROVIDER_ID,
            SESSION.into(),
            vec![bad, terminal(true)],
            false,
            true,
            1,
        )
        .await;
    }
    // A valid start may be recorded, but an invalid terminal must not set last_response.
    let start = event(
        3,
        ProviderEvent::ResponseStarted {
            response_id: "terminal".into(),
        },
    );
    let mut bad = terminal(true);
    bad.event_id = "bad-terminal".into();
    persist(
        PROVIDER_ID,
        SESSION.into(),
        vec![start, bad, terminal(true)],
        false,
        true,
        2,
    )
    .await;
}

#[tokio::test]
async fn id2b_supported_non_v4_session_gaps_max_u64_and_generic_opaque_ids_persist() {
    let start = event(
        3,
        ProviderEvent::ResponseStarted {
            response_id: "terminal".into(),
        },
    );
    persist(
        PROVIDER_ID,
        SESSION.into(),
        vec![start, terminal(false)],
        false,
        false,
        2,
    )
    .await;
    let mut opaque = terminal(false);
    opaque.session_id = "opaque-generic-session".into();
    opaque.event_id = "opaque-generic-event".into();
    opaque.provider = "local-generic".into();
    persist(
        "local-generic",
        "opaque-generic-session".into(),
        vec![opaque],
        false,
        false,
        1,
    )
    .await;
}
