//! One acceptance failure before COMMIT. No provider or HTTP behavior is replaced.
use super::*;
use crate::storage::{CommitCertainty, StorageErrorKind, test_hooks::Hooks};

#[derive(Default)]
pub(super) struct Gate {
    pub(super) armed: bool,
}

impl Gate {
    pub(super) fn arm(
        &mut self,
        hooks: &Arc<Hooks>,
        mutations: bool,
        selected_browser: bool,
        unused: bool,
    ) {
        assert!(
            mutations && selected_browser && unused && !self.armed,
            "acceptance-unknown control rejected"
        );
        hooks.arm_record(
            Record::Acceptance,
            Point::CommitStart,
            Action::Fail(StorageErrorKind::CommitUnknown),
        );
        self.armed = true;
    }
}

#[test]
fn acceptance_unknown_control_is_closed_and_bounded() {
    let raw = r#"{"command":"arm_acceptance_unknown","id":1}"#;
    assert!(matches!(
        serde_json::from_str::<Control>(raw),
        Ok(Control::ArmAcceptanceUnknown { .. })
    ));
    assert!(raw.len() < LIMIT as usize);
    for field in ["command", "id"] {
        let value: Value = serde_json::from_str(raw).unwrap();
        for spelling in [
            field.to_owned(),
            format!("\\u{:04x}{}", field.as_bytes()[0], &field[1..]),
        ] {
            let duplicate = format!(r#"{{"{spelling}":{},{}"#, value[field], &raw[1..]);
            assert!(serde_json::from_str::<Control>(&duplicate).is_err());
        }
        let mut missing = value;
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Control>(missing).is_err());
    }
    for change in [
        json!({"id":0}),
        json!({"id":-1}),
        json!({"id":4294967296_u64}),
        json!({"id":"1"}),
        json!({"id":1.5}),
        json!({"id":null}),
        json!({"text":"private-canary"}),
        json!({"owner":"private-canary"}),
        json!({"session_id":"private-canary"}),
        json!({"point":"CommitStart"}),
        json!({"record":"Acceptance"}),
        json!({"action":"CommitUnknown"}),
        json!({"step":"arm"}),
    ] {
        let mut value: Value = serde_json::from_str(raw).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(serde_json::from_value::<Control>(value).is_err());
    }
}

#[tokio::test]
async fn acceptance_unknown_gate_is_ordered_shared_record_specific_and_one_shot() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("data")).await.unwrap();
    let seed = store
        .create_session(CreateSession::new(OperationId::new(), "seed".into(), None).unwrap())
        .await
        .unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "browser".into(), None).unwrap())
        .await
        .unwrap();
    let seed = store.open_session(seed.session_id().clone()).await.unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let hooks = seed.test_hooks();
    assert!(Arc::ptr_eq(&hooks, &session.test_hooks()));
    let mut gate = Gate::default();
    for (mutations, selected, unused) in [
        (false, true, true),
        (true, false, true),
        (true, true, false),
    ] {
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(
                || gate.arm(&hooks, mutations, selected, unused)
            ))
            .is_err()
        );
        assert!(!gate.armed);
    }
    gate.arm(&hooks, true, true, true);
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(|| gate.arm(&hooks, true, true, true))).is_err()
    );
    // A non-acceptance commit must leave the selected hook armed.
    seed.rename(OperationId::new(), "seed renamed".into())
        .await
        .unwrap();
    let request = crate::run::RunRequest {
        provider_id: PROVIDER_ID.into(),
        options: SessionOptions::new(MODEL),
        prompt: "synthetic task".into(),
    };
    let input = RecordedRunInput::new(
        "synthetic task".into(),
        request,
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    let selection = crate::execution::prepare_session_replay(&session, PROVIDER_ID, MODEL)
        .await
        .unwrap()
        .selection();
    let operation = OperationId::new();
    let run = RunId::new();
    let failure = session
        .accept_history_run(
            operation.clone(),
            run.clone(),
            input.clone(),
            selection.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.kind(), StorageErrorKind::CommitUnknown);
    assert_eq!(failure.certainty(), CommitCertainty::Unknown);
    assert!(
        session
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(session.run_record(run.clone()).await.unwrap().is_none());
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 1);
    // This component-only write proves consumption; the Chromium case never retries.
    assert!(
        session
            .accept_history_run(operation, run, input, selection)
            .await
            .is_ok()
    );
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(|| gate.arm(&hooks, true, true, true))).is_err()
    );
    store.close().await.unwrap();
    temp.close().unwrap();
}
