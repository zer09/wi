use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};

use super::*;

mod failure_tests;
mod field_tests;
use crate::{
    SessionOptions,
    conversation::{
        EntryId,
        primitives::{EntrySource, SourceKey},
    },
    run::RunRequest,
    storage::{
        CreateSession, OperationId, RecordedRunInput, RunId, SessionStore, StorageErrorKind,
        database, filesystem,
    },
};

struct Fixture {
    sql: SqliteConnection,
    _root: tempfile::TempDir,
    path: std::path::PathBuf,
    run: RunId,
    human: EntryId,
    assistant: EntryId,
}
impl Fixture {
    async fn v2() -> Self {
        let root = tempfile::tempdir().unwrap();
        // Capture real canonical producer rows, then populate the released v2 DDL independently.
        let store_root = root.path().join("store");
        let store = SessionStore::open(store_root.clone()).await.unwrap();
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
        let run: RunId = "11111111-1111-4111-8111-111111111111".parse().unwrap();
        let input = RecordedRunInput::new(
            "synthetic".into(),
            RunRequest {
                provider_id: "synthetic".into(),
                options: SessionOptions::new("synthetic-model"),
                prompt: "prepared synthetic".into(),
            },
            vec![],
            vec![],
            vec![],
            None,
        )
        .unwrap();
        session
            .accept_run(OperationId::new(), run.clone(), input)
            .await
            .unwrap();
        for sequence in 3..=8 {
            session
                .rename(OperationId::new(), format!("synthetic-{sequence}"))
                .await
                .unwrap();
        }
        let path = filesystem::session_path(&store_root, created.session_id(), false).unwrap();
        store.close().await.unwrap();
        let source_path = path;
        let path = root.path().join("released-v2.sqlite3");
        let mut sql = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(false)
            .pragma("trusted_schema", "OFF")
            .disable_statement_logging()
            .connect()
            .await
            .unwrap();
        sqlx::raw_sql(crate::storage::session_schema::V2)
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query("ATTACH DATABASE ? AS captured")
            .bind(source_path.to_str().unwrap())
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO manifest SELECT singleton,session_id,2,format_version,title,workspace_json,created_at_ms,updated_at_ms,head_sequence,creation_provenance_json FROM captured.manifest;
            INSERT INTO events SELECT * FROM captured.events;
            INSERT INTO runs SELECT * FROM captured.runs;
            INSERT INTO commands SELECT * FROM captured.commands;
            INSERT INTO tool_results SELECT * FROM captured.tool_results;
            DETACH DATABASE captured; PRAGMA foreign_keys=ON;")
            .execute(&mut sql).await.unwrap();
        Self {
            sql,
            _root: root,
            path,
            run,
            human: EntryId::new(2, 0).unwrap(),
            assistant: EntryId::new(3, 0).unwrap(),
        }
    }
    async fn new() -> Self {
        let mut fixture = Self::v2().await;
        sqlx::raw_sql(SCHEMA)
            .execute(&mut fixture.sql)
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversation_projection VALUES (1,1,8,1)")
            .execute(&mut fixture.sql)
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversation_blocks VALUES (?,2,3,'{}')")
            .bind(fixture.run.as_str())
            .execute(&mut fixture.sql)
            .await
            .unwrap();
        for (entry, kind, source) in [
            (fixture.human, "human", EntrySource::Human),
            (
                fixture.assistant,
                "assistant",
                EntrySource::Assistant {
                    turn_id: "synthetic-turn",
                },
            ),
        ] {
            sqlx::query("INSERT INTO conversation_entries VALUES (?,?,?,?,0,3,3,?,'{}')")
                .bind(fixture.run.as_str())
                .bind(entry.to_string())
                .bind(
                    SourceKey::entry(&fixture.run, source)
                        .unwrap()
                        .bytes()
                        .as_slice(),
                )
                .bind(i64::try_from(entry.first_sequence()).unwrap())
                .bind(kind)
                .execute(&mut fixture.sql)
                .await
                .unwrap();
        }
        fixture
    }
    async fn close(self) {
        self.sql.close().await.unwrap();
    }
}

async fn schema(sql: &mut SqliteConnection, projection: bool) -> Vec<(String, String, String)> {
    sqlx::query_as("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND (name LIKE 'conversation_%')=? ORDER BY type,name")
        .bind(projection).fetch_all(sql).await.unwrap()
}

#[tokio::test]
async fn a2_additive_ddl_matches_contract_preserves_v2_and_has_exact_indexes_and_fks() {
    let contract = include_str!("../../../docs/slices/g1/SCHEMA.md")
        .split("```sql\n")
        .nth(1)
        .unwrap()
        .split("```")
        .next()
        .unwrap();
    assert_eq!(SCHEMA.trim(), contract.trim());
    let mut fixture = Fixture::v2().await;
    let sql = &mut fixture.sql;
    let canonical = schema(sql, false).await;
    sqlx::raw_sql(SCHEMA).execute(&mut *sql).await.unwrap();
    assert_eq!(schema(sql, false).await, canonical);
    let mut expected: Vec<String> = SCHEMA
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_owned())
        .collect();
    let mut actual: Vec<_> = schema(sql, true)
        .await
        .into_iter()
        .map(|(_, _, ddl)| ddl)
        .collect();
    expected.sort();
    actual.sort();
    assert_eq!(actual, expected);
    let versions: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT user_version FROM pragma_user_version),schema_version,(SELECT application_id FROM pragma_application_id) FROM manifest")
        .fetch_one(&mut *sql).await.unwrap();
    assert_eq!(versions, (2, 2, 1464423233));
    let strict: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pragma_table_list WHERE name LIKE 'conversation_%' AND strict=1",
    )
    .fetch_one(&mut *sql)
    .await
    .unwrap();
    assert_eq!(strict, 5);
    for (index, columns) in [
        (
            "conversation_blocks_changed",
            vec!["changed_sequence", "run_id"],
        ),
        (
            "conversation_entries_order",
            vec!["run_id", "first_sequence", "position_slot"],
        ),
        (
            "conversation_entries_changed",
            vec!["changed_sequence", "run_id", "entry_id"],
        ),
    ] {
        let actual: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
                .bind(index)
                .fetch_all(&mut *sql)
                .await
                .unwrap();
        assert_eq!(actual, columns);
    }
    for (table, mut expected) in [
        ("conversation_projection", vec![]),
        (
            "conversation_blocks",
            vec![
                "run_id:runs:run_id",
                "accepted_sequence:events:sequence",
                "changed_sequence:events:sequence",
            ],
        ),
        (
            "conversation_entries",
            vec![
                "run_id:runs:run_id",
                "first_sequence:events:sequence",
                "changed_sequence:events:sequence",
                "content_epoch:events:sequence",
            ],
        ),
        (
            "conversation_fields",
            vec![
                "run_id:conversation_entries:run_id",
                "entry_id:conversation_entries:entry_id",
                "generation:events:sequence",
            ],
        ),
        (
            "conversation_chunks",
            vec![
                "run_id:conversation_fields:run_id",
                "entry_id:conversation_fields:entry_id",
                "field_id:conversation_fields:field_id",
            ],
        ),
    ] {
        let actual: Vec<String> = sqlx::query_scalar("SELECT \"from\"||':'||\"table\"||':'||\"to\" FROM pragma_foreign_key_list(?) ORDER BY 1")
            .bind(table).fetch_all(&mut *sql).await.unwrap();
        expected.sort();
        assert_eq!(actual, expected);
    }
    fixture.close().await;
}

#[tokio::test]
async fn a2_sql_constraints_and_canonical_immutability_remain_enforced() {
    let mut fixture = Fixture::new().await;
    sqlx::query("INSERT INTO conversation_fields VALUES (?,?,'text','0',2,0,'text','{}')")
        .bind(fixture.run.as_str())
        .bind(fixture.human.to_string())
        .execute(&mut fixture.sql)
        .await
        .unwrap();
    for statement in [
        "UPDATE conversation_projection SET singleton=2",
        "UPDATE conversation_projection SET format_version=2",
        "UPDATE conversation_projection SET applied_sequence=0",
        "UPDATE conversation_projection SET metadata_sequence=0",
        "UPDATE conversation_blocks SET run_id='missing'",
        "UPDATE conversation_blocks SET accepted_sequence=99",
        "UPDATE conversation_blocks SET changed_sequence=99",
        "UPDATE conversation_entries SET source_key=zeroblob(31)",
        "UPDATE conversation_entries SET source_key='not a blob'",
        "UPDATE conversation_entries SET position_slot=-1",
        "UPDATE conversation_entries SET kind='provider-map'",
        "UPDATE conversation_entries SET first_sequence=99",
        "UPDATE conversation_entries SET changed_sequence=99",
        "UPDATE conversation_entries SET content_epoch=99",
        "UPDATE conversation_fields SET entry_id='missing'",
        "UPDATE conversation_fields SET generation=99",
        "UPDATE conversation_fields SET byte_length=-1",
        "INSERT INTO conversation_blocks SELECT * FROM conversation_blocks",
        "INSERT INTO conversation_entries SELECT * FROM conversation_entries",
        "INSERT INTO conversation_entries SELECT run_id,'other',source_key,4,1,3,3,kind,metadata_json FROM conversation_entries",
        "INSERT INTO conversation_entries SELECT run_id,'other',randomblob(32),first_sequence,position_slot,3,3,kind,metadata_json FROM conversation_entries",
        "INSERT INTO conversation_fields SELECT * FROM conversation_fields",
        "INSERT INTO conversation_fields SELECT run_id,entry_id,'other',order_key,generation,0,kind,metadata_json FROM conversation_fields",
        "INSERT INTO conversation_chunks SELECT run_id,entry_id,field_id,-1,x'61' FROM conversation_fields",
        "INSERT INTO conversation_chunks SELECT run_id,entry_id,field_id,0,x'' FROM conversation_fields",
        "INSERT INTO conversation_chunks SELECT run_id,entry_id,field_id,0,zeroblob(8193) FROM conversation_fields",
        "INSERT INTO conversation_chunks SELECT run_id,entry_id,'missing',0,x'61' FROM conversation_fields",
        "INSERT INTO conversation_chunks SELECT run_id,entry_id,field_id,0,'text' FROM conversation_fields",
        "UPDATE events SET payload_json='changed'",
        "DELETE FROM events",
        "UPDATE commands SET receipt_json='changed'",
        "DELETE FROM commands",
    ] {
        let error = sqlx::query(statement)
            .execute(&mut fixture.sql)
            .await
            .unwrap_err();
        assert_eq!(
            database::error(error).kind(),
            StorageErrorKind::Integrity,
            "{statement}"
        );
    }
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut fixture.sql)
            .await
            .unwrap()
            .is_empty()
    );
    fixture.close().await;
}
