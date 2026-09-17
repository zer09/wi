use super::*;
use crate::{Gateway, Provider, SessionOptions, tools::ToolRegistry};
use std::sync::{Arc, Mutex, atomic::Ordering};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn p1b2_01_17_independent_provider_pure_delegation_checks_new_input() {
    let rig = Rig::new().await;
    let provider = Arc::new(Script {
        counters: rig.counters.clone(),
        session: rig.session.clone(),
        run_id: RunId::new(),
        identity: identity('a'),
        steps: Mutex::new(Default::default()),
        cancel: CancellationToken::new(),
        stop: Stop::Never,
        selected: true,
    });
    let mut gateway = Gateway::new();
    gateway.register(provider.clone()).unwrap();
    let replay = rig.prepare().await.replay();
    gateway
        .validate_replay(
            ID,
            &SessionOptions::new(MODEL),
            &replay,
            &[InputItem::user("new task")],
        )
        .unwrap();
    assert!(
        gateway
            .validate_replay(ID, &SessionOptions::new(MODEL), &replay, &[])
            .is_err()
    );
    assert!(
        provider
            .validate_replay(
                &SessionOptions::new("different"),
                &replay,
                &[InputItem::user("new")]
            )
            .is_err()
    );
    let wrong = ConversationReplay::new(
        ID.into(),
        MODEL.into(),
        Some(ReplayIdentity::new(ID.into(), "other-format".into(), "a".repeat(64)).unwrap()),
        vec![],
    )
    .unwrap();
    assert!(
        provider
            .validate_replay(
                &SessionOptions::new(MODEL),
                &wrong,
                &[InputItem::user("new")]
            )
            .is_err()
    );
    assert_eq!(rig.counters.work(), (0, 0, 0, 0, 0));
    assert_eq!(rig.counters.replay_checks.load(Ordering::SeqCst), 4);
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_10_12_13_actual_multicall_reuse_and_run_scoped_results() {
    let rig = Rig::new().await;
    let first = response(
        "one",
        vec![
            call("z", json!({"a":17,"b":25})),
            call("a", json!({"a":42,"b":8})),
        ],
    );
    let mut reuse = response(
        "two",
        vec![
            call("a", json!({"b":8,"a":42})),
            call("z", json!({"b":25,"a":17})),
        ],
    );
    reuse.output_provenance = crate::OutputProvenance::ValidatedOutputItemDone;
    reuse.native["output"] = json!([]);
    let final_response = response("final", vec![]);
    let (a, actual) = rig
        .record(Plan::new(
            rig.input("prepared A\r\n雪"),
            vec![first.clone(), reuse.clone(), final_response.clone()],
        ))
        .await;
    assert_eq!(actual.summary.new_tool_dispatches, 2);
    assert_eq!(actual.summary.reused_results, 2);
    let prepared = rig.prepare().await;
    let replay = prepared.replay();
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(prepared.included_exchange_count(), 3);
    assert_eq!(replay.runs()[0].source_run_id(), a.as_str());
    assert_eq!(replay.runs()[0].prepared_prompt(), "prepared A\r\n雪");
    for (exchange, original) in
        replay.runs()[0]
            .exchanges()
            .iter()
            .zip([&first, &reuse, &final_response])
    {
        assert_eq!(value(exchange.response()), value(original));
    }
    assert_eq!(
        value(&replay.runs()[0].exchanges()[0].tool_results()),
        json!([
        {"kind":"tool_result","call_id":"z","output":"{\"sum\":42}"},
        {"kind":"tool_result","call_id":"a","output":"{\"sum\":50}"}])
    );
    assert_eq!(
        value(&replay.runs()[0].exchanges()[1].tool_results()),
        json!([
        {"kind":"tool_result","call_id":"a","output":"{\"sum\":50}"},
        {"kind":"tool_result","call_id":"z","output":"{\"sum\":42}"}])
    );
    let original = rig
        .session
        .tool_result(a.clone(), "a".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.request_id(), Some("request-0"));
    let (b, _) = rig
        .record(Plan::new(
            rig.input("prepared B"),
            vec![
                response("b", vec![call("a", json!({"a":1,"b":2}))]),
                response("done-b", vec![]),
            ],
        ))
        .await;
    let replay = rig.prepare().await.replay();
    assert_eq!(replay.runs().len(), 2);
    assert_eq!(replay.runs()[1].source_run_id(), b.as_str());
    assert_eq!(
        value(&replay.runs()[1].exchanges()[0].tool_results()),
        json!([{"kind":"tool_result","call_id":"a","output":"{\"sum\":3}"}])
    );
    assert_eq!(rig.counters.executes.load(Ordering::SeqCst), 3);
    assert_eq!(
        rig.session
            .tool_result(a, "a".into())
            .await
            .unwrap()
            .unwrap()
            .request_id(),
        Some("request-0")
    );
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_12_actual_error_serialization_and_flags_are_not_inferred() {
    for (mode, expected, flag) in [
        (
            "failed",
            "{\"error\":{\"code\":\"gateway_error\"}}".to_owned(),
            true,
        ),
        (
            "large",
            "{\"error\":{\"code\":\"tool_output_limit\"}}".to_owned(),
            true,
        ),
        (
            "error_shaped",
            json!({"error":{"code":"not_error","text":"雪\r\n\u{0}"}}).to_string(),
            false,
        ),
    ] {
        let rig = Rig::new().await;
        let (run, _) = rig
            .record(Plan::new(
                rig.input("task"),
                vec![
                    response("call", vec![call("same", json!({"mode":mode}))]),
                    response("done", vec![]),
                ],
            ))
            .await;
        let replay = rig.prepare().await.replay();
        assert_eq!(
            value(&replay.runs()[0].exchanges()[0].tool_results()),
            json!([{"kind":"tool_result","call_id":"same","output":expected}])
        );
        let saved = rig
            .session
            .tool_result(run, "same".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.output(), Some(expected.as_str()));
        assert_eq!(saved.is_error(), Some(flag));
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_14_native_recovery_refusal_reasoning_empty_and_alias_fidelity() {
    for recovered in [false, true] {
        for kind in ["empty", "refusal", "reasoning"] {
            let rig = Rig::new().await;
            let mut original = match kind {
                "empty" => response("empty", vec![]),
                "refusal" => response(
                    "refusal",
                    vec![OutputItem {
                        id: Some("message".into()),
                        kind: crate::ItemKind::Message,
                        native_type: "message".into(),
                        function_call: None,
                        native: json!({"id":"message","type":"message","role":"assistant","content":[{"type":"refusal","refusal":"雪\r\nno"}], "opaque":"exact"}),
                    }],
                ),
                _ => response(
                    "reasoning",
                    vec![OutputItem {
                        id: Some("r".into()),
                        kind: crate::ItemKind::Reasoning,
                        native_type: "reasoning".into(),
                        function_call: None,
                        native: json!({"id":"r","type":"reasoning","summary":[],"encrypted_content":"synthetic-opaque 雪\r\n"}),
                    }],
                ),
            };
            if recovered {
                original.output_provenance = crate::OutputProvenance::ValidatedOutputItemDone;
                original.native["output"] = json!([]);
            }
            let mut plan = Plan::new(rig.input("exact prepared"), vec![]);
            plan.steps = vec![Step::Deltas(original.clone(), 135)];
            rig.record(plan).await;
            let prepared = rig.prepare().await;
            assert_eq!(prepared.included_exchange_count(), 1);
            let replay = prepared.replay();
            let restored = replay.runs()[0].exchanges()[0].response();
            assert_eq!(value(restored), value(&original));
            assert_eq!(restored.model.as_deref(), Some("observed-model-version"));
            assert_eq!(
                value(&serde_json::from_value::<ConversationReplay>(value(&replay)).unwrap()),
                value(&replay)
            );
            rig.store.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn p1b2_29_deleted_s1_s2_sources_replay_only_stored_prepared_prompt_and_results() {
    let rig = Rig::new().await;
    let workspace = rig.temp.path().join("workspace");
    let local = workspace.join(".agents/skills/local");
    let global = rig.temp.path().join("global/local");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::create_dir_all(&global).unwrap();
    std::fs::write(
        local.join("SKILL.md"),
        "---\nname: local\ndescription: local instructions\n---\nproject body 雪\r\n",
    )
    .unwrap();
    std::fs::write(
        global.join("SKILL.md"),
        "---\nname: local\ndescription: global instructions\n---\nglobal body\r\n",
    )
    .unwrap();
    std::fs::write(local.join("inert.sh"), "exit 99").unwrap();
    let catalog = crate::context::discover(crate::context::ContextRoots {
        workspace: workspace.clone(),
        global_skills: rig.temp.path().join("global"),
    })
    .unwrap();
    let request = rig.input("new user task").prepared_request().clone();
    let (prepared, tools) = crate::context::prepare_run_with_skill_loading(
        request,
        Arc::new(catalog),
        &["global:local".parse().unwrap()],
        &ToolRegistry::new(),
    )
    .unwrap();
    let input =
        crate::storage::RecordedRunInput::capture("new user task".into(), &prepared, &tools)
            .unwrap();
    let prompt = input.prepared_request().prompt.clone();
    let mut load = call("load", json!({"id":"project:local"}));
    load.function_call.as_mut().unwrap().name = "load_skill".into();
    load.native["name"] = json!("load_skill");
    produce(
        &rig.session,
        &tools,
        rig.counters.clone(),
        Plan::new(
            input,
            vec![
                response("load-response", vec![load]),
                response("done", vec![]),
            ],
        ),
        CancellationToken::new(),
    )
    .await;
    let before = rig.prepare().await;
    std::fs::remove_dir_all(workspace).unwrap();
    std::fs::remove_dir_all(rig.temp.path().join("global")).unwrap();
    drop(tools);
    let after = rig.prepare().await;
    assert_eq!(value(&before.replay()), value(&after.replay()));
    let replay = after.replay();
    assert_eq!(replay.runs()[0].prepared_prompt(), prompt);
    assert!(prompt.contains("global body"));
    let InputItem::ToolResult { output, .. } = &replay.runs()[0].exchanges()[0].tool_results()[0]
    else {
        panic!("result")
    };
    assert_eq!(
        serde_json::from_str::<Value>(output).unwrap()["body"],
        "project body 雪\r\n"
    );
    assert_eq!(
        serde_json::from_str::<Value>(output).unwrap()["id"],
        "project:local"
    );
    rig.store.close().await.unwrap();
}
