use super::*;
use crate::{
    DeltaKind, EventEnvelope, ProviderEvent, SessionOptions,
    run::{RunEvent, RunRequest},
    storage::{
        CreateSession, OperationId, RecordedRunInput, SessionHandle, SessionStore, identifier_tests,
    },
};
use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};

pub(in crate::storage::conversation::reads) const REQUEST: &str =
    "01234567-89ab-5cde-8fab-0123456789ab";

pub(in crate::storage::conversation::reads) struct Fixture {
    pub(in crate::storage::conversation::reads) store: SessionStore,
    pub(in crate::storage::conversation::reads) handle: SessionHandle,
    pub(in crate::storage::conversation::reads) run: RunId,
    pub(in crate::storage::conversation::reads) path: std::path::PathBuf,
    pub(in crate::storage::conversation::reads) sequence: u64,
    _temp: tempfile::TempDir,
}
impl Fixture {
    pub(in crate::storage::conversation::reads) async fn new(text: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("synthetic");
        let store = SessionStore::open(root.clone()).await.unwrap();
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let handle = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let run: RunId = "01234567-89ab-1cde-8fab-1123456789ab".parse().unwrap();
        handle
            .accept_run(OperationId::new(), run.clone(), input(text))
            .await
            .unwrap();
        let path =
            crate::storage::filesystem::session_path(&root, handle.session_id(), false).unwrap();
        Self {
            store,
            handle,
            run,
            path,
            sequence: 0,
            _temp: temp,
        }
    }
    pub(in crate::storage::conversation::reads) async fn runtime(&mut self, event: RunEvent) {
        self.sequence += 1;
        let record = identifier_tests::runtime(&self.run, self.sequence, event);
        self.handle
            .append_run_records(OperationId::new(), self.run.clone(), vec![record])
            .await
            .unwrap();
    }
    pub(in crate::storage::conversation::reads) async fn provider(&mut self, event: ProviderEvent) {
        self.runtime(RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence: self.sequence + 1,
                event_id: "PRIVATE_NATIVE_ENVELOPE".into(),
                session_id: "opaque-local-session".into(),
                request_id: Some(REQUEST.into()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event,
            }),
        })
        .await;
    }
    pub(in crate::storage::conversation::reads) async fn start(&mut self) {
        self.runtime(RunEvent::RunStarted).await;
        self.runtime(RunEvent::TurnStarted { number: 1 }).await;
        self.provider(ProviderEvent::ResponseStarted {
            response_id: "PRIVATE_RESPONSE_".repeat(10000),
        })
        .await;
    }
    pub(in crate::storage::conversation::reads) async fn delta(&mut self, index: u64, text: &str) {
        self.provider(ProviderEvent::OutputItemUpdated {
            response_id: "PRIVATE_RESPONSE_".repeat(10000),
            item_id: format!("PRIVATE_ITEM_{index}"),
            output_index: index,
            summary_index: None,
            content_index: Some(0),
            kind: DeltaKind::Text,
            delta: text.into(),
        })
        .await;
    }
    pub(in crate::storage::conversation::reads) async fn sql(&self) -> SqliteConnection {
        connect(&self.path).await
    }
    pub(in crate::storage::conversation::reads) async fn entry(&self, id: &str) -> EntryPage {
        self.handle
            .conversation_entry(self.run.clone(), id.parse().unwrap())
            .await
            .unwrap()
    }
}

pub(in crate::storage::conversation::reads) async fn connect(
    path: &std::path::Path,
) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .foreign_keys(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}
pub(in crate::storage::conversation::reads) fn input(text: &str) -> RecordedRunInput {
    RecordedRunInput::new(
        text.into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic"),
            prompt: "PRIVATE_PREPARED".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap()
}
pub(in crate::storage::conversation::reads) fn bounded(page: &EntryPage) {
    assert!(DisplayJson::Entry(page.entry()).encode().unwrap().len() <= ENTRY_BYTES);
    assert!(
        DisplayJson::Entry(page.block().human())
            .encode()
            .unwrap()
            .len()
            <= ENTRY_BYTES
    );
    let bytes = DisplayJson::EntryPage(page).encode().unwrap();
    assert!(bytes.len() <= crate::conversation::wire::PAGE_BYTES);
    let text = String::from_utf8(bytes).unwrap();
    for private in [
        "PRIVATE_PREPARED",
        "PRIVATE_RESPONSE",
        "PRIVATE_NATIVE",
        "PRIVATE_ITEM",
        "opaque-local-session",
        REQUEST,
    ] {
        assert!(!text.contains(private));
    }
}
