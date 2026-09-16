// This path constructs only storage. It has no gateway, provider, registry or credential reader.
use super::{Fixture, Snapshot};
use crate::storage::{InterruptionReason, RecordedRunState, SessionStore, StoredEventPayload};

pub(super) async fn selected(fixture: &Fixture, prefix: &Snapshot) {
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    // Taking the lease does not select or execute a session.
    assert!(Snapshot::read(&fixture.root, &fixture.session).await == *prefix);
    let session = store.open_session(fixture.session.clone()).await.unwrap();
    let after = Snapshot::read(&fixture.root, &fixture.session).await;
    assert!(after.events[..prefix.events.len()] == prefix.events);
    if prefix.runs[0].2 == "interrupted" {
        assert!(after == *prefix);
    } else {
        assert_eq!(after.events.len(), prefix.events.len() + 1);
    }
    assert!(after.tools == prefix.tools);
    assert!(after.commands == prefix.commands);
    let page = session.history_page(0, None, 100).await.unwrap();
    assert!(!page.has_more());
    assert_eq!(page.records().len(), after.events.len());
    let mut interruptions = 0;
    for record in page.records() {
        assert_eq!(record.application_session_id(), &fixture.session);
        if let StoredEventPayload::RunInterrupted(interrupted) = record.payload() {
            interruptions += 1;
            assert_eq!(interrupted.run_id(), &fixture.run_id);
            assert_eq!(interrupted.reason(), InterruptionReason::ProcessRestart);
        }
    }
    assert_eq!(interruptions, 1);
    let run = session
        .run_record(fixture.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.state(), RecordedRunState::Interrupted);
    assert!(run.result().is_none());
    assert!(run.result_sequence().is_none());
    assert_eq!(run.terminal_sequence(), Some(after.events.len() as u64));
    assert_eq!(run.owner_instance_id().as_str(), prefix.runs[0].4);
    assert_eq!(run.last_runtime_sequence(), prefix.runs[0].3 as u64);
    assert_eq!(run.provider_session_id(), prefix.runs[0].5.as_deref());
    store.open_session(fixture.session.clone()).await.unwrap();
    assert!(Snapshot::read(&fixture.root, &fixture.session).await == after);
    for (id, terminal) in &fixture.terminals {
        assert!(Snapshot::read(&fixture.root, id).await == *terminal);
        store.open_session(id.clone()).await.unwrap();
        assert!(Snapshot::read(&fixture.root, id).await == *terminal);
    }
    store.close().await.unwrap();
    let next = SessionStore::open(fixture.root.clone()).await.unwrap();
    next.open_session(fixture.session.clone()).await.unwrap();
    assert!(Snapshot::read(&fixture.root, &fixture.session).await == after);
    next.close().await.unwrap();
}
