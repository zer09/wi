use super::*;
use crate::{
    ReplayExchange,
    run::RunEvent,
    storage::{ApplicationSessionId, InterruptionReason, RecordedRunInput, RecordedRunState},
    tools::ToolRegistry,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const PROMPT: &str = "old prepared task\r\n雪";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
enum Case {
    CompleteBatch,
    MissingFinish,
    FinalResponse,
    PartialBatch,
    Intent,
    PartialResponse,
    NoncompletedResponse,
    ZeroExchange,
    LaterTurn,
    LaterRequest,
}

#[derive(Serialize, Deserialize)]
struct ChildInput {
    root: PathBuf,
    session: ApplicationSessionId,
    input: RecordedRunInput,
    case: Case,
}

fn batch() -> ModelResponse {
    response(
        "closed-batch",
        vec![
            call("first", json!({"a":17,"b":25})),
            call("last", json!({"mode":"error_shaped"})),
        ],
    )
}

fn final_response() -> ModelResponse {
    let text = "final text 雪\r\n";
    let mut response = response(
        "final-no-call",
        vec![OutputItem {
            id: Some("message".into()),
            kind: crate::ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: json!({"type":"message", "id":"message", "role":"assistant", "content":[{"type":"output_text","text":text}], "opaque":"kept"}),
        }],
    );
    response.text = text.into();
    response
}

#[test]
#[ignore = "closed subprocess helper; parent supplies synthetic stdin root"]
fn replay_interruption_child() {
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).unwrap();
    let fixture: ChildInput = serde_json::from_str(&line).unwrap();
    assert!(fixture.root.is_absolute());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let store = SessionStore::open(fixture.root).await.unwrap();
        let session = store.open_session(fixture.session).await.unwrap();
        let counters = Arc::new(Counters::default());
        let mut tools = ToolRegistry::new();
        tools
            .register(Arc::new(CountingTool(counters.clone())))
            .unwrap();
        let mut plan = Plan::new(fixture.input, vec![batch()]);
        plan.stop = match fixture.case {
            Case::CompleteBatch => Stop::Exit(ExitAt::Finish("last")),
            Case::MissingFinish => Stop::Exit(ExitAt::Result("last")),
            Case::FinalResponse => {
                plan.steps = vec![Step::Response(final_response())];
                Stop::Exit(ExitAt::Response)
            }
            Case::PartialBatch => Stop::Exit(ExitAt::Result("first")),
            Case::Intent => Stop::Exit(ExitAt::Intent),
            Case::PartialResponse => {
                plan.steps = vec![Step::Partial];
                Stop::Exit(ExitAt::Partial)
            }
            Case::NoncompletedResponse => {
                let mut response = final_response();
                response.outcome = crate::ResponseOutcome::Incomplete { reason: None };
                response.native["status"] = json!("incomplete");
                plan.steps = vec![Step::Response(response)];
                Stop::Exit(ExitAt::Response)
            }
            Case::ZeroExchange => Stop::Exit(ExitAt::Opened),
            Case::LaterTurn => Stop::Exit(ExitAt::Turn(2)),
            Case::LaterRequest => {
                // generate is polled, but no receipt or response reaches the observer.
                plan.steps.push(Step::Exit);
                Stop::Never
            }
        };
        produce(&session, &tools, counters, plan, CancellationToken::new()).await;
        panic!("producer returned instead of exiting at the committed boundary");
    });
}

fn run_child(sandbox: &Path, fixture: &ChildInput) {
    for name in ["home", "xdg", "codex", "tmp"] {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(sandbox.join(name)).unwrap();
    }
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "execution::replay::tests::interrupted::replay_interruption_child",
            "--ignored",
            "--nocapture",
        ])
        .current_dir(sandbox)
        .env_clear()
        .env("HOME", sandbox.join("home"))
        .env("XDG_CONFIG_HOME", sandbox.join("xdg"))
        .env("CODEX_HOME", sandbox.join("codex"))
        .env("TMPDIR", sandbox.join("tmp"))
        .env("TEMP", sandbox.join("tmp"))
        .env("TMP", sandbox.join("tmp"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        serde_json::to_string(fixture).unwrap()
    )
    .unwrap();
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(73), "case {:?}", fixture.case);
            break;
        }
        if started.elapsed() > Duration::from_secs(20) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("child fixture watchdog, case {:?}", fixture.case);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

async fn check_case(case: Case, replayable: bool) {
    let rig = Rig::new().await;
    let fixture = ChildInput {
        root: rig.temp.path().join("store"),
        session: rig.session.session_id().clone(),
        input: rig.input(PROMPT),
        case,
    };
    rig.store.close().await.unwrap();
    run_child(&rig.temp.path().join("child"), &fixture);

    let reopened = SessionStore::open(fixture.root.clone()).await.unwrap();
    let session = reopened
        .open_session(fixture.session.clone())
        .await
        .unwrap();
    let before = history(&session).await;
    let run = before
        .iter()
        .find_map(|event| match event.payload() {
            StoredEventPayload::RunAccepted(accepted) => Some(accepted.run_id().clone()),
            _ => None,
        })
        .unwrap();
    let record = session.run_record(run.clone()).await.unwrap().unwrap();
    assert_eq!(record.state(), RecordedRunState::Interrupted);
    assert!(record.result().is_none());
    assert!(
        matches!(before.last().unwrap().payload(), StoredEventPayload::RunInterrupted(interruption)
        if interruption.reason() == InterruptionReason::ProcessRestart && interruption.run_id() == &run)
    );
    assert_eq!(
        before
            .iter()
            .filter(|event| matches!(event.payload(), StoredEventPayload::RunInterrupted(_)))
            .count(),
        1
    );
    assert!(!before.iter().any(|event| matches!(
        event.payload(),
        StoredEventPayload::RunResultRecorded(_)
            | StoredEventPayload::RuntimeObserved(crate::run::RunEventEnvelope {
                event: RunEvent::RunFinished { .. },
                ..
            })
    )));

    let prepared = prepare_session_replay(&session, ID, MODEL).await;
    if replayable {
        let prepared = prepared.unwrap();
        let (response, results) = if matches!(case, Case::FinalResponse) {
            (final_response(), vec![])
        } else {
            let expected = [
                ("first", json!({"sum":42}).to_string()),
                (
                    "last",
                    json!({"error":{"code":"not_error","text":"雪\r\n\u{0}"}}).to_string(),
                ),
            ];
            let mut results = Vec::new();
            for (call_id, output) in expected {
                let saved = session
                    .tool_result(run.clone(), call_id.into())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.request_id(), Some("request-0"));
                assert_eq!(saved.output(), Some(output.as_str()));
                assert_eq!(saved.is_error(), Some(false));
                assert_eq!(
                    saved.finished_sequence().is_some(),
                    call_id == "first" || matches!(case, Case::CompleteBatch)
                );
                results.push(InputItem::ToolResult {
                    call_id: call_id.into(),
                    output,
                });
            }
            (batch(), results)
        };
        let expected = ConversationReplay::new(
            ID.into(),
            MODEL.into(),
            Some(identity('a')),
            vec![
                ReplayRun::new(
                    run.to_string(),
                    PROMPT.into(),
                    vec![ReplayExchange::new(response, results).unwrap()],
                )
                .unwrap(),
            ],
        )
        .unwrap();
        assert_eq!(value(&prepared.replay()), value(&expected));
        assert_eq!(prepared.included_run_count(), 1);
        assert_eq!(prepared.included_exchange_count(), 1);
        assert!(prepared.excluded_runs().is_empty());
        assert_eq!(
            prepared.selection().through_sequence(),
            before.last().unwrap().sequence()
        );
        let again = prepare_session_replay(&session, ID, MODEL).await.unwrap();
        assert_eq!(again.selection(), prepared.selection());
        assert_eq!(value(&again.replay()), value(&expected));
    } else {
        assert_incomplete(prepared.unwrap_err());
    }
    assert_eq!(value(&before), value(&history(&session).await));
    assert_eq!(
        value(&record),
        value(&session.run_record(run.clone()).await.unwrap().unwrap())
    );
    assert_eq!(rig.counters.work(), (0, 0, 0, 0, 0));
    assert_eq!(rig.counters.replay_checks.load(Ordering::SeqCst), 0);
    reopened.close().await.unwrap();

    // A second store opening must not change or interrupt the old run again.
    let reopened = SessionStore::open(fixture.root).await.unwrap();
    let session = reopened.open_session(fixture.session).await.unwrap();
    assert_eq!(value(&before), value(&history(&session).await));
    assert_eq!(
        session.run_record(run).await.unwrap().unwrap().state(),
        RecordedRunState::Interrupted
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_19_process_exit_after_complete_trailing_batch_preserves_exact_replay() {
    check_case(Case::CompleteBatch, true).await;
}

#[tokio::test]
async fn p1b2_19_process_exit_after_result_commit_needs_no_finish_notification() {
    check_case(Case::MissingFinish, true).await;
}

#[tokio::test]
async fn p1b2_19_process_exit_after_final_no_call_response_preserves_exact_replay() {
    check_case(Case::FinalResponse, true).await;
}

#[tokio::test]
async fn p1b2_20_21_process_exit_incomplete_and_uncertain_tails_reject() {
    for case in [
        Case::PartialBatch,
        Case::Intent,
        Case::PartialResponse,
        Case::NoncompletedResponse,
        Case::ZeroExchange,
        Case::LaterTurn,
        Case::LaterRequest,
    ] {
        check_case(case, false).await;
    }
}
