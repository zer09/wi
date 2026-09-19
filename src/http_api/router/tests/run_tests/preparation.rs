use super::*;
use crate::{CallOrigin, FunctionCall, ItemKind, OutputItem};

fn skill(path: &std::path::Path, name: &str, body: &str) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: synthetic metadata\n---\n{body}"),
    )
    .unwrap();
}

#[tokio::test]
async fn auth_and_strict_task_body_precede_all_work() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    session
        .test_hooks()
        .arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    let command = command();
    for token in [None, Some("wrong")] {
        let mut request = server.http.post(server.url(&path(&session))).json(&command);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        error(request, 401, "api.unauthorized").await;
    }
    let oid = operation(&command);
    let rid = run(&command);
    for body in [
        "{}".into(),
        "[]".into(),
        "null".into(),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}"}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":null}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":"x","tools":[]}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","text":"x","text":"x"}}"#),
        format!(r#"{{"operation_id":"{oid}","operation_id":"{oid}","run_id":"{rid}","text":"x"}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"{rid}","run_id":"{rid}","text":"x"}}"#),
        format!(r#"{{"operation_id":"{oid}","run_id":"bad","text":"x"}}"#),
    ] {
        error(
            server
                .http
                .post(server.url(&path(&session)))
                .bearer_auth(TOKEN)
                .header(header::CONTENT_TYPE, "application/json")
                .body(body),
            400,
            "api.invalid_request",
        )
        .await;
    }
    error(
        server.post(&format!("{}?tools=x", path(&session)), &command),
        400,
        "api.invalid_request",
    )
    .await;
    error(
        server
            .post(&path(&session), &command)
            .header(header::CONTENT_TYPE, "text/plain"),
        415,
        "api.unsupported_media",
    )
    .await;
    error(server.post(&path(&session), &command), 503, "storage.io").await;
    assert_eq!(count(&server.run_hooks.readers), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    assert_eq!(count(&script.opens), 0);
    assert!(session.lookup_receipt(oid).await.unwrap().is_none());
    server.finish().await;
}

#[tokio::test]
async fn preparation_is_blocking_owned_but_dropped_waiter_cannot_dispatch() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let body = command();
    let pause = Arc::new(runs::test_hooks::Pause::default());
    *server.run_hooks.before.lock().unwrap() = Some(pause.clone());
    let socket = wire(&server, &session, &body).await;
    watchdog(pause.reached.notified()).await;
    // This test has one Tokio worker. It still serves other requests during the blocking read.
    assert_ne!(
        server.run_hooks.thread.lock().unwrap().unwrap(),
        std::thread::current().id()
    );
    response(server.get("/v1/settings"), 200).await;
    drop(socket);
    watchdog(server.run_hooks.waiter_left.notified()).await;
    pause.release();
    watchdog(server.run_hooks.reader_left.notified()).await;
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    assert_eq!(count(&script.opens), 0);
    assert!(
        session
            .lookup_receipt(operation(&body))
            .await
            .unwrap()
            .is_none()
    );
    server.finish().await;
}

#[tokio::test]
async fn current_workspace_authority_precedes_discovery() {
    let (server, script) = Script::server().await;
    let created = server
        .host
        .storage()
        .create_session(
            CreateSession::new(
                OperationId::new(),
                "retired".into(),
                Some(
                    server
                        .temp
                        .path()
                        .join("unapproved-do-not-probe")
                        .to_str()
                        .unwrap()
                        .into(),
                ),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let session = server
        .host
        .storage()
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    response(
        server.get(&format!("/v1/sessions/{}", session.session_id())),
        200,
    )
    .await;
    error(
        server.post(&path(&session), &command()),
        403,
        "api.workspace_forbidden",
    )
    .await;
    assert_eq!(count(&server.run_hooks.readers), 0);
    assert_eq!(count(&script.validations), 0);
    assert_eq!(count(&script.opens), 0);
    server.finish().await;
}

#[cfg(unix)]
#[tokio::test]
async fn replaced_canonical_workspace_is_rejected_before_discovery() {
    let (server, script) = Script::server().await;
    let session = server.session().await;
    let workspace = server.temp.path().join("workspace");
    let replacement = server.temp.path().join("replacement");
    std::fs::rename(&workspace, &replacement).unwrap();
    std::os::unix::fs::symlink(&replacement, &workspace).unwrap();
    error(
        server.post(&path(&session), &command()),
        403,
        "api.workspace_forbidden",
    )
    .await;
    assert_eq!(count(&script.opens), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    server.finish().await;
}

#[tokio::test]
async fn real_s2_and_add_numbers_capture_raw_text_metadata_and_paired_tools() {
    let mut first = model("tools");
    first.output = [
        ("add", "add_numbers", json!({"a":19,"b":23})),
        ("skill", "load_skill", json!({"id":"project:same"})),
    ]
    .into_iter()
    .map(|(id, name, args)| OutputItem {
        id: Some(id.into()),
        kind: ItemKind::FunctionCall,
        native_type: "function_call".into(),
        function_call: Some(FunctionCall {
            call_id: id.into(),
            name: name.into(),
            arguments: args.to_string(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        }),
        native: json!({"private":"private-native-canary"}),
    })
    .collect();
    let (gateway, script) = Script::new(Mode::Good, vec![first, model("final")]);
    let server = Server::gateway(gateway).await;
    let (temp, host) = server.stop_http().await;
    let server = Server::start_tools(temp, host, false, true).await;
    let workspace = server.temp.path().join("workspace");
    std::fs::write(workspace.join("AGENTS.md"), "project A instructions\r\n").unwrap();
    skill(
        &workspace.join(".agents/skills/same"),
        "same",
        "project skill body 雪\r\n",
    );
    skill(
        &server.temp.path().join("private-skills-canary/same"),
        "same",
        "global body must not be selected",
    );
    let bad = workspace.join(".agents/skills/bad");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(
        bad.join("SKILL.md"),
        "---\nname: [private-format-canary\n---\n",
    )
    .unwrap();
    std::fs::write(
        workspace.join(".agents/skills/same/script.sh"),
        "private-format-canary",
    )
    .unwrap();
    let session = server.session().await;
    let body = command();
    let accepted = response(server.post(&path(&session), &body), 202).await;
    assert_eq!(accepted["duplicate"], false);
    assert_eq!(
        accepted["notices"][0]["kind"],
        "excluded.invalid_frontmatter"
    );
    watchdog(script.control.waiting.notified()).await;
    let stored = session.run_record(run(&body)).await.unwrap().unwrap();
    let input = stored.input();
    assert_eq!(input.user_text(), RAW);
    assert_eq!(input.available_skills(), ["global:same", "project:same"]);
    assert!(input.active_skills().is_empty());
    assert_eq!(
        input.project_instructions_source(),
        Some("project:AGENTS.md")
    );
    assert!(input.prepared_request().options.tools.is_empty());
    let prepared: Value = serde_json::from_str(&input.prepared_request().prompt).unwrap();
    assert_eq!(prepared["task"], RAW);
    assert_eq!(
        prepared["project_instructions"]["text"],
        "project A instructions\r\n"
    );
    assert!(!input.prepared_request().prompt.contains("skill body"));
    assert!(!input.prepared_request().prompt.contains("global body"));
    assert_eq!(
        input
            .tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect::<Vec<_>>(),
        ["add_numbers", "load_skill"]
    );
    assert_eq!(
        serde_json::to_value(&script.options.lock().unwrap()[0].tools).unwrap(),
        serde_json::to_value(input.tool_definitions()).unwrap()
    );
    script.control.release.notify_one();
    watchdog(script.control.waiting.notified()).await;
    let add = session
        .tool_result(run(&body), "add".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(add.output(), Some("{\"sum\":42}"));
    assert_eq!(add.is_error(), Some(false));
    let loaded = session
        .tool_result(run(&body), "skill".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.is_error(), Some(false));
    assert!(loaded.output().unwrap().contains("project skill body"));
    let second = serde_json::to_value(&script.control.inputs.lock().unwrap()[1]).unwrap();
    assert_eq!(second[0]["output"], add.output().unwrap());
    assert_eq!(second[1]["output"], loaded.output().unwrap());
    script.control.release.notify_one();
    let final_run = finished(&session, &body).await;
    assert_eq!(final_run.result().unwrap().summary.new_tool_dispatches, 2);
    assert_eq!(
        final_run.result().unwrap().outcome,
        crate::run::RunOutcome::Completed
    );
    server.finish().await;
}

#[tokio::test]
async fn fatal_preparation_retains_safe_notices_and_never_opens_provider() {
    let (server, script) = Script::server().await;
    let workspace = server.temp.path().join("workspace");
    let bad = workspace.join(".agents/skills/bad");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("SKILL.md"), "private-format-canary").unwrap();
    std::fs::write(workspace.join("AGENTS.md"), [0xff]).unwrap();
    let session = server.session().await;
    let body = command();
    let failed = response(server.post(&path(&session), &body), 422).await;
    assert_eq!(failed["code"], "context.read_failed");
    assert_eq!(failed["notices"][0]["kind"], "excluded.invalid_frontmatter");
    assert_eq!(
        failed["notices"][0]["source_label"],
        "project:.agents/skills/bad/SKILL.md"
    );
    assert_eq!(count(&script.opens), 0);
    assert_eq!(count(&server.run_hooks.dispatched), 0);
    assert!(
        session
            .lookup_receipt(operation(&body))
            .await
            .unwrap()
            .is_none()
    );
    server.finish().await;
}
