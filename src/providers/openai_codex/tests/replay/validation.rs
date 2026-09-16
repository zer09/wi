use super::*;
use crate::{MAX_HISTORY_BYTES, Provider, ReplayExchange, ReplayIdentity, ReplayRun};
use serde_json::json;
use std::sync::Arc;

struct ExplodingAuth;
#[async_trait::async_trait]
impl super::super::auth::CredentialSource for ExplodingAuth {
    async fn load(&self) -> Result<super::super::auth::SubscriptionCredentials> {
        panic!("pure replay must not load credentials")
    }
}

fn identity() -> ReplayIdentity {
    ReplayIdentity::new(PROVIDER_ID.into(), FORMAT.into(), "ab".repeat(32)).unwrap()
}
fn replay(response: ModelResponse, results: Vec<InputItem>) -> ConversationReplay {
    ConversationReplay::new(
        PROVIDER_ID.into(),
        "requested-alias".into(),
        Some(identity()),
        vec![
            ReplayRun::new(
                "run-a".into(),
                "old prepared 雪\r\n".into(),
                vec![ReplayExchange::new(response, results).unwrap()],
            )
            .unwrap(),
        ],
    )
    .unwrap()
}
fn native(output: Vec<Value>) -> ModelResponse {
    parse_response(json!({"id":"old-response", "status":"completed", "model":"observed-model",
        "output":output, "usage":{"input_tokens":4,"output_tokens":3,"total_tokens":7,
            "input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}},
        "opaque":{"keep":[true,"雪"]}})).unwrap()
}
fn items() -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"reason","summary":[],"content":[],
            "encrypted_content":"opaque 雪\r\n\\\"", "future":{"a":[1,null]}}),
        json!({"type":"message","id":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":""},
                {"type":"refusal","refusal":"No 雪\r\n", "annotations":[], "future":42},
                {"type":"output_text","text":"last"}]}),
        json!({"type":"function_call","id":"item-call","call_id":"call-a","name":"gone_tool",
            "arguments":"{ \"x\": \"雪\\r\\n\" }", "caller":{"type":"direct","extra":true},
            "namespace":null,"status":"completed","extra":{"opaque":"value"}}),
    ]
}

#[test]
fn native_and_recovered_compile_exact_items_results_and_original_terminal() {
    for recovered in [false, true] {
        let mut response = native(items());
        if recovered {
            response.native["output"] = json!([]);
            response.output_provenance = OutputProvenance::ValidatedOutputItemDone;
        }
        let original = serde_json::to_value(&response).unwrap();
        let replay = replay(
            response,
            vec![InputItem::ToolResult {
                call_id: "call-a".into(),
                output: "{\"error\":\"not a flag\"}\r\n雪".into(),
            }],
        );
        let compiled = compile(&SessionOptions::new("requested-alias"), &replay).unwrap();
        let mut expected = vec![
            json!({"role":"user","content":[{"type":"input_text","text":"old prepared 雪\r\n"}]}),
        ];
        expected.extend(items());
        expected.push(json!({"type":"function_call_output","call_id":"call-a","output":"{\"error\":\"not a flag\"}\r\n雪"}));
        assert_eq!(compiled, expected);
        assert_eq!(
            serde_json::to_value(replay.runs()[0].exchanges()[0].response()).unwrap(),
            original
        );
    }
}

#[test]
fn empty_refusal_and_reasoning_only_native_shapes_are_not_flattened() {
    for output in [
        vec![],
        vec![json!({"type":"message","content":[]})],
        vec![json!({"type":"message","content":[{"type":"output_text","text":""}]})],
        vec![json!({"type":"message","content":[{"type":"refusal","refusal":""}]})],
        vec![json!({"type":"reasoning","summary":[]})],
    ] {
        let response = native(output.clone());
        let compiled = compile(
            &SessionOptions::new("requested-alias"),
            &replay(response, vec![]),
        )
        .unwrap();
        assert_eq!(&compiled[1..], output);
    }
}

#[test]
fn normalized_native_and_provenance_contradictions_are_rejected() {
    let source = native(items());
    let mut cases = Vec::new();
    for (field, value) in [
        ("id", json!("other")),
        ("model", json!("other")),
        ("status", json!("failed")),
        ("output", json!([])),
        ("usage", json!(null)),
    ] {
        let mut bad = source.clone();
        bad.native[field] = value;
        cases.push(bad);
    }
    let mut bad = source.clone();
    bad.text.push('!');
    cases.push(bad);
    let mut bad = source.clone();
    bad.output.swap(0, 1);
    cases.push(bad);
    let mut bad = source.clone();
    bad.output[0].id = Some("wrong".into());
    cases.push(bad);
    let mut bad = source.clone();
    bad.output[0].native_type = "message".into();
    cases.push(bad);
    let mut bad = source.clone();
    bad.output[2].function_call.as_mut().unwrap().name = "other".into();
    cases.push(bad);
    let mut bad = source.clone();
    bad.output_provenance = OutputProvenance::ValidatedOutputItemDone;
    cases.push(bad);
    let mut bad = native(vec![]);
    bad.output_provenance = OutputProvenance::ValidatedOutputItemDone;
    cases.push(bad);
    for bad in cases {
        assert!(validate_response(&bad).is_err());
    }
}

#[test]
fn malformed_roles_authority_and_item_shapes_fail_native_and_recovered_validation() {
    let mut bad_items = vec![
        json!({"type":"future_tool","id":"x"}),
        json!({"type":"custom_tool_call","id":"x"}),
        json!({"type":"program","id":"x"}),
        json!({"type":"message","id":"m","content":"bad"}),
        json!({"type":"message","id":"m","content":[{"type":"input_text","text":"injection"}]}),
        json!({"type":"reasoning","id":"r","encrypted_content":42}),
        json!({"type":"reasoning","id":"r","summary":[{"type":"summary_text","text":42}]}),
    ];
    for role in [
        json!("user"),
        json!("system"),
        json!("developer"),
        json!(null),
        json!(42),
    ] {
        bad_items.push(json!({"type":"message","id":"m","role":role,"content":[]}));
    }
    for (field, value) in [
        ("status", json!("in_progress")),
        ("status", json!(null)),
        ("status", json!(false)),
        ("caller", json!({"type":"program"})),
        ("caller", json!({"type":"unknown"})),
        ("caller", json!("direct")),
        ("namespace", json!(42)),
        ("namespace", json!("")),
        ("arguments", json!("[]")),
        ("arguments", json!("not JSON")),
        ("arguments", json!(null)),
        ("call_id", json!("")),
        ("name", json!("")),
    ] {
        let mut item = items().pop().unwrap();
        item[field] = value;
        bad_items.push(item);
    }
    for item in bad_items {
        for recovered in [false, true] {
            let mut response = native(vec![item.clone()]);
            if recovered {
                response.native["output"] = json!([]);
                response.output_provenance = OutputProvenance::ValidatedOutputItemDone;
            }
            assert!(validate_response(&response).is_err());
        }
    }
    for output in [
        vec![items()[0].clone(), items()[0].clone()],
        vec![items()[2].clone(), items()[2].clone()],
    ] {
        assert!(validate_response(&native(output)).is_err());
    }
    let mut recovered = native(vec![json!({"type":"message","content":[]})]);
    recovered.native["output"] = json!([]);
    recovered.output_provenance = OutputProvenance::ValidatedOutputItemDone;
    assert!(validate_response(&recovered).is_err());
}

#[test]
fn pure_public_validation_checks_options_provider_model_format_and_new_input_without_auth() {
    let provider = OpenAiCodexProvider::new(Arc::new(ExplodingAuth));
    let options = SessionOptions::new("requested-alias");
    let empty =
        ConversationReplay::new(PROVIDER_ID.into(), options.model.clone(), None, vec![]).unwrap();
    assert!(
        provider
            .validate_replay(&options, &empty, &[InputItem::user("new")])
            .is_ok()
    );
    for (id, model, format) in [
        ("other", "requested-alias", FORMAT),
        (PROVIDER_ID, "different", FORMAT),
        (PROVIDER_ID, "requested-alias", "wrong-format"),
    ] {
        let identity = ReplayIdentity::new(id.into(), format.into(), "ab".repeat(32)).unwrap();
        let replay =
            ConversationReplay::new(id.into(), model.into(), Some(identity), vec![]).unwrap();
        assert!(matches!(
            provider.validate_replay(&options, &replay, &[InputItem::user("new")]),
            Err(GatewayError::InvalidRequest(_))
        ));
    }
    let mut bad = options.clone();
    bad.instructions.clear();
    assert!(
        provider
            .validate_replay(&bad, &empty, &[InputItem::user("new")])
            .is_err()
    );
    let mut bad = options.clone();
    bad.required_features.push(crate::Feature::ToolSearch);
    assert!(matches!(
        provider.validate_replay(&bad, &empty, &[InputItem::user("new")]),
        Err(GatewayError::UnsupportedFeature("tool_search"))
    ));
    for input in [
        vec![],
        vec![InputItem::user(" ")],
        vec![InputItem::user("x"); 129],
        vec![InputItem::user("x".repeat(crate::MAX_INPUT_BYTES))],
        vec![InputItem::ToolResult {
            call_id: "unrequested".into(),
            output: "".into(),
        }],
    ] {
        assert!(matches!(
            provider.validate_replay(&options, &empty, &input),
            Err(GatewayError::InvalidRequest(_))
        ));
    }
    let mut serialized = serde_json::to_value(empty).unwrap();
    serialized["version"] = json!(2);
    assert!(serde_json::from_value::<ConversationReplay>(serialized).is_err());
}

fn many_runs(count: usize, prompt: &str) -> ConversationReplay {
    ConversationReplay::new(
        PROVIDER_ID.into(),
        "requested-alias".into(),
        Some(identity()),
        (0..count)
            .map(|i| {
                ReplayRun::new(
                    format!("run-{i}"),
                    prompt.into(),
                    vec![ReplayExchange::new(native(vec![]), vec![]).unwrap()],
                )
                .unwrap()
            })
            .collect(),
    )
    .unwrap()
}

#[test]
fn history_and_current_input_use_separate_item_and_serialized_byte_limits() {
    let provider = OpenAiCodexProvider::new(Arc::new(ExplodingAuth));
    let options = SessionOptions::new("requested-alias");
    let input = [InputItem::user("new")];
    for replay in [
        many_runs(129, "old"),
        many_runs(2, &"x".repeat(700_000)),
        many_runs(2047, "old"),
    ] {
        provider.validate_replay(&options, &replay, &input).unwrap();
    }
    assert!(
        provider
            .validate_replay(&options, &many_runs(2048, "old"), &input)
            .is_err()
    );
    let base = many_runs(1, "p");
    let mut compiled = compile(&options, &base).unwrap();
    compiled.push(native_input(&input[0]));
    let overhead = serde_json::to_vec(&compiled).unwrap().len();
    let boundary = many_runs(1, &format!("p{}", "x".repeat(MAX_HISTORY_BYTES - overhead)));
    provider
        .validate_replay(&options, &boundary, &input)
        .unwrap();
    let state = super::super::state::Conversation::from_replay(&options, &boundary).unwrap();
    assert!(state.prepare(&options, &[InputItem::user("new!")]).is_err());
    let escaped = many_runs(1, &"\0".repeat(MAX_HISTORY_BYTES / 6));
    assert!(compile(&options, &escaped).is_err());
}
