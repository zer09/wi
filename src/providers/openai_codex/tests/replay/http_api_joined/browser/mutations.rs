//! Read-only SQLite evidence for browser command recovery. No payload leaves this module.
use super::*;

#[path = "mutations/rename_tests.rs"]
mod rename_tests;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    titles: [String; 2],
    renames: [String; 2],
}
static INPUTS: std::sync::LazyLock<Inputs> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/mutations.json"
    )))
    .unwrap()
});

pub(super) struct Audit {
    root: PathBuf,
    workspaces: Vec<String>,
    catalog: SqliteConnection,
    sessions: Vec<(ApplicationSessionId, SqliteConnection)>,
}

async fn reader(path: PathBuf) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::ZERO)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}

impl Audit {
    pub(super) async fn open(root: PathBuf, workspaces: Vec<String>) -> Self {
        Self {
            catalog: reader(root.join("catalog.sqlite3")).await,
            root,
            workspaces,
            sessions: vec![],
        }
    }

    pub(super) async fn inspect(&mut self, id: u32) -> Value {
        let rows = sqlx::query("SELECT c.command_id AS operation_id,c.session_id AS command_session_id,c.payload_hash,c.creation_event_id,c.created_at_ms AS command_created_at_ms,c.request_json,c.receipt_json,c.state,s.session_id,s.created_at_ms AS session_created_at_ms,s.title,s.workspace_json,s.updated_at_ms,s.head_sequence,s.schema_version,s.availability,s.fault_code,s.last_run_id,s.last_run_state FROM creation_commands c JOIN sessions s ON s.session_id=c.session_id ORDER BY s.session_id")
            .fetch_all(&mut self.catalog).await.unwrap();
        // The join must not hide an extra session or an unfinished creation command.
        for query in [
            "SELECT count(*) FROM sessions",
            "SELECT count(*) FROM creation_commands",
        ] {
            let count: i64 = sqlx::query_scalar(query)
                .fetch_one(&mut self.catalog)
                .await
                .unwrap();
            assert_eq!(count as usize, rows.len());
        }
        let session_count = rows.len();
        let mut seed_sessions = 0;
        let mut creations = vec![];
        for row in rows {
            let request_json: &str = row.get("request_json");
            let request: Value = serde_json::from_str(request_json)
                .unwrap_or_else(|_| panic!("creation evidence mismatch"));
            let slot = if request["workspace"].is_null() {
                seed_sessions += 1;
                assert!(seed_sessions == 1, "seed evidence mismatch");
                None
            } else {
                Some(
                    INPUTS
                        .titles
                        .iter()
                        .position(|title| request["title"] == *title)
                        .unwrap(),
                )
            };
            let (initial_title, workspace) = match slot {
                Some(slot) => (
                    INPUTS.titles[slot].as_str(),
                    Some(self.workspaces[slot].as_str()),
                ),
                None => ("Fixture barrier seed", None),
            };
            let canonical = json!({"method":"create_session","title":initial_title,
                "workspace":workspace})
            .to_string();
            assert!(request_json == canonical, "creation evidence mismatch");
            // Matching stored copies are not proof that either hash covers the request bytes.
            let hash = ring::digest::digest(&ring::digest::SHA256, request_json.as_bytes());
            assert!(
                row.get::<Vec<u8>, _>("payload_hash") == hash.as_ref(),
                "creation evidence mismatch"
            );
            assert!(row.get::<&str, _>("state") == "accepted");
            let receipt: crate::storage::CommitReceipt =
                serde_json::from_str(row.get("receipt_json"))
                    .unwrap_or_else(|_| panic!("creation evidence mismatch"));
            let sid = receipt.session_id();
            assert!(
                sid.as_str() == row.get::<&str, _>("command_session_id")
                    && sid.as_str() == row.get::<&str, _>("session_id"),
                "creation evidence mismatch"
            );
            assert!(receipt.operation_id().as_str() == row.get::<&str, _>("operation_id"));
            assert!(receipt.run_id().is_none());
            assert_eq!((receipt.first_sequence(), receipt.last_sequence()), (1, 1));
            if !self.sessions.iter().any(|(id, _)| id == sid) {
                let path = self
                    .root
                    .join("sessions")
                    .join(&sid.as_str()[..2])
                    .join(sid.as_str())
                    .join("session.sqlite3");
                self.sessions.push((sid.clone(), reader(path).await));
            }
            let (_, session) = self.sessions.iter_mut().find(|(id, _)| id == sid).unwrap();
            let manifest = sqlx::query("SELECT session_id,title,workspace_json,created_at_ms,updated_at_ms,head_sequence,creation_provenance_json FROM manifest WHERE singleton=1")
                .fetch_one(&mut *session).await.unwrap();
            let provenance_json: Value =
                serde_json::from_str(manifest.get("creation_provenance_json"))
                    .unwrap_or_else(|_| panic!("creation evidence mismatch"));
            assert!(
                provenance_json["method"] == "create_session",
                "creation evidence mismatch"
            );
            let provenance: crate::storage::CreationProvenance =
                serde_json::from_value(provenance_json)
                    .unwrap_or_else(|_| panic!("creation evidence mismatch"));
            let workspace_json = workspace.map(|value| serde_json::to_string(value).unwrap());
            assert!(manifest.get::<Option<String>, _>("workspace_json") == workspace_json);
            assert!(row.get::<Option<String>, _>("workspace_json") == workspace_json);
            assert!(provenance.receipt() == &receipt);
            assert!(provenance.request_json() == request_json);
            assert!(
                provenance.payload_hash().as_slice() == hash.as_ref(),
                "creation evidence mismatch"
            );
            assert!(
                provenance.operation_id() == receipt.operation_id()
                    && provenance.session_id() == sid
                    && manifest.get::<&str, _>("session_id") == sid.as_str(),
                "creation evidence mismatch"
            );
            assert!(
                provenance.creation_event_id().as_str() == row.get::<&str, _>("creation_event_id"),
                "creation evidence mismatch"
            );
            let created_at_ms: i64 = row.get("command_created_at_ms");
            assert!(
                created_at_ms >= 0
                    && row.get::<i64, _>("session_created_at_ms") == created_at_ms
                    && manifest.get::<i64, _>("created_at_ms") == created_at_ms
                    && provenance.created_at_ms() == created_at_ms,
                "creation evidence mismatch"
            );
            let event = sqlx::query("SELECT event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json FROM events WHERE sequence=1")
                .fetch_one(&mut *session).await.unwrap();
            assert!(
                event.get::<&str, _>("event_type") == "session.created"
                    && event.get::<i64, _>("event_version") == 1
                    && event.get::<&str, _>("event_id") == provenance.creation_event_id().as_str()
                    && event.get::<i64, _>("created_at_ms") == created_at_ms
                    && event.get::<Option<String>, _>("run_id").is_none()
                    && event.get::<Option<String>, _>("source_event_id").is_none()
                    && event.get::<Option<i64>, _>("source_sequence").is_none(),
                "creation evidence mismatch"
            );
            let created: crate::storage::CreatedPayload =
                serde_json::from_str(event.get("payload_json"))
                    .unwrap_or_else(|_| panic!("creation evidence mismatch"));
            assert!(
                created.title() == initial_title
                    && created.workspace() == workspace
                    && created.creation_provenance() == &provenance,
                "creation evidence mismatch"
            );
            // Read every row so a task, hidden command or extra event cannot escape the audit.
            let events = sqlx::query("SELECT sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json FROM events WHERE sequence<>1 ORDER BY sequence")
                .fetch_all(&mut *session).await.unwrap();
            assert!(events.len() <= INPUTS.renames.len() && (slot == Some(0) || events.is_empty()));
            let commands = sqlx::query("SELECT operation_id,method,first_sequence,last_sequence,receipt_json,payload_hash FROM commands ORDER BY first_sequence")
                .fetch_all(&mut *session).await.unwrap();
            assert_eq!(commands.len(), events.len());
            for query in [
                "SELECT count(*) FROM runs",
                "SELECT count(*) FROM tool_results",
            ] {
                let count: i64 = sqlx::query_scalar(query)
                    .fetch_one(&mut *session)
                    .await
                    .unwrap();
                assert_eq!(count, 0);
            }
            let mut renames = vec![];
            let mut rename_event_ids = vec![];
            let mut observations = vec![(initial_title, created_at_ms)];
            let mut operations = std::collections::HashSet::from([receipt.operation_id().clone()]);
            let mut event_ids =
                std::collections::HashSet::from([provenance.creation_event_id().clone()]);
            for (index, (event, command)) in events.iter().zip(&commands).enumerate() {
                let sequence = (index + 2) as i64;
                let title = INPUTS.renames[index].as_str();
                let event_id: crate::storage::StoredEventId = event
                    .get::<&str, _>("event_id")
                    .parse()
                    .unwrap_or_else(|_| panic!("rename evidence mismatch"));
                let timestamp: i64 = event.get("created_at_ms");
                assert!(
                    event.get::<i64, _>("sequence") == sequence
                        && event.get::<&str, _>("event_type") == "session.renamed"
                        && event.get::<i64, _>("event_version") == 1
                        && timestamp >= 0
                        && event_ids.insert(event_id.clone())
                        && event.get::<Option<String>, _>("run_id").is_none()
                        && event.get::<Option<String>, _>("source_event_id").is_none()
                        && event.get::<Option<i64>, _>("source_sequence").is_none(),
                    "rename evidence mismatch"
                );
                let payload: Value = serde_json::from_str(event.get("payload_json"))
                    .unwrap_or_else(|_| panic!("rename evidence mismatch"));
                assert!(
                    payload == json!({"title":title}),
                    "rename evidence mismatch"
                );
                // Rename stores a request hash, not another creation-provenance document.
                let canonical =
                    json!({"method":"rename","session_id":sid,"title":title}).to_string();
                let hash = ring::digest::digest(&ring::digest::SHA256, canonical.as_bytes());
                assert!(
                    command.get::<Vec<u8>, _>("payload_hash") == hash.as_ref()
                        && command.get::<&str, _>("method") == "rename"
                        && command.get::<i64, _>("first_sequence") == sequence
                        && command.get::<i64, _>("last_sequence") == sequence,
                    "rename evidence mismatch"
                );
                let receipt: crate::storage::CommitReceipt =
                    serde_json::from_str(command.get("receipt_json"))
                        .unwrap_or_else(|_| panic!("rename evidence mismatch"));
                assert!(
                    receipt.session_id() == sid
                        && receipt.run_id().is_none()
                        && receipt.operation_id().as_str()
                            == command.get::<&str, _>("operation_id")
                        && operations.insert(receipt.operation_id().clone())
                        && receipt.first_sequence() == sequence as u64
                        && receipt.last_sequence() == sequence as u64,
                    "rename evidence mismatch"
                );
                renames.push(
                    serde_json::to_value(crate::http_api::dto::ReceiptView::from(&receipt))
                        .unwrap(),
                );
                rename_event_ids.push(event_id);
                observations.push((title, timestamp));
            }
            let (title, timestamp) = observations.last().unwrap();
            assert!(
                manifest.get::<&str, _>("title") == *title
                    && manifest.get::<i64, _>("updated_at_ms") == *timestamp,
                "rename evidence mismatch"
            );
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM events")
                .fetch_one(&mut *session)
                .await
                .unwrap();
            assert_eq!(count, manifest.get::<i64, _>("head_sequence"));
            assert_eq!(count as usize, observations.len());
            let catalog_head: i64 = row.get("head_sequence");
            assert!(
                catalog_head >= 1 && catalog_head <= count,
                "catalog evidence mismatch"
            );
            let (observed_title, observed_timestamp) = observations[catalog_head as usize - 1];
            assert!(
                row.get::<&str, _>("title") == observed_title
                    && row.get::<i64, _>("updated_at_ms") == observed_timestamp
                    && row.get::<i64, _>("schema_version") == 2
                    && row.get::<&str, _>("availability") == "ready"
                    && row.get::<Option<String>, _>("fault_code").is_none()
                    && row.get::<Option<String>, _>("last_run_id").is_none()
                    && row.get::<Option<String>, _>("last_run_state").is_none(),
                "catalog evidence mismatch"
            );
            if let Some(slot) = slot {
                creations.push(json!({"slot":slot,"receipt":crate::http_api::dto::ReceiptView::from(&receipt),
                    "sequence_count":count.to_string(),"rename_events":events.len(),"renames":renames,
                    "rename_event_ids":rename_event_ids,"exact":true,"catalog_head_sequence":catalog_head.to_string(),
                    "catalog_current":catalog_head == count}));
            }
        }
        creations.sort_by_key(|entry| entry["slot"].as_u64().unwrap());
        assert!(creations.len() <= 2);
        for (slot, entry) in creations.iter().enumerate() {
            assert_eq!(entry["slot"], slot);
        }
        assert_eq!(session_count, creations.len() + seed_sessions);
        json!({"id":id,"event":"mutation_inspect","max_input_bytes":crate::provider::MAX_INPUT_BYTES,
            "session_count":session_count,"seed_sessions":seed_sessions,"creations":creations})
    }

    pub(super) async fn close(self) {
        self.catalog.close().await.unwrap();
        for (_, session) in self.sessions {
            session.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn audit_rejects_corrupted_creation_evidence_without_private_diagnostics() {
    let mut missed = vec![];
    for (table, cases) in [
        (
            "creation_commands",
            &[
                (
                    "create_hash",
                    "UPDATE creation_commands SET payload_hash=zeroblob(32)",
                ),
                (
                    "command_operation",
                    "UPDATE creation_commands SET command_id='ab123456-789a-4bcd-8abc-0123456789b1'",
                ),
                (
                    "command_session",
                    "UPDATE creation_commands SET session_id='ab123456-789a-4bcd-8abc-0123456789b1'",
                ),
                (
                    "catalog_creation_event",
                    "UPDATE creation_commands SET creation_event_id='ab123456-789a-4bcd-8abc-0123456789b1'",
                ),
                (
                    "command_timestamp",
                    "UPDATE creation_commands SET created_at_ms=created_at_ms+1",
                ),
                (
                    "receipt_operation",
                    "UPDATE creation_commands SET receipt_json=json_set(receipt_json,'$.operation_id','ab123456-789a-4bcd-8abc-0123456789b1')",
                ),
            ][..],
        ),
        (
            "sessions",
            &[(
                "catalog_timestamp",
                "UPDATE sessions SET created_at_ms=created_at_ms+1",
            )][..],
        ),
        (
            "manifest",
            &[
                (
                    "manifest_session",
                    "UPDATE manifest SET session_id='ab123456-789a-4bcd-8abc-0123456789b1'",
                ),
                (
                    "manifest_timestamp",
                    "UPDATE manifest SET created_at_ms=created_at_ms+1",
                ),
                (
                    "provenance_operation",
                    "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.operation_id','ab123456-789a-4bcd-8abc-0123456789b1')",
                ),
                (
                    "provenance_session",
                    "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.session_id','ab123456-789a-4bcd-8abc-0123456789b1')",
                ),
                (
                    "provenance_method",
                    "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.method','private-method-canary')",
                ),
                (
                    "provenance_hash",
                    "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.payload_hash[0]',(json_extract(creation_provenance_json,'$.payload_hash[0]')+1)%256)",
                ),
                (
                    "provenance_linked_hash",
                    "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.payload_hash[0]',(json_extract(creation_provenance_json,'$.payload_hash[0]')+1)%256)",
                ),
                (
                    "provenance_creation_event",
                    "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.creation_event_id','ab123456-789a-4bcd-8abc-0123456789b1')",
                ),
                (
                    "provenance_timestamp",
                    "UPDATE manifest SET creation_provenance_json=json_set(creation_provenance_json,'$.created_at_ms',json_extract(creation_provenance_json,'$.created_at_ms')+1)",
                ),
            ][..],
        ),
        (
            "events",
            &[
                (
                    "event_id",
                    "UPDATE events SET event_id='ab123456-789a-4bcd-8abc-0123456789b1' WHERE sequence=1",
                ),
                (
                    "event_timestamp",
                    "UPDATE events SET created_at_ms=created_at_ms+1 WHERE sequence=1",
                ),
                (
                    "event_version",
                    "UPDATE events SET event_version=2 WHERE sequence=1",
                ),
                (
                    "event_run",
                    "UPDATE events SET run_id='private-run-canary' WHERE sequence=1",
                ),
                (
                    "source_event_id",
                    "UPDATE events SET source_event_id='private-source-canary' WHERE sequence=1",
                ),
                (
                    "source_sequence",
                    "UPDATE events SET source_sequence=1 WHERE sequence=1",
                ),
                (
                    "embedded_provenance",
                    "UPDATE events SET payload_json=json_set(payload_json,'$.creation_provenance.operation_id','ab123456-789a-4bcd-8abc-0123456789b1') WHERE sequence=1",
                ),
                (
                    "event_title",
                    "UPDATE events SET payload_json=json_set(payload_json,'$.title','private-title-canary') WHERE sequence=1",
                ),
                (
                    "event_workspace",
                    "UPDATE events SET payload_json=json_set(payload_json,'$.workspace','/private-workspace-canary') WHERE sequence=1",
                ),
            ][..],
        ),
    ] {
        for &(case, change) in cases {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("private-data-canary");
            let workspace = temp
                .path()
                .join("private-workspace-canary")
                .to_str()
                .unwrap()
                .to_owned();
            let store = SessionStore::open(root.clone()).await.unwrap();
            let created = store
                .create_session(
                    CreateSession::new(
                        OperationId::new(),
                        INPUTS.titles[0].clone(),
                        Some(workspace.clone()),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
            store.close().await.unwrap();
            let mut audit = Audit::open(root.clone(), vec![workspace.clone()]).await;
            assert!(audit.inspect(1).await["creations"][0]["exact"] == true);
            let session_path = root
                .join("sessions")
                .join(&created.session_id().as_str()[..2])
                .join(created.session_id().as_str())
                .join("session.sqlite3");
            let path = if matches!(table, "manifest" | "events") {
                session_path
            } else {
                root.join("catalog.sqlite3")
            };
            let mut writer = SqliteConnectOptions::new()
                .filename(path)
                .disable_statement_logging()
                .connect()
                .await
                .unwrap();
            // Corrupt only this disposable fixture, then restore its guards before the audit.
            let trigger = match table {
                "manifest" => Some((
                    "DROP TRIGGER manifest_creation_immutable",
                    "CREATE TRIGGER manifest_creation_immutable BEFORE UPDATE OF session_id, created_at_ms, creation_provenance_json ON manifest BEGIN SELECT RAISE(ABORT,'immutable session identity'); END",
                )),
                "events" => Some((
                    "DROP TRIGGER events_no_update",
                    "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END",
                )),
                _ => None,
            };
            if let Some((drop, _)) = trigger {
                sqlx::query(drop).execute(&mut writer).await.unwrap();
            }
            let bypass_check = matches!(
                case,
                "event_version" | "source_event_id" | "source_sequence"
            );
            if bypass_check {
                sqlx::query("PRAGMA ignore_check_constraints=ON")
                    .execute(&mut writer)
                    .await
                    .unwrap();
            }
            assert_eq!(
                sqlx::query(change)
                    .execute(&mut writer)
                    .await
                    .unwrap()
                    .rows_affected(),
                1
            );
            if case.starts_with("provenance_") {
                // Keep both provenance copies equal so their linkage, not copy inequality, must fail.
                sqlx::raw_sql("DROP TRIGGER events_no_update;
                    UPDATE events SET payload_json=json_set(payload_json,'$.creation_provenance',json((SELECT creation_provenance_json FROM manifest))) WHERE sequence=1;
                    CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END")
                    .execute(&mut writer).await.unwrap();
            }
            if case == "provenance_linked_hash" {
                let json: String =
                    sqlx::query_scalar("SELECT creation_provenance_json FROM manifest")
                        .fetch_one(&mut writer)
                        .await
                        .unwrap();
                let provenance: crate::storage::CreationProvenance = serde_json::from_str(&json)
                    .unwrap_or_else(|_| panic!("invalid corruption fixture"));
                let mut catalog = SqliteConnectOptions::new()
                    .filename(root.join("catalog.sqlite3"))
                    .disable_statement_logging()
                    .connect()
                    .await
                    .unwrap();
                // Even three matching stored hashes must not replace independent SHA-256.
                sqlx::query("UPDATE creation_commands SET payload_hash=?")
                    .bind(provenance.payload_hash().as_slice())
                    .execute(&mut catalog)
                    .await
                    .unwrap();
                catalog.close().await.unwrap();
            }
            if bypass_check {
                sqlx::query("PRAGMA ignore_check_constraints=OFF")
                    .execute(&mut writer)
                    .await
                    .unwrap();
            }
            if let Some((_, restore)) = trigger {
                sqlx::raw_sql(restore).execute(&mut writer).await.unwrap();
            }
            writer.close().await.unwrap();
            match AssertUnwindSafe(audit.inspect(2)).catch_unwind().await {
                Ok(_) => missed.push(case),
                Err(error) => {
                    let message = error
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| error.downcast_ref::<&str>().copied())
                        .expect("audit failure must be text");
                    for private in [
                        temp.path().to_str().unwrap(),
                        workspace.as_str(),
                        INPUTS.titles[0].as_str(),
                        "private-method-canary",
                        "private-run-canary",
                        "private-source-canary",
                        "private-title-canary",
                        "/private-workspace-canary",
                        "ab123456-789a-4bcd-8abc-0123456789b1",
                    ] {
                        assert!(
                            !message.contains(private)
                                && !message.contains(&serde_json::to_string(private).unwrap()),
                            "audit failure exposed private evidence"
                        );
                    }
                }
            }
            audit.close().await;
            temp.close().unwrap();
        }
    }
    assert!(
        missed.is_empty(),
        "audit accepted corrupt invariants: {missed:?}"
    );
}

#[tokio::test]
async fn audit_checks_exact_creation_and_rename_without_exporting_payloads() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let workspaces = vec![
        temp.path().join("workspace-z"),
        temp.path().join("workspace-a"),
    ];
    for workspace in &workspaces {
        std::fs::create_dir(workspace).unwrap();
    }
    let settings = ApiSettings::new(
        "http://127.0.0.1:1234",
        workspaces.clone(),
        temp.path().join("skills"),
        PROVIDER_ID.into(),
        SessionOptions::new(MODEL),
        true,
    )
    .unwrap();
    assert!(settings.workspaces()[0] != workspaces[0].to_str().unwrap());
    let store = SessionStore::open(root.clone()).await.unwrap();
    let mut audit = Audit::open(root, settings.workspaces().to_vec()).await;
    assert!(
        audit.inspect(1).await["creations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let mut created_sessions = vec![];
    for slot in 0..2 {
        let input = CreateSession::new(
            OperationId::new(),
            INPUTS.titles[slot].clone(),
            Some(settings.workspaces()[slot].clone()),
        )
        .unwrap();
        let created = store.create_session(input.clone()).await.unwrap();
        let duplicate = store.create_session(input).await.unwrap();
        assert!(duplicate.duplicate() && duplicate.receipt() == created.receipt());
        created_sessions.push(created);
    }
    let created = &created_sessions[0];
    let proof = audit.inspect(2).await;
    assert_eq!(proof["creations"].as_array().unwrap().len(), 2);
    for entry in proof["creations"].as_array().unwrap() {
        assert!(entry["exact"] == true && entry["catalog_current"] == true);
        assert!(entry["rename_events"] == 0 && entry["sequence_count"] == "1");
    }
    assert!(created_sessions[0].session_id() != created_sessions[1].session_id());
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    for (index, title) in INPUTS.renames.iter().enumerate() {
        let operation = OperationId::new();
        let renamed = session
            .rename(operation.clone(), title.clone())
            .await
            .unwrap();
        let duplicate = session.rename(operation, title.clone()).await.unwrap();
        assert!(duplicate.duplicate() && duplicate.receipt() == renamed.receipt());
        let proof = audit.inspect(3).await;
        let entry = &proof["creations"][0];
        assert!(entry["exact"] == true && entry["catalog_current"] == false);
        assert_eq!(entry["rename_events"], index + 1);
        assert_eq!(entry["sequence_count"], (index + 2).to_string());
        assert!(
            entry["receipt"]
                == serde_json::to_value(crate::http_api::dto::ReceiptView::from(created.receipt()))
                    .unwrap()
        );
        session.refresh_catalog().await.unwrap();
        assert!(audit.inspect(4).await["creations"][0]["catalog_current"] == true);
        let text = proof.to_string();
        for private in INPUTS
            .titles
            .iter()
            .chain(&INPUTS.renames)
            .chain(settings.workspaces())
        {
            assert!(
                !text.contains(private) && !text.contains(&serde_json::to_string(private).unwrap())
            );
        }
    }
    // A boolean exact=true must never hide a mismatched workspace expectation.
    audit.workspaces.swap(0, 1);
    assert!(
        AssertUnwindSafe(audit.inspect(5))
            .catch_unwind()
            .await
            .is_err()
    );
    store.close().await.unwrap();
    audit.close().await;
    temp.close().unwrap();
}
