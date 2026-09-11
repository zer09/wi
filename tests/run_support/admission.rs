use super::run_support::*;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use wi::{run::*, tools::ToolRegistry, *};

#[tokio::test]
async fn run_preadmission_rejects_without_observation_or_work() {
    for case in 0..14 {
        let mut script = Script::new(vec![]);
        let mut req = request();
        let token = CancellationToken::new();
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(wi::tools::AddNumbers)).unwrap();
        match case {
            0 => req.prompt.clear(),
            1 => req.prompt = "x".repeat(MAX_INPUT_BYTES),
            2 => req.options.tools = tools.definitions(),
            3 => req.provider_id = "absent".into(),
            4 => script.capabilities.websocket.implemented = false,
            5 => {
                req.options.transport = Transport::Sse;
                script.capabilities.sse.implemented = false;
            }
            6 => script.capabilities.function_tools.implemented = false,
            7 => token.cancel(),
            8 => req.options.model.clear(),
            9 => req.options.instructions = "x".repeat(MAX_INPUT_BYTES),
            10..=13 => {
                req.options.required_features = vec![
                    [
                        Feature::NativeSteering,
                        Feature::ToolSearch,
                        Feature::ProgrammaticTools,
                        Feature::AsyncTools,
                    ][case - 10],
                ]
            }
            _ => unreachable!(),
        }
        let records = script.records.clone();
        let mut gateway = Gateway::new();
        gateway.register(Arc::new(script)).unwrap();
        assert!(
            run(&gateway, req, &tools, token, |_| panic!(
                "preadmission event case {case}"
            ))
            .await
            .is_err()
        );
        assert_eq!(count(&records.opens), 0);
        assert_eq!(count(&records.attempts), 0);
    }
    let (gateway, script, _) = setup(vec![Step::Response(response("r1", vec![], "hello"))]);
    let (result, _) = observed(&gateway, request(), &ToolRegistry::new()).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert!(script.records.options.lock().unwrap()[0].tools.is_empty());
}

#[tokio::test]
async fn run_preadmission_requires_continuation_for_tools_in_check_order() {
    for (transport, function_tools, expected) in [
        (false, false, "transport"),
        (true, false, "function_tools"),
        (true, true, "continuation"),
    ] {
        let (gateway, mut script, tools) = setup(vec![
            Step::Response(response("r1", vec![call("c1", 17, 25)], "")),
            Step::Response(response("r2", vec![], "42")),
        ]);
        drop(gateway);
        let capabilities = &mut Arc::get_mut(&mut script).unwrap().capabilities;
        capabilities.websocket.implemented = transport;
        capabilities.function_tools.implemented = function_tools;
        capabilities.continuation.implemented = false;
        let records = script.records.clone();
        let mut gateway = Gateway::new();
        gateway.register(script).unwrap();
        let mut events = Vec::new();
        let result = run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |event| {
                events.push(event.clone());
                Ok(())
            },
        )
        .await;
        assert!(
            matches!(result, Err(GatewayError::UnsupportedFeature(feature)) if feature == expected)
        );
        assert!(events.is_empty());
        assert_eq!(count(&records.opens), 0);
        assert_eq!(count(&records.attempts), 0);
        assert_eq!(count(&records.tool_calls), 0);
    }
}

#[tokio::test]
async fn run_text_only_does_not_require_continuation_or_function_tools() {
    let mut script = Script::new(vec![Step::Response(response("r1", vec![], "hello"))]);
    script.capabilities.continuation.implemented = false;
    script.capabilities.function_tools.implemented = false;
    let records = script.records.clone();
    let mut gateway = Gateway::new();
    gateway.register(Arc::new(script)).unwrap();
    let (result, events) = observed(&gateway, request(), &ToolRegistry::new()).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.last_response.as_ref().unwrap().text, "hello");
    assert_eq!(count(&records.attempts), 1);
    assert_eq!(count(&records.tool_calls), 0);
    assert!(records.options.lock().unwrap()[0].tools.is_empty());
    assert_eq!(count(&records.opens), 1);
    assert_eq!(count(&records.closes), 1);
    assert!(result.events_complete);
    assert_eq!(result.sink_error, None);
    assert_eq!(trace(&events).first(), Some(&"run_started"));
    assert_eq!(trace(&events).last(), Some(&"run_finished"));
}

#[tokio::test]
async fn run_invalid_snapshot_definition_is_checked_once_before_open() {
    let (gateway, script, _) = setup(vec![]);
    let tool = ProbeTool::new(Mode::InvalidDefinition);
    let mut tools = ToolRegistry::new();
    tools.register(tool.clone()).unwrap();
    assert!(
        run(
            &gateway,
            request(),
            &tools,
            CancellationToken::new(),
            |_| panic!("no event")
        )
        .await
        .is_err()
    );
    assert_eq!(count(&tool.definitions), 2);
    assert_eq!(count(&tool.calls), 0);
    assert_eq!(count(&script.records.opens), 0);
}
