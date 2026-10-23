use super::*;

#[tokio::test]
async fn audit_rejects_corrupted_rename_and_catalog_evidence_without_private_diagnostics() {
    let mut missed = vec![];
    for (table, cases) in [
        (
            "events",
            &[
                (
                    "event_sequence",
                    "UPDATE events SET sequence=4 WHERE sequence=2",
                ),
                (
                    "event_id",
                    "UPDATE events SET event_id='private-event-canary' WHERE sequence=2",
                ),
                (
                    "event_type",
                    "UPDATE events SET event_type='run.accepted' WHERE sequence=2",
                ),
                (
                    "event_version",
                    "UPDATE events SET event_version=2 WHERE sequence=2",
                ),
                (
                    "event_timestamp",
                    "UPDATE events SET created_at_ms=created_at_ms+1 WHERE sequence=3",
                ),
                (
                    "negative_timestamp",
                    "UPDATE events SET created_at_ms=-1 WHERE sequence=2",
                ),
                (
                    "event_run",
                    "UPDATE events SET run_id='private-run-canary' WHERE sequence=2",
                ),
                (
                    "source_event",
                    "UPDATE events SET source_event_id='private-source-canary' WHERE sequence=2",
                ),
                (
                    "source_sequence",
                    "UPDATE events SET source_sequence=1 WHERE sequence=2",
                ),
                (
                    "event_title",
                    "UPDATE events SET payload_json=json_set(payload_json,'$.title','private-title-canary') WHERE sequence=2",
                ),
                (
                    "extra_payload",
                    "UPDATE events SET payload_json=json_set(payload_json,'$.private','private-payload-canary') WHERE sequence=2",
                ),
                ("missing_event", "DELETE FROM events WHERE sequence=2"),
            ][..],
        ),
        (
            "commands",
            &[
                (
                    "method",
                    "UPDATE commands SET method='private-method-canary' WHERE first_sequence=2",
                ),
                (
                    "hash",
                    "UPDATE commands SET payload_hash=zeroblob(32) WHERE first_sequence=2",
                ),
                (
                    "operation",
                    "UPDATE commands SET operation_id='ab123456-789a-4bcd-8abc-0123456789b1' WHERE first_sequence=2",
                ),
                (
                    "first_sequence",
                    "UPDATE commands SET first_sequence=1 WHERE first_sequence=2",
                ),
                (
                    "last_sequence",
                    "UPDATE commands SET last_sequence=3 WHERE first_sequence=2",
                ),
                (
                    "receipt_operation",
                    "UPDATE commands SET receipt_json=json_set(receipt_json,'$.operation_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE first_sequence=2",
                ),
                (
                    "receipt_session",
                    "UPDATE commands SET receipt_json=json_set(receipt_json,'$.session_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE first_sequence=2",
                ),
                (
                    "receipt_run",
                    "UPDATE commands SET receipt_json=json_set(receipt_json,'$.run_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE first_sequence=2",
                ),
                (
                    "receipt_sequence",
                    "UPDATE commands SET receipt_json=json_set(receipt_json,'$.first_sequence',3,'$.last_sequence',3) WHERE first_sequence=2",
                ),
                (
                    "missing_command",
                    "DELETE FROM commands WHERE first_sequence=2",
                ),
                (
                    "extra_command",
                    "INSERT INTO commands SELECT 'ab123456-789a-4bcd-8abc-0123456789b1',method,payload_hash,first_sequence,last_sequence,receipt_json FROM commands WHERE first_sequence=2",
                ),
            ][..],
        ),
        (
            "manifest",
            &[
                (
                    "manifest_title",
                    "UPDATE manifest SET title='private-title-canary'",
                ),
                (
                    "manifest_timestamp",
                    "UPDATE manifest SET updated_at_ms=updated_at_ms+1",
                ),
                ("manifest_head", "UPDATE manifest SET head_sequence=4"),
            ][..],
        ),
        (
            "sessions",
            &[
                (
                    "catalog_title",
                    "UPDATE sessions SET title='private-title-canary' WHERE workspace_json IS NOT NULL",
                ),
                (
                    "catalog_timestamp",
                    "UPDATE sessions SET updated_at_ms=updated_at_ms+1 WHERE workspace_json IS NOT NULL",
                ),
                (
                    "catalog_head",
                    "UPDATE sessions SET head_sequence=2 WHERE workspace_json IS NOT NULL",
                ),
                (
                    "catalog_workspace",
                    "UPDATE sessions SET workspace_json='\"/private-workspace-canary\"' WHERE workspace_json IS NOT NULL",
                ),
                (
                    "catalog_availability",
                    "UPDATE sessions SET availability='unavailable' WHERE workspace_json IS NOT NULL",
                ),
                (
                    "catalog_fault",
                    "UPDATE sessions SET fault_code='private-fault-canary' WHERE workspace_json IS NOT NULL",
                ),
                (
                    "catalog_run",
                    "UPDATE sessions SET last_run_id='private-run-canary' WHERE workspace_json IS NOT NULL",
                ),
                (
                    "catalog_state",
                    "UPDATE sessions SET last_run_state='accepted' WHERE workspace_json IS NOT NULL",
                ),
            ][..],
        ),
        (
            "runs",
            &[(
                "hidden_run",
                "INSERT INTO runs VALUES ('private-run-canary',2,'accepted',0,'private-owner-canary',NULL,NULL,NULL,NULL)",
            )][..],
        ),
    ] {
        for &(case, change) in cases {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("private-data-canary");
            let workspace = temp.path().join("workspace").to_str().unwrap().to_owned();
            let store = SessionStore::open(root.clone()).await.unwrap();
            store
                .create_session(
                    CreateSession::new(OperationId::new(), "Fixture barrier seed".into(), None)
                        .unwrap(),
                )
                .await
                .unwrap();
            let created = store
                .create_session(
                    CreateSession::new(
                        OperationId::new(),
                        INPUTS.titles[0].clone(),
                        Some(workspace.clone()),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
            let session = store
                .open_session(created.session_id().clone())
                .await
                .unwrap();
            for title in &INPUTS.renames {
                session
                    .rename(OperationId::new(), title.clone())
                    .await
                    .unwrap();
            }
            session.refresh_catalog().await.unwrap();
            store.close().await.unwrap();
            let mut audit = Audit::open(root.clone(), vec![workspace.clone()]).await;
            let before = audit.inspect(1).await;
            assert!(before["seed_sessions"] == 1 && before["session_count"] == 2);
            assert!(before["creations"][0]["sequence_count"] == "3");
            assert!(before["creations"][0]["catalog_current"] == true);
            assert!(before.to_string().len() < LIMIT as usize);
            let path = if table == "sessions" {
                root.join("catalog.sqlite3")
            } else {
                root.join("sessions")
                    .join(&created.session_id().as_str()[..2])
                    .join(created.session_id().as_str())
                    .join("session.sqlite3")
            };
            let mut writer = SqliteConnectOptions::new()
                .filename(path)
                .foreign_keys(false)
                .disable_statement_logging()
                .connect()
                .await
                .unwrap();
            // Damage only disposable data. Restore the exact guards before the read-only audit.
            let triggers = match table {
                "events" => &[
                    (
                        "DROP TRIGGER events_no_update",
                        "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END",
                    ),
                    (
                        "DROP TRIGGER events_no_delete",
                        "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END",
                    ),
                ][..],
                "commands" => &[
                    (
                        "DROP TRIGGER commands_no_update",
                        "CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'immutable receipt'); END",
                    ),
                    (
                        "DROP TRIGGER commands_no_delete",
                        "CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT,'immutable receipt'); END",
                    ),
                ][..],
                _ => &[],
            };
            for &(drop, _) in triggers {
                sqlx::query(drop).execute(&mut writer).await.unwrap();
            }
            sqlx::query("PRAGMA ignore_check_constraints=ON")
                .execute(&mut writer)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query(change)
                    .execute(&mut writer)
                    .await
                    .unwrap()
                    .rows_affected(),
                1
            );
            sqlx::query("PRAGMA ignore_check_constraints=OFF")
                .execute(&mut writer)
                .await
                .unwrap();
            for &(_, ddl) in triggers {
                sqlx::query(ddl).execute(&mut writer).await.unwrap();
            }
            writer.close().await.unwrap();
            match AssertUnwindSafe(audit.inspect(2)).catch_unwind().await {
                Ok(_) => missed.push(case),
                Err(error) => {
                    let message = error
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| error.downcast_ref::<&str>().copied())
                        .expect("audit failure must be text");
                    for private in [
                        temp.path().to_str().unwrap(),
                        workspace.as_str(),
                        INPUTS.titles[0].as_str(),
                        INPUTS.renames[0].as_str(),
                        INPUTS.renames[1].as_str(),
                        "private-event-canary",
                        "private-run-canary",
                        "private-source-canary",
                        "private-title-canary",
                        "private-payload-canary",
                        "private-method-canary",
                        "/private-workspace-canary",
                        "private-fault-canary",
                        "private-owner-canary",
                        "ab123456-789a-4bcd-8abc-0123456789b1",
                    ] {
                        assert!(
                            !message.contains(private)
                                && !message.contains(&serde_json::to_string(private).unwrap()),
                            "audit failure exposed private evidence"
                        );
                    }
                }
            }
            audit.close().await;
            temp.close().unwrap();
        }
    }
    assert!(
        missed.is_empty(),
        "audit accepted corrupt invariants: {missed:?}"
    );
}

#[tokio::test]
async fn metadata_audit_rejects_orphan_tool_rows_in_browser_and_seed_sessions() {
    for seed in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        let store = SessionStore::open(root.clone()).await.unwrap();
        let (title, workspace) = if seed {
            ("Fixture barrier seed".into(), None)
        } else {
            (
                INPUTS.titles[0].clone(),
                Some("/synthetic-workspace".into()),
            )
        };
        let created = store
            .create_session(CreateSession::new(OperationId::new(), title, workspace).unwrap())
            .await
            .unwrap();
        store.close().await.unwrap();
        let mut audit = Audit::open(root.clone(), vec!["/synthetic-workspace".into()]).await;
        assert_eq!(audit.inspect(1).await["session_count"], 1);
        let sid = created.session_id().as_str();
        let mut writer = SqliteConnectOptions::new()
            .filename(
                root.join("sessions")
                    .join(&sid[..2])
                    .join(sid)
                    .join("session.sqlite3"),
            )
            .foreign_keys(false)
            .disable_statement_logging()
            .connect()
            .await
            .unwrap();
        // Deliberately orphan a projection so an empty runs table alone is not the oracle.
        sqlx::query("INSERT INTO tool_results (run_id,call_id,tool_name,started_sequence) VALUES ('private-run-canary','private-call-canary','private-tool-canary',1)")
            .execute(&mut writer).await.unwrap();
        writer.close().await.unwrap();
        assert!(
            AssertUnwindSafe(audit.inspect(2))
                .catch_unwind()
                .await
                .is_err()
        );
        audit.close().await;
        temp.close().unwrap();
    }
}

#[tokio::test]
async fn metadata_seed_is_counted_and_cannot_hide_a_rename() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let seed = store
        .create_session(
            CreateSession::new(OperationId::new(), "Fixture barrier seed".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let mut audit = Audit::open(root, vec![]).await;
    let proof = audit.inspect(1).await;
    assert!(proof["seed_sessions"] == 1 && proof["session_count"] == 1);
    assert!(proof["creations"].as_array().unwrap().is_empty());
    let session = store.open_session(seed.session_id().clone()).await.unwrap();
    session
        .rename(OperationId::new(), INPUTS.renames[0].clone())
        .await
        .unwrap();
    assert!(
        AssertUnwindSafe(audit.inspect(2))
            .catch_unwind()
            .await
            .is_err()
    );
    store.close().await.unwrap();
    audit.close().await;
    temp.close().unwrap();
}
