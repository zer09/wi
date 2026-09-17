use super::*;
use crate::execution::tests::process::harness::{Process, release_from_parent};
use crate::storage::ApplicationSessionId;
use serde::Deserialize;
use std::{fs, io::BufRead, path::PathBuf};

#[derive(Serialize, Deserialize)]
struct ChildInput {
    root: PathBuf,
    snapshot: PathBuf,
    produce: bool,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    session_id: ApplicationSessionId,
    run_id: RunId,
    operation_id: OperationId,
    final_operation_id: OperationId,
    acceptance: Value,
    final_receipt: Value,
    run: Value,
    tool: Value,
    history: Vec<StoredEvent>,
}

impl Saved {
    async fn assert_unchanged(&self, session: &SessionHandle) {
        let run = session
            .run_record(self.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.state(), RecordedRunState::Completed);
        assert_eq!(run.result().unwrap().outcome, RunOutcome::Completed);
        assert_eq!(value(&run), self.run);
        assert_eq!(
            value(
                &session
                    .lookup_receipt(self.operation_id.clone())
                    .await
                    .unwrap()
                    .unwrap()
            ),
            self.acceptance
        );
        assert_eq!(
            value(
                &session
                    .lookup_receipt(self.final_operation_id.clone())
                    .await
                    .unwrap()
                    .unwrap()
            ),
            self.final_receipt
        );
        assert_eq!(
            value(
                &session
                    .tool_result(self.run_id.clone(), "same-call".into())
                    .await
                    .unwrap()
                    .unwrap()
            ),
            self.tool
        );
        let page = session
            .history_page(0, Some(self.history.last().unwrap().sequence()), 200)
            .await
            .unwrap();
        assert!(!page.has_more());
        assert_eq!(value(&page.records()), value(&self.history));
    }
}

fn first_responses() -> Vec<ModelResponse> {
    vec![
        response("p1b2-11-a-call", vec![call("same-call", 17, 25)], ""),
        response("p1b2-11-a-final", vec![], "42 雪\r\n"),
    ]
}

async fn produce(input: &ChildInput) {
    let store = SessionStore::open(input.root.clone()).await.unwrap();
    let created = store
        .create_session(
            CreateSession::new(OperationId::new(), "process replay".into(), None).unwrap(),
        )
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let (tools, counts) = replay_tools(&session);
    let task = Task::new(
        &session,
        tools,
        "add 17 and 25",
        Plan {
            responses: first_responses(),
            ..Plan::default()
        },
    );
    let (acceptance, final_record, result) = executed(
        run_in_session(
            &task.gateway,
            &session,
            task.request(),
            &task.tools,
            CancellationToken::new(),
        )
        .await
        .unwrap(),
    );
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(count(&counts.validations), 1);
    assert_eq!(count(&counts.effects), 1);
    assert_eq!(count(&task.observed.records.opens), 1);
    assert_eq!(count(&task.observed.records.closes), 1);
    assert_eq!(count(&task.observed.installs), 1);
    assert!(task.observed.installed.lock().unwrap()[0].runs().is_empty());
    assert_eq!(task.observed.records.inputs.lock().unwrap().len(), 2);
    let tool = session
        .tool_result(task.run_id.clone(), "same-call".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tool.output(), Some("{\"sum\":42}"));
    assert_eq!(tool.is_error(), Some(false));
    assert_eq!(
        tool.request_id(),
        Some(format!("{}-q1", task.run_id).as_str())
    );
    let saved = Saved {
        session_id: session.session_id().clone(),
        run_id: task.run_id.clone(),
        operation_id: task.operation_id.clone(),
        final_operation_id: final_record.receipt().operation_id().clone(),
        acceptance: value(acceptance.receipt()),
        final_receipt: value(final_record.receipt()),
        run: value(
            &session
                .run_record(task.run_id.clone())
                .await
                .unwrap()
                .unwrap(),
        ),
        tool: value(&tool),
        history: history(&session).await,
    };
    saved.assert_unchanged(&session).await;
    store.close().await.unwrap();
    fs::write(&input.snapshot, serde_json::to_vec(&saved).unwrap()).unwrap();
    println!("PROOF p1b2_11 A terminal=completed opens=1 requests=2 effects=1 store_closed=1");
}

async fn resume(input: &ChildInput, parent: &mut impl BufRead) {
    let saved: Saved = serde_json::from_slice(&fs::read(&input.snapshot).unwrap()).unwrap();
    let store = SessionStore::open(input.root.clone()).await.unwrap();
    let session = store.open_session(saved.session_id.clone()).await.unwrap();
    let (tools, counts) = replay_tools(&session);
    let task = Task::new(
        &session,
        tools,
        "add one to the prior answer",
        Plan {
            responses: vec![
                response("p1b2-11-b-call", vec![call("same-call", 42, 1)], ""),
                response("p1b2-11-b-final", vec![], "43"),
            ],
            ..Plan::default()
        },
    );
    // Ignore registration/capture reads, then detect any definitions read by replay preparation.
    counts.definitions.store(0, Ordering::SeqCst);
    let before = session.manifest().await.unwrap();
    saved.assert_unchanged(&session).await;
    assert_eq!(value(&history(&session).await), value(&saved.history));
    let prepared = prepare_session_replay(&session, ID, "synthetic")
        .await
        .unwrap();
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(prepared.included_exchange_count(), 2);
    assert!(prepared.excluded_runs().is_empty());
    assert_eq!(
        prepared.selection().through_sequence(),
        before.head_sequence()
    );
    let replay = prepared.replay();
    assert_eq!(replay.provider_id(), ID);
    assert_eq!(replay.requested_model(), "synthetic");
    assert_eq!(replay.expected_identity(), Some(&identity('a')));
    let old = &replay.runs()[0];
    assert_eq!(old.source_run_id(), saved.run_id.as_str());
    assert_eq!(old.prepared_prompt(), "prepared add 17 and 25");
    assert_eq!(old.exchanges().len(), 2);
    for (exchange, expected) in old.exchanges().iter().zip(first_responses()) {
        assert_eq!(value(exchange.response()), value(&expected));
    }
    assert_eq!(
        value(&old.exchanges()[0].tool_results()),
        value(&vec![InputItem::ToolResult {
            call_id: "same-call".into(),
            output: "{\"sum\":42}".into()
        }])
    );
    assert!(old.exchanges()[1].tool_results().is_empty());
    assert_eq!(value(&session.manifest().await.unwrap()), value(&before));
    assert!(
        session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        session
            .lookup_receipt(task.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    for counter in [
        &task.observed.records.capabilities,
        &task.observed.records.opens,
        &task.observed.records.closes,
        &task.observed.validations,
        &task.observed.identity_reads,
        &task.observed.installs,
        &counts.definitions,
        &counts.validations,
        &counts.effects,
    ] {
        assert_eq!(count(counter), 0);
    }
    assert!(task.observed.validated.lock().unwrap().is_none());
    assert!(task.observed.installed.lock().unwrap().is_empty());
    no_generation(&task);
    println!(
        "PROOF p1b2_11 reopened read_only=1 opens=0 installs=0 requests=0 effects=0 A_terminal=1"
    );
    // B is an explicit new submission after the parent observes the no-work read barrier.
    release_from_parent(parent);
    let (acceptance, _, result) = executed(
        run_in_session(
            &task.gateway,
            &session,
            task.request(),
            &task.tools,
            CancellationToken::new(),
        )
        .await
        .unwrap(),
    );
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.run_id, task.run_id.as_str());
    assert_ne!(task.run_id, saved.run_id);
    assert_ne!(task.operation_id, saved.operation_id);
    assert_eq!(result.session_id, Some(format!("provider-{}", task.run_id)));
    let old_binding = session
        .provider_binding(saved.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        result.session_id.as_deref(),
        Some(old_binding.provider_session_id())
    );
    assert_eq!(
        acceptance.receipt().first_sequence(),
        before.head_sequence() + 1
    );
    assert_eq!(
        acceptance.receipt().last_sequence(),
        before.head_sequence() + 2
    );
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.model_requests_admitted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(count(&task.observed.records.opens), 1);
    assert_eq!(count(&task.observed.records.closes), 1);
    assert_eq!(count(&task.observed.validations), 1);
    assert_eq!(count(&task.observed.identity_reads), 1);
    assert_eq!(count(&task.observed.installs), 1);
    assert_eq!(count(&counts.definitions), 1);
    assert_eq!(count(&counts.validations), 1);
    assert_eq!(count(&counts.effects), 1);
    assert_eq!(
        value(task.observed.validated.lock().unwrap().as_ref().unwrap()),
        value(&replay)
    );
    assert_eq!(
        value(&*task.observed.installed.lock().unwrap()),
        value(&vec![replay])
    );
    // The fresh control installs A first, then receives only B's new input and actual result.
    assert_eq!(
        value(&*task.observed.records.inputs.lock().unwrap()),
        value(&vec![
            vec![InputItem::user("prepared add one to the prior answer")],
            vec![InputItem::ToolResult {
                call_id: "same-call".into(),
                output: "{\"sum\":43}".into()
            }],
        ])
    );
    let events = task.observed.records.events.lock().unwrap().clone();
    assert_eq!(events.len(), 4);
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.session_id, format!("provider-{}", task.run_id));
        assert_eq!(
            event.request_id,
            Some(format!("{}-q{}", task.run_id, index / 2 + 1))
        );
        let expected = if index < 2 {
            "p1b2-11-b-call"
        } else {
            "p1b2-11-b-final"
        };
        match &event.event {
            ProviderEvent::ResponseStarted { response_id } => assert_eq!(response_id, expected),
            ProviderEvent::ResponseFinished { response } => assert_eq!(response.id, expected),
            _ => panic!("unexpected provider event"),
        }
    }
    let tool = session
        .tool_result(task.run_id.clone(), "same-call".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tool.output(), Some("{\"sum\":43}"));
    assert_eq!(tool.is_error(), Some(false));
    assert_eq!(
        tool.request_id(),
        Some(format!("{}-q1", task.run_id).as_str())
    );
    saved.assert_unchanged(&session).await;
    let all = history(&session).await;
    assert!(
        all[saved.history.len()..]
            .iter()
            .all(|event| event.run_id() == Some(&task.run_id))
    );
    assert_eq!(
        session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .unwrap()
            .state(),
        RecordedRunState::Completed
    );
    store.close().await.unwrap();
    println!(
        "PROOF p1b2_11 explicit_B=1 opens=1 requests=2 effects=1 exact_replay=1 A_unchanged=1"
    );
}

#[test]
#[ignore = "closed subprocess helper; parent supplies synthetic stdin roots"]
fn p1b2_11_child() {
    let mut parent = std::io::stdin().lock();
    let mut line = String::new();
    parent.read_line(&mut line).unwrap();
    let input: ChildInput = serde_json::from_str(&line).unwrap();
    assert!(input.root.is_absolute());
    assert!(input.snapshot.is_absolute());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            if input.produce {
                produce(&input).await;
            } else {
                resume(&input, &mut parent).await;
            }
        });
}

#[test]
fn p1b2_11_fresh_process_reads_without_work_then_explicit_task_replays_closed_history() {
    let temp = tempfile::tempdir().unwrap();
    let mut input = ChildInput {
        root: temp.path().join("root"),
        snapshot: temp.path().join("task-a.json"),
        produce: true,
    };
    const HELPER: &str = "execution::tests::in_session::process::p1b2_11_child";
    // Waiting for A's exit ensures no provider control or request future survives into B.
    Process::start_test(&temp.path().join("producer"), &input, HELPER).finish(0);
    input.produce = false;
    let mut child = Process::start_test(&temp.path().join("reader"), &input, HELPER);
    child.ready();
    child.release();
    child.finish(0);
}
