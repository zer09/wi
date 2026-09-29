use super::*;
use axum::{
    body::Bytes,
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
};
use futures_util::{StreamExt, stream};
use std::convert::Infallible;

fn response(sid: &ApplicationSessionId, text: &str) -> Response {
    Sse::new(stream::iter([Ok::<_, Infallible>(
        Event::default()
            .event("wi.event")
            .id(format!("{sid}:1"))
            .data(text),
    )]))
    .into_response()
}

async fn frame(sid: &ApplicationSessionId) -> Bytes {
    response(sid, "private-frame-canary")
        .into_body()
        .into_data_stream()
        .next()
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn duplicate_hits_and_cross_hook_generation_tokens_are_rejected() {
    let sid = ApplicationSessionId::new();
    let a = Arc::new(FaultHook::default());
    let b = Arc::new(FaultHook::default());
    let first = a.subscribe(sid.clone(), 0);
    let foreign = b.subscribe(sid.clone(), 0);
    let target = Target {
        session_id: sid.clone(),
        subscription: 1,
        sequence: 1,
    };
    let plan = a.arm(target.clone(), FaultMode::WholeThenError).unwrap();
    let other_plan = b.arm(target, FaultMode::WholeThenError).unwrap();
    assert_eq!(plan.generation, other_plan.generation);
    let bytes = frame(&sid).await;
    assert!(first.frame(&bytes).unwrap().is_some());
    assert!(foreign.frame(&bytes).unwrap().is_some());
    let hit = plan.reached().await.unwrap();
    assert!(!format!("{hit:?}").contains("private-frame-canary"));
    assert!(matches!(first.frame(&bytes), Err(ControlError::NotReached)));
    assert_eq!(plan.reached().await.unwrap(), hit);
    assert_eq!(a.release(&other_plan), Err(ControlError::Stale));
    assert_eq!(b.release(&plan), Err(ControlError::Stale));
    a.release(&plan).unwrap();
    first.finish(true);
    let next = a.subscribe(sid.clone(), 0);
    let new_plan = a
        .arm(
            Target {
                session_id: sid,
                subscription: next.ordinal,
                sequence: 1,
            },
            FaultMode::PrefixThenError,
        )
        .unwrap();
    assert_eq!(new_plan.generation, plan.generation + 1);
    assert!(next.frame(&bytes).unwrap().is_some());
    assert_eq!(a.release(&plan), Err(ControlError::Stale));
    assert_eq!(new_plan.phase(), Phase::Reached);
    // A late destructor for the old subscription cannot abort the new generation.
    drop(first);
    assert_eq!(new_plan.phase(), Phase::Reached);
    drop(next);
    drop(foreign);
    assert_eq!(new_plan.retired().await, Phase::Aborted);
    assert_eq!(other_plan.retired().await, Phase::Aborted);
}

#[tokio::test]
async fn selected_frame_bound_aborts_without_retaining_oversized_diagnostics() {
    let sid = ApplicationSessionId::new();
    let hook = Arc::new(FaultHook::default());
    let hooks = Arc::new(super::super::Hooks::with_faults(&hook));
    let text = "x".repeat(MAX_FRAME_BYTES);
    let response = hooks.wrap(
        response(&sid, &text),
        sid.clone(),
        0,
        CancellationToken::new(),
    );
    let plan = hook
        .arm(
            Target {
                session_id: sid,
                subscription: 1,
                sequence: 1,
            },
            FaultMode::WholeThenError,
        )
        .unwrap();
    let mut body = response.into_body().into_data_stream();
    assert!(body.next().await.unwrap().is_err());
    assert!(plan.reached().await.is_none());
    assert_eq!(plan.retired().await, Phase::Aborted);
    assert!(hook.subscriptions().is_empty());
    assert!(body.next().await.is_none());
}
