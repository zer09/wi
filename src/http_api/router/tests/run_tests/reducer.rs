use super::*;
use crate::{
    CallOrigin, DeltaKind, FunctionCall, ItemKind, OutputItem, http_api::dto::EventView,
    run::RunOutcome, storage::StoredEventPayload,
};
use futures_util::StreamExt;
use std::collections::BTreeMap;

const DRAFT: &str = "draft 雪\r\n";
const TAIL: &str = "tail 🦀\n";
const SNAPSHOT: &str = "item snapshot 雪\r\n";
const RICH: &str = "authoritative 雪\r\nanswer\n";
const REFUSAL: &str = "断り\n";
const REASON: &str = "理由 🦀\r\n";
const FALLBACK: &str = "normalized fallback 雪\n二\r\n";

type BlockKey = (Option<u64>, Option<u64>, String);

#[derive(Clone, Debug, Default, PartialEq)]
struct ProvisionalItem {
    snapshot: Option<Value>,
    deltas: BTreeMap<BlockKey, String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct ResponseState {
    items: BTreeMap<(u64, String), ProvisionalItem>,
    authoritative: Option<Value>,
}
impl ResponseState {
    fn rendered(&self) -> Vec<String> {
        let Some(response) = &self.authoritative else {
            return Vec::new();
        };
        let blocks: Vec<String> = response["items"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|item| item["content"].as_array().unwrap())
            .map(|block| block["text"].as_str().unwrap().to_owned())
            .collect();
        // Normalized text is an alternative, not another copy of the rich answer.
        if blocks.is_empty() && response["text"] != "" {
            return vec![response["text"].as_str().unwrap().to_owned()];
        }
        blocks
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct ReferenceReducer {
    seen: BTreeMap<(String, u64), Value>,
    users: BTreeMap<String, String>,
    statuses: BTreeMap<String, String>,
    results: BTreeMap<String, Value>,
    responses: BTreeMap<(String, String), ResponseState>,
    tools: BTreeMap<(String, String), (String, bool)>,
    reused: Vec<(String, String)>,
}
impl ReferenceReducer {
    fn apply(&mut self, view: &EventView) {
        // Read the real browser shape without adding getters to production DTOs.
        let event = serde_json::to_value(view).unwrap();
        let cursor = (view.session_id().to_string(), view.sequence());
        if let Some(previous) = self.seen.get(&cursor) {
            assert_eq!(previous, &event, "conflicting canonical duplicate");
            return;
        }
        self.seen.insert(cursor, event.clone());
        let Some(run) = event["run_id"].as_str().map(str::to_owned) else {
            return;
        };
        let data = &event["data"];
        match event["kind"].as_str().unwrap() {
            "run.accepted" => {
                let text = data["user_text"].as_str().unwrap();
                assert_eq!(self.users.entry(run.clone()).or_insert(text.into()), text);
                self.statuses.insert(run, "accepted".into());
            }
            "run.started" => {
                self.statuses.insert(run, "running".into());
            }
            "response.started" => {
                self.responses
                    .entry((run, data["response_id"].as_str().unwrap().into()))
                    .or_default();
            }
            "response.delta" | "response.item.started" | "response.item.finished" => {
                let response = self
                    .responses
                    .entry((run, data["response_id"].as_str().unwrap().into()))
                    .or_default();
                let index = decimal(&data["output_index"]).unwrap();
                if event["kind"] == "response.delta" {
                    let item = response
                        .items
                        .entry((index, data["item_id"].as_str().unwrap().into()))
                        .or_default();
                    let block = (
                        decimal(&data["content_index"]),
                        decimal(&data["summary_index"]),
                        data["kind"].as_str().unwrap().into(),
                    );
                    item.deltas
                        .entry(block)
                        .or_default()
                        .push_str(data["delta"].as_str().unwrap());
                } else {
                    // A snapshot discards the matching item's provisional fragments.
                    response.items.insert(
                        (index, data["item"]["item_id"].as_str().unwrap().into()),
                        ProvisionalItem {
                            snapshot: Some(data["item"].clone()),
                            ..Default::default()
                        },
                    );
                }
            }
            "response.finished" => {
                self.responses.insert(
                    (run, data["response_id"].as_str().unwrap().into()),
                    ResponseState {
                        authoritative: Some(data.clone()),
                        ..Default::default()
                    },
                );
            }
            "run.finished" | "run.result" => {
                self.statuses.insert(
                    run.clone(),
                    data["outcome"]["type"].as_str().unwrap().into(),
                );
                if event["kind"] == "run.result" {
                    self.results.insert(run, data.clone());
                }
            }
            "tool.result" => {
                let key = (run, data["call_id"].as_str().unwrap().into());
                assert!(
                    self.tools
                        .insert(
                            key,
                            (
                                data["output"].as_str().unwrap().into(),
                                data["is_error"].as_bool().unwrap(),
                            ),
                        )
                        .is_none()
                );
            }
            "tool.reused" => {
                let key = (run, data["call_id"].as_str().unwrap().into());
                assert!(self.tools.contains_key(&key));
                self.reused.push(key);
            }
            _ => {}
        }
    }
}

fn decimal(value: &Value) -> Option<u64> {
    value.as_str().map(|text| text.parse().unwrap())
}

fn message(id: &str, text: &str) -> OutputItem {
    OutputItem {
        id: Some(id.into()),
        kind: ItemKind::Message,
        native_type: "message".into(),
        function_call: None,
        native: json!({"content":[{"type":"output_text","text":text}]}),
    }
}

fn responses() -> Vec<ModelResponse> {
    let calls: Vec<_> = [("sum", 20), ("overflow", i64::MAX)]
        .into_iter()
        .map(|(id, a)| OutputItem {
            id: Some(id.into()),
            kind: ItemKind::FunctionCall,
            native_type: "function_call".into(),
            function_call: Some(FunctionCall {
                call_id: id.into(),
                name: "add_numbers".into(),
                arguments: json!({"a":a,"b":22}).to_string(),
                origin: CallOrigin::Direct,
                namespace: None,
                complete: true,
            }),
            native: json!({"private":"private-native-canary"}),
        })
        .collect();
    let mut rich = model("rich");
    rich.text = RICH.into();
    let mut answer = message("shared-item", RICH);
    answer.native["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"refusal","refusal":REFUSAL}));
    rich.output = vec![
        answer,
        OutputItem {
            id: Some("other-item".into()),
            kind: ItemKind::Reasoning,
            native_type: "reasoning".into(),
            function_call: None,
            native: json!({"summary":[{"type":"summary_text","text":REASON}]}),
        },
    ];
    rich.output.extend(calls.clone());
    let mut reuse = model("reuse");
    reuse.text.clear();
    reuse.output = calls;
    let mut fallback = model("fallback");
    fallback.text = FALLBACK.into();
    let mut opaque = message("shared-item", "");
    opaque.native = json!({"content":[{"type":"unknown","private":"private-native-canary"}]});
    fallback.output = vec![opaque];
    vec![rich, reuse, fallback]
}

fn streamed_items(response_id: &str) -> Vec<ProviderEvent> {
    let mut events = Vec::new();
    for (index, id) in [(0, "shared-item"), (1, "other-item")] {
        events.push(ProviderEvent::OutputItemStarted {
            response_id: response_id.into(),
            output_index: index,
            item: message(id, ""),
        });
    }
    for (index, id, text) in [
        (0, "shared-item", DRAFT),
        (1, "other-item", "別\n"),
        (0, "shared-item", TAIL),
    ] {
        events.push(ProviderEvent::OutputItemUpdated {
            response_id: response_id.into(),
            item_id: id.into(),
            output_index: index,
            content_index: Some(0),
            summary_index: None,
            kind: DeltaKind::Text,
            delta: text.into(),
        });
    }
    events.push(ProviderEvent::OutputItemFinished {
        response_id: response_id.into(),
        output_index: 0,
        item: message("shared-item", SNAPSHOT),
    });
    events
}

// Reuse the HTTP provider gates/control, but record real streaming events too.
struct Streamed(Arc<Script>);
#[async_trait]
impl Provider for Streamed {
    fn id(&self) -> &'static str {
        self.0.id()
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.0.capabilities()
    }
    fn validate_replay(
        &self,
        options: &SessionOptions,
        replay: &ConversationReplay,
        input: &[InputItem],
    ) -> crate::Result<()> {
        self.0.validate_replay(options, replay, input)
    }
    async fn open_session(&self, options: SessionOptions) -> crate::Result<ProviderSession> {
        let mut session = self.0.open_session(options).await?;
        let mut source = session.events;
        session.events = Box::pin(async_stream::stream! {
            let mut sequence = 0;
            while let Some(mut envelope) = source.next().await {
                let extra = match &envelope.event {
                    ProviderEvent::ResponseStarted { response_id } => streamed_items(response_id),
                    _ => Vec::new(),
                };
                for event in std::iter::once(envelope.event.clone()).chain(extra) {
                    sequence += 1;
                    envelope.sequence = sequence;
                    envelope.event_id = format!("stream-{sequence}");
                    envelope.event = event;
                    yield envelope.clone();
                }
            }
        });
        Ok(session)
    }
}

#[tokio::test]
async fn v1b_18_reference_reducer_uses_persisted_browser_events() {
    let (_, script) = Script::new(Mode::Good, responses());
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(Streamed(script.clone())))
        .unwrap();
    let server = Server::gateway(Arc::new(gateway)).await;
    let (temp, host) = server.stop_http().await;
    let server = Server::start_tools(temp, host, false, true).await;
    let mut reducer = ReferenceReducer::default();
    let mut counts = BTreeMap::<String, usize>::new();

    // Repeated provider response/item/call IDs must not merge different runs.
    for _ in 0..2 {
        // The reused fixture numbers each connection's scripted requests from zero.
        script.control.inputs.lock().unwrap().clear();
        let session = server.session().await;
        let body = command();
        let rid = run(&body);
        let run_key = rid.to_string();
        response(server.post(&path(&session), &body), 202).await;
        for _ in 0..3 {
            watchdog(script.control.waiting.notified()).await;
            script.control.release.notify_one();
        }
        let recorded = finished(&session, &body).await;
        let result = recorded.result().unwrap();
        assert_eq!(result.outcome, RunOutcome::Completed);
        assert_eq!(result.summary.new_tool_dispatches, 2);
        assert_eq!(result.summary.reused_results, 2);
        assert_eq!(result.last_response.as_ref().unwrap().text, FALLBACK);

        let page = session.history_page(0, None, 128).await.unwrap();
        assert!(!page.has_more());
        let views: Vec<_> = page.records().iter().map(EventView::from).collect();
        let browser = response(
            server.get(&format!(
                "/v1/sessions/{}/history?limit=128",
                session.session_id()
            )),
            200,
        )
        .await;
        assert_eq!(browser["events"], serde_json::to_value(&views).unwrap());
        for (stored, view) in page.records().iter().zip(&views) {
            assert_eq!(view.sequence(), stored.sequence());
            let event = serde_json::to_value(view).unwrap();
            assert_eq!(event["event_id"], stored.event_id().as_str());
            let kind = event["kind"].as_str().unwrap();
            *counts.entry(kind.into()).or_default() += 1;
            let data = &event["data"];
            let before = reducer.clone();
            reducer.apply(view);
            match kind {
                "run.accepted" => {
                    assert_eq!(reducer.users[&run_key], RAW);
                    assert_eq!(reducer.users.len(), before.users.len() + 1);
                }
                "response.delta" | "response.item.finished" | "response.finished" => {
                    let key = (
                        run_key.clone(),
                        data["response_id"].as_str().unwrap().into(),
                    );
                    let state = &reducer.responses[&key];
                    for (other, previous) in &before.responses {
                        if other != &key {
                            assert_eq!(&reducer.responses[other], previous);
                        }
                    }
                    if kind == "response.delta" {
                        let index = decimal(&data["output_index"]).unwrap();
                        let item_key = (index, data["item_id"].as_str().unwrap().into());
                        let block = (Some(0), None, "text".into());
                        let previous = before.responses[&key].items[&item_key]
                            .deltas
                            .get(&block)
                            .cloned()
                            .unwrap_or_default();
                        assert_eq!(
                            state.items[&item_key].deltas[&block],
                            previous + data["delta"].as_str().unwrap()
                        );
                        for (other, item) in &before.responses[&key].items {
                            if other != &item_key {
                                assert_eq!(&state.items[other], item);
                            }
                        }
                    } else if kind == "response.item.finished" {
                        let item_key = (0, "shared-item".into());
                        assert_eq!(
                            before.responses[&key].items[&item_key].deltas
                                [&(Some(0), None, "text".into())],
                            format!("{DRAFT}{TAIL}")
                        );
                        assert!(state.items[&item_key].deltas.is_empty());
                        assert_eq!(
                            state.items[&item_key].snapshot.as_ref(),
                            Some(&data["item"])
                        );
                        assert_eq!(data["item"]["content"][0]["text"], SNAPSHOT);
                        assert_eq!(
                            state.items[&(1, "other-item".into())],
                            before.responses[&key].items[&(1, "other-item".into())]
                        );
                    } else {
                        assert_eq!(before.responses[&key].items.len(), 2);
                        assert!(state.items.is_empty());
                        assert_eq!(state.authoritative.as_ref(), Some(data));
                        let expected = match key.1.as_str() {
                            "rich" => vec![RICH, REFUSAL, REASON],
                            "fallback" => {
                                assert_eq!(data["items"][0]["unsupported_content"], true);
                                vec![FALLBACK]
                            }
                            "reuse" => vec![],
                            _ => panic!("unexpected fixture response"),
                        };
                        assert_eq!(state.rendered(), expected);
                    }
                    assert_eq!(reducer.statuses[&run_key], "running");
                    assert!(!reducer.results.contains_key(&run_key));
                }
                "tool.result" => {
                    let StoredEventPayload::ToolResultRecorded(actual) = stored.payload() else {
                        panic!("tool result must come from canonical storage");
                    };
                    let key = (run_key.clone(), actual.call_id().to_owned());
                    assert_eq!(
                        reducer.tools[&key],
                        (actual.output().into(), actual.is_error())
                    );
                    let saved = session
                        .tool_result(rid.clone(), actual.call_id().into())
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(saved.output(), Some(actual.output()));
                    assert_eq!(saved.is_error(), Some(actual.is_error()));
                    let expected = if actual.call_id() == "sum" {
                        ("{\"sum\":42}".into(), false)
                    } else {
                        ("{\"error\":{\"code\":\"gateway_error\"}}".into(), true)
                    };
                    assert_eq!(reducer.tools[&key], expected);
                }
                "tool.reused" => {
                    let key = (run_key.clone(), data["call_id"].as_str().unwrap().into());
                    assert!(before.tools.contains_key(&key));
                    assert_eq!(reducer.reused.last(), Some(&key));
                    assert_eq!(reducer.tools, before.tools);
                }
                "run.finished" | "run.result" => {
                    assert_eq!(reducer.responses, before.responses);
                    assert_eq!(reducer.users, before.users);
                    assert_eq!(reducer.tools, before.tools);
                    assert_eq!(reducer.statuses[&run_key], "completed");
                    assert_eq!(reducer.results.contains_key(&run_key), kind == "run.result");
                    if kind == "run.result" {
                        assert_eq!(&reducer.results[&run_key], data);
                        assert!(data.get("last_response").is_none());
                    }
                }
                _ => {}
            }
            let applied = reducer.clone();
            reducer.apply(view);
            assert_eq!(
                reducer, applied,
                "replayed record must be applied only once"
            );
        }
    }
    for (kind, expected) in [
        ("run.accepted", 2),
        ("response.delta", 18),
        ("response.item.finished", 6),
        ("response.finished", 6),
        ("run.finished", 2),
        ("run.result", 2),
        ("tool.started", 4),
        ("tool.finished", 4),
        ("tool.result", 4),
        ("tool.reused", 4),
    ] {
        assert_eq!(counts[kind], expected, "{kind}");
    }
    assert_eq!(reducer.users.len(), 2);
    assert_eq!(reducer.responses.len(), 6);
    assert_eq!(reducer.tools.len(), 4);
    assert_eq!(count(&script.opens), 2);
    server.finish().await;
}
