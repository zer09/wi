use super::*;
use crate::{
    DeltaKind, EventEnvelope, ItemKind, OutputItem, ProviderEvent,
    conversation::{
        ActivityCursor, BlockCursor, ContentCursor, ConversationQuery, EntryPage,
        wire::{DisplayJson, ENTRY_BYTES, PAGE_BYTES},
    },
    run::{RunEvent, RunEventEnvelope, RunOutcome, RunRequest, RunResult, RunSummary},
    storage::{
        AppendRunRecord, RecordedRunInput, StorageErrorKind,
        test_hooks::{Action, Pause, Point},
    },
    tools::ToolExecutionEvent,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::collections::BTreeMap;

mod legacy;
mod limits;
mod security;
mod sse;
mod tools;

const REQUEST: &str = "01234567-89ab-5cde-8fab-0123456789ab";
const TURN: &str = "01234567-89ab-1cde-8fab-0123456789ab";

fn input(text: &str) -> RecordedRunInput {
    RecordedRunInput::new(
        text.into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic-model"),
            prompt: "private-prepared-prompt-canary".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

struct Writer {
    session: SessionHandle,
    run: RunId,
    sequence: u64,
}
impl Writer {
    async fn accept(session: &SessionHandle, text: &str) -> Self {
        let run = RunId::new();
        session
            .accept_run(OperationId::new(), run.clone(), input(text))
            .await
            .unwrap();
        Self {
            session: session.clone(),
            run,
            sequence: 0,
        }
    }
    async fn runtime(&mut self, event: RunEvent) {
        self.sequence += 1;
        let started = matches!(event, RunEvent::RunStarted);
        let no_turn = started || matches!(event, RunEvent::RunFinished { .. });
        let no_request = started || matches!(event, RunEvent::TurnStarted { .. });
        self.session
            .append_run_records(
                OperationId::new(),
                self.run.clone(),
                vec![AppendRunRecord::Runtime(RunEventEnvelope {
                    schema_version: 2,
                    sequence: self.sequence,
                    event_id: uuid::Uuid::new_v4().to_string(),
                    run_id: self.run.to_string(),
                    turn_id: (!no_turn).then(|| TURN.into()),
                    session_id: (!started).then(|| "private-provider-session-canary".into()),
                    request_id: (!no_request).then(|| REQUEST.into()),
                    event,
                })],
            )
            .await
            .unwrap();
    }
    async fn provider(&mut self, event: ProviderEvent) {
        self.runtime(RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence: self.sequence + 1,
                event_id: "private-native-canary".into(),
                session_id: "private-provider-session-canary".into(),
                request_id: Some(REQUEST.into()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event,
            }),
        })
        .await;
    }
    async fn start(&mut self) {
        self.runtime(RunEvent::RunStarted).await;
        self.runtime(RunEvent::TurnStarted { number: 1 }).await;
        self.provider(ProviderEvent::ResponseStarted {
            response_id: "private-response-canary".into(),
        })
        .await;
    }
    async fn delta(&mut self, index: u64, text: &str) {
        self.provider(ProviderEvent::OutputItemUpdated {
            response_id: "private-response-canary".into(),
            item_id: format!("private-item-{index}"),
            output_index: index,
            summary_index: None,
            content_index: Some(0),
            kind: DeltaKind::Text,
            delta: text.into(),
        })
        .await;
    }
    async fn result(&self) {
        self.session
            .append_run_records(
                OperationId::new(),
                self.run.clone(),
                vec![AppendRunRecord::Result(RunResult {
                    run_id: self.run.to_string(),
                    session_id: (self.sequence > 0)
                        .then(|| "private-provider-session-canary".into()),
                    outcome: RunOutcome::Failed {
                        code: "event_sink".into(),
                    },
                    summary: RunSummary::default(),
                    last_response: None,
                    events_complete: false,
                    sink_error: None,
                })],
            )
            .await
            .unwrap();
    }
}

fn base(session: &SessionHandle) -> String {
    format!("/v1/sessions/{}/conversation", session.session_id())
}
fn addressed(session: &SessionHandle, run: &RunId, entry: impl std::fmt::Display) -> String {
    format!(
        "{}/entries/{run}/{}",
        base(session),
        entry.to_string().replace(':', "%3A")
    )
}
async fn exact(request: reqwest::RequestBuilder, wire: DisplayJson<'_>) -> Value {
    let expected = wire.encode().unwrap();
    let reply = request.send().await.unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    for (name, value) in [
        (header::CONTENT_TYPE, "application/json"),
        (header::CACHE_CONTROL, "no-store"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::VARY, "Origin"),
    ] {
        assert_eq!(reply.headers()[name], value);
    }
    let bytes = reply.bytes().await.unwrap();
    assert_eq!(bytes.as_ref(), expected);
    assert!(bytes.len() <= PAGE_BYTES);
    let text = std::str::from_utf8(&bytes).unwrap();
    for private in [
        TOKEN,
        "private-prepared-prompt-canary",
        "private-native-canary",
        "private-provider-session-canary",
        "private-response-canary",
        "private-item-",
    ] {
        assert!(!text.contains(private));
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["api_version"], 1);
    assert_eq!(value["conversation_version"], 1);
    println!("b1 HTTP bytes={}", bytes.len());
    value
}
fn bounded(entry: &crate::conversation::EntryView) {
    assert!(DisplayJson::Entry(entry).encode().unwrap().len() <= ENTRY_BYTES);
    assert!(entry.fields().len() <= 64);
}
async fn sql(server: &Server, session: &SessionHandle) -> SqliteConnection {
    let id = session.session_id().as_str();
    let path = server
        .temp
        .path()
        .join("private-data-canary")
        .join(format!("sessions/{}/{id}/session.sqlite3", &id[..2]));
    SqliteConnectOptions::new()
        .filename(path)
        .foreign_keys(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}
async fn snapshot(server: &Server, session: &SessionHandle) -> Vec<String> {
    let mut sql = sql(server, session).await;
    let mut values = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM (SELECT * FROM runs ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,call_id,tool_name,request_id,started_sequence,finished_sequence,result_sequence,is_error,output)) FROM (SELECT * FROM tool_results ORDER BY run_id,call_id)",
        "SELECT json_group_array(json_array(singleton,format_version,applied_sequence,metadata_sequence)) FROM conversation_projection",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,changed_sequence,header_json)) FROM (SELECT * FROM conversation_blocks ORDER BY run_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,hex(source_key),first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json)) FROM (SELECT * FROM conversation_entries ORDER BY run_id,entry_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json)) FROM (SELECT * FROM conversation_fields ORDER BY run_id,entry_id,field_id)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,start_byte,hex(bytes))) FROM (SELECT * FROM conversation_chunks ORDER BY run_id,entry_id,field_id,start_byte)",
    ] {
        values.push(sqlx::query_scalar(query).fetch_one(&mut sql).await.unwrap());
    }
    sql.close().await.unwrap();
    values
}

#[tokio::test]
async fn b1_empty_created_and_renamed_latest_keep_full_nested_session() {
    let server = Server::new().await;
    let session = server.session().await;
    for renamed in [false, true] {
        if renamed {
            session
                .rename(OperationId::new(), "renamed 雪\0".into())
                .await
                .unwrap();
        }
        let page = session
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        let body = exact(server.get(&base(&session)), DisplayJson::Page(&page)).await;
        assert_eq!(body["block"], Value::Null);
        assert_eq!(body["entries"], json!([]));
        assert_eq!(body["session"]["api_version"], 1);
        assert_eq!(body["session"]["view"], "canonical");
        assert_eq!(body["session"]["workspace"], server.workspace());
        assert_eq!(body["session"]["title"], page.session().title());
        assert_eq!(body["session"].as_object().unwrap().len(), 8);
        assert_eq!(body["snapshot_head"], body["session"]["head_sequence"]);
        assert!(body["live_after"].is_string());
    }
    server.finish().await;
}

#[tokio::test]
async fn b1_latest_b_before_a_within_b_order_exact_bytes_and_warm_immutability() {
    let server = Server::new().await;
    let session = server.session().await;
    let a = Writer::accept(&session, "Task A").await;
    a.result().await;
    let mut b = Writer::accept(&session, "Task B\0雪").await;
    b.start().await;
    for index in 0..70 {
        b.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: format!("call-{index}"),
                tool_name: "synthetic".into(),
            },
        })
        .await;
    }
    let before = snapshot(&server, &session).await;
    let page = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let body = exact(server.get(&base(&session)), DisplayJson::Page(&page)).await;
    assert_eq!(body["block"]["run_id"], b.run.as_str());
    assert_eq!(body["block"]["human"]["fields"][0]["text"], "Task B\0雪");
    assert_eq!(page.entries().len(), 64);
    let mut positions = Vec::new();
    for entry in page.entries() {
        bounded(entry);
        positions.push(*entry.position());
    }
    let mut older = page.earlier_activity().cloned();
    while let Some(cursor) = older {
        let page = session
            .conversation_page(ConversationQuery::Within(cursor.clone()))
            .await
            .unwrap();
        let body = exact(
            server.get(&format!("{}?within={cursor}", base(&session))),
            DisplayJson::Page(&page),
        )
        .await;
        assert_eq!(body["live_after"], Value::Null);
        assert_eq!(page.block().unwrap().run_id(), &b.run);
        assert!(
            page.entries()
                .iter()
                .all(|entry| entry.kind() != crate::conversation::EntryKind::Human)
        );
        let previous: Vec<_> = page
            .entries()
            .iter()
            .map(|entry| *entry.position())
            .collect();
        positions.splice(0..0, previous);
        older = page.earlier_activity().cloned();
    }
    assert_eq!(positions.len(), 71);
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    let cursor = page.previous_block().unwrap();
    let old = session
        .conversation_page(ConversationQuery::Before(cursor.clone()))
        .await
        .unwrap();
    let body = exact(
        server.get(&format!("{}?before={cursor}", base(&session))),
        DisplayJson::Page(&old),
    )
    .await;
    assert_eq!(body["block"]["run_id"], a.run.as_str());
    assert_eq!(body["live_after"], Value::Null);
    assert!(old.previous_block().is_none());
    let end = BlockCursor::new(
        session.session_id().clone(),
        old.block().unwrap().accepted_sequence(),
    )
    .unwrap();
    let empty = session
        .conversation_page(ConversationQuery::Before(end.clone()))
        .await
        .unwrap();
    assert!(empty.block().is_none());
    exact(
        server.get(&format!("{}?before={end}", base(&session))),
        DisplayJson::Page(&empty),
    )
    .await;
    assert_eq!(snapshot(&server, &session).await, before);
    server.finish().await;
}

async fn restore(
    server: &Server,
    session: &SessionHandle,
    mut page: EntryPage,
) -> BTreeMap<String, String> {
    let mut restored = BTreeMap::new();
    let mut previous = None;
    let mut reads = 0;
    loop {
        bounded(page.entry());
        bounded(page.block().human());
        for field in page.entry().fields() {
            let value = restored
                .entry(field.field_id().to_owned())
                .or_insert_with(String::new);
            value.insert_str(0, field.text());
        }
        reads += 1;
        let Some(cursor) = page.entry().earlier_content().cloned() else {
            break;
        };
        assert_ne!(previous.as_ref(), Some(&cursor));
        previous = Some(cursor.clone());
        page = session.conversation_content(cursor.clone()).await.unwrap();
        let body = exact(
            server.get(&format!("{}/content?cursor={cursor}", base(session))),
            DisplayJson::EntryPage(&page),
        )
        .await;
        assert!(body.get("live_after").is_none());
        assert!(reads < 500);
    }
    println!(
        "b1 restored content reads={reads} fields={} bytes={}",
        restored.len(),
        restored.values().map(String::len).sum::<usize>()
    );
    restored
}

#[tokio::test]
async fn b1_large_human_escape_unicode_nul_and_many_fields_progress_with_exact_limits() {
    let server = Server::new().await;
    let session = server.session().await;
    let text = "雪é\0\\\"\r\n".repeat(12000);
    let mut writer = Writer::accept(&session, &text).await;
    writer.start().await;
    writer.delta(0, &text).await;
    for index in 1..85 {
        writer
            .delta(index, if index % 2 == 0 { "" } else { "field 雪\0" })
            .await;
    }
    let before = snapshot(&server, &session).await;
    let latest = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    exact(server.get(&base(&session)), DisplayJson::Page(&latest)).await;
    for id in [
        latest.block().unwrap().human().entry_id(),
        latest.entries()[0].entry_id(),
    ] {
        let page = session
            .conversation_entry(writer.run.clone(), *id)
            .await
            .unwrap();
        exact(
            server.get(&addressed(&session, &writer.run, id)),
            DisplayJson::EntryPage(&page),
        )
        .await;
        let fields = restore(&server, &session, page).await;
        if id == latest.block().unwrap().human().entry_id() {
            assert_eq!(fields["text"], text);
        } else {
            assert_eq!(fields.len(), 85);
            assert_eq!(fields.values().filter(|s| s.as_str() == text).count(), 1);
            assert_eq!(fields.values().filter(|s| s.is_empty()).count(), 42);
            assert_eq!(
                fields
                    .values()
                    .filter(|s| s.as_str() == "field 雪\0")
                    .count(),
                42
            );
        }
    }
    assert_eq!(snapshot(&server, &session).await, before);
    server.finish().await;
}

fn changed(cursor: &ContentCursor, index: usize, value: Value) -> String {
    let token = cursor.to_string();
    let mut fields: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(token.strip_prefix("g11c.").unwrap())
            .unwrap(),
    )
    .unwrap();
    fields[index] = value;
    format!("g11c.{}", URL_SAFE_NO_PAD.encode(fields.to_string()))
}

#[tokio::test]
async fn b1_cursor_current_append_compatible_stale_future_wrong_resource_and_missing() {
    let server = Server::new().await;
    let session = server.session().await;
    let mut writer = Writer::accept(&session, "anchor").await;
    writer.start().await;
    writer.delta(0, &"雪\0".repeat(20000)).await;
    let first = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let entry = first.entries()[0].entry_id();
    let cursor = first.entries()[0].earlier_content().unwrap().clone();
    let old = session.conversation_content(cursor.clone()).await.unwrap();
    writer.delta(0, "appended 🦀").await;
    let now = session.conversation_content(cursor.clone()).await.unwrap();
    assert_eq!(
        old.entry().fields()[0].text(),
        now.entry().fields()[0].text()
    );
    assert_eq!(
        now.entry().fields()[0].to_byte(),
        cursor.exclusive_upper_byte()
    );
    exact(
        server.get(&format!("{}/content?cursor={cursor}", base(&session))),
        DisplayJson::EntryPage(&now),
    )
    .await;
    for (index, value, status, code) in [
        (
            1,
            json!(ApplicationSessionId::new()),
            400,
            "api.conversation_cursor_invalid",
        ),
        (
            2,
            json!(RunId::new()),
            400,
            "api.conversation_cursor_invalid",
        ),
        (
            3,
            json!(format!("e:{}:1", entry.first_sequence())),
            404,
            "storage.not_found",
        ),
        (
            3,
            json!("e:99999:0"),
            400,
            "api.conversation_cursor_invalid",
        ),
        (
            4,
            json!((now.snapshot_head() + 1).to_string()),
            400,
            "api.conversation_cursor_invalid",
        ),
        (
            5,
            json!("f".repeat(64)),
            400,
            "api.conversation_cursor_invalid",
        ),
        (
            6,
            json!((now.snapshot_head() + 1).to_string()),
            400,
            "api.conversation_cursor_invalid",
        ),
        (7, json!("1"), 400, "api.conversation_cursor_invalid"),
        (7, json!("9999999"), 400, "api.conversation_cursor_invalid"),
    ] {
        let bad = changed(&cursor, index, value);
        error(
            server.get(&format!("{}/content?cursor={bad}", base(&session))),
            status,
            code,
        )
        .await;
    }
    for boundary in [1, now.snapshot_head() + 1] {
        let bad = BlockCursor::new(session.session_id().clone(), boundary).unwrap();
        error(
            server.get(&format!("{}?before={bad}", base(&session))),
            400,
            "api.conversation_cursor_invalid",
        )
        .await;
    }
    let bad =
        ActivityCursor::new(session.session_id().clone(), writer.run.clone(), 99999, 0).unwrap();
    error(
        server.get(&format!("{}?within={bad}", base(&session))),
        400,
        "api.conversation_cursor_invalid",
    )
    .await;
    let other = server.session().await;
    error(
        server.get(&format!("{}/content?cursor={cursor}", base(&other))),
        400,
        "api.conversation_cursor_invalid",
    )
    .await;
    error(
        server.get(&addressed(&session, &writer.run, "e:99999:0")),
        404,
        "storage.not_found",
    )
    .await;
    error(
        server.get(&addressed(&session, &RunId::new(), entry)),
        404,
        "storage.not_found",
    )
    .await;
    error(
        server.get(&format!(
            "/v1/sessions/{}/conversation",
            ApplicationSessionId::new()
        )),
        404,
        "storage.not_found",
    )
    .await;
    writer
        .provider(ProviderEvent::OutputItemFinished {
            response_id: "private-response-canary".into(),
            output_index: 0,
            item: OutputItem {
                id: Some("replacement".into()),
                kind: ItemKind::Message,
                native_type: "message".into(),
                function_call: None,
                native: json!({"content":[{"type":"refusal","refusal":"replacement"}]}),
            },
        })
        .await;
    error(
        server.get(&format!("{}/content?cursor={cursor}", base(&session))),
        409,
        "api.conversation_cursor_stale",
    )
    .await;
    let fresh = session
        .conversation_entry(writer.run.clone(), *entry)
        .await
        .unwrap();
    exact(
        server.get(&addressed(&session, &writer.run, entry)),
        DisplayJson::EntryPage(&fresh),
    )
    .await;
    server.finish().await;
}

#[tokio::test]
async fn b1_projection_and_tool_scalar_damage_remain_storage_errors_without_repair() {
    for damage in [
        "DROP INDEX conversation_entries_order",
        "UPDATE conversation_projection SET applied_sequence=1",
        "UPDATE conversation_entries SET metadata_json=json_set(metadata_json,'$.is_error',true) WHERE kind='tool'",
        "UPDATE conversation_entries SET source_key=zeroblob(32) WHERE kind='human'",
    ] {
        let server = Server::new().await;
        let session = server.session().await;
        let mut writer = Writer::accept(&session, "anchor").await;
        writer.start().await;
        writer
            .runtime(RunEvent::ToolEvent {
                event: ToolExecutionEvent::ToolExecutionStarted {
                    call_id: "pending".into(),
                    tool_name: "synthetic".into(),
                },
            })
            .await;
        let latest = session
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        let entry = latest.entries().last().unwrap().entry_id();
        let mut sql = sql(&server, &session).await;
        sqlx::query(damage).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = snapshot(&server, &session).await;
        for path in [base(&session), addressed(&session, &writer.run, entry)] {
            error(server.get(&path), 500, "storage.integrity").await;
        }
        assert_eq!(snapshot(&server, &session).await, before);
        server.finish().await;
    }
}

#[tokio::test]
async fn b1_http_snapshot_owned_read_write_and_shutdown_release_storage() {
    let server = Server::new().await;
    let session = server.session().await;
    let writer = Writer::accept(&session, "anchor").await;
    let expected = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let pause = Arc::new(Pause::default());
    session.test_hooks().arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let request = server.get(&base(&session));
    let reader = tokio::spawn(async move { exact(request, DisplayJson::Page(&expected)).await });
    watchdog(pause.reached.notified()).await;
    let handle = session.clone();
    let write = tokio::spawn(async move {
        handle
            .rename(OperationId::new(), "later title".into())
            .await
    });
    tokio::task::yield_now().await;
    assert!(!write.is_finished());
    pause.release.notify_one();
    watchdog(reader).await.unwrap();
    watchdog(write).await.unwrap().unwrap();
    // The delivered bytes do not own SQL: another write succeeds before the client drains them.
    let reply = server.get(&base(&session)).send().await.unwrap();
    writer.result().await;
    let bytes = reply.bytes().await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["session"]["title"],
        "later title"
    );
    let pause = Arc::new(Pause::default());
    session.test_hooks().arm(
        Point::ConversationHeadCaptured,
        Action::Pause(pause.clone()),
    );
    let request = server.get(&base(&session));
    let read = tokio::spawn(async move { request.send().await });
    watchdog(pause.reached.notified()).await;
    let close = server.host.begin_shutdown();
    let waiter = close.clone();
    let shutdown = tokio::spawn(async move { waiter.wait().await });
    tokio::task::yield_now().await;
    assert!(!shutdown.is_finished());
    pause.release.notify_one();
    watchdog(read).await.unwrap().unwrap();
    assert!(matches!(
        &*watchdog(shutdown).await.unwrap(),
        crate::service::ShutdownOutcome::Closed
    ));
    server.finish().await;
}
