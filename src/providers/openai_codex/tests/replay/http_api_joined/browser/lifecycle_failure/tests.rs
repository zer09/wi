use super::*;

#[test]
fn lifecycle_schema_is_exclusive_closed_and_unescaped() {
    let start = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,"lifecycle_failure":true,"owner":"a".repeat(64)});
    let parse = |raw: &[u8]| {
        let s: Start = decode_control(raw);
        s.validate();
    };
    parse(start.to_string().as_bytes());
    for field in start.as_object().unwrap().keys() {
        let raw = start.to_string();
        for bad in [
            format!(r#"{{"{field}":{},{}"#, start[field], &raw[1..]),
            raw.replace(
                &format!("\"{field}\""),
                &format!("\"\\u{:04x}{}\"", field.as_bytes()[0], &field[1..]),
            ),
        ] {
            assert!(std::panic::catch_unwind(|| parse(bad.as_bytes())).is_err());
        }
    }
    for field in ["id", "transport", "recovered", "mime", "owner"] {
        let mut bad = start.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(std::panic::catch_unwind(|| parse(bad.to_string().as_bytes())).is_err());
    }
    for (field, v) in [
        ("transport", json!("sse")),
        ("recovered", json!(true)),
        ("mime", json!(false)),
        ("mutations", json!(true)),
        ("presentation", json!(true)),
        ("unbound_history", json!(true)),
        ("fixed_head", json!(true)),
        ("tool_fidelity", json!(true)),
        ("lifecycle_failure", Value::Null),
        ("extra", json!(false)),
    ] {
        let mut bad = start.clone();
        bad[field] = v;
        assert!(std::panic::catch_unwind(|| parse(bad.to_string().as_bytes())).is_err());
    }
    let controls = [
        json!({"command":"arm_lifecycle_failure","id":2}),
        json!({"command":"wait_lifecycle_failure","id":3,"session_id":ApplicationSessionId::new(),"run_id":RunId::new(),"operation_id":OperationId::new()}),
        json!({"command":"release_lifecycle_failure","id":4,"final_operation_id":OperationId::new()}),
        json!({"command":"inspect_lifecycle_failure","id":5}),
    ];
    for good in controls {
        let _: Control = decode_control(good.to_string().as_bytes());
        for field in good.as_object().unwrap().keys() {
            let mut bad = good.clone();
            bad.as_object_mut().unwrap().remove(field);
            let raw = good.to_string();
            for bad in [
                bad.to_string(),
                format!(r#"{{"{field}":{},{}"#, good[field], &raw[1..]),
                raw.replace(
                    &format!("\"{field}\""),
                    &format!("\"\\u{:04x}{}\"", field.as_bytes()[0], &field[1..]),
                ),
            ] {
                assert!(
                    std::panic::catch_unwind(|| decode_control::<Control>(bad.as_bytes())).is_err()
                );
            }
        }
        for (field, v) in [
            ("id", json!(0)),
            ("id", json!(-1)),
            ("id", json!("2")),
            ("id", Value::Null),
            ("id", json!(1.5)),
            ("id", json!(4294967296_u64)),
            ("extra", json!(true)),
            ("command", json!("unknown")),
        ] {
            let mut bad = good.clone();
            bad[field] = v;
            assert!(
                std::panic::catch_unwind(|| decode_control::<Control>(bad.to_string().as_bytes()))
                    .is_err()
            );
        }
    }
    for raw in [
        "null",
        "[]",
        "{",
        r#"{"command":"wait_lifecycle_failure","id":1,"session_id":"bad","run_id":"bad","operation_id":"bad"}"#,
    ] {
        assert!(std::panic::catch_unwind(|| decode_control::<Control>(raw.as_bytes())).is_err());
    }
}

#[test]
fn lifecycle_controls_reject_competing_out_of_order_and_wrong_identity() {
    let mut a = Audit::default();
    let id = NonZeroU32::new(2).unwrap();
    for command in [
        Control::ArmLifecycleFailure { id },
        Control::InspectLifecycleFailure { id },
        Control::Drive { id: 2, gate: 1 },
        Control::Inspect { id: 2 },
    ] {
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| a.check_control(&command))).is_err());
    }
    let sid = ApplicationSessionId::new();
    a.check_control(&Control::Select {
        id: 2,
        session_id: sid.to_string(),
    });
    a.check_control(&Control::ArmLifecycleFailure { id });
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(
            || a.check_control(&Control::ArmLifecycleFailure { id })
        ))
        .is_err()
    );
    a.check_control(&Control::Drive { id: 3, gate: 1 });
    a.check_control(&Control::Drive { id: 4, gate: 2 });
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(|| a.check_control(
            &Control::WaitLifecycleFailure {
                id,
                session_id: ApplicationSessionId::new(),
                run_id: RunId::new(),
                operation_id: OperationId::new()
            }
        )))
        .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lifecycle_real_http_rollback_audit_and_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "private-project-browser\r\n").unwrap();
    let token = temp.path().join("owner");
    std::fs::write(&token, OWNER).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    let root = temp.path().join("private-data");
    let store = SessionStore::open(root.clone()).await.unwrap();
    let seed = store
        .create_session(CreateSession::new(OperationId::new(), "seed".into(), None).unwrap())
        .await
        .unwrap();
    let hooks = store
        .open_session(seed.session_id().clone())
        .await
        .unwrap()
        .test_hooks();
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
    let host = RunHost::new(store, Arc::new(gateway)).unwrap();
    let client = host.client();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut options = SessionOptions::new(MODEL);
    options.instructions = INSTRUCTIONS.into();
    let settings = ApiSettings::new(
        &format!("http://{address}"),
        vec![workspace.clone()],
        temp.path().join("skills"),
        PROVIDER_ID.into(),
        options,
        true,
    )
    .unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        listener,
        host,
        ApiConfig::new(settings, OwnerToken::load(&token).unwrap()),
        stop.clone(),
    ));
    let created=json_response(http().post(format!("http://{address}/v1/sessions")).bearer_auth(OWNER)
        .json(&json!({"operation_id":OperationId::new(),"title":text("title"),"workspace":workspace})),201).await;
    let sid: ApplicationSessionId = created["session_id"].as_str().unwrap().parse().unwrap();
    let db = Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    db.open(sid.clone()).await;
    let proof = Arc::new(Mutex::new(Proof::default()));
    let (drive, driven) = mpsc::channel(1);
    let provider = tokio::spawn(provider(wire, db.clone(), proof.clone(), driven));
    let mut a = Audit::default();
    a.check_control(&Control::Select {
        id: 2,
        session_id: sid.to_string(),
    });
    let nz = |n| NonZeroU32::new(n).unwrap();
    a.check_control(&Control::ArmLifecycleFailure { id: nz(3) });
    a.arm(&db, &hooks, seed.session_id()).await;
    let command = command(&text("task"));
    let run = rid(&command);
    let op: OperationId = command["operation_id"].as_str().unwrap().parse().unwrap();
    let receipt = json_response(
        http()
            .post(format!("http://{address}/v1/sessions/{sid}/runs"))
            .bearer_auth(OWNER)
            .json(&command),
        202,
    )
    .await;
    assert!(receipt["receipt"]["operation_id"] == value(&op));
    for number in 1..=2 {
        watch(async {
            while proof.lock().unwrap().gate != Some(number) {
                tokio::task::yield_now().await;
            }
        })
        .await;
        a.check_control(&Control::Drive {
            id: 3 + number as u32,
            gate: number,
        });
        proof.lock().unwrap().gate = None;
        drive.send(number).await.unwrap();
    }
    a.check_control(&Control::WaitLifecycleFailure {
        id: nz(6),
        session_id: sid.clone(),
        run_id: run.clone(),
        operation_id: op.clone(),
    });
    let paused = a
        .wait(&db, &client, 6, sid.clone(), run.clone(), op.clone())
        .await;
    assert!(paused["hits"] == 1 && paused["final_operation_id"] != value(&op));
    assert!(
        AssertUnwindSafe(a.inspect(&db, &proof, &auth, seed.session_id(), 7))
            .catch_unwind()
            .await
            .is_err()
    );
    let final_id = a.fault.as_ref().unwrap().final_operation.clone();
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(|| a.check_control(
            &Control::ReleaseLifecycleFailure {
                id: nz(7),
                final_operation_id: OperationId::new()
            }
        )))
        .is_err()
    );
    a.check_control(&Control::ReleaseLifecycleFailure {
        id: nz(7),
        final_operation_id: final_id,
    });
    a.release(&client).await;
    watch(async {
        while proof.lock().unwrap().completed != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    for id in 8..=9 {
        a.check_control(&Control::InspectLifecycleFailure { id: nz(id) });
        assert!(a.inspect(&db, &proof, &auth, seed.session_id(), id).await["exact"] == true);
    }
    let public = json_response(
        http()
            .get(format!("http://{address}/v1/sessions/{sid}/runs/{run}"))
            .bearer_auth(OWNER),
        200,
    )
    .await;
    assert!(
        public["state"] == "failed"
            && public["terminal_sequence"] == "19"
            && public["result_recorded"] == false
            && public["result_sequence"].is_null()
            && public["result"].is_null()
    );
    let base = snapshot(&db).await;
    let f = a.fault.as_ref().unwrap();
    for index in 0..base.records.len() {
        let mut bad = base.clone();
        bad.records.remove(index);
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, f))).is_err());
        for field in ["application_session_id", "event_id", "run_id", "sequence"] {
            let mut bad = base.clone();
            let mut raw = value(&bad.records[index]);
            raw[field] = if field == "sequence" {
                json!(99)
            } else {
                json!(ApplicationSessionId::new())
            };
            assert!(
                std::panic::catch_unwind(AssertUnwindSafe(|| {
                    bad.records[index] = checked(serde_json::from_value(raw));
                    // A fresh event ID is valid; duplicating an existing identity is not.
                    if field == "event_id" {
                        bad.records[index] = base.records[(index + 1) % base.records.len()].clone();
                    }
                    audit(&bad, f);
                }))
                .is_err()
            );
        }
    }
    for table in 0..3 {
        let rows = match table {
            0 => &base.runs,
            1 => &base.tools,
            _ => &base.commands,
        };
        for (index, row) in rows.iter().enumerate() {
            for field in row.as_object().unwrap().keys() {
                let mut bad = base.clone();
                let rows = match table {
                    0 => &mut bad.runs,
                    1 => &mut bad.tools,
                    _ => &mut bad.commands,
                };
                rows[index][field] = json!("corrupt");
                assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, f))).is_err());
            }
        }
    }
    for edit in 0..13 {
        let mut bad = f.clone();
        match edit {
            0 => bad.hits = 0,
            1 => bad.hits = 2,
            2 => bad.rollback = false,
            3 => bad.final_operation = bad.acceptance.clone(),
            4 => bad.attempt.run_id = RunId::new().to_string(),
            5 => bad.attempt.summary.new_tool_dispatches = 2,
            6 => bad.attempt.events_complete = false,
            7 => bad.attempt.last_response.as_mut().unwrap().text = "corrupt".into(),
            8 => bad.acceptance = OperationId::new(),
            9 => bad.session = ApplicationSessionId::new(),
            10 => bad.run = RunId::new(),
            11 => bad.attempt.outcome = RunOutcome::Completed,
            _ => bad.attempt.sink_error = Some(crate::run::RunSinkError::Failed),
        }
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&base, &bad))).is_err());
    }
    for (index, from, to) in [
        (15, text("partial"), "corrupt"),
        (7, text("arguments"), "{}"),
        (7, "native_terminal".into(), "validated_output_item_done"),
        (14, text("item_id"), "other-item"),
        (16, "unexpected_end".into(), "transport"),
        (16, "unknown".into(), "terminal_received"),
        (18, "provider_request_failed".into(), "provider_eof"),
    ] {
        let mut bad = base.clone();
        let raw = serde_json::to_string(&bad.records[index]).unwrap();
        let from = serde_json::to_string(&from).unwrap();
        let to = serde_json::to_string(&to).unwrap();
        assert!(raw.contains(&from));
        bad.records[index] = checked(serde_json::from_str(&raw.replace(&from, &to)));
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, f))).is_err());
    }
    provider.abort();
    let _ = provider.await;
    drop(a);
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
    temp.close().unwrap();
}
