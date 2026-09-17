use super::*;
use crate::storage::{CreateSession, OperationId, SessionStore};
use crate::{InputItem, ModelResponse, OutputItem, ProviderEvent};
use serde_json::{Value, json};
mod fixture;
use fixture::history;
use fixture::*;
mod concurrency;
mod fidelity;
mod integrity;
mod interrupted;
mod policy;

#[tokio::test]
async fn p1b2_08_empty_preparation_is_deterministic_and_read_only() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::open(root.path().join("store")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "title".into(), None).unwrap())
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let before = session.manifest().await.unwrap();
    let a = prepare_session_replay(&session, "script", "alias")
        .await
        .unwrap();
    let b = prepare_session_replay(&session, "script", "alias")
        .await
        .unwrap();
    assert_eq!(a.selection(), b.selection());
    assert_eq!(a.included_run_count(), 0);
    assert_eq!(a.included_exchange_count(), 0);
    assert!(a.excluded_runs().is_empty());
    assert!(a.replay().runs().is_empty());
    assert_eq!(format!("{a:?}"), "PreparedSessionReplay([redacted])");
    assert_eq!(
        session.manifest().await.unwrap().head_sequence(),
        before.head_sequence()
    );
    store.close().await.unwrap();
}
