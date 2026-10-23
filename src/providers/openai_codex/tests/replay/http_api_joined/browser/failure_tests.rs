use super::*;

#[test]
fn gate11_opt_in_preserves_closed_start_and_control() {
    let base = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,
        "presentation":true,"owner":"ab".repeat(32),"gate11_diagnostics":true});
    let start: Start = decode_control(&serde_json::to_vec(&base).unwrap());
    start.validate();
    for (key, value) in [
        ("presentation", json!(false)),
        ("mutations", json!(true)),
        ("recovered", json!(true)),
        ("mime", json!(false)),
        ("transport", json!("sse")),
        ("tool_fidelity", json!(true)),
        ("gate11_diagnostics", json!("true")),
    ] {
        let mut changed = base.clone();
        changed[key] = value;
        assert!(
            std::panic::catch_unwind(|| {
                let start: Start = decode_control(&serde_json::to_vec(&changed).unwrap());
                start.validate();
            })
            .is_err()
        );
    }
    let control: Control = decode_control(br#"{"command":"gate11_diagnostic","id":2}"#);
    assert_eq!(control.id(), 2);
    for raw in [
        br#"{"command":"gate11_diagnostic","id":0}"#.as_slice(),
        br#"{"command":"gate11_diagnostic","id":2,"private":"canary"}"#.as_slice(),
        br#"{"command":"gate11_diagnostic","id":2,"id":3}"#.as_slice(),
    ] {
        assert!(std::panic::catch_unwind(|| decode_control::<Control>(raw)).is_err());
    }
}

#[test]
fn gate11_absent_disabled_and_capture_failure_are_explicit() {
    let disabled = presentation::Trace::new(false);
    disabled.admit();
    assert_eq!(disabled.snapshot(2)["state"], "disabled");
    let trace = presentation::Trace::new(true);
    assert_eq!(trace.snapshot(2)["state"], "unavailable");
    trace.admit();
    trace.mark_at(600_001, presentation::Phase::Send, 1, 0, None);
    assert_eq!(trace.snapshot(2)["state"], "capture_failed");
    assert!(trace.snapshot(2)["trace"].is_null());
}

#[tokio::test]
async fn gate11_progress_send_read_and_pacing_stalls_have_distinct_witnesses() {
    for (phase, index, label) in [
        (presentation::Phase::Send, 0, "send"),
        (presentation::Phase::Read, 2, "read"),
        (presentation::Phase::Pace, 4, "pace"),
    ] {
        let trace = presentation::Trace::new(true);
        trace.admit();
        trace.consumed();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let pending = trace.during(phase, 3, 1, rx);
        tokio::pin!(pending);
        assert!(futures_util::poll!(&mut pending).is_pending());
        let stalled = trace.snapshot(2);
        assert_eq!(stalled["trace"]["await_counts"][index], 1);
        assert_eq!(stalled["trace"]["await_counts"][index + 1], 0);
        assert_eq!(stalled["trace"]["history"][0][1], label);
        tx.send(()).unwrap();
        pending.await.unwrap();
        let progressing = trace.snapshot(2);
        assert_eq!(progressing["trace"]["await_counts"][index + 1], 1);
        assert!(progressing["trace"]["consumed_ms"].is_number());
    }
}

#[test]
fn gate11_exact_count_under_and_overshoot_are_not_completion() {
    let trace = presentation::Trace::new(true);
    trace.admit();
    let frames = presentation::partial("synthetic-private-response", 1, 1);
    let deltas = frames.iter().filter(|f| f.get("delta").is_some()).count();
    assert_eq!(deltas, 70);
    trace.expected(frames.len() + 1, deltas);
    assert!(!trace.counted(3, 1, 0));
    assert!(!trace.counted(3, 1, 2));
    assert!(trace.counted(3, 1, 1));
    let value = trace.snapshot(2);
    assert_eq!(value["trace"]["committed_counts"], json!([0, 1, 0, 2]));
    assert_eq!(value["trace"]["count_changes"], 3);
    assert_eq!(value["trace"]["expected_deltas"], 70);
    assert_eq!(value["trace"]["history"][1][2], 3);
    assert_eq!(value["trace"]["history"][1][3], 1);
}

#[test]
fn gate11_bounded_history_retains_aggregates_gate_and_privacy() {
    let trace = presentation::Trace::new(true);
    trace.admit();
    trace.consumed();
    trace.expected(72, 70);
    for n in 0..1000 {
        trace.mark_at(n, presentation::Phase::Count, 3, 1, Some(n as usize));
    }
    for n in 0..3 {
        trace.gate(n);
    }
    let value = trace.snapshot(2);
    assert_eq!(value["trace"]["history"].as_array().unwrap().len(), 12);
    assert_eq!(value["trace"]["truncated"], true);
    assert_eq!(value["trace"]["committed_counts"], json!([0, 999, 0, 999]));
    assert!(
        value["trace"]["gate_ms"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_number)
    );
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(bytes.len() < LIMIT as usize);
    let text = String::from_utf8(bytes).unwrap();
    for private in [
        "synthetic-private-response",
        "owner",
        "payload",
        "token",
        "panic",
        "path",
    ] {
        assert!(!text.contains(private));
    }
    trace.mark_at(1, presentation::Phase::Count, 3, 1, Some(1_000_001));
    assert_eq!(trace.snapshot(2)["state"], "capture_failed");
}

#[tokio::test]
async fn gate11_default_off_real_reply_and_provider_selection_take_no_diagnostic_locks() {
    for opt_in in [None, Some(false), Some(true)] {
        let mut input = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,
            "presentation":true,"owner":"ab".repeat(32)});
        if let Some(enabled) = opt_in {
            input["gate11_diagnostics"] = json!(enabled);
        }
        let start: Start = decode_control(&serde_json::to_vec(&input).unwrap());
        start.validate();
        let trace = presentation::new_trace(start.gate11_diagnostics);
        assert_eq!(trace.is_some(), opt_in == Some(true));
        for gate in [1, 4, 7, 10] {
            assert_eq!(
                presentation::gate_trace(trace.as_deref(), gate).is_some(),
                opt_in == Some(true) && gate == 10
            );
        }
    }
    for mode in ["none", "disabled", "earlier_gate", "enabled"] {
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut diagnostic = presentation::Trace::new(mode != "disabled");
        diagnostic.lock_operations = Some(counter.clone());
        let trace = match mode {
            "none" => None,
            "disabled" => Some(&diagnostic),
            "earlier_gate" => presentation::gate_trace(Some(&diagnostic), 7),
            _ => presentation::gate_trace(Some(&diagnostic), 10),
        };
        if mode == "enabled" {
            diagnostic.admit();
        }
        let mut wire = Wire::new(Transport::WebSocket).await;
        let address = wire.listener.local_addr().unwrap();
        let (client, server) = tokio::join!(
            tokio_tungstenite::connect_async(format!("ws://{address}")),
            async {
                let (socket, _) = wire.listener.accept().await.unwrap();
                tokio_tungstenite::accept_async(socket).await.unwrap()
            }
        );
        let (mut client, _) = client.unwrap();
        wire.websocket = Some(server);
        let (temp, db, mut writer) = independent().await;
        sqlx::query("CREATE TABLE events(sequence INTEGER,event_id TEXT,event_type TEXT,event_version INTEGER,created_at_ms INTEGER,run_id TEXT,payload_json TEXT)")
            .execute(&mut writer).await.unwrap();
        // A real send/read/10-ms pacing loop with no committed delta stays pending.
        let frame = json!({"type":"response.output_text.delta","delta":"synthetic"});
        let result = tokio::time::timeout(
            Duration::from_millis(35),
            presentation::reply(
                &mut wire,
                &db,
                "synthetic",
                vec![frame.clone()],
                trace,
                None,
            ),
        )
        .await;
        assert!(result.is_err());
        let sent = watch(client.next()).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(sent.to_text().unwrap()).unwrap(),
            frame
        );
        let locks = counter.load(Ordering::SeqCst);
        if mode == "enabled" {
            assert!(locks > 0);
            let snapshot = diagnostic.snapshot(2);
            assert!(snapshot["trace"]["await_counts"][2].as_u64().unwrap() >= 1);
            assert!(snapshot["trace"]["await_counts"][4].as_u64().unwrap() >= 1);
        } else {
            assert_eq!(locks, 0, "default path locked in {mode}");
        }
        drop(client);
        drop(wire);
        close(db, writer, temp).await;
    }
}

#[tokio::test]
async fn gate11_disabled_hooks_and_original_await_count_controls_take_no_locks() {
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut disabled = presentation::Trace::new(false);
    disabled.lock_operations = Some(counter.clone());
    disabled.admit();
    disabled.consumed();
    disabled.expected(72, 70);
    disabled.gate(0);
    disabled.mark_at(1, presentation::Phase::Send, 1, 0, None);
    assert!(disabled.counted(2, 1, 1));
    for trace in [None, Some(&disabled)] {
        for phase in [
            presentation::Phase::Send,
            presentation::Phase::Read,
            presentation::Phase::Pace,
        ] {
            let (tx, rx) = tokio::sync::oneshot::channel::<usize>();
            let pending = presentation::await_phase(trace, phase, 2, 1, rx);
            tokio::pin!(pending);
            assert!(futures_util::poll!(&mut pending).is_pending());
            tx.send(42).unwrap();
            assert_eq!(pending.await.unwrap(), 42);
        }
        assert!(!presentation::counted(trace, 2, 1, 0));
        assert!(!presentation::counted(trace, 2, 1, 2));
        assert!(presentation::counted(trace, 2, 1, 1));
    }
    disabled
        .during(presentation::Phase::Read, 2, 1, async {})
        .await;
    assert_eq!(counter.load(Ordering::SeqCst), 0);
}

#[test]
fn gate11_latency_requires_diagnostics_and_closed_page_control() {
    let base = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,
        "presentation":true,"owner":"ab".repeat(32),"gate11_diagnostics":true,"native_latency":true});
    decode_control::<Start>(&serde_json::to_vec(&base).unwrap()).validate();
    for change in [json!(false), json!("true")] {
        let mut value = base.clone();
        value["gate11_diagnostics"] = change;
        assert!(
            std::panic::catch_unwind(|| decode_control::<Start>(
                &serde_json::to_vec(&value).unwrap()
            )
            .validate())
            .is_err()
        );
    }
    let page: Control = decode_control(br#"{"command":"gate11_latency","id":2,"page":0}"#);
    assert_eq!(page.id(), 2);
    for raw in [
        br#"{"command":"gate11_latency","id":0,"page":0}"#.as_slice(),
        br#"{"command":"gate11_latency","id":2,"page":0,"path":"private"}"#.as_slice(),
        br#"{"command":"gate11_latency","id":2,"page":0,"page":1}"#.as_slice(),
        br#"{"command":"gate11_latency","id":2,"page":-1}"#.as_slice(),
    ] {
        assert!(std::panic::catch_unwind(|| decode_control::<Control>(raw)).is_err());
    }
}

#[tokio::test]
async fn gate11_latency_real_independent_reader_and_frozen_bounded_pages() {
    use crate::storage::test_hooks::latency::{Collector, Stage};
    let (temp, db, writer) = independent().await;
    let mut writer = writer;
    sqlx::query("CREATE TABLE events(sequence INTEGER,event_id TEXT,event_type TEXT,event_version INTEGER,created_at_ms INTEGER,run_id TEXT,payload_json TEXT)").execute(&mut writer).await.unwrap();
    let c = Collector::new();
    let mut trace = presentation::Trace::new(true);
    trace.latency = Some(c.clone());
    trace.admit();
    let read = c.reader(1);
    let outer = read.span(Stage::Reader);
    assert!(read.scope(db.records()).await.is_empty());
    drop(outer);
    assert_eq!(trace.snapshot(1)["state"], "captured");
    assert_eq!(c.capture_state(), "captured");
    let (pages, first) = c.page(0).unwrap();
    assert!(pages <= 34);
    let all: Vec<_> = (0..pages).flat_map(|p| c.page(p).unwrap().1).collect();
    assert_eq!(all[1 + 24][2], 1);
    assert_eq!(all[1 + 25][2], 1);
    assert_eq!(all[1 + 26][2], 1);
    for p in 0..pages {
        let value = json!({"protocol":1,"event":"gate11_latency","state":"captured","id":p+1,"page":p,"pages":pages,"rows":c.page(p).unwrap().1});
        assert!(serde_json::to_vec(&value).unwrap().len() < LIMIT as usize);
    }
    assert_eq!(c.page(0).unwrap().1, first);
    assert!(serde_json::to_vec(&all).unwrap().len() < 48 * 1024);
    close(db, writer, temp).await;
}

#[test]
fn retired_start_keys_reject_before_setup_even_when_false() {
    let base = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,
        "owner":"ab".repeat(32)});
    for value in [
        json!(true),
        json!(false),
        Value::Null,
        json!(0),
        json!("false"),
    ] {
        let mut input = base.clone();
        input["read_reconnect"] = value;
        let mut setup_reached = false;
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let start: Start = decode_control(&serde_json::to_vec(&input).unwrap());
            start.validate();
            setup_reached = true;
        }));
        assert!(result.is_err() && !setup_reached);
    }
    for raw in [
        br#"{"id":1,"transport":"web_socket","recovered":false,"mime":true,"read_reconnect":false,"read_reconnect":true}"#.as_slice(),
        br#"{"id":1,"transport":"web_socket","recovered":false,"mime":true,"read_\u0072econnect":false}"#.as_slice(),
    ] {
        assert!(std::panic::catch_unwind(|| decode_control::<Start>(raw)).is_err());
    }
}

#[test]
fn retired_controls_reject_before_dispatch() {
    for step in ["pending", "arm", "written", "release", "retired", "inspect"] {
        let input = json!({"command":"read_reconnect","id":2,"step":step,"window":1,
            "subscription":1,"session_id":"11111111-1111-4111-8111-111111111111",
            "run_id":"22222222-2222-4222-8222-222222222222",
            "operation_id":"33333333-3333-4333-8333-333333333333"});
        let mut dispatch_reached = false;
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _: Control = decode_control(&serde_json::to_vec(&input).unwrap());
            dispatch_reached = true;
        }));
        assert!(result.is_err() && !dispatch_reached);
    }
    for raw in [
        br#"{"command":"read_reconnect","id":2}"#.as_slice(),
        br#"{"command":"read_reconnect","id":2,"id":3}"#.as_slice(),
        br#"{"command":"read_\u0072econnect","id":2}"#.as_slice(),
    ] {
        assert!(std::panic::catch_unwind(|| decode_control::<Control>(raw)).is_err());
    }
}

#[test]
fn retained_start_and_control_decoding_still_use_closed_inputs() {
    let base = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,
        "owner":"ab".repeat(32)});
    let mut scenarios = vec![
        base.clone(),
        json!({"id":1,"transport":"sse","recovered":true,
        "mime":false,"owner":"ab".repeat(32)}),
    ];
    for mode in [
        "presentation",
        "mutations",
        "tool_fidelity",
        "lifecycle_failure",
        "cancellation",
    ] {
        let mut input = base.clone();
        input[mode] = json!(true);
        scenarios.push(input);
    }
    for mode in ["unbound_history", "fixed_head"] {
        let mut input = base.clone();
        input["mutations"] = json!(true);
        input[mode] = json!(true);
        scenarios.push(input);
    }
    for input in scenarios {
        let start: Start = decode_control(&serde_json::to_vec(&input).unwrap());
        start.validate();
        assert_eq!(start.id, 1);
        let mut extra = input;
        extra["private"] = json!(false);
        assert!(
            std::panic::catch_unwind(|| {
                decode_control::<Start>(&serde_json::to_vec(&extra).unwrap())
            })
            .is_err()
        );
    }
    for command in [
        "inspect",
        "stop",
        "arm_cancellation",
        "inspect_cancellation",
        "arm_lifecycle_failure",
        "inspect_lifecycle_failure",
        "inspect_tool_fidelity",
    ] {
        let input = json!({"command":command,"id":2});
        let control: Control = decode_control(&serde_json::to_vec(&input).unwrap());
        assert_eq!(control.id(), 2);
        let mut extra = input;
        extra["private"] = json!(false);
        assert!(
            std::panic::catch_unwind(|| {
                decode_control::<Control>(&serde_json::to_vec(&extra).unwrap())
            })
            .is_err()
        );
    }
}

#[test]
fn final_polling_is_closed_requires_latency_and_selects_only_gate10() {
    let base = json!({"id":1,"transport":"web_socket","recovered":false,"mime":true,
        "presentation":true,"owner":"ab".repeat(32),"gate11_diagnostics":true,"native_latency":true});
    for mode in ["baseline", "incremental"] {
        let mut value = base.clone();
        value["final_polling"] = json!(mode);
        decode_control::<Start>(&serde_json::to_vec(&value).unwrap()).validate();
        for (key, change) in [
            ("native_latency", json!(false)),
            ("gate11_diagnostics", json!(false)),
            ("presentation", json!(false)),
            ("recovered", json!(true)),
            ("mime", json!(false)),
            ("transport", json!("sse")),
            ("mutations", json!(true)),
            ("fixed_head", json!(true)),
            ("unbound_history", json!(true)),
            ("tool_fidelity", json!(true)),
            ("lifecycle_failure", json!(true)),
            ("cancellation", json!(true)),
        ] {
            let mut invalid = value.clone();
            invalid[key] = change;
            assert!(
                std::panic::catch_unwind(|| decode_control::<Start>(
                    &serde_json::to_vec(&invalid).unwrap()
                )
                .validate())
                .is_err()
            );
        }
    }
    for mode in [Value::Null, json!(true), json!(0), json!("full"), json!({})] {
        let mut invalid = base.clone();
        invalid["final_polling"] = mode;
        assert!(
            std::panic::catch_unwind(|| decode_control::<Start>(
                &serde_json::to_vec(&invalid).unwrap()
            ))
            .is_err()
        );
    }
    let trace = presentation::Trace::new(true);
    assert!(trace.cursor("task-1-final").is_none());
    for gate in [1, 4, 7, 11, 12] {
        assert!(presentation::gate_trace(Some(&trace), gate).is_none());
    }
}

fn polling_runtime(sequence: u64, response: &str) -> Value {
    use crate::run::RunEventEnvelope;
    use crate::{DeltaKind, EventEnvelope};
    let run = RunId::new();
    let event = RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: crate::storage::StoredEventId::new().to_string(),
        run_id: run.to_string(),
        turn_id: Some("synthetic-turn".into()),
        session_id: Some("synthetic-session".into()),
        request_id: Some("synthetic-request".into()),
        event: RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence,
                event_id: "synthetic-provider".into(),
                session_id: "synthetic-session".into(),
                request_id: Some("synthetic-request".into()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event: ProviderEvent::OutputItemUpdated {
                    response_id: response.into(),
                    item_id: "synthetic-item".into(),
                    output_index: 0,
                    content_index: Some(0),
                    summary_index: None,
                    kind: DeltaKind::Text,
                    delta: "synthetic-private-text".into(),
                },
            }),
        },
    };
    json!({"sequence":sequence,"event_id":crate::storage::StoredEventId::new(),"event_type":"runtime.observed",
        "event_version":1,"created_at_ms":1,"run_id":run,"payload":event})
}
async fn polling_insert(writer: &mut SqliteConnection, row: &Value) {
    sqlx::query("INSERT INTO events VALUES(?,?,?,?,?,?,?)")
        .bind(row["sequence"].as_i64().unwrap())
        .bind(row["event_id"].as_str().unwrap())
        .bind(row["event_type"].as_str().unwrap())
        .bind(row["event_version"].as_i64().unwrap())
        .bind(row["created_at_ms"].as_i64().unwrap())
        .bind(row["run_id"].as_str())
        .bind(serde_json::to_string(&row["payload"]).unwrap())
        .execute(writer)
        .await
        .unwrap();
}
async fn polling_database() -> (tempfile::TempDir, Database, SqliteConnection) {
    let (temp, db, mut writer) = independent().await;
    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&mut writer)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE events(sequence INTEGER,event_id TEXT,event_type TEXT,event_version INTEGER,created_at_ms INTEGER,run_id TEXT,payload_json TEXT)").execute(&mut writer).await.unwrap();
    // A real creation supplies the immutable provenance; no joined producer is started.
    let store = SessionStore::open(temp.path().join("seed")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap())
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let page = session.history_page(0, None, 2).await.unwrap();
    let row = serde_json::to_value(&page.records()[0]).unwrap();
    *db.session.lock().unwrap() = Some(created.session_id().clone());
    polling_insert(&mut writer, &row).await;
    store.close().await.unwrap();
    (temp, db, writer)
}

#[tokio::test]
async fn final_polling_original_and_incremental_oracles_match_interleaved_rows_and_count_work() {
    use crate::storage::test_hooks::latency::{self, Collector, Stage};
    let (temp, db, mut writer) = polling_database().await;
    for sequence in 2..=65 {
        polling_insert(&mut writer, &polling_runtime(sequence, "task-0-final")).await;
    }
    let prefix = db.records().await;
    let mut trace = presentation::Trace::new(true);
    trace.latency = Some(Collector::new());
    trace.polling = Some(FinalPolling::Incremental);
    trace.bind_prefix(&prefix, "task-1-final");
    let mut cursor = trace.cursor("task-1-final").unwrap();
    let mut ordinary = presentation::ordinary_cursor(10, &prefix, None).unwrap();
    let full = Collector::new();
    let incremental = Collector::new();
    full.open();
    incremental.open();
    let mut sequence = 65;
    let mut full_rows = 0;
    let mut new_rows = 0;
    for delta in 1..=3 {
        // Polls before a commit see zero new rows and retain the cumulative exact count.
        let read = incremental.reader(delta);
        let outer = read.span(Stage::Reader);
        let rows = read.scope(db.records_after(cursor.sequence)).await;
        assert!(rows.is_empty());
        assert_eq!(
            cursor.observe(&rows, "task-1-final", delta as usize),
            delta as usize - 1
        );
        assert_eq!(
            ordinary.observe(&rows, "task-1-final", delta as usize),
            delta as usize - 1
        );
        read.work(latency::COMPLETED_READS, 1);
        drop(outer);
        for response in ["unrelated-final", "task-1-final", "another-final"] {
            sequence += 1;
            polling_insert(&mut writer, &polling_runtime(sequence, response)).await;
        }
        let read = full.reader(delta);
        let outer = read.span(Stage::Reader);
        let rows = read.scope(db.records()).await;
        full_rows += rows.len() as u64;
        let original = presentation::matching_updates(&rows, "task-1-final");
        assert_eq!(original, delta as usize);
        read.work(latency::COMPLETED_READS, 1);
        read.work(latency::BARRIERS, 1);
        drop(outer);
        let read = incremental.reader(delta);
        let outer = read.span(Stage::Reader);
        let rows = read.scope(db.records_after(cursor.sequence)).await;
        new_rows += rows.len() as u64;
        assert_eq!(
            cursor.observe(&rows, "task-1-final", delta as usize),
            original
        );
        assert_eq!(
            ordinary.observe(&rows, "task-1-final", delta as usize),
            original
        );
        assert_eq!(ordinary.sequence, sequence);
        assert_eq!(cursor.sequence, sequence);
        read.work(latency::COMPLETED_READS, 1);
        read.work(latency::BARRIERS, 1);
        drop(outer);
    }
    full.freeze();
    incremental.freeze();
    let all = |c: &Collector| {
        (0..c.page(0).unwrap().0)
            .flat_map(|p| c.page(p).unwrap().1)
            .collect::<Vec<_>>()
    };
    assert_eq!(all(&full)[31], vec![4, full_rows, full_rows, 3, 3]);
    assert_eq!(all(&incremental)[31], vec![4, new_rows, new_rows, 3, 6]);
    assert_eq!(new_rows, 9);
    assert_eq!(full_rows, 68 + 71 + 74);
    close(db, writer, temp).await;
}

#[tokio::test]
async fn final_polling_real_reply_keeps_frames_serial_barriers_and_full_default_oracle() {
    use crate::storage::test_hooks::latency::Collector;
    for (enabled, mode) in [
        (false, None),
        (true, None),
        (true, Some(FinalPolling::Baseline)),
        (true, Some(FinalPolling::Incremental)),
    ] {
        let (temp, db, mut writer) = polling_database().await;
        for sequence in 2..=65 {
            polling_insert(&mut writer, &polling_runtime(sequence, "task-0-final")).await;
        }
        let mut trace = presentation::Trace::new(enabled);
        let c = mode.map(|_| Collector::new());
        trace.latency = c.clone();
        trace.polling = mode;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        trace.lock_operations = Some(counter.clone());
        let prefix = db.records().await;
        trace.bind_prefix(&prefix, "task-1-final");
        let diagnostic = enabled.then_some(&trace);
        let cursor = presentation::ordinary_cursor(10, &prefix, diagnostic);
        assert_eq!(cursor.is_some(), mode.is_none());
        trace.admit();
        let mut wire = Wire::new(Transport::WebSocket).await;
        let address = wire.listener.local_addr().unwrap();
        let (client, server) = tokio::join!(
            tokio_tungstenite::connect_async(format!("ws://{address}")),
            async {
                let (socket, _) = wire.listener.accept().await.unwrap();
                tokio_tungstenite::accept_async(socket).await.unwrap()
            }
        );
        let (mut client, _) = client.unwrap();
        wire.websocket = Some(server);
        let mut frames = vec![events("task-1-final", vec![], false).remove(0)];
        frames.extend(presentation::partial("task-1-final", 1, 1));
        let frames_count = frames.len();
        assert_eq!(frames_count, 72);
        let expected = frames.clone();
        let peer = async {
            let mut sequence = 65;
            for expected in expected {
                let message = watch(client.next()).await.unwrap().unwrap();
                let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                assert_eq!(value, expected);
                if value.get("delta").is_some() {
                    // No next frame may pass an uncommitted delta's equality barrier.
                    assert!(
                        tokio::time::timeout(Duration::from_millis(15), client.next())
                            .await
                            .is_err()
                    );
                    for response in ["unrelated-final", "task-1-final"] {
                        sequence += 1;
                        polling_insert(&mut writer, &polling_runtime(sequence, response)).await;
                    }
                }
            }
        };
        tokio::join!(
            presentation::reply(&mut wire, &db, "task-1-final", frames, diagnostic, cursor),
            peer
        );
        if let Some(c) = c {
            c.freeze();
            let rows: Vec<_> = (0..c.page(0).unwrap().0)
                .flat_map(|p| c.page(p).unwrap().1)
                .collect();
            assert_eq!(rows[31][3], 70);
            assert!(rows[31][4] >= 70);
            assert_eq!(rows[31][1], rows[31][2]);
            if mode == Some(FinalPolling::Incremental) {
                assert_eq!(rows[31][1], 140);
            } else {
                assert!(rows[31][1] >= 65 * 70 + 140);
            }
        } else {
            assert!(trace.latency.is_none());
        }
        assert_eq!(
            presentation::matching_updates(&db.records().await, "task-1-final"),
            70
        );
        if enabled {
            assert_eq!(trace.snapshot(1)["trace"]["expected_frames"], frames_count);
            assert_eq!(trace.snapshot(1)["trace"]["expected_deltas"], 70);
        } else {
            assert_eq!(counter.load(Ordering::SeqCst), 0);
        }
        drop(client);
        drop(wire);
        close(db, writer, temp).await;
    }
}

#[tokio::test]
async fn final_polling_rejects_sequence_gaps_duplicates_overshoot_and_invalid_immutable_rows() {
    let (temp, db, mut writer) = polling_database().await;
    polling_insert(&mut writer, &polling_runtime(2, "task-1-final")).await;
    let records = db.records_after(1).await;
    for (sequence, committed, sent, rows) in [
        (0, 0, 1, records.clone()),
        (2, 0, 1, records.clone()),
        (1, 1, 1, records.clone()),
        (1, 0, 1, vec![records[0].clone(), records[0].clone()]),
    ] {
        let mut cursor = presentation::FinalCursor {
            sequence,
            committed,
        };
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| cursor.observe(
                &rows,
                "task-1-final",
                sent
            )))
            .is_err()
        );
    }
    for query in [
        "UPDATE events SET event_version=2 WHERE sequence=2",
        "UPDATE events SET sequence=0 WHERE sequence=2",
        "UPDATE events SET event_id='invalid' WHERE sequence=2",
        "UPDATE events SET payload_json='{}' WHERE sequence=2",
        "UPDATE events SET run_id=NULL WHERE sequence=2",
    ] {
        sqlx::query(query).execute(&mut writer).await.unwrap();
        // The independent reader sees committed rows only, including malformed unrelated rows.
        assert_eq!(failed(db.records()).await, FixtureFailure::EventsDecode);
        sqlx::query("DELETE FROM events WHERE sequence != 1")
            .execute(&mut writer)
            .await
            .unwrap();
        polling_insert(&mut writer, &polling_runtime(2, "task-1-final")).await;
    }
    sqlx::query("DELETE FROM events WHERE sequence=2")
        .execute(&mut writer)
        .await
        .unwrap();
    polling_insert(&mut writer, &polling_runtime(2, "unrelated-final")).await;
    sqlx::query("UPDATE events SET payload_json='{}' WHERE sequence=2")
        .execute(&mut writer)
        .await
        .unwrap();
    assert_eq!(
        failed(db.records_after(1)).await,
        FixtureFailure::EventsDecode
    );
    close(db, writer, temp).await;
}

#[tokio::test]
async fn final_polling_ordinary_prefix_and_selection_reject_invalid_seed_without_diagnostics() {
    let (temp, db, mut writer) = polling_database().await;
    polling_insert(&mut writer, &polling_runtime(2, "task-0-final")).await;
    let prefix = db.records().await;
    for enabled in [false, true] {
        let trace = presentation::Trace::new(enabled);
        assert!(trace.latency.is_none());
        for gate in [1, 4, 7, 11, 12] {
            assert!(presentation::ordinary_cursor(gate, &[], Some(&trace)).is_none());
        }
        let cursor = presentation::ordinary_cursor(10, &prefix, Some(&trace)).unwrap();
        assert_eq!((cursor.sequence, cursor.committed), (2, 0));
    }
    for rows in [
        vec![],
        vec![prefix[1].clone()],
        vec![prefix[0].clone(), prefix[0].clone()],
    ] {
        assert!(
            std::panic::catch_unwind(AssertUnwindSafe(|| presentation::ordinary_cursor(
                10, &rows, None
            )))
            .is_err()
        );
    }
    polling_insert(&mut writer, &polling_runtime(3, "task-1-final")).await;
    let prefix = db.records().await;
    assert!(
        std::panic::catch_unwind(AssertUnwindSafe(|| presentation::ordinary_cursor(
            10, &prefix, None
        )))
        .is_err()
    );
    close(db, writer, temp).await;
}

fn database(root: PathBuf) -> Database {
    Database {
        root,
        session: Arc::default(),
        read_failure: Arc::default(),
        reader: Arc::default(),
    }
}

async fn independent() -> (tempfile::TempDir, Database, SqliteConnection) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("audit.sqlite3");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .busy_timeout(Duration::ZERO)
        .disable_statement_logging();
    let writer = options.clone().connect().await.unwrap();
    let reader = options.read_only(true).connect().await.unwrap();
    let db = database(temp.path().to_owned());
    *db.reader.lock().await = Some(reader);
    *db.session.lock().unwrap() = Some(ApplicationSessionId::new());
    (temp, db, writer)
}

async fn close(db: Database, writer: SqliteConnection, temp: tempfile::TempDir) {
    db.reader
        .lock()
        .await
        .take()
        .unwrap()
        .close()
        .await
        .unwrap();
    writer.close().await.unwrap();
    temp.close().unwrap();
}

async fn failed(future: impl std::future::Future<Output = impl Sized>) -> FixtureFailure {
    let payload = AssertUnwindSafe(future).catch_unwind().await.err().unwrap();
    caught_failure(payload.as_ref())
}

#[tokio::test]
async fn real_connect_failure_and_selection_invariant_are_static() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path().to_owned());
    assert_eq!(
        failed(db.open(ApplicationSessionId::new())).await,
        FixtureFailure::ConnectOther
    );
    assert_eq!(*db.read_failure.lock().unwrap(), Some("connect_other"));
    let sid = ApplicationSessionId::new();
    let id = sid.as_str();
    let directory = temp.path().join("sessions").join(&id[..2]).join(id);
    std::fs::create_dir_all(&directory).unwrap();
    let mut writer = SqliteConnectOptions::new()
        .filename(directory.join("session.sqlite3"))
        .create_if_missing(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    sqlx::query("CREATE TABLE events(sequence INTEGER,event_id TEXT,event_type TEXT,event_version INTEGER,created_at_ms INTEGER,run_id TEXT,payload_json TEXT)")
        .execute(&mut writer).await.unwrap();
    assert_eq!(
        failed(db.open(sid)).await,
        FixtureFailure::SelectionInvariant
    );
    close(db, writer, temp).await;
}

#[tokio::test]
async fn independent_event_and_receipt_queries_classify_real_sql_errors() {
    let (temp, db, mut writer) = independent().await;
    assert_eq!(failed(db.records()).await, FixtureFailure::EventsQueryOther);
    assert_eq!(
        failed(db.receipts()).await,
        FixtureFailure::ReceiptsQueryOther
    );
    sqlx::query("CREATE TABLE events(sequence INTEGER,event_id TEXT,event_type TEXT,event_version INTEGER,created_at_ms INTEGER,run_id TEXT,payload_json TEXT)")
        .execute(&mut writer).await.unwrap();
    sqlx::query("CREATE TABLE commands(receipt_json TEXT,method TEXT,first_sequence INTEGER)")
        .execute(&mut writer)
        .await
        .unwrap();
    // Refresh the reader's schema before locking, so missing tables cannot mask busy.
    assert!(db.records().await.is_empty());
    assert!(db.receipts().await.is_empty());
    // The lock is already held, so no scheduling race is needed to obtain SQLITE_BUSY.
    sqlx::query("BEGIN EXCLUSIVE")
        .execute(&mut writer)
        .await
        .unwrap();
    assert_eq!(failed(db.records()).await, FixtureFailure::EventsQueryBusy);
    assert_eq!(
        failed(db.receipts()).await,
        FixtureFailure::ReceiptsQueryBusy
    );
    sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();
    close(db, writer, temp).await;
}

#[tokio::test]
async fn targeted_event_and_receipt_decoding_failures_do_not_become_sql_categories() {
    let (temp, db, mut writer) = independent().await;
    sqlx::query("CREATE TABLE events(sequence INTEGER,event_id TEXT,event_type TEXT,event_version INTEGER,created_at_ms INTEGER,run_id TEXT,payload_json TEXT)")
        .execute(&mut writer).await.unwrap();
    sqlx::query("INSERT INTO events VALUES(1,'synthetic','synthetic',1,1,NULL,'{')")
        .execute(&mut writer)
        .await
        .unwrap();
    assert_eq!(failed(db.records()).await, FixtureFailure::EventsDecode);
    sqlx::query("UPDATE events SET payload_json='{}'")
        .execute(&mut writer)
        .await
        .unwrap();
    assert_eq!(failed(db.records()).await, FixtureFailure::EventsDecode);
    sqlx::query("CREATE TABLE commands(receipt_json TEXT,method TEXT,first_sequence INTEGER)")
        .execute(&mut writer)
        .await
        .unwrap();
    sqlx::query("INSERT INTO commands VALUES('{','accept_history_run',1)")
        .execute(&mut writer)
        .await
        .unwrap();
    assert_eq!(failed(db.receipts()).await, FixtureFailure::ReceiptsDecode);
    assert_eq!(*db.read_failure.lock().unwrap(), None);
    close(db, writer, temp).await;
}

#[tokio::test]
async fn stale_shared_sql_failure_cannot_classify_an_unrelated_control_unwind() {
    let (temp, db, writer) = independent().await;
    let shared = db.clone();
    assert_eq!(
        tokio::spawn(async move { failed(shared.records()).await })
            .await
            .unwrap(),
        FixtureFailure::EventsQueryOther
    );
    assert_eq!(*db.read_failure.lock().unwrap(), Some("query_other"));
    assert_eq!(
        failed(async {
            decode_control::<Control>(b"{invalid\n");
        })
        .await,
        FixtureFailure::ControlOther
    );
    close(db, writer, temp).await;
}

#[test]
fn closed_terminal_delivery_and_broken_output_cannot_skip_cleanup() {
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }
    for failure in [
        FixtureFailure::ConnectBusy,
        FixtureFailure::ConnectOther,
        FixtureFailure::EventsQueryBusy,
        FixtureFailure::EventsQueryOther,
        FixtureFailure::EventsDecode,
        FixtureFailure::ReceiptsQueryBusy,
        FixtureFailure::ReceiptsQueryOther,
        FixtureFailure::ReceiptsDecode,
        FixtureFailure::SelectionInvariant,
        FixtureFailure::ControlOther,
    ] {
        let mut bytes = vec![];
        emit_failure(&mut bytes, failure);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let (phase, category) = failure.labels();
        assert_eq!(
            value,
            json!({"protocol":1,"event":"fixture_failed","phase":phase,"category":category})
        );
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert!(bytes.len() <= LIMIT as usize);
        let mut cleaned = false;
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            emit_failure(&mut Broken, failure);
            cleaned = true;
        }));
        assert!(result.is_ok() && cleaned);
    }
    let payload: Box<dyn std::any::Any + Send> = Box::new("synthetic-private-panic");
    assert_eq!(
        caught_failure(payload.as_ref()),
        FixtureFailure::ControlOther
    );
}
