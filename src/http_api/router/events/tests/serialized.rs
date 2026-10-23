use super::*;
use axum::{
    body::Bytes,
    http::{HeaderValue, StatusCode},
};
use futures_util::{FutureExt, stream};
use std::sync::atomic::{AtomicUsize, Ordering};
use test_hooks::{ControlError, FaultHook, FaultMode, Phase, Target};

fn event(sid: &ApplicationSessionId, sequence: u64) -> Event {
    Event::default()
        .event("wi.event")
        .id(format!("{sid}:{sequence}"))
        .data(r#"{"synthetic":"雪\nline"}"#)
}

fn response(sid: &ApplicationSessionId, polls: Arc<AtomicUsize>) -> Response {
    let events = vec![
        event(sid, 1),
        Event::default().comment("keep-alive"),
        event(sid, 2),
        event(sid, 3),
    ];
    Sse::new(
        stream::iter(events.into_iter().map(Ok::<_, Infallible>)).inspect(move |_| {
            polls.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .into_response()
}

async fn bytes(event: Event) -> Bytes {
    let mut body = Sse::new(stream::iter([Ok::<_, Infallible>(event)]))
        .into_response()
        .into_body()
        .into_data_stream();
    body.next().await.unwrap().unwrap()
}

fn target(hook: &FaultHook, sequence: u64) -> Target {
    let subscriptions = hook.subscriptions();
    let subscription = subscriptions.last().unwrap();
    Target {
        session_id: subscription.session_id.clone(),
        subscription: subscription.ordinal,
        sequence,
    }
}

#[tokio::test]
async fn inactive_wrapper_preserves_axum_bytes_status_and_headers() {
    let sid = ApplicationSessionId::new();
    let hook = Arc::new(FaultHook::default());
    let hooks = Arc::new(test_hooks::Hooks::with_faults(&hook));
    let mut original = response(&sid, Arc::default());
    *original.status_mut() = StatusCode::ACCEPTED;
    original
        .headers_mut()
        .insert("x-fixture", HeaderValue::from_static("unchanged"));
    let status = original.status();
    let headers = original.headers().clone();
    let wrapped = hooks.wrap(original, sid.clone(), 0, CancellationToken::new());
    assert!(wrapped.status() == status && wrapped.headers() == &headers);
    let mut actual = wrapped.into_body().into_data_stream();
    let mut expected = response(&sid, Arc::default())
        .into_body()
        .into_data_stream();
    while let Some(frame) = expected.next().await {
        assert!(actual.next().await.unwrap().unwrap() == frame.unwrap());
    }
    assert!(actual.next().await.is_none());
    wait(hook.wait_subscriptions(0)).await;
    wait(hooks.wait_active(0)).await;
}

#[tokio::test]
async fn late_armed_modes_yield_exact_bytes_then_wait_without_polling_ahead() {
    for mode in [FaultMode::PrefixThenError, FaultMode::WholeThenError] {
        let sid = ApplicationSessionId::new();
        let hook = Arc::new(FaultHook::default());
        let hooks = Arc::new(test_hooks::Hooks::with_faults(&hook));
        let polls = Arc::new(AtomicUsize::new(0));
        let mut body = hooks
            .wrap(
                response(&sid, polls.clone()),
                sid.clone(),
                0,
                CancellationToken::new(),
            )
            .into_body()
            .into_data_stream();
        assert!(body.next().await.unwrap().unwrap() == bytes(event(&sid, 1)).await);
        let selected = target(&hook, 2);
        let plan = hook.arm(selected.clone(), mode).unwrap();
        assert_eq!(hook.release(&plan), Err(ControlError::NotReached));
        assert!(body.next().await.unwrap().unwrap().as_ref() == b": keep-alive\n\n");
        let actual = body.next().await.unwrap().unwrap();
        let expected = bytes(event(&sid, 2)).await;
        let hit = wait(plan.reached()).await.unwrap();
        assert_eq!(hit.target, selected);
        assert_eq!(hit.mode, mode);
        assert_eq!(hit.frame_bytes, expected.len());
        assert_eq!(hit.yielded_bytes, actual.len());
        match mode {
            FaultMode::PrefixThenError => {
                assert!(!actual.is_empty() && actual.len() < expected.len() - 2);
                assert!(!actual.windows(2).any(|s| s == b"\n\n"));
                assert!(expected.starts_with(&actual));
            }
            FaultMode::WholeThenError => assert!(actual == expected),
        }
        assert!(body.next().now_or_never().is_none());
        assert!(body.next().now_or_never().is_none());
        assert_eq!(polls.load(Ordering::SeqCst), 3);
        assert_eq!(plan.phase(), Phase::Reached);
        hook.release(&plan).unwrap();
        assert_eq!(plan.phase(), Phase::Released);
        assert_eq!(hook.release(&plan), Err(ControlError::NotReached));
        assert!(body.next().await.unwrap().is_err());
        assert_eq!(wait(plan.retired()).await, Phase::Completed);
        assert_eq!(polls.load(Ordering::SeqCst), 3);
        assert!(body.next().await.is_none());
        wait(hook.wait_subscriptions(0)).await;
        wait(hooks.wait_active(0)).await;
    }
}
