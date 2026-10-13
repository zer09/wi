//! Real-store display reads with synthetic records, no provider or tool execution.
use std::error::Error;
use wi::{
    DeltaKind, EventEnvelope, ItemKind, ModelResponse, OutputItem, OutputProvenance, ProviderEvent,
    ResponseOutcome, SessionOptions, UpstreamOutcome,
    conversation::{
        BlockView, ConversationPage, ConversationQuery, EntryKind, EntryView, RecordedState,
    },
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunResult, RunSummary, TurnOutcome},
    storage::{
        AppendRunRecord, CreateSession, OperationId, RecordedRunInput, RecordedRunState, RunId,
        SessionHandle, SessionStore,
    },
};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

const TURN: &str = "11111111-1111-4111-8111-000000000001";
const REQUEST: &str = "22222222-2222-4222-8222-000000000001";
const PROVIDER_SESSION: &str = "33333333-3333-4333-8333-000000000001";
const RESPONSE: &str = "synthetic-response";
const PARTIAL: &str = "Partial 雪 café 🦀";

fn input(text: &str) -> Result<RecordedRunInput> {
    Ok(RecordedRunInput::new(
        text.into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic-model"),
            prompt: "Synthetic prepared input, not the human anchor".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )?)
}

fn runtime(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    let started = matches!(event, RunEvent::RunStarted);
    let finished = matches!(event, RunEvent::RunFinished { .. });
    let requested = !started && !matches!(event, RunEvent::TurnStarted { .. });
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: uuid::Uuid::new_v4().to_string(),
        run_id: run.as_str().into(),
        turn_id: if started || finished {
            None
        } else {
            Some(TURN.into())
        },
        session_id: if started {
            None
        } else {
            Some(PROVIDER_SESSION.into())
        },
        request_id: if requested {
            Some(REQUEST.into())
        } else {
            None
        },
        event,
    })
}

fn provider(sequence: u64, event: ProviderEvent) -> RunEvent {
    RunEvent::ProviderEvent {
        event: Box::new(EventEnvelope {
            schema_version: 1,
            sequence,
            event_id: format!("{PROVIDER_SESSION}:{sequence}"),
            session_id: PROVIDER_SESSION.into(),
            request_id: Some(REQUEST.into()),
            provider: "synthetic".into(),
            provider_sequence: Some(sequence + 100),
            event,
        }),
    }
}

fn delta(text: &str) -> ProviderEvent {
    ProviderEvent::OutputItemUpdated {
        response_id: RESPONSE.into(),
        item_id: "synthetic-message".into(),
        output_index: 0,
        summary_index: None,
        content_index: Some(0),
        kind: DeltaKind::Text,
        delta: text.into(),
    }
}

fn assert_entry(left: &EntryView, right: &EntryView) {
    assert_eq!(left.run_id(), right.run_id());
    assert_eq!(left.entry_id(), right.entry_id());
    assert_eq!(left.position(), right.position());
    assert_eq!(left.revision(), right.revision());
    assert_eq!(left.content_epoch(), right.content_epoch());
    assert_eq!(left.kind(), right.kind());
    assert_eq!(left.recorded_state(), right.recorded_state());
    assert_eq!(left.provisional(), right.provisional());
    assert_eq!(left.reference(), right.reference());
    assert_eq!(left.result_recorded(), right.result_recorded());
    assert_eq!(left.finish_recorded(), right.finish_recorded());
    assert_eq!(left.is_error(), right.is_error());
    assert!(left.earlier_content() == right.earlier_content());
    assert_eq!(left.content_complete(), right.content_complete());
    assert_eq!(left.fields().len(), right.fields().len());
    for (left, right) in left.fields().iter().zip(right.fields()) {
        assert_eq!(left.field_id(), right.field_id());
        assert_eq!(left.order_key(), right.order_key());
        assert_eq!(left.kind(), right.kind());
        assert_eq!(left.generation(), right.generation());
        assert_eq!(left.total_bytes(), right.total_bytes());
        assert_eq!(left.from_byte(), right.from_byte());
        assert_eq!(left.to_byte(), right.to_byte());
        assert_eq!(left.text(), right.text());
        assert_eq!(left.has_earlier(), right.has_earlier());
        assert_eq!(left.has_later(), right.has_later());
    }
}

fn assert_block(left: &BlockView, right: &BlockView) {
    assert_eq!(left.run_id(), right.run_id());
    assert_eq!(left.accepted_sequence(), right.accepted_sequence());
    assert_eq!(left.revision(), right.revision());
    assert_eq!(left.state(), right.state());
    assert_eq!(left.result_recorded(), right.result_recorded());
    assert_eq!(left.outcome(), right.outcome());
    assert_eq!(left.events_complete(), right.events_complete());
    assert_eq!(left.sink_error(), right.sink_error());
    assert_eq!(left.summary().is_some(), right.summary().is_some());
    if let (Some(left), Some(right)) = (left.summary(), right.summary()) {
        assert_eq!(left.turns_started(), right.turns_started());
        assert_eq!(left.turns_finished(), right.turns_finished());
        assert_eq!(
            left.model_requests_attempted(),
            right.model_requests_attempted()
        );
        assert_eq!(
            left.model_requests_admitted(),
            right.model_requests_admitted()
        );
        assert_eq!(left.new_tool_dispatches(), right.new_tool_dispatches());
        assert_eq!(left.tool_results_prepared(), right.tool_results_prepared());
        assert_eq!(left.reused_results(), right.reused_results());
        assert_eq!(left.last_request_id(), right.last_request_id());
        assert_eq!(left.last_upstream_outcome(), right.last_upstream_outcome());
    }
    assert_entry(left.human(), right.human());
}

fn assert_page(left: &ConversationPage, right: &ConversationPage) {
    assert_eq!(left.session_id(), right.session_id());
    assert_eq!(left.snapshot_head(), right.snapshot_head());
    assert!(left.session() == right.session());
    assert_eq!(left.block().is_some(), right.block().is_some());
    if let (Some(left), Some(right)) = (left.block(), right.block()) {
        assert_block(left, right);
    }
    assert_eq!(left.entries().len(), right.entries().len());
    for (left, right) in left.entries().iter().zip(right.entries()) {
        assert_entry(left, right);
    }
    assert!(left.earlier_activity() == right.earlier_activity());
    assert!(left.previous_block() == right.previous_block());
    assert!(left.live_after() == right.live_after());
}

fn assert_chronological(page: &ConversationPage) {
    let block = page.block().unwrap();
    assert_eq!(block.human().kind(), EntryKind::Human);
    assert_eq!(block.human().run_id(), block.run_id());
    assert_eq!(
        block.human().entry_id().first_sequence(),
        block.accepted_sequence()
    );
    for entry in page.entries() {
        assert_eq!(entry.run_id(), block.run_id());
        assert_ne!(entry.kind(), EntryKind::Human);
        assert!(entry.position() > block.human().position());
    }
    assert!(
        page.entries()
            .windows(2)
            .all(|pair| pair[0].position() < pair[1].position())
    );
    assert!(page.earlier_activity().is_none());
}

async fn warm_reads(
    handle: &SessionHandle,
    latest: &ConversationPage,
    older: &ConversationPage,
) -> Result<()> {
    for _ in 0..3 {
        let current = handle.conversation_page(ConversationQuery::Latest).await?;
        assert_page(latest, &current);
        let before = handle
            .conversation_page(ConversationQuery::Before(
                latest.previous_block().unwrap().clone(),
            ))
            .await?;
        assert_page(older, &before);
        let entry = &latest.entries()[0];
        let addressed = handle
            .conversation_entry(entry.run_id().clone(), *entry.entry_id())
            .await?;
        assert_eq!(addressed.session_id(), latest.session_id());
        assert_eq!(addressed.snapshot_head(), latest.snapshot_head());
        assert_block(latest.block().unwrap(), addressed.block());
        assert_entry(entry, addressed.entry());
    }
    // Stable warm values are not a trace proof. The native storage regression measures replay.
    Ok(())
}

async fn seed_and_read(handle: SessionHandle) -> Result<(ConversationPage, ConversationPage)> {
    let a = RunId::new();
    handle
        .accept_run(OperationId::new(), a.clone(), input("Older A")?)
        .await?;
    let item = serde_json::json!({"type":"message","id":"synthetic-message","role":"assistant","content":[{"type":"output_text","text":"Answer A"}]});
    let response = ModelResponse {
        output_provenance: OutputProvenance::NativeTerminal,
        id: RESPONSE.into(),
        model: Some("synthetic-model".into()),
        outcome: ResponseOutcome::Completed,
        output: vec![OutputItem {
            id: Some("synthetic-message".into()),
            kind: ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: item.clone(),
        }],
        text: "Answer A".into(),
        usage: None,
        native: serde_json::json!({"id":RESPONSE,"status":"completed","output":[item]}),
    };
    let summary = RunSummary {
        turns_started: 1,
        turns_finished: 1,
        model_requests_attempted: 1,
        model_requests_admitted: 1,
        last_request_id: Some(REQUEST.into()),
        last_upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
        ..RunSummary::default()
    };
    handle
        .append_run_records(
            OperationId::new(),
            a.clone(),
            vec![
                runtime(&a, 1, RunEvent::RunStarted),
                runtime(&a, 2, RunEvent::TurnStarted { number: 1 }),
                runtime(
                    &a,
                    3,
                    provider(
                        1,
                        ProviderEvent::ResponseStarted {
                            response_id: RESPONSE.into(),
                        },
                    ),
                ),
                runtime(&a, 4, provider(2, delta("Answer A"))),
                runtime(
                    &a,
                    5,
                    provider(
                        3,
                        ProviderEvent::ResponseFinished {
                            response: response.clone(),
                        },
                    ),
                ),
                runtime(
                    &a,
                    6,
                    RunEvent::TurnFinished {
                        number: 1,
                        response_id: Some(RESPONSE.into()),
                        outcome: TurnOutcome::ModelCompleted,
                        upstream_outcome: Some(UpstreamOutcome::TerminalReceived),
                    },
                ),
                runtime(
                    &a,
                    7,
                    RunEvent::RunFinished {
                        outcome: RunOutcome::Completed,
                        summary: summary.clone(),
                    },
                ),
                AppendRunRecord::Result(RunResult {
                    run_id: a.as_str().into(),
                    session_id: Some(PROVIDER_SESSION.into()),
                    outcome: RunOutcome::Completed,
                    summary,
                    last_response: Some(response),
                    events_complete: true,
                    sink_error: None,
                }),
            ],
        )
        .await?;

    let b = RunId::new();
    let accepted = handle
        .accept_run(OperationId::new(), b.clone(), input("Newest B")?)
        .await?;
    let committed = handle
        .append_run_records(
            OperationId::new(),
            b.clone(),
            vec![
                runtime(&b, 1, RunEvent::RunStarted),
                runtime(&b, 2, RunEvent::TurnStarted { number: 1 }),
                runtime(
                    &b,
                    3,
                    provider(
                        1,
                        ProviderEvent::ResponseStarted {
                            response_id: RESPONSE.into(),
                        },
                    ),
                ),
                runtime(&b, 4, provider(2, delta("Partial 雪"))),
                runtime(&b, 5, provider(3, delta(" café 🦀"))),
            ],
        )
        .await?;
    // Canonical positions come from receipts, not run-local or provider counters.
    let latest = handle.conversation_page(ConversationQuery::Latest).await?;
    let block = latest.block().unwrap();
    assert_eq!(block.run_id(), &b);
    assert_eq!(
        block.accepted_sequence(),
        accepted.receipt().first_sequence()
    );
    assert_eq!(block.state(), RecordedRunState::Running);
    assert!(!block.result_recorded());
    assert!(block.outcome().is_none() && block.summary().is_none());
    assert!(block.events_complete().is_none() && block.sink_error().is_none());
    assert_eq!(block.human().fields()[0].text(), "Newest B");
    assert_eq!(latest.entries().len(), 1);
    let assistant = &latest.entries()[0];
    assert_eq!(assistant.kind(), EntryKind::Assistant);
    assert_eq!(assistant.recorded_state(), RecordedState::InProgress);
    assert!(assistant.provisional());
    assert_eq!(
        assistant.entry_id().first_sequence(),
        committed.receipt().first_sequence() + 2
    );
    assert_eq!(assistant.fields().len(), 1);
    assert_eq!(assistant.fields()[0].text(), PARTIAL);
    assert!(assistant.content_complete());
    assert_eq!(latest.snapshot_head(), committed.receipt().last_sequence());
    let live = latest.live_after().unwrap();
    assert_eq!(live.session_id(), latest.session_id());
    assert_eq!(live.sequence(), latest.snapshot_head());
    assert_eq!(live.rank(), 3);
    assert_chronological(&latest);
    println!(
        "Latest B: Newest B | {PARTIAL} | running H={}",
        latest.snapshot_head()
    );

    // Only after B is asserted and printed does this example explicitly request A.
    let older = handle
        .conversation_page(ConversationQuery::Before(
            latest.previous_block().unwrap().clone(),
        ))
        .await?;
    assert_eq!(older.snapshot_head(), latest.snapshot_head());
    assert_eq!(older.block().unwrap().run_id(), &a);
    assert_eq!(older.block().unwrap().state(), RecordedRunState::Completed);
    assert!(older.block().unwrap().result_recorded());
    assert_eq!(older.block().unwrap().human().fields()[0].text(), "Older A");
    assert_eq!(older.entries().len(), 1);
    assert_eq!(older.entries()[0].fields()[0].text(), "Answer A");
    assert_eq!(
        older.entries()[0].recorded_state(),
        RecordedState::Completed
    );
    assert!(!older.entries()[0].provisional());
    assert!(older.live_after().is_none() && older.previous_block().is_none());
    assert_chronological(&older);
    println!("Before: Older A | Answer A | completed, no live cursor");
    warm_reads(&handle, &latest, &older).await?;
    Ok((latest, older))
}

async fn scenario() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("synthetic-conversation");
    let store = SessionStore::open(root.clone()).await?;
    let seeded = async {
        let created = store
            .create_session(CreateSession::new(
                OperationId::new(),
                "Synthetic conversation".into(),
                None,
            )?)
            .await?;
        let handle = store.open_session(created.session_id().clone()).await?;
        // A joined assertion task lets storage drain even if an assertion panics.
        tokio::spawn(seed_and_read(handle)).await?
    }
    .await;
    store.close().await?;
    let (before, older_before) = seeded?;
    drop(store);

    let store = SessionStore::open(root.clone()).await?;
    let reopened = async {
        let handle = store.open_session(before.session_id().clone()).await?;
        let latest = handle.conversation_page(ConversationQuery::Latest).await?;
        let older = handle
            .conversation_page(ConversationQuery::Before(
                latest.previous_block().unwrap().clone(),
            ))
            .await?;
        let check_latest = latest.clone();
        let check_older = older.clone();
        tokio::spawn(async move { warm_reads(&handle, &check_latest, &check_older).await })
            .await??;
        Ok::<_, Box<dyn Error + Send + Sync>>((latest, older))
    }
    .await;
    store.close().await?;
    let (interrupted, older_interrupted) = reopened?;
    drop(store);

    assert_eq!(interrupted.snapshot_head(), before.snapshot_head() + 1);
    let block = interrupted.block().unwrap();
    assert_eq!(block.state(), RecordedRunState::Interrupted);
    assert_eq!(block.revision(), interrupted.snapshot_head());
    assert!(!block.result_recorded());
    assert!(block.outcome().is_none() && block.summary().is_none());
    assert!(block.events_complete().is_none() && block.sink_error().is_none());
    assert_entry(before.block().unwrap().human(), block.human());
    let partial = &interrupted.entries()[0];
    assert_eq!(partial.recorded_state(), RecordedState::Interrupted);
    assert!(partial.provisional());
    assert_eq!(partial.revision(), interrupted.snapshot_head());
    // Interruption changes recorded state, not identity, order or committed text.
    let previous = &before.entries()[0];
    assert_eq!(partial.entry_id(), previous.entry_id());
    assert_eq!(partial.position(), previous.position());
    assert_eq!(partial.content_epoch(), previous.content_epoch());
    assert_eq!(
        partial.fields()[0].generation(),
        previous.fields()[0].generation()
    );
    assert_eq!(partial.fields()[0].text(), PARTIAL);
    assert_eq!(partial.fields()[0].total_bytes(), PARTIAL.len() as u64);
    assert_eq!(partial.fields()[0].from_byte(), 0);
    assert_eq!(partial.fields()[0].to_byte(), PARTIAL.len() as u64);
    assert!(partial.content_complete());
    assert_block(
        older_before.block().unwrap(),
        older_interrupted.block().unwrap(),
    );
    assert_entry(&older_before.entries()[0], &older_interrupted.entries()[0]);
    assert_chronological(&interrupted);
    println!(
        "Reopened B: {PARTIAL} | interrupted H={}, no result",
        interrupted.snapshot_head()
    );

    let store = SessionStore::open(root).await?;
    let reopened_again = async {
        let handle = store.open_session(interrupted.session_id().clone()).await?;
        let latest = handle.conversation_page(ConversationQuery::Latest).await?;
        let older = handle
            .conversation_page(ConversationQuery::Before(
                latest.previous_block().unwrap().clone(),
            ))
            .await?;
        Ok::<_, Box<dyn Error + Send + Sync>>((latest, older))
    }
    .await;
    store.close().await?;
    let (latest_again, older_again) = reopened_again?;
    drop(store);
    assert_page(&interrupted, &latest_again);
    assert_page(&older_interrupted, &older_again);
    temp.close()?;
    println!(
        "Same-H reopened parity and repeated warm display reads passed; synthetic root retired"
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    scenario().await
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn latest_before_restart_and_warm_display_parity() {
        super::scenario().await.unwrap();
    }
}
