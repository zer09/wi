use super::*;
use crate::storage::{
    AppendRunRecord,
    test_hooks::{Action, Hooks, Pause, Point},
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn p1b2_07_08_paged_fixed_head_ignores_concurrent_rename_and_uses_checkpoint() {
    let rig = Rig::new().await;
    rig.session
        .rename(OperationId::new(), "before acceptance 雪\r\n".into())
        .await
        .unwrap();
    let mut plan = Plan::new(rig.input("first"), vec![]);
    plan.steps = vec![Step::Deltas(response("one", vec![]), 140)];
    rig.record(plan).await;
    let before = rig.prepare().await;
    let hooks = Arc::new(Hooks::default());
    let pause = Arc::new(Pause::default());
    hooks.arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
    let session = rig.session.clone();
    let reader = tokio::spawn(async move {
        hooks
            .scope(prepare_session_replay(&session, ID, MODEL))
            .await
    });
    pause.reached.notified().await;
    rig.session
        .rename(OperationId::new(), "after H".into())
        .await
        .unwrap();
    pause.release.notify_one();
    let captured = reader.await.unwrap().unwrap();
    assert_eq!(captured.selection(), before.selection());
    assert_eq!(value(&captured.replay()), value(&before.replay()));
    let after = rig.prepare().await;
    assert_ne!(
        captured.selection().history_digest(),
        after.selection().history_digest()
    );
    assert_eq!(value(&captured.replay()), value(&after.replay()));
    assert_eq!(captured.included_exchange_count(), 1);
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_08_20_result_committed_above_h_cannot_complete_captured_history() {
    let rig = Rig::new().await;
    // Unlike a complete exchange, an empty run needs its actual final result
    // before the captured prefix can prove that no request was attempted.
    let mut plan = Plan::new(rig.input("not submitted"), vec![]);
    plan.stop = Stop::OpenFail;
    plan.final_result = false;
    let (run, actual) = rig.record(plan).await;
    let hooks = Arc::new(Hooks::default());
    let pause = Arc::new(Pause::default());
    hooks.arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
    let session = rig.session.clone();
    let reader = tokio::spawn(async move {
        hooks
            .scope(prepare_session_replay(&session, ID, MODEL))
            .await
    });
    pause.reached.notified().await;
    rig.session
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![AppendRunRecord::Result(actual)],
        )
        .await
        .unwrap();
    pause.release.notify_one();
    assert_incomplete(reader.await.unwrap().unwrap_err());
    let prepared = rig.prepare().await;
    assert_eq!(prepared.included_exchange_count(), 0);
    assert_eq!(prepared.excluded_runs()[0].run_id(), run);
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_08_20_tool_result_above_h_does_not_fill_an_old_intent() {
    let rig = Arc::new(Rig::new().await);
    let producer = {
        let rig = rig.clone();
        tokio::spawn(async move {
            rig.record(Plan::new(
                rig.input("wait for effect"),
                vec![
                    response("call", vec![call("x", json!({"mode":"wait"}))]),
                    response("done", vec![]),
                ],
            ))
            .await
        })
    };
    rig.counters.waiting.notified().await;
    let hooks = Arc::new(Hooks::default());
    let pause = Arc::new(Pause::default());
    hooks.arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
    let session = rig.session.clone();
    let reader = tokio::spawn(async move {
        hooks
            .scope(prepare_session_replay(&session, ID, MODEL))
            .await
    });
    pause.reached.notified().await;
    rig.counters.release_tool.notify_one();
    producer.await.unwrap();
    pause.release.notify_one();
    assert_incomplete(reader.await.unwrap().unwrap_err());
    assert_eq!(rig.prepare().await.included_exchange_count(), 2);
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_31_session_isolation_and_dropped_preparation_do_not_cancel_producer() {
    let rig = Arc::new(Rig::new().await);
    let other = create(&rig.store).await;
    let cancel = CancellationToken::new();
    let producing = {
        let rig = rig.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let mut plan = Plan::new(rig.input("still running"), vec![]);
            plan.steps = vec![Step::Wait];
            produce(&rig.session, &rig.tools, rig.counters.clone(), plan, cancel).await
        })
    };
    rig.counters.waiting.notified().await;
    let hooks = Arc::new(Hooks::default());
    let pause = Arc::new(Pause::default());
    hooks.arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
    let session = rig.session.clone();
    let reader = tokio::spawn(async move {
        hooks
            .scope(prepare_session_replay(&session, ID, MODEL))
            .await
    });
    pause.reached.notified().await;
    reader.abort();
    assert!(reader.await.unwrap_err().is_cancelled());
    assert!(!producing.is_finished());
    assert!(!cancel.is_cancelled());
    assert_eq!(rig.counters.work().1, 0);
    rig.session
        .rename(OperationId::new(), "running rename".into())
        .await
        .unwrap();
    assert_eq!(
        prepare_session_replay(&other, ID, MODEL)
            .await
            .unwrap()
            .included_run_count(),
        0
    );
    cancel.cancel();
    producing.await.unwrap();
    let mut plan = Plan::new(
        rig.input("only other session"),
        vec![
            response("other", vec![call("same", json!({"a":1,"b":2}))]),
            response("other-done", vec![]),
        ],
    );
    plan.identity = identity('b');
    produce(
        &other,
        &rig.tools,
        rig.counters.clone(),
        plan,
        CancellationToken::new(),
    )
    .await;
    let replay = prepare_session_replay(&other, ID, MODEL)
        .await
        .unwrap()
        .replay();
    assert_eq!(replay.runs().len(), 1);
    assert_eq!(replay.runs()[0].prepared_prompt(), "only other session");
    assert_eq!(replay.expected_identity(), Some(&identity('b')));
    assert_incomplete(
        prepare_session_replay(&rig.session, ID, MODEL)
            .await
            .unwrap_err(),
    );
    rig.store.close().await.unwrap();
}
