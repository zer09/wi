use super::*;
use futures_util::FutureExt;
use test_hooks::{ControlError, FaultHook, FaultMode, Phase, Target};

fn target(hook: &FaultHook, sequence: u64) -> Target {
    let subscription = hook.subscriptions().pop().unwrap();
    Target {
        session_id: subscription.session_id,
        subscription: subscription.ordinal,
        sequence,
    }
}

async fn body(
    session: &SessionHandle,
    hooks: &Arc<test_hooks::Hooks>,
    closing: CancellationToken,
) -> Response {
    let page = session.history_page(0, None, PAGE_SIZE).await.unwrap();
    hooks.page(0, None, &page).await;
    stream_response(session.clone(), page, 0, closing, hooks.clone())
}

#[tokio::test]
async fn exact_session_subscription_sequence_and_concurrent_one_shot_generations() {
    let (_temp, store, a) = fixture().await;
    a.rename(OperationId::new(), "second".into()).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "other".into(), None).unwrap())
        .await
        .unwrap();
    let b = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    b.rename(OperationId::new(), "second other".into())
        .await
        .unwrap();
    let hook = Arc::new(FaultHook::default());
    let hooks = Arc::new(test_hooks::Hooks::with_faults(&hook));
    let first = body(&a, &hooks, CancellationToken::new()).await;
    let selected = target(&hook, 2);
    let second = body(&a, &hooks, CancellationToken::new()).await;
    let third = body(&b, &hooks, CancellationToken::new()).await;
    assert_eq!(
        hook.subscriptions()
            .iter()
            .map(|s| s.ordinal)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    // These are response ordinals, not polls, history reads or TCP connection counts.
    assert_eq!(hooks.reads.lock().unwrap().len(), 3);
    for wrong in [
        Target {
            subscription: 0,
            ..selected.clone()
        },
        Target {
            subscription: 4,
            ..selected.clone()
        },
        Target {
            session_id: b.session_id().clone(),
            ..selected.clone()
        },
        Target {
            sequence: 0,
            ..selected.clone()
        },
        Target {
            sequence: i64::MAX as u64 + 1,
            ..selected.clone()
        },
    ] {
        assert!(matches!(
            hook.arm(wrong, FaultMode::WholeThenError),
            Err(ControlError::InvalidTarget)
        ));
    }
    let barrier = std::sync::Barrier::new(2);
    let launch = || {
        barrier.wait();
        hook.arm(selected.clone(), FaultMode::WholeThenError)
    };
    let plans = std::thread::scope(|scope| {
        let a = scope.spawn(launch);
        let b = scope.spawn(launch);
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(plans.iter().filter(|p| p.is_ok()).count(), 1);
    assert_eq!(
        plans
            .iter()
            .filter(|p| matches!(p, Err(ControlError::Active)))
            .count(),
        1
    );
    let plan = plans.into_iter().find_map(Result::ok).unwrap();
    assert!(matches!(
        hook.arm(selected.clone(), FaultMode::PrefixThenError),
        Err(ControlError::Active)
    ));
    assert_eq!(hook.release(&plan), Err(ControlError::NotReached));
    for response in [second, third] {
        let mut other = response.into_body().into_data_stream();
        for _ in 0..2 {
            let bytes = wait(other.next()).await.unwrap().unwrap();
            assert!(bytes.ends_with(b"\n\n"));
        }
        assert_eq!(plan.phase(), Phase::Armed);
    }
    let mut first = first.into_body().into_data_stream();
    assert!(first.next().await.unwrap().is_ok());
    assert_eq!(plan.phase(), Phase::Armed);
    assert!(first.next().await.unwrap().is_ok());
    assert_eq!(wait(plan.reached()).await.unwrap().target, selected);
    assert!(first.next().now_or_never().is_none());
    hook.release(&plan).unwrap();
    assert!(first.next().await.unwrap().is_err());
    assert_eq!(wait(plan.retired()).await, Phase::Completed);
    assert!(matches!(
        hook.arm(selected, FaultMode::WholeThenError),
        Err(ControlError::InvalidTarget)
    ));
    let mut next = body(&a, &hooks, CancellationToken::new())
        .await
        .into_body()
        .into_data_stream();
    let next_target = target(&hook, 2);
    assert_eq!(next_target.subscription, 4);
    assert!(next.next().await.unwrap().is_ok());
    assert!(matches!(
        hook.arm(
            Target {
                sequence: 1,
                ..next_target.clone()
            },
            FaultMode::WholeThenError
        ),
        Err(ControlError::InvalidTarget)
    ));
    let next_plan = hook.arm(next_target, FaultMode::WholeThenError).unwrap();
    assert!(next.next().await.unwrap().is_ok());
    assert_eq!(hook.release(&plan), Err(ControlError::Stale));
    assert_eq!(next_plan.phase(), Phase::Reached);
    assert!(next.next().now_or_never().is_none());
    hook.release(&next_plan).unwrap();
    assert!(next.next().await.unwrap().is_err());
    assert_eq!(wait(next_plan.retired()).await, Phase::Completed);
    drop(first);
    drop(next);
    wait(hook.wait_subscriptions(0)).await;
    wait(hooks.wait_active(0)).await;
    wait(store.close()).await.unwrap();
}

#[tokio::test]
async fn body_drop_aborts_unpolled_and_reached_plans_and_wakes_all_waiters() {
    let (_temp, store, session) = fixture().await;
    for reached in [false, true] {
        let hook = Arc::new(FaultHook::default());
        let hooks = Arc::new(test_hooks::Hooks::with_faults(&hook));
        let mut body = body(&session, &hooks, CancellationToken::new())
            .await
            .into_body()
            .into_data_stream();
        let plan = hook
            .arm(target(&hook, 1), FaultMode::PrefixThenError)
            .unwrap();
        if reached {
            assert!(body.next().await.unwrap().is_ok());
            assert!(body.next().now_or_never().is_none());
        }
        let one = {
            let plan = plan.clone();
            tokio::spawn(async move { plan.retired().await })
        };
        let two = {
            let plan = plan.clone();
            tokio::spawn(async move { plan.retired().await })
        };
        drop(body);
        assert_eq!(wait(one).await.unwrap(), Phase::Aborted);
        assert_eq!(wait(two).await.unwrap(), Phase::Aborted);
        assert_eq!(wait(plan.reached()).await.is_some(), reached);
        assert_eq!(hook.release(&plan), Err(ControlError::Stale));
        wait(hook.wait_subscriptions(0)).await;
        wait(hooks.wait_active(0)).await;
    }
    wait(store.close()).await.unwrap();
}

#[tokio::test]
async fn hook_drop_and_shutdown_wake_wrapper_without_body_drop() {
    let (_temp, store, session) = fixture().await;
    for shutdown in [false, true] {
        let hook = Arc::new(FaultHook::default());
        let weak = Arc::downgrade(&hook);
        let hooks = Arc::new(test_hooks::Hooks::with_faults(&hook));
        let closing = CancellationToken::new();
        let mut body = body(&session, &hooks, closing.clone())
            .await
            .into_body()
            .into_data_stream();
        let plan = hook
            .arm(target(&hook, 1), FaultMode::WholeThenError)
            .unwrap();
        assert!(body.next().await.unwrap().is_ok());
        assert!(body.next().now_or_never().is_none());
        let waiting = tokio::spawn(async move {
            let error = body.next().await.unwrap().is_err();
            (body, error)
        });
        if shutdown {
            closing.cancel();
        } else {
            drop(hook);
        }
        let (mut body, error) = wait(waiting).await.unwrap();
        assert!(error);
        assert_eq!(wait(plan.retired()).await, Phase::Aborted);
        // The response is still alive here; cleanup does not depend on its eventual drop.
        wait(hooks.wait_active(0)).await;
        assert!(body.next().await.is_none());
        if shutdown {
            assert!(weak.upgrade().unwrap().subscriptions().is_empty());
        } else {
            assert!(weak.upgrade().is_none());
        }
    }
    wait(store.close()).await.unwrap();
}

#[tokio::test]
async fn selected_serialized_frame_pause_keeps_one_page_and_releases_storage_locks() {
    let (_temp, store, session) = fixture().await;
    for index in 0..70 {
        session
            .rename(OperationId::new(), format!("title {index}"))
            .await
            .unwrap();
    }
    let hook = Arc::new(FaultHook::default());
    let hooks = Arc::new(test_hooks::Hooks::with_faults(&hook));
    let mut body = body(&session, &hooks, CancellationToken::new())
        .await
        .into_body()
        .into_data_stream();
    // Open and read before arming. Select the last frame of the already-read page.
    assert!(body.next().await.unwrap().is_ok());
    let plan = hook
        .arm(target(&hook, 32), FaultMode::PrefixThenError)
        .unwrap();
    for _ in 1..32 {
        assert!(body.next().await.unwrap().is_ok());
    }
    assert_eq!(wait(plan.reached()).await.unwrap().target.sequence, 32);
    assert!(body.next().now_or_never().is_none());
    wait(session.rename(OperationId::new(), "writer progresses during fault".into()))
        .await
        .unwrap();
    let page = wait(session.history_page(71, None, PAGE_SIZE))
        .await
        .unwrap();
    assert_eq!(page.through_sequence(), 72);
    assert_eq!(page.records().len(), 1);
    assert_eq!(
        hooks.reads.lock().unwrap().as_slice(),
        [test_hooks::Read {
            after: 0,
            through: None,
            head: 71,
            count: 32
        }]
    );
    assert!(body.next().now_or_never().is_none());
    assert_eq!(hook.subscriptions()[0].last_sequence, 32);
    hook.release(&plan).unwrap();
    assert!(body.next().await.unwrap().is_err());
    assert_eq!(hooks.reads.lock().unwrap().len(), 1);
    wait(hooks.wait_active(0)).await;
    wait(store.close()).await.unwrap();
}
