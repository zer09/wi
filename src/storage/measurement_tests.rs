// Compile the public example unchanged against this crate's test build. Only this
// test can inspect the private counters; neither the example nor the library API can.
#[allow(dead_code)]
mod offline {
    use crate as wi;
    include!("../../examples/persisted_run_offline.rs");
}

#[tokio::test]
async fn p1b1_28_exact_example_recording_window_counts() {
    let fixture = offline::fixture().await.unwrap();
    let before = fixture.store.inner.lifecycle.gauge();
    let transactions = fixture.store.inner.hooks.measurements();
    assert_eq!(before.0, 0);
    assert_eq!(before.1, before.2);
    let saved = offline::record_trace(&fixture).await.unwrap();
    let after = fixture.store.inner.lifecycle.gauge();
    let end = fixture.store.inner.hooks.measurements();
    assert_eq!(after.0, 0);
    assert!(!after.3);
    assert_eq!(after.1, after.2);
    assert_eq!(end.recording_commits - transactions.recording_commits, 15);
    assert_eq!(end.other_commits - transactions.other_commits, 1);
    assert_eq!(end.read_transactions - transactions.read_transactions, 6);
    assert_eq!(after.1 - before.1, 76);
    assert_eq!(after.2 - before.2, 76);
    println!(
        "exact_test_counters recording_window: recording_write_transactions=15 catalog_refresh_write_transactions=1 explicit_read_transactions=6 connection_opens=76 connection_closes=76 active_connections=0"
    );
    // 15 recording calls each open catalog RO, session RO validation, session RW.
    // 13 session reads include the composition's TWO absent-receipt lookups:
    // provider-open history, tool-intent history, partial history/receipt,
    // continuation history/tool projection, final history/run/manifest/two receipts.
    // Each session read opens catalog RO and session RO. Refresh opens four;
    // catalog listing opens one. Read transactions: five history pages + refresh.
    assert_eq!(76, 15 * 3 + 13 * 2 + 4 + 1);
    offline::reopen(fixture, saved).await.unwrap();
}
