use super::*;

#[tokio::test]
async fn incomplete_response_never_executes() {
    let mut r = single_call::registry();
    let mut events = vec![];
    assert!(
        r.execute_response(
            &single_call::response(ResponseOutcome::Incomplete {
                reason: Some("max_output_tokens".into())
            }),
            |e| events.push(e)
        )
        .await
        .is_err()
    );
    assert!(events.is_empty());
}

#[tokio::test]
async fn invalid_json_never_executes() {
    let mut r = single_call::registry();
    let mut resp = single_call::response(ResponseOutcome::Completed);
    resp.output[0].function_call.as_mut().unwrap().arguments = "{\"a\":".into();
    assert!(matches!(
        r.execute_response(&resp, |_| {}).await,
        Err(GatewayError::InvalidToolArguments)
    ));
}

#[test]
fn unknown_fields_and_non_integers_are_rejected() {
    assert!(
        AddNumbers
            .validate(&json!({"a":2,"b":3,"shell":"rm"}))
            .is_err()
    );
    assert!(AddNumbers.validate(&json!({"a":2.5,"b":3})).is_err());
    assert!(AddNumbers.validate(&json!({"a":2})).is_err());
}

#[tokio::test]
async fn unknown_tool_fails_before_any_execution() {
    let mut r = single_call::registry();
    let mut resp = single_call::response(ResponseOutcome::Completed);
    let mut second = resp.output[0].clone();
    second.function_call.as_mut().unwrap().call_id = "call2".into();
    second.function_call.as_mut().unwrap().name = "bash".into();
    resp.output.push(second);
    let mut events = vec![];
    assert!(r.execute_response(&resp, |e| events.push(e)).await.is_err());
    assert!(events.is_empty());
}

#[tokio::test]
async fn duplicate_call_ids_rejected_before_execution() {
    let mut r = single_call::registry();
    let mut resp = single_call::response(ResponseOutcome::Completed);
    resp.output.push(resp.output[0].clone());
    assert!(
        r.execute_response(&resp, |_| panic!("must not execute"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn programmatic_call_is_preserved_but_not_executed() {
    let mut r = single_call::registry();
    let mut resp = single_call::response(ResponseOutcome::Completed);
    resp.output[0].function_call.as_mut().unwrap().origin = CallOrigin::Programmatic;
    assert!(matches!(
        r.execute_response(&resp, |_| {}).await,
        Err(GatewayError::UnsupportedOutput)
    ));
}

#[tokio::test]
async fn assembled_native_namespace_rejects_batch_without_results_or_cache() {
    for namespace in [
        json!({"name":"unsupported"}),
        json!(7),
        json!("unsupported"),
    ] {
        let mut r = single_call::registry();
        let mut resp = single_call::response(ResponseOutcome::Completed);
        let mut second = resp.output[0].clone();
        second.function_call.as_mut().unwrap().call_id = "call2".into();
        second.native = json!({"namespace":namespace});
        resp.output.push(second);
        let mut events = vec![];
        assert!(matches!(
            r.execute_response(&resp, |e| events.push(e)).await,
            Err(GatewayError::UnsupportedOutput)
        ));
        assert!(events.is_empty());
        assert!(r.results.is_empty());
    }
}

#[tokio::test]
async fn whole_batch_authority_rejects_before_dispatch_or_reuse() {
    // Status/caller native forms are normalized by the adapter. Its inherited
    // decoded_status_rejects_batch_without_execution_or_cache covers raw status.
    for cached_first in [false, true] {
        for variant in 0..22 {
            let (mut registry, calls) = registry();
            registry
                .execute_response(&response(&["saved"]), |_| {})
                .await
                .unwrap();
            let first = if cached_first { "saved" } else { "new" };
            let mut response = response(&[first, "bad"]);
            let item = &mut response.output[1];
            let call = item.function_call.as_mut().unwrap();
            match variant {
                0 => call.arguments = "{\"a\":".into(),
                1 => call.arguments = json!({"a":2,"b":3,"extra":4}).to_string(),
                2 => call.arguments = json!({"a":2.5,"b":3}).to_string(),
                3 => call.name = "unknown".into(),
                4 => call.call_id = first.into(),
                5 => {
                    call.call_id = "saved".into();
                    call.arguments = json!({"a":4,"b":3}).to_string();
                }
                6 => call.complete = false,
                7 => item.native = json!({"namespace":"unsupported"}),
                8 => item.native = json!({"namespace":{}}),
                9 => item.native = json!({"namespace":7}),
                10 => call.origin = CallOrigin::Programmatic,
                11 => call.origin = CallOrigin::Unknown,
                12 => item.kind = ItemKind::Unknown,
                13 => item.function_call = None,
                14 => call.call_id.clear(),
                15 => call.arguments = "[]".into(),
                16 => call.arguments = "null".into(),
                17 => call.arguments = " ".repeat(64 * 1024 + 1),
                18 => call.namespace = Some("namespace".into()),
                19 => {
                    call.call_id = "saved".into();
                    call.name = "other".into();
                }
                20 => call.arguments = json!({"a":2}).to_string(),
                21 => call.call_id = "x".repeat(513),
                _ => unreachable!(),
            }
            let result = registry
                .execute_response(&response, |_| panic!("rejected batch emitted an event"))
                .await;
            assert!(result.is_err(), "variant {variant}");
            assert_eq!(calls.lock().unwrap().len(), 1, "variant {variant}");
            assert_eq!(registry.results.len(), 1, "variant {variant}");
            assert!(registry.results.contains_key("saved"));
        }
    }
}

#[tokio::test]
async fn cached_calls_still_require_authority_and_schema() {
    for variant in 0..5 {
        let (mut registry, calls) = registry();
        registry
            .execute_response(&response(&["saved"]), |_| {})
            .await
            .unwrap();
        let mut response = response(&["new", "saved"]);
        let item = &mut response.output[1];
        let call = item.function_call.as_mut().unwrap();
        match variant {
            0 => call.complete = false,
            1 => call.origin = CallOrigin::Unknown,
            2 => item.native = json!({"namespace":7}),
            3 => call.arguments = json!({"a":2,"b":3,"extra":4}).to_string(),
            4 => call.arguments = "{\"a\":".into(),
            _ => unreachable!(),
        }
        assert!(
            registry
                .execute_response(&response, |_| panic!())
                .await
                .is_err()
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(registry.results.len(), 1);
    }
}

#[tokio::test]
async fn noncompleted_responses_reject_entire_batch() {
    for outcome in [
        ResponseOutcome::Incomplete { reason: None },
        ResponseOutcome::Failed,
        ResponseOutcome::Cancelled,
    ] {
        let (mut registry, calls) = registry();
        let mut response = response(&["one", "two"]);
        response.outcome = outcome;
        assert!(
            registry
                .execute_response(&response, |_| panic!())
                .await
                .is_err()
        );
        assert!(registry.results.is_empty());
        assert!(calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn ordinary_noncall_items_and_null_namespace_are_ignored() {
    let (mut registry, calls) = registry();
    let mut response = response(&["one", "two", "three"]);
    response.output[0].kind = ItemKind::Message;
    response.output[0].function_call = None;
    response.output[1].kind = ItemKind::Reasoning;
    response.output[1].function_call = None;
    response.output[2].native = json!({"namespace":null});
    let results = registry.execute_response(&response, |_| {}).await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(calls.lock().unwrap().len(), 1);
}
