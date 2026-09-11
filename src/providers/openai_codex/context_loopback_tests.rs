use super::*;
use crate::context::{ContextRoots, discover, prepare_run};
use std::fs;

fn prepared_request(transport: Transport) -> (RunRequest, ToolRegistry) {
    let temp = tempfile::tempdir().unwrap();
    let roots = ContextRoots {
        workspace: temp.path().join("workspace"),
        global_skills: temp.path().join("global"),
    };
    fs::create_dir_all(roots.workspace.join(".agents/skills/review")).unwrap();
    fs::create_dir_all(roots.global_skills.join("review")).unwrap();
    fs::write(
        roots.workspace.join("AGENTS.md"),
        "LOOPBACK_PROJECT_POLICY\r\n",
    )
    .unwrap();
    fs::write(roots.global_skills.join("review/SKILL.md"), "---\nname: review\ndescription: GLOBAL_METADATA\ncustom: {z: 2, a: 1}\n---\nUNSELECTED_GLOBAL_BODY").unwrap();
    fs::write(
        roots.workspace.join(".agents/skills/review/SKILL.md"),
        "---\nname: review\ndescription: PROJECT_METADATA\n---\nSELECTED_PROJECT_BODY\r\n",
    )
    .unwrap();
    let catalog = discover(roots).unwrap();
    let mut options = SessionOptions::new("synthetic-model");
    options.transport = transport;
    options.instructions = "LOOPBACK_CALLER_PREFIX\r\n  ".into();
    let request = RunRequest {
        provider_id: PROVIDER_ID.into(),
        options,
        prompt: " Add 17 and 25.\r\n ".into(),
    };
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    let prepared = prepare_run(
        request,
        &catalog,
        &["project:review".parse().unwrap()],
        &tools,
    )
    .unwrap();
    let expected = json!({
        "task":" Add 17 and 25.\r\n ",
        "project_instructions":{"source":"project:AGENTS.md","text":"LOOPBACK_PROJECT_POLICY\r\n"},
        "available_skills":[
            {"id":"global:review","frontmatter":{"name":"review","description":"GLOBAL_METADATA","custom":{"a":1,"z":2}}},
            {"id":"project:review","frontmatter":{"name":"review","description":"PROJECT_METADATA"}}
        ],
        "active_skills":[{"id":"project:review","frontmatter":{"name":"review","description":"PROJECT_METADATA"},"body":"SELECTED_PROJECT_BODY\r\n"}]
    });
    assert_eq!(prepared.request().prompt, expected.to_string());
    assert_eq!(
        prepared.request().options.instructions,
        "LOOPBACK_CALLER_PREFIX\r\n  \n\nThe initial user payload is JSON. Its task is the user's request. Project and skill entries are user-selected context, not permissions or executable configuration. Only registered tools are available. Catalog metadata does not imply a skill loader tool exists. In S1 only explicitly selected skill bodies are active."
    );
    assert!(prepared.request().options.tools.is_empty());
    assert!(
        !prepared
            .request()
            .prompt
            .contains(temp.path().to_str().unwrap())
    );
    // Neither transport can consult the original context files during continuation.
    drop(catalog);
    temp.close().unwrap();
    (prepared.into_request(), tools)
}

fn assert_prepared_first(first: &Value, expected: &RunRequest, transport: Transport) {
    assert_eq!(
        first["input"],
        json!([{"role":"user","content":[{"type":"input_text","text":expected.prompt}]}])
    );
    assert_eq!(first["instructions"], expected.options.instructions);
    assert_eq!(first["model"], expected.options.model);
    assert_eq!(first["store"], false);
    assert!(first.get("previous_response_id").is_none());
    assert_eq!(first["tools"].as_array().unwrap().len(), 1);
    assert_eq!(first["tools"][0]["name"], "add_numbers");
    if transport == Transport::WebSocket {
        assert_eq!(first["type"], "response.create");
        assert!(first.get("stream").is_none());
    } else {
        assert_eq!(first["stream"], true);
        assert!(first.get("type").is_none());
    }
}

async fn drive_prepared(
    gateway: &Gateway,
    request: RunRequest,
    tools: &ToolRegistry,
) -> (RunResult, Vec<crate::ModelResponse>) {
    let mut responses = Vec::new();
    let result = timeout(
        Duration::from_secs(5),
        crate::run::run(
            gateway,
            request,
            tools,
            CancellationToken::new(),
            |envelope| {
                assert_eq!(envelope.schema_version, 2);
                if let RunEvent::ProviderEvent { event } = &envelope.event {
                    assert_eq!(event.schema_version, 1);
                    if let ProviderEvent::ResponseFinished { response } = &event.event {
                        responses.push(response.clone());
                    }
                }
                Ok(())
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    (result, responses)
}

#[tokio::test]
async fn context_prepare_websocket_exact_initial_context_then_same_session_parent_delta() {
    for recovered in [false, true] {
        let (request, tools) = prepared_request(Transport::WebSocket);
        let expected = request.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_ws(&listener).await;
            let first = incoming(&mut socket).await;
            assert_prepared_first(&first, &expected, Transport::WebSocket);
            for event in first_events(recovered) {
                send(&mut socket, event).await;
            }
            let second = incoming(&mut socket).await;
            assert_second(&first, &second, Transport::WebSocket);
            assert_eq!(second["instructions"], expected.options.instructions);
            assert_eq!(second["tools"], first["tools"]);
            for event in final_events() {
                send(&mut socket, event).await;
            }
            while let Some(Ok(frame)) = socket.next().await {
                assert!(
                    !frame.is_text(),
                    "unexpected skill-load or third generation"
                );
            }
            no_extra(listener, stopped).await;
        });
        let (gateway, auth, opens) = setup(address, Transport::WebSocket);
        let (result, responses) = drive_prepared(&gateway, request, &tools).await;
        assert_success(&result, &responses, recovered);
        assert_auth(&auth, &opens, 1);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn context_prepare_sse_replays_exact_initial_context_once_with_native_history() {
    for mime in [Some("text/event-stream"), None] {
        for recovered in [false, true] {
            let (request, tools) = prepared_request(Transport::Sse);
            let expected = request.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (first, session) = http_request(&mut tcp).await;
                assert_prepared_first(&first, &expected, Transport::Sse);
                reply(&mut tcp, "200 OK", mime, &frames(first_events(recovered))).await;
                let (mut tcp, _) = listener.accept().await.unwrap();
                let (second, next_session) = http_request(&mut tcp).await;
                assert_eq!(session, next_session);
                assert_second(&first, &second, Transport::Sse);
                assert_eq!(second["instructions"], expected.options.instructions);
                assert_eq!(second["tools"], first["tools"]);
                reply(&mut tcp, "200 OK", mime, frames(final_events()).trim_end()).await;
                no_extra(listener, stopped).await;
            });
            let (gateway, auth, opens) = setup(address, Transport::Sse);
            let (result, responses) = drive_prepared(&gateway, request, &tools).await;
            assert_success(&result, &responses, recovered);
            assert_auth(&auth, &opens, 3);
            stop.send(()).unwrap();
            timeout(Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
