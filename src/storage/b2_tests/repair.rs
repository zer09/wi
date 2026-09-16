use super::*;

#[tokio::test]
async fn p1b2_30_repair_metadata_corruption_isolated_from_ready_legacy_sessions() {
    for mutation in [
        "UPDATE events SET payload_json=json_set(payload_json,'$.selection.history_digest',printf('%064d',0)) WHERE event_type='run.history.selected'",
        "UPDATE events SET payload_json=json_set(payload_json,'$.selection.through_sequence',2) WHERE event_type='run.history.selected'",
        "UPDATE events SET payload_json=json_set(payload_json,'$.selection.provider_id','other') WHERE event_type='run.history.selected'",
        "UPDATE events SET payload_json=json_set(payload_json,'$.selection.policy','other') WHERE event_type='run.history.selected'",
        "UPDATE events SET payload_json=json_set(payload_json,'$.identity.principal_digest','bad') WHERE event_type='run.provider.bound'",
        "UPDATE events SET payload_json=json_set(payload_json,'$.identity.provider_id','other') WHERE event_type='run.provider.bound'",
        "UPDATE runs SET provider_session_id='other'",
        "UPDATE commands SET last_sequence=first_sequence,receipt_json=json_set(receipt_json,'$.last_sequence',first_sequence) WHERE method='accept_history_run'",
        "UPDATE commands SET method='accept_run' WHERE method='accept_history_run'",
        "UPDATE commands SET payload_hash=zeroblob(32) WHERE method='accept_history_run'",
        "UPDATE events SET source_event_id='invented',source_sequence=99 WHERE event_type='run.provider.bound'",
        "INSERT INTO events SELECT (SELECT max(sequence)+1 FROM events),'ab123456-789a-4bcd-8abc-0123456789ab',event_type,event_version,created_at_ms,run_id,NULL,NULL,payload_json FROM events WHERE event_type='run.provider.bound'; UPDATE manifest SET head_sequence=head_sequence+1",
        "INSERT INTO events SELECT (SELECT max(sequence)+1 FROM events),'ab123456-789a-4bcd-8abc-0123456789ab',event_type,event_version,created_at_ms,run_id,NULL,NULL,payload_json FROM events WHERE event_type='run.history.selected'; UPDATE manifest SET head_sequence=head_sequence+1",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let store = SessionStore::open(root).await.unwrap();
        let handle = create(&store).await;
        let legacy = create(&store).await;
        let run = RunId::new();
        let selected = selection(&store, &handle).await;
        handle
            .accept_history_run(OperationId::new(), run.clone(), input(), selected)
            .await
            .unwrap();
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![
                    runtime(&run, 1, RunEvent::RunStarted),
                    AppendRunRecord::ProviderBinding(binding(&run)),
                ],
            )
            .await
            .unwrap();
        legacy
            .accept_run(OperationId::new(), RunId::new(), input())
            .await
            .unwrap();
        let path = filesystem::session_path(&store.inner.root, handle.session_id(), false).unwrap();
        let mut sql = migration::connect(&path).await;
        sqlx::raw_sql("DROP TRIGGER events_no_update; DROP TRIGGER commands_no_update; PRAGMA ignore_check_constraints=ON;").execute(&mut sql).await.unwrap();
        sqlx::raw_sql(mutation).execute(&mut sql).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END; CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'immutable receipt'); END; PRAGMA ignore_check_constraints=OFF;").execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let report = store.repair_catalog().await.unwrap();
        assert_eq!(report.ready_sessions(), 1, "{mutation}");
        assert_eq!(report.unavailable_sessions(), 1, "{mutation}");
        assert_eq!(legacy.manifest().await.unwrap().head_sequence(), 2);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_30_same_head_schema_upgrade_requires_identical_summary_and_good_availability() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let id = handle.session_id();
    let guard = store.inner.lifecycle.admit().unwrap();
    let (mut sql, _) = session::connection(&store.inner, id, false).await.unwrap();
    let canonical = catalog_sync::observe(&mut sql, id).await.unwrap();
    database::close(sql, &store.inner.lifecycle).await.unwrap();
    assert_eq!(canonical.schema_version(), 2);
    let mut catalog = catalog_ops::connect(&store.inner, true).await.unwrap();
    sqlx::query("UPDATE sessions SET schema_version=1 WHERE session_id=?")
        .bind(id.as_str())
        .execute(&mut catalog)
        .await
        .unwrap();
    database::close(catalog, &store.inner.lifecycle)
        .await
        .unwrap();
    let mut bad = canonical.clone();
    bad.manifest.title = "not canonical".into();
    assert_eq!(
        catalog_sync::publish(&store.inner, &bad)
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    assert_eq!(
        catalog_sync::publish(&store.inner, &canonical)
            .await
            .unwrap(),
        RefreshResult::Updated
    );
    assert_eq!(
        catalog_sync::publish(&store.inner, &canonical)
            .await
            .unwrap(),
        RefreshResult::Unchanged
    );
    bad = canonical.clone();
    bad.schema_version = 1;
    assert_eq!(
        catalog_sync::publish(&store.inner, &bad)
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    bad.manifest.head_sequence += 1;
    assert_eq!(
        catalog_sync::publish(&store.inner, &bad)
            .await
            .unwrap_err()
            .code(),
        "storage.integrity"
    );
    for availability in [
        SessionAvailability::Creating,
        SessionAvailability::Missing,
        SessionAvailability::Unavailable,
    ] {
        bad = canonical.clone();
        bad.availability = availability;
        assert!(catalog_sync::publish(&store.inner, &bad).await.is_err());
    }
    guard.finish();
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_04_binding_rejects_legacy_late_and_wrong_links_but_records_actual_identity() {
    for legacy in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("root")).await.unwrap();
        let handle = create(&store).await;
        let run = RunId::new();
        if legacy {
            handle
                .accept_run(OperationId::new(), run.clone(), input())
                .await
                .unwrap();
        } else {
            let selected = selection(&store, &handle).await;
            let expected =
                ReplayIdentity::new("synthetic".into(), "native-v1".into(), "b".repeat(64))
                    .unwrap();
            let selected = StoredHistorySelection::new(
                selected.through_sequence(),
                selected.history_digest().into(),
                "synthetic".into(),
                "model".into(),
                Some(expected),
            )
            .unwrap();
            handle
                .accept_history_run(OperationId::new(), run.clone(), input(), selected)
                .await
                .unwrap();
        }
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![runtime(&run, 1, RunEvent::RunStarted)],
            )
            .await
            .unwrap();
        for binding in [
            binding(&RunId::new()),
            RecordedProviderBinding::new(
                run.clone(),
                "session".into(),
                "other".into(),
                binding(&run).identity().clone(),
            )
            .unwrap(),
            RecordedProviderBinding::new(
                run.clone(),
                "session".into(),
                "model".into(),
                ReplayIdentity::new("other".into(), "native-v1".into(), "a".repeat(64)).unwrap(),
            )
            .unwrap(),
        ] {
            assert_eq!(
                handle
                    .append_run_records(
                        OperationId::new(),
                        run.clone(),
                        vec![AppendRunRecord::ProviderBinding(binding)]
                    )
                    .await
                    .unwrap_err()
                    .code(),
                "storage.invalid_transition"
            );
        }
        if legacy {
            assert_eq!(
                handle
                    .append_run_records(
                        OperationId::new(),
                        run.clone(),
                        vec![AppendRunRecord::ProviderBinding(binding(&run))]
                    )
                    .await
                    .unwrap_err()
                    .code(),
                "storage.invalid_transition"
            );
        } else {
            // Expected-vs-actual principal equality is the execution gate, not storage policy.
            handle
                .append_run_records(
                    OperationId::new(),
                    run.clone(),
                    vec![
                        AppendRunRecord::ProviderBinding(binding(&run)),
                        runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
                    ],
                )
                .await
                .unwrap();
            assert_eq!(
                handle.provider_binding(run.clone()).await.unwrap(),
                Some(binding(&run))
            );
        }
        store.close().await.unwrap();
    }
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let run = RunId::new();
    handle
        .accept_history_run(
            OperationId::new(),
            run.clone(),
            input(),
            selection(&store, &handle).await,
        )
        .await
        .unwrap();
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![
                runtime(&run, 1, RunEvent::RunStarted),
                AppendRunRecord::ProviderBinding(binding(&run)),
                runtime(&run, 2, RunEvent::TurnStarted { number: 1 }),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![AppendRunRecord::ProviderBinding(binding(&run))]
            )
            .await
            .unwrap_err()
            .code(),
        "storage.invalid_transition"
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_25_second_row_sql_failure_and_binding_commit_certainty() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("root")).await.unwrap();
    let handle = create(&store).await;
    let run = RunId::new();
    let operation = OperationId::new();
    let selected = selection(&store, &handle).await;
    let path = filesystem::session_path(&store.inner.root, handle.session_id(), false).unwrap();
    let mut sql = migration::connect(&path).await;
    sqlx::raw_sql("CREATE TRIGGER reject_selection BEFORE INSERT ON events WHEN NEW.event_type='run.history.selected' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;")
        .execute(&mut sql).await.unwrap();
    sql.close().await.unwrap();
    let error = handle
        .accept_history_run(operation.clone(), run.clone(), input(), selected.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "storage.integrity");
    assert_eq!(error.certainty(), CommitCertainty::NotCommitted);
    assert_eq!(handle.manifest().await.unwrap().head_sequence(), 1);
    assert!(handle.run_record(run.clone()).await.unwrap().is_none());
    assert!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .is_none()
    );
    let mut sql = migration::connect(&path).await;
    sqlx::query("DROP TRIGGER reject_selection")
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    handle
        .accept_history_run(operation, run.clone(), input(), selected)
        .await
        .unwrap();
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![runtime(&run, 1, RunEvent::RunStarted)],
        )
        .await
        .unwrap();
    let operation = OperationId::new();
    let records = vec![AppendRunRecord::ProviderBinding(binding(&run))];
    // The fixture reports an uncertain commit after a real rollback. Receipt lookup,
    // not a retry assumption, distinguishes this case from committed cleanup failure.
    store.inner.hooks.arm_record(
        Record::ProviderBinding,
        Point::CommitStart,
        Action::Fail(StorageErrorKind::CommitUnknown),
    );
    let error = handle
        .append_run_records(operation.clone(), run.clone(), records.clone())
        .await
        .unwrap_err();
    assert_eq!(error.certainty(), CommitCertainty::Unknown);
    assert!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        handle
            .provider_binding(run.clone())
            .await
            .unwrap()
            .is_none()
    );
    let pause = Arc::new(Pause::default());
    store.inner.hooks.arm_record(
        Record::ProviderBinding,
        Point::BeforeCommit,
        Action::Pause(pause.clone()),
    );
    let writer = tokio::spawn({
        let h = handle.clone();
        let op = operation.clone();
        let run = run.clone();
        let records = records.clone();
        async move { h.append_run_records(op, run, records).await.unwrap() }
    });
    pause.reached.notified().await;
    // An independent SQLite reader sees no intermediate binding before COMMIT.
    let mut sql = migration::connect(&path).await;
    assert_eq!(
        sqlx::query("SELECT count(*) FROM events WHERE event_type='run.provider.bound'")
            .fetch_one(&mut sql)
            .await
            .unwrap()
            .get::<i64, _>(0),
        0
    );
    sql.close().await.unwrap();
    store.inner.hooks.arm_record(
        Record::ProviderBinding,
        Point::WriteClosed,
        Action::Fail(StorageErrorKind::Io),
    );
    pause.release.notify_one();
    let committed = writer.await.unwrap();
    assert_eq!(
        committed.cleanup_warning(),
        Some(CleanupWarning::ConnectionCloseFailed)
    );
    assert_eq!(
        handle
            .lookup_receipt(operation.clone())
            .await
            .unwrap()
            .as_ref(),
        Some(committed.receipt())
    );
    assert!(
        handle
            .append_run_records(operation, run.clone(), records)
            .await
            .unwrap()
            .duplicate()
    );
    assert_eq!(
        handle
            .provider_binding(run)
            .await
            .unwrap()
            .unwrap()
            .provider_session_id(),
        "session"
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_25_selected_acceptance_owned_sql_drains_after_waiter_drop() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let handle = create(&store).await;
    let run = RunId::new();
    let op = OperationId::new();
    let id = handle.session_id().clone();
    let selected = selection(&store, &handle).await;
    let pause = Arc::new(Pause::default());
    store.inner.hooks.arm_record(
        Record::Acceptance,
        Point::HistorySelection,
        Action::Pause(pause.clone()),
    );
    let waiter = tokio::spawn({
        let handle = handle.clone();
        let run = run.clone();
        let op = op.clone();
        async move { handle.accept_history_run(op, run, input(), selected).await }
    });
    pause.reached.notified().await;
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    // Close must retain the admitted SQL owner through both rows and the receipt.
    let close = tokio::spawn(async move { store.close().await });
    pause.release.notify_one();
    close.await.unwrap().unwrap();
    let store = SessionStore::open(root).await.unwrap();
    let handle = store.open_session(id).await.unwrap();
    let receipt = handle.lookup_receipt(op).await.unwrap().unwrap();
    assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (2, 3));
    assert!(handle.history_selection(run).await.unwrap().is_some());
    store.close().await.unwrap();
}
