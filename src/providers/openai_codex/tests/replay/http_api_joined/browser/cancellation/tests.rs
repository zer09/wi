use super::*;

#[test]
fn cancellation_protocol_is_closed_exclusive_and_unescaped() {
    let start = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,"cancellation":true,"owner":"a".repeat(64)});
    let parse = |raw: &[u8]| {
        let s: Start = decode_control(raw);
        s.validate();
    };
    parse(start.to_string().as_bytes());
    for (field, v) in [
        ("transport", json!("sse")),
        ("recovered", json!(true)),
        ("mime", json!(false)),
        ("mutations", json!(true)),
        ("presentation", json!(true)),
        ("unbound_history", json!(true)),
        ("fixed_head", json!(true)),
        ("tool_fidelity", json!(true)),
        ("lifecycle_failure", json!(true)),
        ("cancellation", Value::Null),
        ("private", json!(false)),
    ] {
        let mut bad = start.clone();
        bad[field] = v;
        assert!(std::panic::catch_unwind(|| parse(bad.to_string().as_bytes())).is_err());
    }
    let controls = [
        json!({"command":"arm_cancellation","id":2}),
        json!({"command":"wait_cancellation_pending","id":3,"session_id":ApplicationSessionId::new(),"run_id":RunId::new(),"operation_id":OperationId::new()}),
        json!({"command":"wait_cancellation","id":4}),
        json!({"command":"release_cancellation","id":5,"terminal_operation_id":OperationId::new()}),
        json!({"command":"inspect_cancellation","id":6}),
    ];
    for good in std::iter::once(start).chain(controls) {
        let parse = |raw: &[u8]| {
            if good.get("command").is_some() {
                let _: Control = decode_control(raw);
            } else {
                parse(raw);
            }
        };
        parse(good.to_string().as_bytes());
        for field in good.as_object().unwrap().keys() {
            let raw = good.to_string();
            for bad in [
                format!(r#"{{"{field}":{},{}"#, good[field], &raw[1..]),
                raw.replace(
                    &format!("\"{field}\""),
                    &format!("\"\\u{:04x}{}\"", field.as_bytes()[0], &field[1..]),
                ),
            ] {
                assert!(std::panic::catch_unwind(|| parse(bad.as_bytes())).is_err());
            }
            if field != "cancellation" {
                let mut bad = good.clone();
                bad.as_object_mut().unwrap().remove(field);
                assert!(std::panic::catch_unwind(|| parse(bad.to_string().as_bytes())).is_err());
            }
        }
        for (field, v) in [
            ("id", json!(0)),
            ("id", json!(-1)),
            ("id", json!("2")),
            ("id", Value::Null),
            ("id", json!(1.5)),
            ("id", json!(4294967296_u64)),
            ("private", json!(true)),
        ] {
            let mut bad = good.clone();
            bad[field] = v;
            assert!(std::panic::catch_unwind(|| parse(bad.to_string().as_bytes())).is_err());
        }
    }
    for raw in [
        "null",
        "[]",
        "{",
        r#"{"command":"wait_cancellation_pending","id":1,"session_id":"bad","run_id":"bad","operation_id":"bad"}"#,
    ] {
        assert!(std::panic::catch_unwind(|| decode_control::<Control>(raw.as_bytes())).is_err());
    }
}

#[test]
fn cancellation_controls_reject_wrong_order_and_identity() {
    let mut a = Audit::default();
    let id = NonZeroU32::new(2).unwrap();
    for command in [
        Control::ArmCancellation { id },
        Control::WaitCancellation { id },
        Control::InspectCancellation { id },
        Control::Drive { id: 2, gate: 1 },
        Control::Inspect { id: 2 },
        Control::ArmLifecycleFailure { id },
    ] {
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| a.check_control(&command))).is_err());
    }
    let sid = ApplicationSessionId::new();
    a.check_control(&Control::Select {
        id: 2,
        session_id: sid.to_string(),
    });
    a.check_control(&Control::ArmCancellation { id });
    for command in [
        Control::Select {
            id: 3,
            session_id: sid.to_string(),
        },
        Control::ArmCancellation { id },
        Control::WaitCancellationPending {
            id,
            session_id: ApplicationSessionId::new(),
            run_id: RunId::new(),
            operation_id: OperationId::new(),
        },
    ] {
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| a.check_control(&command))).is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_real_http_pause_commit_and_corruption_audit() {
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
    let created = json_response(
        http().post(format!("http://{address}/v1/sessions")).bearer_auth(OWNER)
            .json(&json!({"operation_id":OperationId::new(),"title":text("title"),"workspace":workspace})),
        201,
    ).await;
    let sid: ApplicationSessionId = created["session_id"].as_str().unwrap().parse().unwrap();
    let db = Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    db.open(sid.clone()).await;
    let proof = Arc::new(Mutex::new(Proof::default()));
    let provider = tokio::spawn(provider(wire, db.clone(), proof.clone()));
    let mut a = Audit::default();
    let nz = |n| NonZeroU32::new(n).unwrap();
    let result = AssertUnwindSafe(async {
        a.check_control(&Control::Select {
            id: 2,
            session_id: sid.to_string(),
        });
        a.check_control(&Control::ArmCancellation { id: nz(3) });
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
        a.check_control(&Control::WaitCancellationPending {
            id: nz(4),
            session_id: sid.clone(),
            run_id: run.clone(),
            operation_id: op.clone(),
        });
        assert!(a.pending(&db, &client, &proof, 4).await["exact"] == true);
        // Read before Cancel. The terminal pause holds the public session reader's mutex.
        let running = json_response(
            http()
                .get(format!("http://{address}/v1/sessions/{sid}/runs/{run}"))
                .bearer_auth(OWNER),
            200,
        )
        .await;
        assert!(
            running
                == json!({"api_version":1,"run_id":run,"user_text":text("task"),"accepted_sequence":"2",
        "state":"running","result_recorded":false,"terminal_sequence":null,"result_sequence":null,"result":null})
        );
        let cancel = json_response(
            http()
                .post(format!("http://{address}/v1/sessions/{sid}/runs/{run}/cancel"))
                .bearer_auth(OWNER)
                .json(&json!({})),
            202,
        )
        .await;
        assert!(
            cancel
                == json!({"api_version":1,"session_id":sid,"run_id":run,"disposition":"requested"})
        );
        a.check_control(&Control::WaitCancellation { id: nz(5) });
        let paused = a.wait(&db, &client, &proof, 5).await;
        assert!(paused["sequence_count"] == "7");
        // wait() audited the independent SQLite prefix; do not issue a public read here.
        assert!(running["state"] == "running" && running["result"].is_null());
        let terminal = a.terminal.clone().unwrap();
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| a.check_control(
                &Control::ReleaseCancellation {
                    id: nz(6),
                    terminal_operation_id: OperationId::new()
                }
            )))
            .is_err()
        );
        a.check_control(&Control::ReleaseCancellation {
            id: nz(6),
            terminal_operation_id: terminal,
        });
        a.release(&client).await;
        for id in 7..=9 {
            a.check_control(&Control::InspectCancellation { id: nz(id) });
            assert!(a.inspect(&db, &proof, &auth, id).await["exact"] == true);
        }
        let public = json_response(
            http()
                .get(format!("http://{address}/v1/sessions/{sid}/runs/{run}"))
                .bearer_auth(OWNER),
            200,
        )
        .await;
        assert!(
            public["state"] == "cancelled_locally"
                && public["result_recorded"] == true
                && public["terminal_sequence"] == "8"
                && public["result_sequence"] == "9"
        );
        let base = snapshot(&db).await;
        let identity = a.identity.as_ref().unwrap();
        let final_view = value(&crate::http_api::dto::EventView::from(&base.records[8]));
        assert!(
            public
                == json!({"api_version":1,"run_id":run,"user_text":text("task"),"accepted_sequence":"2",
        "state":"cancelled_locally","result_recorded":true,"terminal_sequence":"8","result_sequence":"9","result":final_view["data"]})
        );
        for index in 0..base.records.len() {
            let mut bad = base.clone();
            bad.records.remove(index);
            assert!(
                std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, identity, 9))).is_err()
            );
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
                        if field == "event_id" {
                            bad.records[index] = base.records[(index + 1) % base.records.len()].clone();
                        }
                        audit(&bad, identity, 9);
                    }))
                    .is_err()
                );
            }
        }
        for table in 0..2 {
            let rows = if table == 0 {
                &base.runs
            } else {
                &base.commands
            };
            for (i, row) in rows.iter().enumerate() {
                for field in row.as_object().unwrap().keys() {
                    let mut bad = base.clone();
                    let rows = if table == 0 {
                        &mut bad.runs
                    } else {
                        &mut bad.commands
                    };
                    rows[i][field] = json!("corrupt");
                    assert!(
                        std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, identity, 9)))
                            .is_err()
                    );
                }
            }
        }
        for edit in 0..11 {
            let mut bad = base.clone();
            let StoredEventPayload::RunResultRecorded(result) = bad.records[8].payload() else {
                unreachable!()
            };
            let mut result = result.clone();
            match edit {
                0 => result.outcome = RunOutcome::Completed,
                1 => result.summary.model_requests_attempted = 2,
                2 => result.summary.model_requests_admitted = 0,
                3 => result.summary.new_tool_dispatches = 1,
                4 => result.summary.tool_results_prepared = 1,
                5 => result.summary.reused_results = 1,
                6 => result.events_complete = false,
                7 => result.sink_error = Some(crate::run::RunSinkError::Failed),
                8 => result.run_id = RunId::new().to_string(),
                9 => result.summary.last_upstream_outcome = Some(crate::UpstreamOutcome::TerminalReceived),
                _ => bad.tools = 1,
            }
            let mut raw = value(&bad.records[8]);
            raw["payload"] = value(&result);
            assert!(
                std::panic::catch_unwind(AssertUnwindSafe(|| {
                    bad.records[8] = checked(serde_json::from_value(raw));
                    audit(&bad, identity, 9);
                }))
                .is_err(),
                "cancellation corruption case {edit} accepted"
            );
        }
        for field in 0..3 {
            let mut bad = identity.clone();
            match field {
                0 => bad.session = ApplicationSessionId::new(),
                1 => bad.run = RunId::new(),
                _ => bad.acceptance = OperationId::new(),
            }
            assert!(
                std::panic::catch_unwind(AssertUnwindSafe(|| audit(&base, &bad, 9))).is_err()
            );
        }
    })
    .catch_unwind()
    .await;
    // Release the writer even if an assertion fails, then drain and reap all owners.
    drop(a);
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
    temp.close().unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
