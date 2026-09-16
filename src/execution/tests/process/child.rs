use super::*;
use crate::storage::test_hooks::{Action, Pause, Point};
use std::io::BufRead;

pub(super) async fn retire(
    fixture: &Fixture,
    how: Retirement,
    tool: bool,
    input: &mut impl BufRead,
) {
    let store = SessionStore::open(fixture.root.clone()).await.unwrap();
    let session = store.open_session(fixture.session.clone()).await.unwrap();
    let step = if tool {
        Step::Response(response("r1", vec![call("one", 17, 25)], ""))
    } else {
        Step::Wait
    };
    let (gateway, tools, records) = runtime(fixture, &session, vec![step], ToolMode::Pending);
    let retire = Arc::new(Notify::new());
    let returned = Arc::new(AtomicUsize::new(0));
    let cancel = CancellationToken::new();
    let task = tokio::spawn({
        let session = session.clone();
        let request = fixture.request();
        let retire = retire.clone();
        let returned = returned.clone();
        let cancel = cancel.clone();
        async move {
            let mut running = Box::pin(run_persisted(&gateway, &session, request, &tools, cancel));
            tokio::select! {
                _ = &mut running => { returned.fetch_add(1, Ordering::SeqCst); panic!("unexpected returned execution"); }
                _ = retire.notified() => match how {
                    Retirement::Drop => drop(running),
                    Retirement::Panic => panic!("synthetic owning future panic"),
                    Retirement::Abort => unreachable!(),
                }
            }
        }
    });
    if tool {
        watchdog(records.tool_entered.notified()).await;
    } else {
        watchdog(records.waiting.notified()).await;
    }
    assert_eq!(count(&records.opens), 1);
    assert_eq!(count(&records.closes), 0);
    assert_eq!(count(&records.calls), usize::from(tool));
    assert_eq!(records.inputs.lock().unwrap().len(), 1);

    let pause = Arc::new(Pause::default());
    session
        .test_hooks()
        .arm(Point::BeforeCommit, Action::Pause(pause.clone()));
    let operation = OperationId::new();
    let writer = tokio::spawn({
        let session = session.clone();
        let operation = operation.clone();
        async move {
            session
                .rename(
                    operation,
                    "admitted SQL survived owning-future retirement".into(),
                )
                .await
        }
    });
    watchdog(pause.reached.notified()).await;
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());
    match how {
        Retirement::Abort => task.abort(),
        _ => retire.notify_one(),
    }
    let retired = watchdog(task).await;
    match how {
        Retirement::Drop => retired.unwrap(),
        Retirement::Abort => assert!(retired.unwrap_err().is_cancelled()),
        Retirement::Panic => assert!(retired.unwrap_err().is_panic()),
    }
    assert_eq!(count(&returned), 0);
    assert_eq!(count(&records.closes), 1);
    assert!(!cancel.is_cancelled());
    assert_eq!(
        session.manifest().await.unwrap_err().code(),
        "storage.closed"
    );
    let before = Snapshot::read(&fixture.root, &fixture.session).await;
    before.unfinished(fixture);
    assert!(
        before
            .tools
            .iter()
            .all(|row| row.5.is_none() && row.6.is_none() && row.7.is_none() && row.8.is_none())
    );
    let mut closing = Box::pin(store.close());
    assert!(futures_util::poll!(&mut closing).is_pending());
    // Parent probes the lease before the admitted transaction can publish.
    harness::release_from_parent(input);
    pause.release.notify_one();
    assert_eq!(
        watchdog(&mut closing).await.unwrap_err().code(),
        "storage.io"
    );
    drop(closing);
    let drained = Snapshot::read(&fixture.root, &fixture.session).await;
    drained.unfinished(fixture);
    assert!(drained.events[..before.events.len()] == before.events);
    assert_eq!(drained.events.len(), before.events.len() + 1);
    let receipt = drained
        .commands
        .iter()
        .find(|row| row.0 == operation.as_str())
        .unwrap();
    assert_eq!(receipt.1, "rename");
    assert_eq!(receipt.3 as usize, drained.events.len());
    assert_eq!(receipt.3, receipt.4);
    assert_eq!(count(&returned), 0);
    assert_eq!(count(&records.closes), 1);
    assert_eq!(count(&records.calls), usize::from(tool));
    assert_eq!(records.inputs.lock().unwrap().len(), 1);
    drop(session);
    drop(store);
    println!(
        "PROOF retirement={how:?} tool_wait={tool} opens=1 closes=1 requests=1 effects={} returned=0 sql_drained=1",
        usize::from(tool)
    );
    // Parent probes again after SQL retirement and after all ordinary owners were dropped.
    harness::release_from_parent(input);
}
