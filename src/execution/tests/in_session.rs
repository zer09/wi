use super::faults::watchdog;
use super::*;
use crate::storage::{
    CommitCertainty, StorageErrorKind,
    test_hooks::{Action, Pause, Point, Record},
};
use crate::{ConversationReplay, ReplayIdentity};

mod admission;
mod fixture;
mod process;
mod startup;
use fixture::*;

fn no_generation(task: &Task) {
    assert!(task.observed.records.inputs.lock().unwrap().is_empty());
    assert!(task.observed.records.events.lock().unwrap().is_empty());
}

async fn recorded_outcome(task: &Task, result: &RunResult, outcome: RunOutcome) {
    assert_eq!(result.outcome, outcome);
    assert!(result.events_complete);
    assert!(result.sink_error.is_none());
    assert_eq!(result.summary.model_requests_attempted, 0);
    assert_eq!(result.summary.model_requests_admitted, 0);
    assert_eq!(result.summary.turns_started, 0);
    assert!(result.last_response.is_none());
    let saved = task
        .session
        .run_record(task.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(value(saved.result().unwrap()), value(result));
    no_generation(task);
}

#[tokio::test]
async fn p1b2_01_09_10_12_13_public_tasks_install_exact_history_and_only_execute_new_tools() {
    let fixture = Fixture::new().await;
    fixture
        .session
        .rename(OperationId::new(), "before first task".into())
        .await
        .unwrap();
    let first_response = response("a-call", vec![call("same-call", 17, 25)], "");
    let final_response = response("a-final", vec![], "42 雪\r\n");
    let first = fixture.task(
        "add 17 and 25",
        Plan {
            responses: vec![first_response.clone(), final_response.clone()],
            ..Plan::default()
        },
    );
    fixture.counts.definitions.store(0, Ordering::SeqCst);
    let (acceptance, _, result) = first.execute().await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.run_id, first.run_id.as_str());
    assert_eq!(result.summary.model_requests_attempted, 2);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(acceptance.receipt().first_sequence(), 3);
    assert_eq!(acceptance.receipt().last_sequence(), 4);
    assert_eq!(count(&fixture.counts.definitions), 1);
    assert_eq!(count(&fixture.counts.validations), 1);
    assert_eq!(count(&fixture.counts.effects), 1);
    assert_eq!(count(&first.observed.validations), 1);
    assert_eq!(count(&first.observed.identity_reads), 1);
    assert_eq!(count(&first.observed.installs), 1);
    assert_eq!(count(&first.observed.records.opens), 1);
    assert_eq!(count(&first.observed.records.closes), 1);
    assert!(
        first.observed.installed.lock().unwrap()[0]
            .runs()
            .is_empty()
    );
    let selected = fixture
        .session
        .history_selection(first.run_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.through_sequence(), 2);
    assert!(selected.expected_identity().is_none());
    let saved = fixture
        .session
        .tool_result(first.run_id.clone(), "same-call".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.output(), Some("{\"sum\":42}"));
    assert_eq!(saved.is_error(), Some(false));
    assert_eq!(
        saved.request_id(),
        Some(format!("{}-q1", first.run_id).as_str())
    );

    let second = fixture.task(
        "add one to the prior answer",
        Plan {
            responses: vec![
                response("b-call", vec![call("same-call", 42, 1)], ""),
                response("b-final", vec![], "43"),
            ],
            ..Plan::default()
        },
    );
    fixture.counts.definitions.store(0, Ordering::SeqCst);
    let (_, _, result) = second.execute().await;
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(result.summary.new_tool_dispatches, 1);
    assert_eq!(count(&fixture.counts.definitions), 1);
    assert_eq!(count(&fixture.counts.validations), 2);
    assert_eq!(count(&fixture.counts.effects), 2);
    assert_eq!(count(&second.observed.validations), 1);
    let installed = second.observed.installed.lock().unwrap()[0].clone();
    assert_eq!(installed.runs().len(), 1);
    assert_eq!(installed.expected_identity(), Some(&identity('a')));
    let old = &installed.runs()[0];
    assert_eq!(old.source_run_id(), first.run_id.as_str());
    assert_eq!(old.prepared_prompt(), first.input.prepared_request().prompt);
    assert_ne!(old.prepared_prompt(), first.input.user_text());
    assert_eq!(old.exchanges().len(), 2);
    assert_eq!(value(old.exchanges()[0].response()), value(&first_response));
    assert_eq!(value(old.exchanges()[1].response()), value(&final_response));
    assert_eq!(
        value(&old.exchanges()[0].tool_results()),
        value(&vec![InputItem::ToolResult {
            call_id: "same-call".into(),
            output: saved.output().unwrap().into()
        }])
    );
    assert!(old.exchanges()[1].tool_results().is_empty());
    let new = fixture
        .session
        .tool_result(second.run_id.clone(), "same-call".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(new.output(), Some("{\"sum\":43}"));
    assert_ne!(new.request_id(), saved.request_id());
    let prepared = prepare_session_replay(&fixture.session, ID, "synthetic")
        .await
        .unwrap();
    assert_eq!(prepared.included_run_count(), 2);
    assert_eq!(prepared.included_exchange_count(), 4);
    assert_eq!(count(&fixture.counts.effects), 2);
    assert_eq!(count(&fixture.counts.validations), 2);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_17_21_missing_identity_is_recorded_then_excluded_without_install() {
    let fixture = Fixture::new().await;
    let task = fixture.task(
        "missing identity",
        Plan {
            identity: None,
            ..Plan::default()
        },
    );
    let (_, _, result) = task.execute().await;
    recorded_outcome(
        &task,
        &result,
        RunOutcome::Failed {
            code: "history_identity".into(),
        },
    )
    .await;
    assert_eq!(result.session_id, Some(format!("provider-{}", task.run_id)));
    assert!(
        fixture
            .session
            .provider_binding(task.run_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&task.observed.identity_reads), 1);
    assert_eq!(count(&task.observed.installs), 0);
    assert_eq!(count(&task.observed.records.closes), 1);
    let prepared = prepare_session_replay(&fixture.session, ID, "synthetic")
        .await
        .unwrap();
    assert_eq!(prepared.included_run_count(), 0);
    assert_eq!(prepared.excluded_runs()[0].run_id(), task.run_id);
    assert_eq!(
        fixture
            .task("new explicit task", Plan::default())
            .execute()
            .await
            .2
            .outcome,
        RunOutcome::Completed
    );
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_16_21_actual_mismatched_binding_commits_before_refusal_and_later_match_works() {
    let fixture = Fixture::new().await;
    let first = fixture.task("account X", Plan::default());
    first.execute().await;
    let mismatch = fixture.task(
        "account Y",
        Plan {
            identity: Some(identity('b')),
            ..Plan::default()
        },
    );
    let (_, _, result) = mismatch.execute().await;
    recorded_outcome(
        &mismatch,
        &result,
        RunOutcome::Failed {
            code: "history_identity".into(),
        },
    )
    .await;
    assert_eq!(
        fixture
            .session
            .provider_binding(mismatch.run_id.clone())
            .await
            .unwrap()
            .unwrap()
            .identity(),
        &identity('b')
    );
    assert_eq!(count(&mismatch.observed.installs), 0);
    assert_eq!(count(&mismatch.observed.records.opens), 1);
    assert_eq!(count(&mismatch.observed.records.closes), 1);
    let next = fixture.task("explicit X again", Plan::default());
    assert_eq!(next.execute().await.2.outcome, RunOutcome::Completed);
    let installed = next.observed.installed.lock().unwrap()[0].clone();
    assert_eq!(installed.runs().len(), 1);
    assert_eq!(installed.runs()[0].source_run_id(), first.run_id.as_str());
    let prepared = prepare_session_replay(&fixture.session, ID, "synthetic")
        .await
        .unwrap();
    assert_eq!(prepared.excluded_runs()[0].run_id(), mismatch.run_id);
    fixture.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_18_install_rejection_commits_execution_failure_without_generate_or_retry() {
    let fixture = Fixture::new().await;
    let task = fixture.task(
        "install failure",
        Plan {
            install_error: true,
            ..Plan::default()
        },
    );
    let (_, _, result) = task.execute().await;
    recorded_outcome(
        &task,
        &result,
        RunOutcome::Failed {
            code: "history_restore".into(),
        },
    )
    .await;
    assert_eq!(count(&task.observed.installs), 1);
    assert_eq!(count(&task.observed.records.opens), 1);
    assert_eq!(count(&task.observed.records.closes), 1);
    assert!(task.observed.installed.lock().unwrap().is_empty());
    assert!(
        fixture
            .session
            .provider_binding(task.run_id.clone())
            .await
            .unwrap()
            .is_some()
    );
    fixture.store.close().await.unwrap();
}
