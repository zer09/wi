use super::*;
use serde_json::{Value, json};
use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub(super) async fn connect(path: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}

// Independent released DDL and hand-populated rows, not a downgraded v2 initializer.
pub(super) async fn fixture(root: &Path) -> (ApplicationSessionId, PathBuf) {
    SessionStore::open(root.to_owned())
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let id = ApplicationSessionId::new();
    let path = filesystem::session_path(root, &id, true).unwrap();
    drop(filesystem::open_file(&path, true).unwrap());
    let mut sql = connect(&path).await;
    sqlx::raw_sql(include_str!("../../../tests/storage/session_v1.sql"))
        .execute(&mut sql)
        .await
        .unwrap();
    let operation = OperationId::new();
    let event = StoredEventId::new();
    let request = r#"{"method":"create_session","title":"original","workspace":null}"#;
    let hash = ring::digest::digest(&ring::digest::SHA256, request.as_bytes());
    let receipt = json!({"operation_id":operation,"session_id":id,"run_id":null,"first_sequence":1,"last_sequence":1});
    let provenance = json!({"operation_id":operation,"method":"create_session","session_id":id,"creation_event_id":event,"created_at_ms":42,"request_json":request,"payload_hash":hash.as_ref(),"receipt":receipt});
    sqlx::query("INSERT INTO manifest VALUES (1,?,1,1,'renamed 雪',NULL,42,42,0,?)")
        .bind(id.as_str())
        .bind(provenance.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events VALUES (1,?,'session.created',1,42,NULL,NULL,NULL,?)")
        .bind(event.as_str())
        .bind(
            json!({"title":"original","workspace":null,"creation_provenance":provenance})
                .to_string(),
        )
        .execute(&mut sql)
        .await
        .unwrap();
    let mut head = 1;
    insert(
        &mut sql,
        &mut head,
        "session.renamed",
        None,
        json!({"title":"renamed 雪"}),
    )
    .await;
    let rename = OperationId::new();
    let rename_request =
        json!({"method":"rename","session_id":id,"title":"renamed 雪"}).to_string();
    let rename_hash = ring::digest::digest(&ring::digest::SHA256, rename_request.as_bytes());
    sqlx::query("INSERT INTO commands VALUES (?,'rename',?,2,2,?)")
        .bind(rename.as_str()).bind(rename_hash.as_ref()).bind(format!(" {} \n", json!({"operation_id":rename,"session_id":id,"run_id":null,"first_sequence":2,"last_sequence":2}))).execute(&mut sql).await.unwrap();
    for ordinal in 0..2 {
        let run = RunId::new();
        let owner = StoredEventId::new();
        let accepted = insert(
            &mut sql,
            &mut head,
            "run.accepted",
            Some(&run),
            json!({"run_id":run,"owner_instance_id":owner,"input":input()}),
        )
        .await;
        let mut source = 0;
        observed(
            &mut sql,
            &mut head,
            &run,
            &mut source,
            json!({"type":"run_started"}),
        )
        .await;
        observed(
            &mut sql,
            &mut head,
            &run,
            &mut source,
            json!({"type":"turn_started","number":1}),
        )
        .await;
        let mut provider_sequence = 0;
        // Cross the actual migration copy page boundary and history read boundaries.
        for _ in 0..130 {
            provider_sequence += 1;
            observed(&mut sql, &mut head, &run, &mut source, json!({"type":"provider_event","event":{
                "schema_version":1,"sequence":provider_sequence,"event_id":StoredEventId::new(),"session_id":"session","request_id":"request","provider":"synthetic","provider_sequence":null,
                "type":"output_item_updated","response_id":"response","item_id":"item","output_index":0,"content_index":0,"summary_index":null,"kind":"text","delta":"partial\r\n雪"}})).await;
        }
        provider_sequence += 1;
        let item = json!({"id":"item","kind":"message","native_type":"message","function_call":null,"native":{"id":"item","type":"message","content":[{"type":"output_text","text":"complete 雪"}],"unknown":{"z":1,"a":[3,2,1]}}});
        observed(&mut sql, &mut head, &run, &mut source, json!({"type":"provider_event","event":{
            "schema_version":1,"sequence":provider_sequence,"event_id":StoredEventId::new(),"session_id":"session","request_id":"request","provider":"synthetic","provider_sequence":null,
            "type":"response_finished","response":{"id":"response","model":"observed-model","outcome":{"status":"completed"},"text":"complete 雪","usage":null,"output":[item.clone()],
            "output_provenance":if ordinal == 0 { "native_terminal" } else { "validated_output_item_done" },
            "native":{"id":"response","status":"completed","output":if ordinal == 0 { json!([item["native"].clone()]) } else { json!([]) }}}}})).await;
        let started = observed(&mut sql, &mut head, &run, &mut source, json!({"type":"tool_event","event":{"type":"tool_execution_started","call_id":"call","tool_name":"synthetic"}})).await;
        let output = " {\"sum\":42,\"string\":\"雪\\r\\n\"} \n";
        let result = insert(
            &mut sql,
            &mut head,
            "tool.result.recorded",
            Some(&run),
            json!({"request_id":"request","call_id":"call","output":output,"is_error":false}),
        )
        .await;
        let finished = observed(&mut sql, &mut head, &run, &mut source, json!({"type":"tool_event","event":{"type":"tool_execution_finished","call_id":"call","tool_name":"synthetic","is_error":false}})).await;
        observed(&mut sql, &mut head, &run, &mut source, json!({"type":"turn_finished","number":1,"response_id":"response","outcome":{"type":"tools_prepared"},"upstream_outcome":"terminal_received"})).await;
        let terminal = observed(&mut sql, &mut head, &run, &mut source, json!({"type":"run_finished","outcome":{"type":"completed"},"summary":RunSummary::default()})).await;
        let terminal_json: String = sqlx::query("SELECT payload_json FROM events WHERE sequence=?")
            .bind(terminal as i64)
            .fetch_one(&mut sql)
            .await
            .unwrap()
            .try_get(0)
            .unwrap();
        sqlx::query("INSERT INTO runs VALUES (?,?,'completed',?,?,'session',?,?,NULL)")
            .bind(run.as_str())
            .bind(accepted as i64)
            .bind(source as i64)
            .bind(owner.as_str())
            .bind(terminal as i64)
            .bind(terminal_json)
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query("INSERT INTO tool_results VALUES (?,'call','synthetic','request',?,?,?,0,?)")
            .bind(run.as_str())
            .bind(started as i64)
            .bind(finished as i64)
            .bind(result as i64)
            .bind(output)
            .execute(&mut sql)
            .await
            .unwrap();
        let op = OperationId::new();
        let request =
            json!({"method":"accept_run","session_id":id,"run_id":run,"input":input()}).to_string();
        let hash = ring::digest::digest(&ring::digest::SHA256, request.as_bytes());
        sqlx::query("INSERT INTO commands VALUES (?,'accept_run',?,?,?,?)")
            .bind(op.as_str()).bind(hash.as_ref()).bind(accepted as i64).bind(accepted as i64)
            .bind(format!("\n {} ", json!({"operation_id":op,"session_id":id,"run_id":run,"first_sequence":accepted,"last_sequence":accepted}))).execute(&mut sql).await.unwrap();
    }
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(head as i64)
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    let mut catalog = connect(&root.join("catalog.sqlite3")).await;
    sqlx::query("INSERT INTO sessions (session_id,relative_path,title,created_at_ms,updated_at_ms,head_sequence,schema_version,availability) VALUES (?,?,'original',42,42,1,1,'ready')")
        .bind(id.as_str()).bind(filesystem::session_relative_path(&id)).execute(&mut catalog).await.unwrap();
    sqlx::query("INSERT INTO creation_commands VALUES (?,?,?,?,?,42,'accepted',?,NULL)")
        .bind(operation.as_str())
        .bind(hash.as_ref())
        .bind(request)
        .bind(id.as_str())
        .bind(event.as_str())
        .bind(receipt.to_string())
        .execute(&mut catalog)
        .await
        .unwrap();
    catalog.close().await.unwrap();
    (id, path)
}

async fn insert(
    sql: &mut SqliteConnection,
    head: &mut u64,
    kind: &str,
    run: Option<&RunId>,
    payload: Value,
) -> u64 {
    *head += 1;
    sqlx::query("INSERT INTO events VALUES (?,?,?,1,42,?,?,?,?)")
        .bind(*head as i64)
        .bind(StoredEventId::new().as_str())
        .bind(kind)
        .bind(run.map(RunId::as_str))
        .bind(payload.get("event_id").and_then(Value::as_str))
        .bind(payload.get("sequence").and_then(Value::as_i64))
        .bind(format!(
            " \n{}\n ",
            serde_json::to_string_pretty(&payload).unwrap()
        ))
        .execute(sql)
        .await
        .unwrap();
    *head
}

async fn observed(
    sql: &mut SqliteConnection,
    head: &mut u64,
    run: &RunId,
    source: &mut u64,
    mut payload: Value,
) -> u64 {
    *source += 1;
    let kind = payload["type"].as_str().unwrap().to_owned();
    payload["schema_version"] = json!(2);
    payload["sequence"] = json!(*source);
    payload["event_id"] = json!(StoredEventId::new());
    payload["run_id"] = json!(run);
    payload["session_id"] = if kind == "run_started" {
        Value::Null
    } else {
        json!("session")
    };
    payload["turn_id"] = if kind == "run_started" || kind == "run_finished" {
        Value::Null
    } else {
        json!("turn")
    };
    payload["request_id"] = if kind == "run_started" || kind == "turn_started" {
        Value::Null
    } else {
        json!("request")
    };
    insert(sql, head, "runtime.observed", Some(run), payload).await
}

async fn snapshot(sql: &mut SqliteConnection) -> Vec<String> {
    let mut rows = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(singleton,session_id,format_version,title,workspace_json,created_at_ms,updated_at_ms,head_sequence,creation_provenance_json)) FROM manifest",
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM (SELECT * FROM runs ORDER BY accepted_sequence)",
        "SELECT json_group_array(json_array(run_id,call_id,tool_name,request_id,started_sequence,finished_sequence,result_sequence,is_error,output)) FROM (SELECT * FROM tool_results ORDER BY run_id,call_id)",
    ] {
        rows.push(
            sqlx::query(query)
                .fetch_one(&mut *sql)
                .await
                .unwrap()
                .try_get(0)
                .unwrap(),
        );
    }
    rows
}

async fn assert_complete(path: &Path, version: u64, before: &[String]) {
    let mut sql = connect(path).await;
    assert_eq!(session_schema::version(&mut sql).await.unwrap(), version);
    assert_eq!(snapshot(&mut sql).await, before);
    assert!(
        sqlx::query("SELECT 1 FROM pragma_foreign_key_check")
            .fetch_all(&mut sql)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        sqlx::query("SELECT 1 FROM sqlite_schema WHERE name='events_p1b2_new'")
            .fetch_all(&mut sql)
            .await
            .unwrap()
            .is_empty()
    );
    for query in [
        "UPDATE events SET payload_json=payload_json",
        "DELETE FROM events",
        "UPDATE commands SET receipt_json=receipt_json",
        "DELETE FROM commands",
        "UPDATE manifest SET created_at_ms=43",
    ] {
        assert!(sqlx::query(query).execute(&mut sql).await.is_err());
    }
    sql.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_02_populated_independent_v1_migration_preserves_bytes_fk_indexes_and_hash() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let (id, path) = fixture(&root).await;
    let mut sql = connect(&path).await;
    let before = snapshot(&mut sql).await;
    let head: i64 = sqlx::query("SELECT head_sequence FROM manifest")
        .fetch_one(&mut sql)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    let hash = history_prefix::digest(&mut sql, head as u64, &[])
        .await
        .unwrap();
    sql.close().await.unwrap();
    let store = SessionStore::open(root).await.unwrap();
    // Catalog listing and explicit repair observe v1 without migration.
    assert_eq!(
        store.list_sessions(None, 10).await.unwrap().sessions()[0].schema_version(),
        1
    );
    assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
    assert_complete(&path, 1, &before).await;
    let handle = store.open_session(id.clone()).await.unwrap();
    assert_complete(&path, 2, &before).await;
    let mut sql = connect(&path).await;
    assert_eq!(
        history_prefix::digest(&mut sql, head as u64, &[])
            .await
            .unwrap(),
        hash
    );
    for name in [
        "events_source_id",
        "events_source_sequence",
        "events_run_sequence",
        "events_no_update",
        "events_no_delete",
    ] {
        assert!(
            sqlx::query("SELECT 1 FROM sqlite_schema WHERE name=?")
                .bind(name)
                .fetch_optional(&mut sql)
                .await
                .unwrap()
                .is_some()
        );
    }
    sql.close().await.unwrap();
    assert_eq!(
        handle.refresh_catalog().await.unwrap(),
        RefreshResult::Updated
    );
    assert_eq!(
        handle.refresh_catalog().await.unwrap(),
        RefreshResult::Unchanged
    );
    assert_eq!(
        store.list_sessions(None, 10).await.unwrap().sessions()[0].schema_version(),
        2
    );
    let guard = store.inner.lifecycle.admit().unwrap();
    let (mut sql, _) = session::connection(&store.inner, &id, true).await.unwrap();
    database::check_settings(&mut sql, true).await.unwrap();
    database::close(sql, &store.inner.lifecycle).await.unwrap();
    guard.finish();
    store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_03_invalid_v1_inputs_preserved_before_writable_migration() {
    for mutation in [
        "PRAGMA user_version=3",
        "PRAGMA application_id=17",
        "UPDATE manifest SET schema_version=2",
        "CREATE TABLE events_p1b2_new (value TEXT)",
        "DROP INDEX fixture_source_id",
        "PRAGMA foreign_keys=OFF; UPDATE tool_results SET started_sequence=999999",
        "DROP TRIGGER events_no_update; UPDATE events SET payload_json='{}' WHERE sequence=8; CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let (id, path) = fixture(&root).await;
        let mut sql = connect(&path).await;
        sqlx::raw_sql(mutation).execute(&mut sql).await.unwrap();
        sql.close().await.unwrap();
        let before = std::fs::read(&path).unwrap();
        let store = SessionStore::open(root).await.unwrap();
        assert!(store.open_session(id).await.is_err(), "{mutation}");
        store.close().await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), before, "{mutation}");
    }
}

fn point(stage: u8) -> Point {
    match stage {
        0 => Point::MigrationCreated,
        1 => Point::MigrationCopied,
        2 => Point::MigrationRebuilt,
        3 => Point::MigrationPrecommit,
        4 => Point::MigrationCommitted,
        _ => panic!("stage"),
    }
}

#[tokio::test]
async fn p1b2_03_injected_migration_failures_reopen_complete_schemas() {
    for stage in 0..5 {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let (id, path) = fixture(&root).await;
        let mut sql = connect(&path).await;
        let before = snapshot(&mut sql).await;
        sql.close().await.unwrap();
        let store = SessionStore::open(root.clone()).await.unwrap();
        store
            .inner
            .hooks
            .arm(point(stage), Action::Fail(StorageErrorKind::Io));
        let error = store.open_session(id.clone()).await.unwrap_err();
        assert_eq!(
            error.certainty(),
            if stage == 4 {
                CommitCertainty::Unknown
            } else {
                CommitCertainty::NotCommitted
            }
        );
        store.close().await.unwrap();
        assert_complete(&path, if stage == 4 { 2 } else { 1 }, &before).await;
        let store = SessionStore::open(root).await.unwrap();
        store.open_session(id).await.unwrap();
        store.close().await.unwrap();
        assert_complete(&path, 2, &before).await;
    }
}

#[test]
#[ignore = "closed migration process helper; receives only a synthetic fixture on stdin"]
fn migration_child() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).unwrap();
    let (root, id, stage): (PathBuf, ApplicationSessionId, u8) =
        serde_json::from_str(&text).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let store = SessionStore::open(root).await.unwrap();
        if stage < 5 {
            store.inner.hooks.arm(point(stage), Action::Exit);
        }
        store.open_session(id).await.unwrap();
        store.close().await.unwrap();
    });
}

fn child(root: &Path, id: &ApplicationSessionId, stage: u8) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "storage::b2_tests::migration::migration_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env("HOME", root.parent().unwrap())
        .env("TMPDIR", root.parent().unwrap())
        .env("XDG_CONFIG_HOME", root.parent().unwrap())
        .env("CODEX_HOME", root.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    if let Some(value) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", value);
    }
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            serde_json::to_string(&(root, id, stage))
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(if stage < 5 { 73 } else { 0 }),
        "child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn p1b2_03_process_exit_mid_copy_precommit_and_postcommit() {
    for stage in 0..5 {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let (id, path) = fixture(&root).await;
        let mut sql = connect(&path).await;
        let before = snapshot(&mut sql).await;
        sql.close().await.unwrap();
        child(&root, &id, stage);
        assert_complete(&path, if stage == 4 { 2 } else { 1 }, &before).await;
        child(&root, &id, 5);
        assert_complete(&path, 2, &before).await;
    }
}
