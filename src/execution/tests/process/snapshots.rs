use super::{Fixture, value};
use crate::{run::RunEvent, storage::*};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{ConnectOptions, Connection, sqlite::SqliteConnectOptions};
use std::path::Path;

// Keep raw payload strings and SQL identities, not only decoded event equality.
type EventRow = (
    i64,
    String,
    String,
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<i64>,
    String,
);
type RunRow = (
    String,
    i64,
    String,
    i64,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<i64>,
);
type ToolRow = (
    String,
    String,
    String,
    Option<String>,
    i64,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<String>,
);
type CommandRow = (String, String, Vec<u8>, i64, i64, String);

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct Snapshot {
    pub manifest: (String, i64),
    pub events: Vec<EventRow>,
    pub runs: Vec<RunRow>,
    pub tools: Vec<ToolRow>,
    pub commands: Vec<CommandRow>,
}

impl Snapshot {
    pub async fn read(root: &Path, session: &ApplicationSessionId) -> Self {
        let id = session.as_str();
        let path = root
            .join("sessions")
            .join(&id[..2])
            .join(id)
            .join("session.sqlite3");
        let mut connection = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .disable_statement_logging()
            .connect()
            .await
            .unwrap();
        let mut tx = connection.begin().await.unwrap();
        let snapshot = Self {
            manifest: sqlx::query_as("SELECT session_id, head_sequence FROM manifest")
                .fetch_one(&mut *tx).await.unwrap(),
            events: sqlx::query_as("SELECT sequence, event_id, event_type, event_version, created_at_ms, run_id, source_event_id, source_sequence, payload_json FROM events ORDER BY sequence")
                .fetch_all(&mut *tx).await.unwrap(),
            runs: sqlx::query_as("SELECT run_id, accepted_sequence, state, last_runtime_sequence, owner_instance_id, provider_session_id, terminal_sequence, terminal_json, result_sequence FROM runs ORDER BY run_id")
                .fetch_all(&mut *tx).await.unwrap(),
            tools: sqlx::query_as("SELECT run_id, call_id, tool_name, request_id, started_sequence, finished_sequence, result_sequence, is_error, output FROM tool_results ORDER BY run_id, call_id")
                .fetch_all(&mut *tx).await.unwrap(),
            commands: sqlx::query_as("SELECT operation_id, method, payload_hash, first_sequence, last_sequence, receipt_json FROM commands ORDER BY operation_id")
                .fetch_all(&mut *tx).await.unwrap(),
        };
        tx.commit().await.unwrap();
        connection.close().await.unwrap();
        snapshot
    }

    pub fn decoded(&self) -> Vec<StoredEvent> {
        self.events
            .iter()
            .map(|(sequence, id, kind, version, time, run, _, _, payload)| {
                serde_json::from_value(json!({
                    "schema_version": 1, "application_session_id": self.manifest.0,
                    "sequence": sequence, "event_id": id, "event_type": kind,
                    "event_version": version, "created_at_ms": time, "run_id": run,
                    "payload": serde_json::from_str::<serde_json::Value>(payload).unwrap()
                }))
                .unwrap()
            })
            .collect()
    }

    pub fn acceptance(&self, operation: &OperationId) -> CommitReceipt {
        let row = self
            .commands
            .iter()
            .find(|row| row.0 == operation.as_str())
            .unwrap();
        assert_eq!(row.1, "accept_run");
        assert_eq!((row.3, row.4), (2, 2));
        serde_json::from_str(&row.5).unwrap()
    }

    pub fn unfinished(&self, fixture: &Fixture) {
        assert_eq!(self.manifest.0, fixture.session.as_str());
        assert_eq!(self.manifest.1 as usize, self.events.len());
        assert_eq!(self.runs.len(), 1);
        let (run, accepted, state, last, owner, provider, terminal, terminal_json, result) =
            &self.runs[0];
        assert_eq!(run, fixture.run_id.as_str());
        assert_eq!(*accepted, 2);
        assert!(state == "accepted" || state == "running");
        assert!(terminal.is_none() && terminal_json.is_none() && result.is_none());
        let records = self.decoded();
        let StoredEventPayload::RunAccepted(payload) = records[1].payload() else {
            panic!("missing acceptance")
        };
        assert_eq!(payload.run_id(), &fixture.run_id);
        assert_eq!(payload.owner_instance_id().as_str(), owner);
        assert!(value(payload.input()) == value(&fixture.input));
        assert_eq!(
            self.acceptance(&fixture.operation_id).run_id(),
            Some(&fixture.run_id)
        );
        let mut source = 0;
        for (index, record) in records.iter().enumerate() {
            assert_eq!(record.sequence(), index as u64 + 1);
            assert_eq!(record.application_session_id(), &fixture.session);
            match record.payload() {
                StoredEventPayload::RuntimeObserved(event) => {
                    source += 1;
                    assert_eq!(event.sequence, source);
                    assert_eq!(event.run_id, fixture.run_id.as_str());
                    assert_eq!(event.schema_version, 2);
                    assert_eq!(
                        self.events[index].6.as_deref(),
                        Some(event.event_id.as_str())
                    );
                    assert_eq!(self.events[index].7, Some(event.sequence as i64));
                    assert!(!matches!(event.event, RunEvent::RunFinished { .. }));
                    if !matches!(event.event, RunEvent::RunStarted) {
                        assert_eq!(event.session_id.as_deref(), Some("provider-session"));
                    }
                }
                StoredEventPayload::RunResultRecorded(_)
                | StoredEventPayload::RunInterrupted(_) => {
                    panic!("fabricated terminal record")
                }
                _ => {}
            }
        }
        assert_eq!(*last, source as i64);
        if source > 1 {
            assert_eq!(provider.as_deref(), Some("provider-session"));
        }
    }
}
