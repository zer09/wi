use super::*;

#[test]
fn exclusive_start_and_control_schemas_are_closed() {
    let start = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,"tool_fidelity":true,"owner":"a".repeat(64)});
    let parse = |raw: &[u8]| {
        let value: Start = decode_control(raw);
        value.validate();
        value
    };
    assert!(parse(start.to_string().as_bytes()).tool_fidelity);
    let mut default = start.clone();
    default.as_object_mut().unwrap().remove("tool_fidelity");
    assert!(!parse(default.to_string().as_bytes()).tool_fidelity);
    for field in ["id", "transport", "recovered", "mime", "owner"] {
        let mut bad = start.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(std::panic::catch_unwind(|| parse(bad.to_string().as_bytes())).is_err());
    }
    for (field, value) in [
        ("tool_fidelity", json!(null)),
        ("tool_fidelity", json!("true")),
        ("id", json!(0)),
        ("owner", json!("invalid")),
        ("transport", json!("sse")),
        ("mime", json!(false)),
        ("recovered", json!(true)),
        ("mutations", json!(true)),
        ("presentation", json!(true)),
        ("fixed_head", json!(true)),
        ("unbound_history", json!(true)),
        ("extra", json!(true)),
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
    for raw in [
        "{}",
        "null",
        "[]",
        "{",
        r#"{"command":"inspect_tool_fidelity"}"#,
        r#"{"command":"inspect_tool_fidelity","id":0}"#,
        r#"{"command":"inspect_tool_fidelity","id":2,"id":2}"#,
        r#"{"command":"inspect_tool_fidelity","id":2,"extra":false}"#,
        r#"{"command":"inspect_tool_fidelity","\u0069d":2}"#,
        r#"{"command":"inspect_tool_fidelity","id":1.5}"#,
        r#"{"command":"inspect_tool_fidelity","id":4294967296}"#,
        r#"{"command":"inspect_tool_fidelity","id":"2"}"#,
        r#"{"command":"inspect_tool_fidelity","command":"inspect_tool_fidelity","id":2}"#,
    ] {
        assert!(std::panic::catch_unwind(|| decode_control::<Control>(raw.as_bytes())).is_err());
    }
    let inspect: Control = decode_control(br#"{"command":"inspect_tool_fidelity","id":2}"#);
    assert_eq!(inspect.id(), 2);
    let mut audit = Audit::default();
    assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit.check_control(&inspect))).is_err());
    audit.check_control(&Control::Select {
        id: 2,
        session_id: ApplicationSessionId::new().to_string(),
    });
    audit.check_control(&inspect);
    for command in [
        Control::Inspect { id: 3 },
        Control::InspectTask { id: 3 },
        Control::RotateAccount {
            id: NonZeroU32::new(3).unwrap(),
        },
        Control::Drive { id: 3, gate: 6 },
        Control::Select {
            id: 3,
            session_id: ApplicationSessionId::new().to_string(),
        },
    ] {
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| audit.check_control(&command))).is_err()
        );
    }
}

#[tokio::test]
async fn inert_success_is_error_shaped_but_not_an_error_and_validates_exact_arguments() {
    let tool = Arc::new(InertTool::default());
    let args: Value = checked(serde_json::from_str(&text("fixture_arguments")));
    for bad in [
        Value::Null,
        json!({}),
        json!({"text":1}),
        json!({"text":"wrong"}),
        json!({"text":args["text"],"extra":false}),
    ] {
        assert!(tool.execute(bad).await.is_err());
    }
    assert_eq!(tool.executions.load(Ordering::SeqCst), 0);
    assert!(
        checked(serde_json::to_string(&tool.execute(args).await.unwrap()))
            == text("fixture_output")
    );
    assert_eq!(tool.executions.load(Ordering::SeqCst), 1);
    let original: Value = checked(serde_json::from_str(&at("arguments", 0)));
    let reordered: Value = checked(serde_json::from_str(&at("arguments", 1)));
    assert!(original == reordered && at("arguments", 0) != at("arguments", 1));
    assert!(
        at("arguments", 0).contains("\r\n")
            && text("fixture_output").contains("\\r\\n")
            && !text("fixture_output").contains(['\r', '\n'])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_http_tools_and_independent_audit_reject_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("a");
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
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut options = SessionOptions::new(MODEL);
    options.instructions = INSTRUCTIONS.into();
    let mut settings = ApiSettings::new(
        &format!("http://{address}"),
        vec![workspace],
        temp.path().join("skills"),
        PROVIDER_ID.into(),
        options,
        true,
    )
    .unwrap();
    let tool = Arc::new(InertTool::default());
    settings.set_test_tool(tool.clone());
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        listener,
        RunHost::new(store, Arc::new(gateway)).unwrap(),
        ApiConfig::new(settings, OwnerToken::load(&token).unwrap()),
        stop.clone(),
    ));
    let f = Fixture {
        temp,
        address,
        stop,
        server,
        hooks,
        auth,
        wire,
    };
    let sid = f.create("a").await;
    let db = Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    };
    db.open(sid.clone()).await;
    let proof = Arc::new(Mutex::new(Proof::default()));
    let (drive, driven) = mpsc::channel(1);
    let provider = tokio::spawn(provider(f.wire, db.clone(), proof.clone(), driven));
    let mut audit_state = Audit::default();
    audit_state.check_control(&Control::Select {
        id: 2,
        session_id: sid.to_string(),
    });
    for task in 0..2 {
        let request = command(&at("tasks", task));
        json_response(
            http()
                .post(format!("http://{address}/v1/sessions/{sid}/runs"))
                .bearer_auth(OWNER)
                .json(&request),
            202,
        )
        .await;
        let gates = if task == 0 { 1..=3 } else { 4..=5 };
        for gate in gates {
            watch(async {
                loop {
                    if proof.lock().unwrap().gate == Some(gate) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await;
            proof.lock().unwrap().gate = None;
            drive.send(gate).await.unwrap();
        }
        watch(async {
            loop {
                if proof.lock().unwrap().completed == task + 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        let evidence = audit_state
            .inspect(&db, task as u32 + 3, &proof, &tool)
            .await;
        assert!(evidence["exact"] == true && evidence["prior_unchanged"] == true);
        assert!(
            evidence["run_id"] == request["run_id"]
                && evidence["operation_id"] == request["operation_id"]
        );
        let fields: Vec<_> = evidence
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(
            fields
                == [
                    "completed",
                    "event",
                    "exact",
                    "executions",
                    "id",
                    "new_dispatches",
                    "operation_id",
                    "prepared_results",
                    "prior_unchanged",
                    "requests",
                    "result_rows",
                    "reused",
                    "run_id",
                    "sequence_count",
                    "session_id"
                ]
        );
        assert!(evidence.to_string().len() < LIMIT as usize);
        private(&evidence);
        assert!(
            AssertUnwindSafe(audit_state.inspect(&db, 9, &proof, &tool))
                .catch_unwind()
                .await
                .is_err()
        );
    }
    let base = snapshot(&db).await;
    audit(&base, 2, 1);
    for executions in [0, 2] {
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| audit(&base, 2, executions))).is_err()
        );
    }
    for index in 0..base.tools.len() {
        for field in base.tools[index].as_object().unwrap().keys() {
            let mut bad = base.clone();
            bad.tools[index][field] = json!("corrupt");
            assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, 2, 1))).is_err());
        }
    }
    for index in 0..base.runs.len() {
        for field in base.runs[index].as_object().unwrap().keys() {
            let mut bad = base.clone();
            bad.runs[index][field] = Value::Null;
            assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, 2, 1))).is_err());
        }
    }
    for kind in [
        "tool.started",
        "tool.result",
        "tool.finished",
        "tool.reused",
        "response.finished",
    ] {
        let index = base
            .records
            .iter()
            .position(|r| {
                checked(serde_json::to_value(crate::http_api::dto::EventView::from(
                    r,
                )))["kind"]
                    == kind
            })
            .unwrap();
        let mut bad = base.clone();
        bad.records.remove(index);
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, 2, 1))).is_err());
        let mut bad = base.clone();
        let mut raw = checked(serde_json::to_value(&bad.records[index]));
        raw["payload"]["request_id"] = json!("wrong-request");
        // Provider envelopes can reject mismatched nested request IDs during decoding.
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| {
                bad.records[index] = checked(serde_json::from_value(raw));
                audit(&bad, 2, 1);
            }))
            .is_err()
        );
    }
    let mut bad = base.clone();
    bad.tools.push(base.tools[0].clone());
    assert!(std::panic::catch_unwind(AssertUnwindSafe(|| audit(&bad, 2, 1))).is_err());
    provider.abort();
    let _ = provider.await;
    f.stop.cancel();
    let outcome = watch(f.server).await.unwrap();
    assert!(outcome.http.is_ok() && matches!(&*outcome.shutdown, ShutdownOutcome::Closed));
    checked(db.reader.lock().await.take().unwrap().close().await);
    checked(f.temp.close());
}
