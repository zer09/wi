use super::*;

#[test]
fn fixed_head_start_is_closed_before_resources() {
    let start = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,"mutations":true,"fixed_head":true,"owner":"a".repeat(64)});
    let parse = |raw: &[u8]| {
        let s: Start = decode_control(raw);
        s.validate();
        s
    };
    assert!(parse(start.to_string().as_bytes()).fixed_head);
    let mut default = start.clone();
    default.as_object_mut().unwrap().remove("fixed_head");
    assert!(!parse(default.to_string().as_bytes()).fixed_head);
    for (field, value) in [
        ("fixed_head", json!(null)),
        ("fixed_head", json!(1)),
        ("fixed_head", json!("true")),
        ("mutations", json!(false)),
        ("transport", json!("sse")),
        ("mime", json!(false)),
        ("recovered", json!(true)),
        ("presentation", json!(true)),
        ("unbound_history", json!(true)),
        ("path", json!("private")),
        ("digest", json!("private")),
        ("session_id", json!("private")),
        ("owner", json!("invalid")),
        ("id", json!(0)),
    ] {
        let mut bad = start.clone();
        bad[field] = value;
        assert!(std::panic::catch_unwind(|| parse(bad.to_string().as_bytes())).is_err());
    }
    let raw = start.to_string();
    for field in start.as_object().unwrap().keys() {
        let duplicate = format!(r#"{{"{field}":{},{}"#, start[field], &raw[1..]);
        assert!(std::panic::catch_unwind(|| parse(duplicate.as_bytes())).is_err());
        let escaped = raw.replace(
            &format!("\"{field}\""),
            &format!("\"\\u{:04x}{}\"", field.as_bytes()[0], &field[1..]),
        );
        assert!(std::panic::catch_unwind(|| parse(escaped.as_bytes())).is_err());
    }
    for raw in [b"{".as_slice(), b"null", b"[]", b"{}"] {
        assert!(std::panic::catch_unwind(|| parse(raw)).is_err());
    }
}

#[tokio::test]
async fn fixed_head_seed_uses_real_rename_receipts_and_rejects_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let store = SessionStore::open(temp.path().join("data")).await.unwrap();
    let seed = store
        .create_session(
            CreateSession::new(OperationId::new(), "Fixture barrier seed".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let db = Database {
        root: temp.path().join("data"),
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    let mut a = Audit::seed(&store, &db, &workspace, seed.session_id()).await;
    let base = snapshot(&db).await;
    for (table, count, fields) in [
        (
            "events",
            66,
            vec![
                "sequence",
                "event_id",
                "event_type",
                "event_version",
                "run_id",
                "source_event_id",
                "source_sequence",
                "payload_json",
            ],
        ),
        (
            "commands",
            65,
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
            "manifest",
            1,
            vec![
                "head_sequence",
                "title",
                "workspace_json",
                "created_at_ms",
                "updated_at_ms",
                "creation_provenance_json",
            ],
        ),
    ] {
        for index in 0..count {
            for field in &fields {
                let mut bad = base.clone();
                let rows = match table {
                    "events" => &mut bad.events,
                    "commands" => &mut bad.commands,
                    _ => &mut bad.manifest,
                };
                rows[index][*field] = json!("corrupt");
                assert!(
                    std::panic::catch_unwind(AssertUnwindSafe(|| audit(
                        &bad,
                        Some(&base),
                        a.session_id(),
                        &a.workspace,
                        &a.seed
                    )))
                    .is_err(),
                    "corruption escaped"
                );
            }
        }
    }
    for table in [
        "events",
        "commands",
        "runs",
        "tools",
        "manifest",
        "creations",
        "catalog",
    ] {
        let mut bad = base.clone();
        let rows = match table {
            "events" => &mut bad.events,
            "commands" => &mut bad.commands,
            "runs" => &mut bad.runs,
            "tools" => &mut bad.tools,
            "manifest" => &mut bad.manifest,
            "creations" => &mut bad.creations,
            _ => &mut bad.catalog,
        };
        rows.push(json!({}));
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| audit(
                &bad,
                Some(&base),
                a.session_id(),
                &a.workspace,
                &a.seed
            )))
            .is_err()
        );
    }
    for raw in [
        json!({"command":"arm_acceptance","id":2}),
        json!({"command":"inspect_task","id":2}),
        json!({"command":"drive","id":2,"gate":1}),
        json!({"command":"select","id":2,"session_id":seed.session_id()}),
    ] {
        let c: Control = checked(serde_json::from_value(raw));
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| a.check_control(&c))).is_err());
    }
    let evidence = a
        .inspect(
            &db,
            2,
            &Mutex::new(Proof::default()),
            &CountedAuth::new(TOKEN_A, ACCOUNT),
        )
        .await;
    assert!(evidence["exact"] == true && evidence["sequence_count"] == "66");
    private(&evidence);
    checked(store.close().await);
    checked(db.reader.lock().await.take().unwrap().close().await);
    checked(temp.close());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixed_head_final_audit_rejects_corrupt_records_commands_and_projections() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "private-project-browser\r\n").unwrap();
    let token = temp.path().join("owner");
    std::fs::write(&token, OWNER).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    let root = temp.path().join("data");
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
    let a = Audit::seed(&store, &db, &workspace, seed.session_id()).await;
    let wire = Wire::new(Transport::WebSocket).await;
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let mut adapter = OpenAiCodexProvider::loopback(
        auth.clone(),
        Transport::WebSocket,
        wire.listener.local_addr().unwrap(),
    );
    adapter.sse_endpoint = format!(
        "http://{}/codex/responses",
        wire.listener.local_addr().unwrap()
    );
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(adapter)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut options = SessionOptions::new(MODEL);
    options.instructions = INSTRUCTIONS.into();
    options.transport = Transport::WebSocket;
    let settings = ApiSettings::new(
        &origin,
        vec![workspace],
        temp.path().join("skills"),
        PROVIDER_ID.into(),
        options,
        true,
    )
    .unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        listener,
        RunHost::new(store, Arc::new(gateway)).unwrap(),
        ApiConfig::new(settings, OwnerToken::load(&token).unwrap()),
        stop.clone(),
    ));
    let proof = Arc::new(Mutex::new(Proof::default()));
    let (drive, driven) = mpsc::channel(1);
    let provider_db = db.clone();
    let provider_proof = proof.clone();
    let provider = tokio::spawn(async move {
        super::super::provider(
            wire,
            provider_db,
            provider_proof,
            driven,
            false,
            true,
            (false, true, true),
        )
        .await;
    });
    a.session
        .rename(OperationId::new(), RENAMED.into())
        .await
        .unwrap();
    a.session.refresh_catalog().await.unwrap();
    let request = http()
        .post(format!("{origin}/v1/sessions/{}/runs", a.session_id()))
        .bearer_auth(OWNER)
        .json(&command(TASKS[0]))
        .send()
        .await
        .unwrap();
    assert!(request.status() == 202);
    for gate in 1..=3 {
        watch(async {
            loop {
                if proof.lock().unwrap().gate == Some(gate) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        if gate == 1 {
            let evidence = a.inspect(&db, 2, &proof, &auth).await;
            assert!(evidence["phase"] == "interleaved" && evidence["sequence_count"] == "72");
        }
        proof.lock().unwrap().gate.take();
        drive.send(gate).await.unwrap();
    }
    watch(async {
        loop {
            if proof.lock().unwrap().completed == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let evidence = a.inspect(&db, 3, &proof, &auth).await;
    assert!(evidence["phase"] == "completed" && evidence["sequence_count"] == "86");
    private(&evidence);
    let base = snapshot(&db).await;
    provider.abort();
    let _ = provider.await;
    stop.cancel();
    let outcome = watch(server).await.unwrap();
    assert!(outcome.http.is_ok() && matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
    db.reader
        .lock()
        .await
        .take()
        .unwrap()
        .close()
        .await
        .unwrap();

    let rejected = |bad: &Snapshot, label: &str| {
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| audit(
                bad,
                Some(&a.baseline),
                a.session_id(),
                &a.workspace,
                &a.seed
            )))
            .is_err(),
            "corruption escaped: {label}"
        );
    };
    // Mutate private snapshots, never the joined SQLite source or public replies.
    for (table, rows) in [
        ("events", &base.events),
        ("commands", &base.commands),
        ("runs", &base.runs),
        ("tools", &base.tools),
        ("manifest", &base.manifest),
    ] {
        for (index, row) in rows.iter().enumerate() {
            for field in row.as_object().unwrap().keys() {
                let mut bad = base.clone();
                let rows = match table {
                    "events" => &mut bad.events,
                    "commands" => &mut bad.commands,
                    "runs" => &mut bad.runs,
                    "tools" => &mut bad.tools,
                    _ => &mut bad.manifest,
                };
                rows[index][field] = json!("corrupt");
                rejected(&bad, &format!("{table}.{field}"));
            }
        }
    }
    for table in [
        "events",
        "commands",
        "runs",
        "tools",
        "manifest",
        "creations",
        "catalog",
    ] {
        for extra in [false, true] {
            let mut bad = base.clone();
            let rows = match table {
                "events" => &mut bad.events,
                "commands" => &mut bad.commands,
                "runs" => &mut bad.runs,
                "tools" => &mut bad.tools,
                "manifest" => &mut bad.manifest,
                "creations" => &mut bad.creations,
                _ => &mut bad.catalog,
            };
            if extra {
                rows.push(rows[0].clone());
            } else {
                rows.pop();
            }
            rejected(&bad, table);
        }
    }
    // Validly encoded private digest plus a matching command hash must still fail.
    let mut bad = base.clone();
    let mut selection = decode(&bad.events[68]["payload_json"]);
    selection["selection"]["history_digest"] = json!("a".repeat(64));
    bad.events[68]["payload_json"] = json!(selection.to_string());
    let accepted = decode(&bad.events[67]["payload_json"]);
    let canonical = json!({"method":"accept_history_run","session_id":a.session_id(),"run_id":accepted["run_id"],
        "input":accepted["input"],"selection":selection["selection"]}).to_string();
    bad.commands[66]["payload_hash"] = hash(&canonical);
    rejected(&bad, "private digest with recomputed hash");
    assert!(
        audit(
            &base,
            Some(&a.baseline),
            a.session_id(),
            &a.workspace,
            &a.seed
        ) == 86
    );
    temp.close().unwrap();
}
