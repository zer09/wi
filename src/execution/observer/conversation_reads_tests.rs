use super::*;
use crate::{
    EventEnvelope, ProviderEvent, SessionOptions,
    conversation::{EntryId, EntryKind, wire::DisplayJson},
    run::{RunEvent, RunRequest},
    storage::{CreateSession, RecordedRunInput, SessionStore, StoredEventId},
    tools::ToolExecutionEvent,
};

#[tokio::test]
async fn a5b1_persistent_observer_produces_exact_entry_pages_without_tool_execution() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("synthetic"))
        .await
        .unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap())
        .await
        .unwrap();
    let handle = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let run = RunId::new();
    let input = RecordedRunInput::new(
        "raw human".into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic"),
            prompt: "private prepared".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    handle
        .accept_run(OperationId::new(), run.clone(), input)
        .await
        .unwrap();
    let mut observer = PersistentObserver::new(&handle, run.clone());
    let turn = StoredEventId::new().as_str().to_owned();
    let request = StoredEventId::new().as_str().to_owned();
    let mut sequence = 0;
    for event in [
        RunEvent::RunStarted,
        RunEvent::TurnStarted { number: 1 },
        RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence: 1,
                event_id: "private native event".into(),
                session_id: "synthetic-provider-session".into(),
                request_id: Some(request.clone()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event: ProviderEvent::ResponseStarted {
                    response_id: "private response".into(),
                },
            }),
        },
        RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence: 2,
                event_id: "private native event 2".into(),
                session_id: "synthetic-provider-session".into(),
                request_id: Some(request.clone()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event: ProviderEvent::OutputItemUpdated {
                    response_id: "private response".into(),
                    item_id: "private item".into(),
                    output_index: 0,
                    content_index: Some(0),
                    summary_index: None,
                    kind: crate::DeltaKind::Text,
                    delta: "assistant\0雪".into(),
                },
            }),
        },
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: "call".into(),
                tool_name: "synthetic tool".into(),
            },
        },
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionFinished {
                call_id: "call".into(),
                tool_name: "synthetic tool".into(),
                is_error: false,
            },
        },
        RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolResultReused {
                call_id: "call".into(),
                tool_name: "synthetic tool".into(),
            },
        },
    ] {
        sequence += 1;
        let started = matches!(event, RunEvent::RunStarted);
        let no_request = started || matches!(event, RunEvent::TurnStarted { .. });
        observer
            .event(&RunEventEnvelope {
                schema_version: 2,
                sequence,
                event_id: StoredEventId::new().as_str().into(),
                run_id: run.as_str().into(),
                session_id: (!started).then(|| "synthetic-provider-session".into()),
                turn_id: (!started).then(|| turn.clone()),
                request_id: (!no_request).then(|| request.clone()),
                event,
            })
            .await
            .unwrap();
        if sequence == 5 {
            observer
                .tool_result(&request, "call", "actual result\0é", false)
                .await
                .unwrap();
        }
    }
    let mut pages = Vec::new();
    for (id, kind) in [
        ("e:2:0", EntryKind::Human),
        ("e:5:0", EntryKind::Assistant),
        ("e:7:0", EntryKind::Tool),
        ("e:10:0", EntryKind::Reuse),
    ] {
        let id: EntryId = id.parse().unwrap();
        let page = handle.conversation_entry(run.clone(), id).await.unwrap();
        assert_eq!(page.entry().kind(), kind);
        DisplayJson::EntryPage(&page).encode().unwrap();
        pages.push(page);
    }
    assert_eq!(pages[0].entry().fields()[0].text(), "raw human");
    assert_eq!(pages[1].entry().fields()[0].text(), "assistant\0雪");
    assert_eq!(
        pages[2].entry().fields().last().unwrap().text(),
        "actual result\0é"
    );
    assert_eq!(pages[2].entry().is_error(), Some(false));
    assert_eq!(pages[2].entry().finish_recorded(), Some(true));
    assert_eq!(
        pages[3].entry().reference().unwrap().entry_id(),
        pages[2].entry().entry_id()
    );
    assert_eq!(pages[3].entry().reference().unwrap().run_id(), &run);
    assert!(observer.failure.is_none());
    store.close().await.unwrap();
}
