use super::*;

#[test]
fn unbound_history_start_and_controls_are_closed() {
    let start = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,"mutations":true,"unbound_history":true,"owner":"a".repeat(64)});
    let parse = |value: Value| {
        let start: Start = checked(serde_json::from_value(value));
        start.validate();
        start
    };
    assert!(parse(start.clone()).unbound_history);
    let mut default = start.clone();
    default.as_object_mut().unwrap().remove("unbound_history");
    assert!(!parse(default).unbound_history);
    for (field, value) in [
        ("unbound_history", json!(null)),
        ("unbound_history", json!("true")),
        ("unbound_history", json!(1)),
        ("mutations", json!(false)),
        ("presentation", json!(true)),
        ("transport", json!("sse")),
        ("recovered", json!(true)),
        ("mime", json!(false)),
        ("id", json!(0)),
        ("owner", json!("not-canonical")),
        ("owner", json!("A".repeat(64))),
        ("prompt", json!("private")),
        ("session_id", json!("private")),
        ("provider", json!("private")),
        ("path", json!("private")),
        ("action", json!("private")),
    ] {
        let mut bad = start.clone();
        bad[field] = value;
        assert!(std::panic::catch_unwind(|| parse(bad)).is_err());
    }
    for field in ["id", "owner", "transport", "recovered", "mime"] {
        let mut missing = start.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Start>(missing).is_err());
    }
    let raw = start.to_string();
    for field in start.as_object().unwrap().keys() {
        for spelling in [
            field.clone(),
            format!("\\u{:04x}{}", field.as_bytes()[0], &field[1..]),
        ] {
            let duplicate = format!(r#"{{"{spelling}":{},{}"#, start[field], &raw[1..]);
            assert!(serde_json::from_str::<Start>(&duplicate).is_err());
        }
    }
    for command in [
        "inspect",
        "stop",
        "select",
        "arm_acceptance",
        "arm_acceptance_unknown",
        "arm_acceptance_warning",
        "rotate_account",
        "wait_acceptance",
        "release_acceptance",
        "drive",
        "inspect_mutations",
        "inspect_task",
        "seed_input_framing",
        "replay_head",
    ] {
        let mut raw = json!({"command":command,"id":2});
        if command == "select" {
            raw["session_id"] = json!(ApplicationSessionId::new());
        }
        if command == "drive" {
            raw["gate"] = json!(1);
        }
        if command == "replay_head" {
            raw["step"] = json!("arm");
        }
        let control: Control = checked(serde_json::from_value(raw));
        assert!(
            std::panic::catch_unwind(|| check_control(&control)).is_ok()
                == matches!(command, "inspect" | "stop")
        );
    }
}

#[tokio::test]
async fn unbound_history_real_seed_and_private_audit_corruption_negatives() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let store = SessionStore::open(root.clone()).await.unwrap();
    let seed = store
        .create_session(
            CreateSession::new(OperationId::new(), "Fixture barrier seed".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let db = Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    let seeded = Audit::seed(&store, &db, &workspace, seed.session_id()).await;
    let records = db.records().await;
    let base = snapshot(&db).await;
    audit(&base, &records);
    let proof = Mutex::new(Proof::default());
    let auth = CountedAuth::new(TOKEN_A, ACCOUNT);
    let evidence = seeded.inspect(&db, 2, &proof, &auth).await;
    assert!(evidence["exact"] == true && evidence["sequence_count"] == "9");
    private(&evidence);
    assert!(
        !evidence
            .to_string()
            .contains("stored history has no replay provenance")
    );
    // Corrupt copies only. No SQL writer or invalid on-disk histories are needed.
    for (table, fields) in [
        (
            "events",
            vec![
                "sequence",
                "event_id",
                "event_type",
                "event_version",
                "created_at_ms",
                "run_id",
                "source_event_id",
                "source_sequence",
                "payload_json",
            ],
        ),
        (
            "commands",
            vec![
                "operation_id",
                "method",
                "first_sequence",
                "last_sequence",
                "payload_hash",
                "receipt_json",
            ],
        ),
        (
            "runs",
            vec![
                "run_id",
                "owner_instance_id",
                "accepted_sequence",
                "state",
                "last_runtime_sequence",
                "provider_session_id",
                "terminal_sequence",
                "result_sequence",
                "terminal_json",
            ],
        ),
        ("manifest", vec!["head_sequence", "updated_at_ms"]),
    ] {
        let count = match table {
            "events" => base.events.len(),
            "commands" => base.commands.len(),
            "runs" => 1,
            _ => 1,
        };
        for index in 0..count {
            for field in &fields {
                let mut bad = base.clone();
                let rows = match table {
                    "events" => &mut bad.events,
                    "commands" => &mut bad.commands,
                    "runs" => &mut bad.runs,
                    _ => &mut bad.manifest,
                };
                rows[index][*field] = json!("corrupt");
                assert!(
                    std::panic::catch_unwind(|| audit(&bad, &records)).is_err(),
                    "audit corruption escaped"
                );
            }
        }
    }
    for table in ["events", "commands", "runs", "tools", "manifest"] {
        for extra in [false, true] {
            let mut bad = base.clone();
            let rows = match table {
                "events" => &mut bad.events,
                "commands" => &mut bad.commands,
                "runs" => &mut bad.runs,
                "tools" => &mut bad.tools,
                _ => &mut bad.manifest,
            };
            if extra {
                rows.push(json!({}));
            } else if rows.pop().is_none() {
                continue;
            }
            assert!(std::panic::catch_unwind(|| audit(&bad, &records)).is_err());
        }
    }
    // A coherent but wrong turn payload must fail even when its raw and typed copies agree.
    for (index, field, replacement) in [(3, "number", json!(2)), (6, "response_id", json!("other"))]
    {
        let mut copies: Vec<Value> = records.iter().map(value).collect();
        copies[index]["payload"][field] = replacement;
        let mut bad = base.clone();
        bad.events[index]["payload_json"] = json!(copies[index]["payload"].to_string());
        let copies: Vec<StoredEvent> = copies
            .into_iter()
            .map(|v| checked(serde_json::from_value(v)))
            .collect();
        assert!(std::panic::catch_unwind(|| audit(&bad, &copies)).is_err());
    }
    let mut wrong_method = base.clone();
    wrong_method.commands[0]["method"] = json!("accept_history_run");
    assert!(std::panic::catch_unwind(|| audit(&wrong_method, &records)).is_err());
    // Real storage APIs prove the baseline rejects a subsequent metadata mutation too.
    seeded
        .session
        .rename(OperationId::new(), "changed legacy".into())
        .await
        .unwrap();
    assert!(
        AssertUnwindSafe(seeded.unchanged(&db))
            .catch_unwind()
            .await
            .is_err()
    );
    store.close().await.unwrap();
    db.reader
        .lock()
        .await
        .take()
        .unwrap()
        .close()
        .await
        .unwrap();
    temp.close().unwrap();
}
