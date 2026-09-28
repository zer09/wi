//! One committed acceptance with a reported connection-close failure, before run admission.
use super::*;
use crate::storage::{CleanupWarning, StorageErrorKind, test_hooks::Hooks};

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
            "acceptance-warning control rejected"
        );
        hooks.arm_record(
            Record::Acceptance,
            Point::WriteClosed,
            Action::Fail(StorageErrorKind::Io),
        );
        self.armed = true;
    }
}

pub(super) async fn inspect_seed(root: &std::path::Path, sid: &ApplicationSessionId) {
    let mut reader = SqliteConnectOptions::new()
        .filename(
            root.join("sessions")
                .join(&sid.as_str()[..2])
                .join(sid.as_str())
                .join("session.sqlite3"),
        )
        .read_only(true)
        .busy_timeout(Duration::ZERO)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    // The seed only supplies shared hooks. It must not receive the browser's acceptance.
    let counts: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT head_sequence,(SELECT count(*) FROM events),(SELECT count(*) FROM events WHERE sequence=1 AND event_type='session.created'),(SELECT count(*) FROM commands),(SELECT count(*) FROM runs),(SELECT count(*) FROM tool_results) FROM manifest WHERE singleton=1")
        .fetch_one(&mut reader).await.unwrap();
    reader.close().await.unwrap();
    assert!(
        counts == (1, 1, 1, 0, 0, 0),
        "acceptance-warning seed evidence mismatch"
    );
}

#[test]
fn acceptance_warning_control_is_closed_and_bounded() {
    let raw = r#"{"command":"arm_acceptance_warning","id":1}"#;
    let control = serde_json::from_str::<Control>(raw).unwrap();
    assert!(matches!(control, Control::ArmAcceptanceWarning { .. }) && control.id() == 1);
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
        json!({"point":"WriteClosed"}),
        json!({"record":"Acceptance"}),
        json!({"action":"Io"}),
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
async fn acceptance_warning_gate_is_ordered_shared_record_specific_and_one_shot() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let store = SessionStore::open(root.clone()).await.unwrap();
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
    // A different write closes a connection without consuming the acceptance-specific hook.
    store
        .create_session(CreateSession::new(OperationId::new(), "unrelated".into(), None).unwrap())
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
    let commit = session
        .accept_history_run(
            operation.clone(),
            run.clone(),
            input.clone(),
            selection.clone(),
        )
        .await
        .unwrap();
    assert!(!commit.duplicate());
    assert_eq!(
        commit.cleanup_warning(),
        Some(CleanupWarning::ConnectionCloseFailed)
    );
    assert_eq!(
        (
            commit.receipt().first_sequence(),
            commit.receipt().last_sequence()
        ),
        (2, 3)
    );
    assert!(
        session
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .as_ref()
            == Some(commit.receipt())
    );
    assert!(session.run_record(run.clone()).await.unwrap().is_some());
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 3);
    inspect_seed(&root, seed.session_id()).await;
    // Component-only replay proves hook consumption. The browser never resubmits.
    let duplicate = session
        .accept_history_run(operation, run, input, selection)
        .await
        .unwrap();
    assert!(duplicate.duplicate() && duplicate.cleanup_warning().is_none());
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(|| gate.arm(&hooks, true, true, true))).is_err()
    );
    seed.rename(OperationId::new(), "changed seed".into())
        .await
        .unwrap();
    assert!(
        AssertUnwindSafe(inspect_seed(&root, seed.session_id()))
            .catch_unwind()
            .await
            .is_err()
    );
    store.close().await.unwrap();
    temp.close().unwrap();
}
