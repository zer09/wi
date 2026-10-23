use super::*;

#[test]
fn account_mismatch_control_closed_private_duplicate_and_bounded() {
    let raw = r#"{"command":"rotate_account","id":1}"#;
    let parsed: Control = serde_json::from_str(raw).unwrap();
    assert!(matches!(parsed, Control::RotateAccount { .. }) && parsed.id() == 1);
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
        json!({"token":"private-canary"}),
        json!({"account":"private-canary"}),
        json!({"principal_digest":"private-canary"}),
        json!({"owner":"private-canary"}),
        json!({"session_id":"private-canary"}),
        json!({"step":"arm"}),
        json!({"command":"rotate"}),
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
async fn account_mismatch_requires_audit_and_rejects_incompatible_and_duplicate_controls() {
    let gate = Gate {
        armed: true,
        baseline: None,
    };
    for control in [
        Control::Select {
            id: 2,
            session_id: "private-canary".into(),
        },
        Control::RotateAccount {
            id: NonZeroU32::new(2).unwrap(),
        },
        Control::Drive { id: 2, gate: 1 },
        Control::ArmAcceptance { id: 2 },
        Control::WaitAcceptance { id: 2 },
        Control::ReleaseAcceptance { id: 2 },
        Control::ArmAcceptanceWarning {
            id: NonZeroU32::new(2).unwrap(),
        },
        Control::ArmAcceptanceUnknown {
            id: NonZeroU32::new(2).unwrap(),
        },
        Control::SeedInputFraming { id: 2 },
        Control::ReplayHead {
            id: NonZeroU32::new(2).unwrap(),
            step: Step::Arm,
        },
        Control::InspectMutations { id: 2 },
    ] {
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| gate.check_control(&control))).is_err()
        );
    }
    for control in [
        Control::Inspect { id: 2 },
        Control::InspectTask { id: 2 },
        Control::Stop { id: 2 },
    ] {
        gate.check_control(&control);
    }
    let db = Database {
        root: PathBuf::new(),
        session: Arc::default(),
        reader: Arc::default(),
        read_failure: Arc::default(),
    };
    let auth = CountedAuth::new(TOKEN_A, ACCOUNT);
    let proof = Mutex::new(Proof::default());
    for compatible in [false, true] {
        let mut gate = Gate::default();
        assert!(
            AssertUnwindSafe(gate.arm(&db, &proof, &auth, compatible))
                .catch_unwind()
                .await
                .is_err()
        );
        assert!(!gate.armed && *auth.current.lock().unwrap() == (TOKEN_A, ACCOUNT));
        auth.assert_loads(0);
    }
}

#[tokio::test]
async fn account_mismatch_sqlite_audit_checks_real_history_and_rejects_corruption() {
    let mut fixture = Fixture::new(Transport::WebSocket).await;
    let sid = fixture.create("a").await;
    let db = Database {
        root: fixture.temp.path().join("private-data"),
        session: Arc::default(),
        reader: Arc::default(),
        read_failure: Arc::default(),
    };
    db.open(sid.clone()).await;
    let first = command(TASKS[0]);
    fixture.submit(&sid, &first).await;
    fixture.wire.receive().await;
    fixture
        .wire
        .reply(
            events(
                "task-0-tools",
                vec![call("add-雪", "add_numbers", ARGUMENTS[0])],
                false,
            ),
            None,
        )
        .await;
    fixture.wire.receive().await;
    let mut reply = events("task-0-final", answer(0), false);
    reply.insert(1, json!({"type":"response.output_item.added","response_id":"task-0-final","output_index":0,
        "item":{"type":"message","id":"answer","role":"assistant","status":"in_progress","content":[]}}));
    reply.insert(
        2,
        json!({"type":"response.output_text.delta","response_id":"task-0-final","item_id":"answer",
        "output_index":0,"content_index":0,"delta":"42 雪"}),
    );
    fixture.wire.reply(reply, None).await;
    fixture.finished(&sid, &first).await;
    fixture.wire.closed().await;
    assert!(task::inspect(&db, 1).await["run_state"] == "completed");
    let mut gate = Gate::default();
    gate.capture(&db).await;
    gate.capture(&db).await;
    let proof = Mutex::new(Proof {
        completed: 1,
        connections: 1,
        requests: 2,
        prepared_exact: 2,
        fresh_empty: true,
        fresh_parents: 1,
        continuations: 1,
        provider_stage: Some("finished"),
        ..Proof::default()
    });
    assert!(
        AssertUnwindSafe(gate.arm(&db, &proof, &fixture.auth, false))
            .catch_unwind()
            .await
            .is_err()
    );
    gate.arm(&db, &proof, &fixture.auth, true).await;
    assert!(
        AssertUnwindSafe(gate.arm(&db, &proof, &fixture.auth, true))
            .catch_unwind()
            .await
            .is_err()
    );
    let second = command(TASKS[1]);
    fixture.submit(&sid, &second).await;
    let (tcp, _) = watch(fixture.wire.listener.accept()).await.unwrap();
    socket(tcp).await;
    fixture.finished(&sid, &second).await;
    let state = snapshot(&db).await;
    let records = db.records().await;
    let base = gate.baseline.as_ref().unwrap();
    let receipt = audit(base, &state, &records);
    assert!(
        receipt["run_id"] == second["run_id"] && receipt["operation_id"] == second["operation_id"]
    );
    for table in ["events", "commands", "runs", "tools", "manifest"] {
        let source = match table {
            "events" => &state.events,
            "commands" => &state.commands,
            "runs" => &state.runs,
            "tools" => &state.tools,
            _ => &state.manifest,
        };
        for index in 0..source.len() {
            for key in source[index].as_object().unwrap().keys() {
                let mut changed = state.clone();
                let target = match table {
                    "events" => &mut changed.events,
                    "commands" => &mut changed.commands,
                    "runs" => &mut changed.runs,
                    "tools" => &mut changed.tools,
                    _ => &mut changed.manifest,
                };
                target[index][key] = json!("private-corruption-canary");
                assert!(
                    std::panic::catch_unwind(AssertUnwindSafe(|| audit(base, &changed, &records)))
                        .is_err(),
                    "changed SQLite field must reject"
                );
            }
            let mut changed = state.clone();
            let target = match table {
                "events" => &mut changed.events,
                "commands" => &mut changed.commands,
                "runs" => &mut changed.runs,
                "tools" => &mut changed.tools,
                _ => &mut changed.manifest,
            };
            target.remove(index);
            assert!(
                std::panic::catch_unwind(AssertUnwindSafe(|| audit(base, &changed, &records)))
                    .is_err()
            );
        }
    }
    fixture.auth.assert_loads(2);
    assert!(fixture.wire.requests == 2);
    let reader = db.reader.lock().await.take().unwrap();
    reader.close().await.unwrap();
    fixture.finish().await;
}

#[tokio::test]
async fn account_mismatch_socket_rejects_partial_payload_and_drains_empty_eof() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    for bytes in [
        vec![],
        vec![0x81],
        vec![0x82, 0x81, 1, 2, 3, 4, 0],
        vec![0x89, 0x81, 1, 2, 3, 4, 0],
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            socket(tcp).await;
        });
        let mut request = format!("ws://{address}/codex/responses")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {TOKEN_B}").parse().unwrap(),
        );
        request
            .headers_mut()
            .insert("chatgpt-account-id", ACCOUNT_Y.parse().unwrap());
        let tcp = TcpStream::connect(address).await.unwrap();
        let (mut client, _) = tokio_tungstenite::client_async(request, tcp).await.unwrap();
        client.get_mut().write_all(&bytes).await.unwrap();
        client.get_mut().shutdown().await.unwrap();
        drop(client);
        assert!(
            watch(server).await.is_ok() == bytes.is_empty(),
            "socket payload classification rejected"
        );
    }
}

#[test]
fn account_mismatch_socket_rejects_all_payload_forms_without_reporting_bytes() {
    assert!(empty_frame(&Message::Close(None)));
    assert!(empty_frame(&Message::Ping(vec![].into())));
    for frame in [
        Message::Text("private-canary".into()),
        Message::Text("".into()),
        Message::Binary(vec![1].into()),
        Message::Binary(vec![].into()),
        Message::Ping(vec![1].into()),
        Message::Pong(vec![1].into()),
        Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "private-canary".into(),
        })),
    ] {
        assert!(!empty_frame(&frame), "payload must be rejected");
    }
}
