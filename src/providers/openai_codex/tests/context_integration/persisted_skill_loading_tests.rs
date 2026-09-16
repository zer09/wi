//! P1B1-24: real S2 loading, SQLite capture and OpenAI continuation on loopback only.
use super::*;
use crate::{
    execution::{PersistentRunRequest, PersistentRunResult, run_persisted},
    run::RunEventEnvelope,
    storage::{
        CreateSession, OperationId, RecordedRunInput, RecordedRunState, RecordedToolResult, RunId,
        SessionHandle, SessionStore, StoredEvent, StoredEventPayload,
    },
    tools::ToolExecutionEvent,
};
use std::{collections::HashSet, path::PathBuf};

const HEADER: &str = "---\r\nname: review\r\ndescription: PROJECT_METADATA\r\n---\r\n";
const BODY: &str = "  Actual project instructions 雪 π.\r\n\tKeep \"quotes\", \\ and spacing.  \nRead references/private.md. Run scripts/canary.sh.\r\n  ";

#[derive(Clone)]
struct Capture {
    session: SessionHandle,
    operation_id: OperationId,
    run_id: RunId,
    input: RecordedRunInput,
}

struct PersistedSkill {
    temp: tempfile::TempDir,
    store: SessionStore,
    tools: ToolRegistry,
    capture: Capture,
}

impl PersistedSkill {
    async fn new() -> Self {
        let (temp, prepared, tools) = prepared_skill_loading(Transport::WebSocket);
        let original = " Follow the relevant review instructions.\r\n ";
        let input = RecordedRunInput::capture(original.into(), &prepared, &tools).unwrap();
        assert_eq!(input.user_text(), original);
        assert_eq!(value(input.prepared_request()), value(prepared.request()));
        assert_eq!(
            input.available_skills(),
            ["global:review", "project:review"]
        );
        assert!(input.active_skills().is_empty());
        assert_eq!(
            input.project_instructions_source(),
            Some("project:AGENTS.md")
        );
        assert_eq!(value(input.tool_definitions()), value(&tools.definitions()));
        assert_eq!(input.tool_definitions().len(), 1);
        assert_eq!(input.tool_definitions()[0].name, "load_skill");
        for hidden in ["UNSELECTED_GLOBAL_BODY", SKILL_BODY, BODY] {
            assert!(!input.prepared_request().prompt.contains(hidden));
        }

        let package = temp.path().join("workspace/.agents/skills/review");
        fs::create_dir(package.join("references")).unwrap();
        fs::create_dir(package.join("scripts")).unwrap();
        fs::write(package.join("references/private.md"), "RESOURCE_CANARY").unwrap();
        let script = package.join("scripts/canary.sh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\ntouch '{}'\n# SCRIPT_CANARY\n",
                temp.path().join("executed").display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
        }
        // Acceptance must use the supplied snapshot, not reopen project instructions.
        fs::remove_file(temp.path().join("workspace/AGENTS.md")).unwrap();
        let store = SessionStore::open(temp.path().join("storage"))
            .await
            .unwrap();
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "synthetic S2".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let session = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        Self {
            temp,
            store,
            tools,
            capture: Capture {
                session,
                operation_id: OperationId::new(),
                run_id: RunId::new(),
                input,
            },
        }
    }

    fn main_file(&self) -> PathBuf {
        self.temp
            .path()
            .join("workspace/.agents/skills/review/SKILL.md")
    }

    fn assert_resources_inert(&self) {
        let package = self.main_file().parent().unwrap().to_owned();
        assert_eq!(
            fs::read_to_string(package.join("references/private.md")).unwrap(),
            "RESOURCE_CANARY"
        );
        assert!(
            fs::read_to_string(package.join("scripts/canary.sh"))
                .unwrap()
                .contains("SCRIPT_CANARY")
        );
        assert!(!self.temp.path().join("executed").exists());
    }

    async fn drive(&self, gateway: &Gateway) -> RunResult {
        let capture = &self.capture;
        let execution = run_persisted(
            gateway,
            &capture.session,
            PersistentRunRequest {
                operation_id: capture.operation_id.clone(),
                run_id: capture.run_id.clone(),
                input: capture.input.clone(),
            },
            &self.tools,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let PersistentRunResult::Executed {
            acceptance,
            final_record,
            result,
        } = execution
        else {
            panic!("new operation did not execute")
        };
        for receipt in [&acceptance, &final_record] {
            assert!(!receipt.duplicate());
            assert_eq!(receipt.cleanup_warning(), None);
            assert_eq!(receipt.receipt().session_id(), capture.session.session_id());
            assert_eq!(receipt.receipt().run_id(), Some(&capture.run_id));
            assert_eq!(
                capture
                    .session
                    .lookup_receipt(receipt.receipt().operation_id().clone())
                    .await
                    .unwrap()
                    .as_ref(),
                Some(receipt.receipt())
            );
        }
        assert_eq!(acceptance.receipt().operation_id(), &capture.operation_id);
        assert_eq!(
            (
                acceptance.receipt().first_sequence(),
                acceptance.receipt().last_sequence()
            ),
            (2, 2)
        );
        assert_ne!(final_record.receipt().operation_id(), &capture.operation_id);
        assert_eq!(result.run_id, capture.run_id.as_str());
        assert_ne!(
            result.session_id.as_deref(),
            Some(capture.session.session_id().as_str())
        );
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        let history = capture.history().await;
        let mut runtime_sequence = 0;
        let mut provider_sequence = 0;
        let mut event_ids = HashSet::new();
        for (index, record) in history.iter().enumerate() {
            assert_eq!(record.sequence(), index as u64 + 1);
            assert_eq!(record.schema_version(), 1);
            assert_eq!(record.event_version(), 1);
            assert_eq!(
                record.application_session_id(),
                capture.session.session_id()
            );
            if index > 0 {
                assert_eq!(record.run_id(), Some(&capture.run_id));
            }
            if let StoredEventPayload::RuntimeObserved(envelope) = record.payload() {
                runtime_sequence += 1;
                assert_eq!(envelope.sequence, runtime_sequence);
                assert_eq!(envelope.schema_version, 2);
                assert_eq!(envelope.run_id, result.run_id);
                assert!(uuid::Uuid::parse_str(&envelope.event_id).is_ok());
                assert!(event_ids.insert(&envelope.event_id));
                assert!(record.sequence() > envelope.sequence);
                if let Some(session_id) = &envelope.session_id {
                    assert_eq!(Some(session_id), result.session_id.as_ref());
                }
                if let RunEvent::ProviderEvent { event } = &envelope.event {
                    provider_sequence += 1;
                    assert_eq!(event.schema_version, 1);
                    assert_eq!(event.sequence, provider_sequence);
                    assert_eq!(event.provider, PROVIDER_ID);
                    assert_eq!(envelope.session_id.as_ref(), Some(&event.session_id));
                    assert_eq!(envelope.request_id, event.request_id);
                    assert!(envelope.request_id.is_some());
                    assert!(envelope.turn_id.is_some());
                }
            }
        }
        let StoredEventPayload::RunResultRecorded(saved) = history.last().unwrap().payload() else {
            panic!("missing actual returned result")
        };
        assert_eq!(value(saved), value(&result));
        assert_eq!(
            final_record.receipt().first_sequence(),
            history.len() as u64
        );
        assert_eq!(final_record.receipt().last_sequence(), history.len() as u64);
        assert!(matches!(&runtime(&history[history.len() - 2]).event,
            RunEvent::RunFinished { outcome, summary }
            if outcome == &result.outcome && value(summary) == value(&result.summary)));
        let run = capture
            .session
            .run_record(capture.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value(run.input()), value(&capture.input));
        assert_eq!(value(run.result().unwrap()), value(&result));
        assert_eq!(run.provider_session_id(), result.session_id.as_deref());
        assert_eq!(run.last_runtime_sequence(), runtime_sequence);
        assert_eq!(run.result_sequence(), Some(history.len() as u64));
        assert_eq!(
            value(run.terminal().unwrap()),
            value(&history[history.len() - 2])
        );
        let expected_state = if result.outcome == RunOutcome::Completed {
            RecordedRunState::Completed
        } else {
            RecordedRunState::Failed
        };
        assert_eq!(run.state(), expected_state);
        self.assert_resources_inert();
        *result
    }
}

impl Capture {
    async fn history(&self) -> Vec<StoredEvent> {
        let page = self.session.history_page(0, None, 100).await.unwrap();
        assert!(!page.has_more());
        page.records().to_vec()
    }

    async fn assert_first(&self, first: &Value) {
        assert_skill_first(first, self.input.prepared_request(), Transport::WebSocket);
        assert!(!first.to_string().contains("Actual project instructions"));
        let receipt = self
            .session
            .lookup_receipt(self.operation_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt.run_id(), Some(&self.run_id));
        assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (2, 2));
        let run = self
            .session
            .run_record(self.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.state(), RecordedRunState::Running);
        assert_eq!(run.accepted_sequence(), 2);
        assert_eq!(value(run.input()), value(&self.input));
        assert_eq!(
            first["prompt_cache_key"],
            run.provider_session_id().unwrap()
        );
        assert!(run.result().is_none());
        let history = self.history().await;
        let StoredEventPayload::RunAccepted(accepted) = history[1].payload() else {
            panic!("missing committed acceptance")
        };
        assert_eq!(accepted.run_id(), &self.run_id);
        assert_eq!(value(accepted.input()), value(&self.input));
        assert!(matches!(runtime(&history[2]).event, RunEvent::RunStarted));
        assert!(
            self.session
                .tool_result(self.run_id.clone(), "call-skill".into())
                .await
                .unwrap()
                .is_none()
        );
    }

    async fn committed_result(
        &self,
        output: &str,
        is_error: bool,
    ) -> (RecordedToolResult, Vec<StoredEvent>) {
        // These reads use independent SQL connections while the provider withholds its next response.
        let saved = self
            .session
            .tool_result(self.run_id.clone(), "call-skill".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.run_id(), &self.run_id);
        assert_eq!(saved.call_id(), "call-skill");
        assert_eq!(saved.tool_name(), "load_skill");
        assert_eq!(saved.output(), Some(output));
        assert_eq!(saved.is_error(), Some(is_error));
        let history = self.history().await;
        let terminal = response_finished(&history, "r1");
        let envelope = runtime(terminal);
        assert!(saved.request_id().is_some());
        assert_eq!(saved.request_id(), envelope.request_id.as_deref());
        assert!(terminal.sequence() < saved.started_sequence());
        assert!(saved.started_sequence() < saved.result_sequence().unwrap());
        assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
        let outputs: Vec<_> = history
            .iter()
            .filter(|record| matches!(record.payload(), StoredEventPayload::ToolResultRecorded(_)))
            .collect();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].sequence(), saved.result_sequence().unwrap());
        let StoredEventPayload::ToolResultRecorded(actual) = outputs[0].payload() else {
            unreachable!()
        };
        assert_eq!(actual.request_id(), saved.request_id());
        assert_eq!(actual.call_id(), saved.call_id());
        assert_eq!(actual.output(), output);
        assert_eq!(actual.is_error(), is_error);
        let events: Vec<_> = history
            .iter()
            .filter_map(|record| {
                let StoredEventPayload::RuntimeObserved(envelope) = record.payload() else {
                    return None;
                };
                let RunEvent::ToolEvent { event } = &envelope.event else {
                    return None;
                };
                if matches!(event, ToolExecutionEvent::ToolResultReused { .. }) {
                    return None;
                }
                Some((record.sequence(), envelope, event))
            })
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, saved.started_sequence());
        assert_eq!(events[1].0, saved.finished_sequence().unwrap());
        assert_eq!(
            value(events[0].2),
            value(&ToolExecutionEvent::ToolExecutionStarted {
                call_id: "call-skill".into(),
                tool_name: "load_skill".into()
            })
        );
        assert_eq!(
            value(events[1].2),
            value(&ToolExecutionEvent::ToolExecutionFinished {
                call_id: "call-skill".into(),
                tool_name: "load_skill".into(),
                is_error
            })
        );
        for (_, event, _) in events {
            assert_eq!(event.request_id, envelope.request_id);
            assert_eq!(event.turn_id, envelope.turn_id);
        }
        (saved, history)
    }
}

fn value(value: &(impl serde::Serialize + ?Sized)) -> Value {
    serde_json::to_value(value).unwrap()
}

fn runtime(record: &StoredEvent) -> &RunEventEnvelope {
    let StoredEventPayload::RuntimeObserved(envelope) = record.payload() else {
        panic!("missing runtime observation")
    };
    envelope
}

fn response_finished<'a>(history: &'a [StoredEvent], id: &str) -> &'a StoredEvent {
    history
        .iter()
        .find(|record| {
            matches!(record.payload(),
        StoredEventPayload::RuntimeObserved(envelope) if matches!(&envelope.event,
            RunEvent::ProviderEvent { event } if matches!(&event.event,
                ProviderEvent::ResponseFinished { response } if response.id == id)))
        })
        .unwrap()
}

fn assert_continuation(first: &Value, next: &Value, parent: &str, output: &str) {
    for field in [
        "prompt_cache_key",
        "instructions",
        "tools",
        "model",
        "store",
        "tool_choice",
    ] {
        assert_eq!(next[field], first[field]);
    }
    assert_eq!(next["type"], "response.create");
    assert!(next.get("stream").is_none());
    assert!(next.get("background").is_none());
    assert_eq!(next["previous_response_id"], parent);
    assert_eq!(
        next["input"],
        json!([{"type":"function_call_output", "call_id":"call-skill", "output":output}])
    );
}

#[tokio::test]
async fn p1b1_24_persisted_skill_load_commits_exact_bytes_then_reuses_after_deletion() {
    let fixture = PersistedSkill::new().await;
    let capture = fixture.capture.clone();
    let file = fixture.main_file();
    // Changing only the body after capture proves the result comes from the actual later read.
    fs::write(&file, format!("{HEADER}{BODY}")).unwrap();
    let expected = json!({"body":BODY, "frontmatter":{"name":"review", "description":"PROJECT_METADATA"}, "id":"project:review"}).to_string();
    assert!(expected.contains("\\r\\n"));
    assert!(expected.contains('雪'));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept_ws(&listener).await;
        let first = incoming(&mut socket).await;
        capture.assert_first(&first).await;
        for event in skill_events(false) {
            send(&mut socket, event).await;
        }
        let second = incoming(&mut socket).await;
        let (original, _) = capture.committed_result(&expected, false).await;
        assert_continuation(&first, &second, "r1", original.output().unwrap());
        // A second execution would now fail. Cache reuse must keep the original committed bytes.
        fs::remove_file(&file).unwrap();
        send(
            &mut socket,
            json!({"type":"response.created", "response":{"id":"r2"}}),
        )
        .await;
        send(&mut socket, terminal("r2", skill_output())).await;
        let third = incoming(&mut socket).await;
        let (reused, history) = capture.committed_result(&expected, false).await;
        assert_eq!(value(&reused), value(&original));
        assert!(!file.exists());
        assert_continuation(&first, &third, "r2", reused.output().unwrap());
        assert_eq!(third["input"], second["input"]);
        let second_terminal = response_finished(&history, "r2");
        let current = runtime(second_terminal);
        assert_ne!(current.request_id.as_deref(), original.request_id());
        assert_ne!(
            current.turn_id,
            runtime(response_finished(&history, "r1")).turn_id
        );
        let reuse: Vec<_> = history
            .iter()
            .filter(|record| {
                matches!(record.payload(),
            StoredEventPayload::RuntimeObserved(envelope) if matches!(&envelope.event,
                RunEvent::ToolEvent { event: ToolExecutionEvent::ToolResultReused { .. } }))
            })
            .collect();
        assert_eq!(reuse.len(), 1);
        assert!(original.finished_sequence().unwrap() < second_terminal.sequence());
        assert!(second_terminal.sequence() < reuse[0].sequence());
        assert_eq!(runtime(reuse[0]).request_id, current.request_id);
        assert_eq!(runtime(reuse[0]).turn_id, current.turn_id);
        assert!(matches!(&runtime(reuse[0]).event,
            RunEvent::ToolEvent { event: ToolExecutionEvent::ToolResultReused { call_id, tool_name } }
            if call_id == "call-skill" && tool_name == "load_skill"));
        for id in ["r1", "r2"] {
            let RunEvent::ProviderEvent { event } = &runtime(response_finished(&history, id)).event
            else {
                unreachable!()
            };
            let ProviderEvent::ResponseFinished { response } = &event.event else {
                unreachable!()
            };
            assert_eq!(response.native, terminal(id, skill_output())["response"]);
            assert_eq!(
                response
                    .output
                    .iter()
                    .map(|item| item.native.clone())
                    .collect::<Vec<_>>(),
                skill_output()
            );
        }
        send(
            &mut socket,
            json!({"type":"response.created", "response":{"id":"r3"}}),
        )
        .await;
        send(&mut socket, terminal("r3", vec![json!({"type":"message", "id":"answer", "content":[{"type":"output_text", "text":"42"}]})])).await;
        assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
        no_extra(listener, stopped).await;
    });
    let (gateway, auth, opens) = setup(address, Transport::WebSocket);
    let result = fixture.drive(&gateway).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.model_requests_attempted, 3);
    assert_eq!(result.summary.model_requests_admitted, 3);
    assert_eq!(result.summary.turns_started, 3);
    assert_eq!(result.summary.turns_finished, 3);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 2);
    assert_eq!(result.summary.reused_results, 1);
    assert_eq!(result.last_response.as_ref().unwrap().id, "r3");
    assert_eq!(result.last_response.as_ref().unwrap().text, "42");
    assert_auth(&auth, &opens, 1);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_24_persisted_skill_rejects_changed_frontmatter_with_committed_gateway_error() {
    let fixture = PersistedSkill::new().await;
    let capture = fixture.capture.clone();
    let file = fixture.main_file();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept_ws(&listener).await;
        let first = incoming(&mut socket).await;
        capture.assert_first(&first).await;
        // The accepted metadata is already committed. Only the real loader sees this change.
        fs::write(
            &file,
            format!(
                "{}{BODY}",
                HEADER.replace("PROJECT_METADATA", "CHANGED_METADATA")
            ),
        )
        .unwrap();
        for event in skill_events(false) {
            send(&mut socket, event).await;
        }
        let second = incoming(&mut socket).await;
        let (saved, history) = capture
            .committed_result("{\"error\":{\"code\":\"gateway_error\"}}", true)
            .await;
        assert_continuation(&first, &second, "r1", saved.output().unwrap());
        assert!(history.iter().any(|record| matches!(record.payload(),
            StoredEventPayload::RuntimeObserved(envelope) if matches!(&envelope.event,
                RunEvent::TurnFinished { number: 1, outcome: crate::run::TurnOutcome::ToolsPrepared, .. }))));
        assert!(
            fs::read_to_string(&file)
                .unwrap()
                .contains("CHANGED_METADATA")
        );
        send(
            &mut socket,
            json!({"type":"response.created", "response":{"id":"r2"}}),
        )
        .await;
        send(&mut socket, terminal("r2", vec![json!({"type":"message", "id":"answer", "content":[{"type":"output_text", "text":"Skill unavailable."}]})])).await;
        assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
        no_extra(listener, stopped).await;
    });
    let (gateway, auth, opens) = setup(address, Transport::WebSocket);
    let result = fixture.drive(&gateway).await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.turns_started, 2);
    assert_eq!(result.summary.turns_finished, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(result.summary.tool_results_prepared, 1);
    assert_eq!(result.summary.reused_results, 0);
    assert_eq!(result.last_response.as_ref().unwrap().id, "r2");
    assert_eq!(
        result.last_response.as_ref().unwrap().text,
        "Skill unavailable."
    );
    assert_auth(&auth, &opens, 1);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b1_24_persisted_skill_rejects_unqualified_id_before_any_batch_execution() {
    let fixture = PersistedSkill::new().await;
    let capture = fixture.capture.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut socket = accept_ws(&listener).await;
        let first = incoming(&mut socket).await;
        capture.assert_first(&first).await;
        let mut calls = skill_output();
        calls.push(json!({"type":"function_call", "id":"item-unqualified", "call_id":"unqualified", "name":"load_skill", "arguments":"{\"id\":\"review\"}", "status":"completed"}));
        send(
            &mut socket,
            json!({"type":"response.created", "response":{"id":"r1"}}),
        )
        .await;
        send(&mut socket, terminal("r1", calls)).await;
        assert!(matches!(socket.next().await, Some(Ok(Message::Close(_)))));
        no_extra(listener, stopped).await;
    });
    let (gateway, auth, opens) = setup(address, Transport::WebSocket);
    let result = fixture.drive(&gateway).await;
    assert_eq!(
        result.outcome,
        RunOutcome::Failed {
            code: "tool_preflight".into()
        }
    );
    assert_eq!(result.summary.model_requests_attempted, 1);
    assert_eq!(result.summary.model_requests_admitted, 1);
    assert_eq!(result.summary.turns_started, 1);
    assert_eq!(result.summary.turns_finished, 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
    assert_eq!(result.summary.tool_results_prepared, 0);
    assert_eq!(result.summary.reused_results, 0);
    let history = fixture.capture.history().await;
    assert!(history.iter().all(|record| match record.payload() {
        StoredEventPayload::ToolResultRecorded(_) => false,
        StoredEventPayload::RuntimeObserved(envelope) =>
            !matches!(envelope.event, RunEvent::ToolEvent { .. }),
        _ => true,
    }));
    for call in ["call-skill", "unqualified"] {
        assert!(
            fixture
                .capture
                .session
                .tool_result(fixture.capture.run_id.clone(), call.into())
                .await
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(
        fs::read_to_string(fixture.main_file()).unwrap(),
        format!("---\nname: review\ndescription: PROJECT_METADATA\n---\n{SKILL_BODY}")
    );
    assert_auth(&auth, &opens, 1);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    fixture.store.close().await.unwrap();
}
