use super::*;
use crate::{
    SessionOptions,
    run::RunRequest,
    storage::{
        ApplicationSessionId, CreateSession, OperationId, SessionStore, StoredEventId, filesystem,
    },
};
use sqlx::{ConnectOptions, Connection, sqlite::SqliteConnectOptions};

pub(super) struct Fixture {
    pub(super) sql: SqliteConnection,
    pub(super) run: RunId,
    pub(super) sequence: u64,
    pub(super) session: ApplicationSessionId,
    pub(super) path: std::path::PathBuf,
    _root: tempfile::TempDir,
}
impl Fixture {
    pub(super) async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("store");
        let store = SessionStore::open(path.clone()).await.unwrap();
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let session = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let run = RunId::new();
        session
            .accept_run(OperationId::new(), run.clone(), input())
            .await
            .unwrap();
        let db = filesystem::session_path(&path, created.session_id(), false).unwrap();
        store.close().await.unwrap();
        let sql = SqliteConnectOptions::new()
            .filename(&db)
            .foreign_keys(true)
            .disable_statement_logging()
            .connect()
            .await
            .unwrap();
        Self {
            sql,
            run,
            sequence: 2,
            session: created.session_id().clone(),
            path: db,
            _root: root,
        }
    }
    pub(super) async fn append(&mut self, record: AppendRunRecord) {
        let (kind, payload) = match &record {
            AppendRunRecord::Runtime(runtime) => {
                ("runtime.observed", serde_json::to_value(runtime).unwrap())
            }
            AppendRunRecord::ProviderBinding(binding) => {
                ("run.provider.bound", serde_json::to_value(binding).unwrap())
            }
            AppendRunRecord::ToolResult {
                request_id,
                call_id,
                output,
                is_error,
            } => (
                "tool.result.recorded",
                json!({"request_id":request_id,"call_id":call_id,"output":output,"is_error":is_error}),
            ),
            AppendRunRecord::Result(result) => {
                ("run.result.recorded", serde_json::to_value(result).unwrap())
            }
        };
        let stored = self.stored(kind, payload, true);
        let mut transaction = self.sql.begin().await.unwrap();
        insert(&mut transaction, &stored).await;
        apply(
            &mut transaction,
            Event::record(stored.sequence(), &self.run, &record).unwrap(),
        )
        .await
        .unwrap();
        transaction.commit().await.unwrap();
        self.sequence = stored.sequence();
    }
    pub(super) fn stored(&self, kind: &str, payload: serde_json::Value, run: bool) -> StoredEvent {
        serde_json::from_value(json!({
            "schema_version":1,"application_session_id":self.session,"sequence":self.sequence+1,
            "event_id":StoredEventId::new(),"created_at_ms":1,"event_version":1,
            "run_id":if run {Some(&self.run)} else {None},"event_type":kind,"payload":payload,
        }))
        .unwrap()
    }
    pub(super) async fn stored_event(&mut self, kind: &str, payload: serde_json::Value, run: bool) {
        let stored = self.stored(kind, payload, run);
        let mut transaction = self.sql.begin().await.unwrap();
        insert(&mut transaction, &stored).await;
        apply(&mut transaction, Event::try_from(&stored).unwrap())
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        self.sequence = stored.sequence();
    }
    pub(super) async fn runtime(&mut self, turn: Option<&str>, event: RunEvent) {
        let no_request = matches!(event, RunEvent::RunStarted | RunEvent::TurnStarted { .. });
        let envelope = RunEventEnvelope {
            schema_version: 2,
            sequence: self.sequence,
            event_id: StoredEventId::new().as_str().into(),
            run_id: self.run.as_str().into(),
            session_id: if matches!(event, RunEvent::RunStarted) {
                None
            } else {
                Some("synthetic-provider-session".into())
            },
            request_id: if no_request {
                None
            } else {
                Some(format!("request-{}", turn.unwrap_or("final")))
            },
            turn_id: turn.map(str::to_owned),
            event,
        };
        self.append(AppendRunRecord::Runtime(envelope)).await;
    }
    pub(super) async fn provider(&mut self, turn: &str, event: ProviderEvent) {
        self.runtime(
            Some(turn),
            RunEvent::ProviderEvent {
                event: Box::new(EventEnvelope {
                    schema_version: 1,
                    sequence: self.sequence,
                    event_id: StoredEventId::new().as_str().into(),
                    session_id: "synthetic-provider-session".into(),
                    request_id: Some(format!("request-{turn}")),
                    provider: "synthetic".into(),
                    provider_sequence: Some(u64::MAX),
                    event,
                }),
            },
        )
        .await;
    }
    pub(super) async fn start(&mut self) {
        self.runtime(None, RunEvent::RunStarted).await;
        self.runtime(Some("t1"), RunEvent::TurnStarted { number: 1 })
            .await;
    }
    pub(super) async fn assistant(&mut self, turn: &str) -> rows::Entry {
        rows::lookup(
            &mut self.sql,
            &self.run,
            self.sequence,
            &Source::Assistant {
                turn_id: turn.into(),
            },
        )
        .await
        .unwrap()
        .unwrap()
    }
    pub(super) async fn tool(&mut self, call: &str) -> rows::Entry {
        rows::lookup(
            &mut self.sql,
            &self.run,
            self.sequence,
            &Source::Tool {
                call_id: call.into(),
            },
        )
        .await
        .unwrap()
        .unwrap()
    }
    pub(super) async fn fields(&mut self, entry: EntryId) -> Vec<(String, String, u64)> {
        let rows = sqlx::query("SELECT field_id,kind,generation FROM conversation_fields WHERE run_id=? AND entry_id=? ORDER BY order_key")
            .bind(self.run.as_str()).bind(entry.to_string()).fetch_all(&mut self.sql).await.unwrap();
        let mut result = vec![];
        for row in rows {
            let id: String = row.get("field_id");
            let chunks: Vec<Vec<u8>> = sqlx::query_scalar("SELECT bytes FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? ORDER BY start_byte")
                .bind(self.run.as_str()).bind(entry.to_string()).bind(id).fetch_all(&mut self.sql).await.unwrap();
            result.push((
                row.get("kind"),
                String::from_utf8(chunks.concat()).unwrap(),
                row.get::<i64, _>("generation") as u64,
            ));
        }
        result
    }
    pub(super) async fn dump(&mut self) -> Vec<String> {
        let mut result = Vec::new();
        for query in [
            "SELECT json_array(singleton,format_version,applied_sequence,metadata_sequence) FROM conversation_projection ORDER BY 1",
            "SELECT json_array(run_id,accepted_sequence,changed_sequence,header_json) FROM conversation_blocks ORDER BY 1",
            "SELECT json_array(run_id,entry_id,hex(source_key),first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json) FROM conversation_entries ORDER BY 1",
            "SELECT json_array(run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json) FROM conversation_fields ORDER BY 1",
            "SELECT json_array(run_id,entry_id,field_id,start_byte,hex(bytes)) FROM conversation_chunks ORDER BY 1",
        ] {
            let rows: Vec<String> = sqlx::query_scalar(query)
                .fetch_all(&mut self.sql)
                .await
                .unwrap();
            result.extend(rows);
        }
        result
    }
    pub(super) async fn visible_and_metadata(&mut self) -> String {
        let chunks: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT bytes FROM conversation_chunks ORDER BY run_id,entry_id,field_id,start_byte",
        )
        .fetch_all(&mut self.sql)
        .await
        .unwrap();
        let mut text = String::from_utf8(chunks.concat()).unwrap();
        text.push_str(&self.dump().await.join(""));
        text
    }
    pub(super) async fn close(self) {
        self.sql.close().await.unwrap();
    }
}

pub(super) fn input() -> RecordedRunInput {
    RecordedRunInput::new(
        " exact\0用户\n\u{1b} ".into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic"),
            prompt: "PRIVATE_PREPARED_CANARY".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}

pub(super) async fn insert(sql: &mut SqliteConnection, event: &StoredEvent) {
    let json = serde_json::to_value(event).unwrap();
    let runtime = match event.payload() {
        StoredEventPayload::RuntimeObserved(event) => Some(event),
        _ => None,
    };
    sqlx::query("INSERT INTO main.events (sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json) VALUES (?,?,?,1,1,?,?,?,?)")
        .bind(event.sequence() as i64).bind(event.event_id().as_str()).bind(event.event_type()).bind(event.run_id().map(RunId::as_str))
        .bind(runtime.map(|event|event.event_id.as_str())).bind(runtime.map(|event|event.sequence as i64)).bind(json["payload"].to_string())
        .execute(&mut *sql).await.unwrap();
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(event.sequence() as i64)
        .execute(sql)
        .await
        .unwrap();
}

pub(super) fn delta(
    output: u64,
    summary: Option<u64>,
    content: Option<u64>,
    kind: DeltaKind,
    text: &str,
) -> ProviderEvent {
    ProviderEvent::OutputItemUpdated {
        response_id: "repeated".into(),
        item_id: format!("item-{output}"),
        output_index: output,
        summary_index: summary,
        content_index: content,
        kind,
        delta: text.into(),
    }
}
pub(super) fn message(text: &str) -> OutputItem {
    OutputItem {
        id: Some("item".into()),
        kind: ItemKind::Message,
        native_type: "message".into(),
        function_call: None,
        native: json!({"content":[{"type":"output_text","text":text,"private":"PRIVATE_NATIVE_CANARY"}],"private":"PRIVATE_NATIVE_CANARY"}),
    }
}
pub(super) fn response(output: Vec<OutputItem>, text: &str) -> ModelResponse {
    ModelResponse {
        id: "repeated".into(),
        model: Some("synthetic".into()),
        output,
        text: text.into(),
        outcome: ResponseOutcome::Completed,
        output_provenance: OutputProvenance::NativeTerminal,
        usage: None,
        native: json!({"output":[],"private":"PRIVATE_NATIVE_CANARY"}),
    }
}
pub(super) fn summary() -> RunSummary {
    RunSummary {
        turns_started: u64::MAX,
        ..Default::default()
    }
}
