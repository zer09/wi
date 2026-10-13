use super::*;
use crate::ReplayIdentity;

async fn populated(version: u64, root: &Path) -> (ApplicationSessionId, PathBuf) {
    let (id, path) = fixture_version(root, version).await;
    if version == 1 {
        return (id, path);
    }
    let mut sql = connect(&path).await;
    let mut head: u64 = sqlx::query_scalar::<_, i64>("SELECT head_sequence FROM manifest")
        .fetch_one(&mut sql)
        .await
        .unwrap() as u64;
    let selection = StoredHistorySelection::new(
        head,
        history_prefix::digest(&mut sql, head, &[]).await.unwrap(),
        "synthetic".into(),
        "model".into(),
        None,
    )
    .unwrap();
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
    insert(
        &mut sql,
        &mut head,
        "run.history.selected",
        Some(&run),
        json!({"run_id":run,"selection":selection}),
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
    let binding = RecordedProviderBinding::new(
        run.clone(),
        "session".into(),
        "model".into(),
        ReplayIdentity::new("synthetic".into(), "native-v1".into(), "a".repeat(64)).unwrap(),
    )
    .unwrap();
    insert(
        &mut sql,
        &mut head,
        "run.provider.bound",
        Some(&run),
        json!(binding),
    )
    .await;
    let terminal = insert(
        &mut sql,
        &mut head,
        "run.interrupted",
        Some(&run),
        json!({"run_id":run,"reason":"process_restart"}),
    )
    .await;
    let terminal_json: String =
        sqlx::query_scalar("SELECT payload_json FROM events WHERE sequence=?")
            .bind(terminal as i64)
            .fetch_one(&mut sql)
            .await
            .unwrap();
    sqlx::query("INSERT INTO runs VALUES (?,?,'interrupted',1,?,'session',?,?,NULL)")
        .bind(run.as_str())
        .bind(accepted as i64)
        .bind(owner.as_str())
        .bind(terminal as i64)
        .bind(terminal_json)
        .execute(&mut sql)
        .await
        .unwrap();
    let op = OperationId::new();
    let request = dto::canonical_json(&json!({"method":"accept_history_run","session_id":id,
        "run_id":run,"input":input(),"selection":selection}))
    .unwrap();
    sqlx::query("INSERT INTO commands VALUES (?,'accept_history_run',?,?,?,?)")
        .bind(op.as_str())
        .bind(dto::hash(&request).as_slice())
        .bind(accepted as i64)
        .bind(accepted as i64 + 1)
        .bind(format!(
            "\n {} \n",
            json!({"operation_id":op,"session_id":id,"run_id":run,
            "first_sequence":accepted,"last_sequence":accepted+1})
        ))
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("UPDATE manifest SET head_sequence=?")
        .bind(head as i64)
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
    (id, path)
}

async fn projection_snapshot(sql: &mut SqliteConnection) -> Vec<String> {
    let mut result = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(singleton,format_version,applied_sequence,metadata_sequence)) FROM conversation_projection",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,changed_sequence,header_json)) FROM (SELECT * FROM conversation_blocks ORDER BY accepted_sequence)",
        "SELECT json_group_array(json_array(run_id,entry_id,hex(source_key),first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json)) FROM (SELECT * FROM conversation_entries ORDER BY run_id,first_sequence,position_slot)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,order_key,generation,byte_length,kind,metadata_json)) FROM (SELECT * FROM conversation_fields ORDER BY run_id,entry_id,order_key)",
        "SELECT json_group_array(json_array(run_id,entry_id,field_id,start_byte,hex(bytes))) FROM (SELECT * FROM conversation_chunks ORDER BY run_id,entry_id,field_id,start_byte)",
    ] {
        result.push(
            sqlx::query_scalar(query)
                .fetch_one(&mut *sql)
                .await
                .unwrap(),
        );
    }
    result
}

#[tokio::test]
async fn a4_genuine_populated_one_two_preservation_bounded_backfill_and_warm_open() {
    for version in [1, 2] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let (id, path) = populated(version, &root).await;
        let mut sql = connect(&path).await;
        let before = snapshot(&mut sql).await;
        let head: i64 = sqlx::query_scalar("SELECT head_sequence FROM manifest")
            .fetch_one(&mut sql)
            .await
            .unwrap();
        let digest = history_prefix::digest(&mut sql, head as u64, &[])
            .await
            .unwrap();
        let provenance: CreationProvenance = dto::decode(
            &sqlx::query_scalar::<_, String>("SELECT creation_provenance_json FROM manifest")
                .fetch_one(&mut sql)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(session_schema::version(&mut sql).await.unwrap(), version);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'conversation_%'"
            )
            .fetch_one(&mut sql)
            .await
            .unwrap(),
            0
        );
        sql.close().await.unwrap();
        let store = SessionStore::open(root).await.unwrap();
        assert_eq!(
            store.list_sessions(None, 10).await.unwrap().sessions()[0].schema_version(),
            version
        );
        assert_eq!(store.repair_catalog().await.unwrap().ready_sessions(), 1);
        assert_complete(&path, version, &before).await;
        disk_snapshot(&path, version, "before_cold_open");
        let started = std::time::Instant::now();
        store.open_session(id.clone()).await.unwrap();
        let elapsed = started.elapsed();
        let measurements = store.inner.hooks.measurements();
        disk_snapshot(&path, version, "after_cold_open");
        println!(
            "a4_cold old={version} elapsed_us={} projection_pages={} projection_max_page_cumulative={}",
            elapsed.as_micros(),
            measurements.projection_pages,
            measurements.projection_max_page
        );
        assert_eq!(measurements.projection_pages, (head as usize).div_ceil(256));
        assert_eq!(measurements.projection_max_page, 256);
        assert_complete(&path, 3, &before).await;
        let guard = store.inner.lifecycle.admit().unwrap();
        let mut sql = database::open(&path, false, &store.inner.lifecycle)
            .await
            .unwrap();
        database::check_settings(&mut sql, true).await.unwrap();
        session_schema::validate(&mut sql, &id, Some(&provenance))
            .await
            .unwrap();
        assert_eq!(
            history_prefix::digest(&mut sql, head as u64, &[])
                .await
                .unwrap(),
            digest
        );
        let projected = projection_snapshot(&mut sql).await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT applied_sequence FROM conversation_projection")
                .fetch_one(&mut sql)
                .await
                .unwrap(),
            head
        );
        let human_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversation_entries WHERE kind='human'")
                .fetch_one(&mut sql)
                .await
                .unwrap();
        assert_eq!(human_count, if version == 1 { 2 } else { 3 });
        let output: Vec<u8> = sqlx::query_scalar("SELECT bytes FROM conversation_chunks c JOIN conversation_fields f USING(run_id,entry_id,field_id) WHERE f.kind='tool_result' LIMIT 1").fetch_one(&mut sql).await.unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            " {\"sum\":42,\"string\":\"雪\\r\\n\"} \n"
        );
        database::close(sql, &store.inner.lifecycle).await.unwrap();
        guard.finish();
        let mut warm_index = 0;
        for _ in 0..2 {
            warm_index += 1;
            let warm_before = store.inner.hooks.measurements();
            let warm_started = std::time::Instant::now();
            store.open_session(id.clone()).await.unwrap();
            let warm_elapsed = warm_started.elapsed();
            let warm_after = store.inner.hooks.measurements();
            let projection_page_delta = warm_after.projection_pages - warm_before.projection_pages;
            assert_eq!(projection_page_delta, 0);
            println!(
                "a4_warm old={version} index={warm_index} elapsed_us={} projection_page_delta={projection_page_delta} projection_max_page_cumulative={} read_transactions_delta={} validation_bytes_delta={} recording_commits_delta={} other_commits_delta={}",
                warm_elapsed.as_micros(),
                warm_after.projection_max_page,
                warm_after.read_transactions - warm_before.read_transactions,
                warm_after.validation_payload_bytes - warm_before.validation_payload_bytes,
                warm_after.recording_commits - warm_before.recording_commits,
                warm_after.other_commits - warm_before.other_commits
            );
        }
        disk_snapshot(&path, version, "after_warm_opens");
        assert_eq!(
            store.inner.hooks.measurements().projection_pages,
            measurements.projection_pages
        );
        let mut sql = connect(&path).await;
        assert_eq!(projection_snapshot(&mut sql).await, projected);
        sql.close().await.unwrap();
        let (admitted, opened, closed, _) = store.inner.lifecycle.gauge();
        assert_eq!(admitted, 0);
        assert_eq!(opened, closed);
        store.close().await.unwrap();
        println!(
            "a4 old={version} head={head} pages={} max={} cold_ms={} canonical_sha256={}",
            measurements.projection_pages,
            measurements.projection_max_page,
            elapsed.as_millis(),
            ring::digest::digest(&ring::digest::SHA256, before.join("\n").as_bytes())
                .as_ref()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
    }
}

fn disk_snapshot(path: &Path, version: u64, stage: &str) {
    // These lengths show only named boundaries, not the in-flight peak.
    for (label, suffix) in [
        ("db", ""),
        ("wal", "-wal"),
        ("shm", "-shm"),
        ("journal", "-journal"),
    ] {
        let mut file = path.as_os_str().to_os_string();
        file.push(suffix);
        let (present, bytes) = match std::fs::metadata(Path::new(&file)) {
            Ok(metadata) => (true, metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (false, 0),
            Err(error) => panic!("session disk snapshot metadata failed: {error}"),
        };
        println!(
            "a4_disk old={version} stage={stage} file={label} present={present} bytes={bytes}"
        );
    }
}

fn point(stage: u8) -> Point {
    match stage {
        0 => Point::ProjectionCreated,
        1 => Point::ProjectionCopied,
        2 => Point::ProjectionPrecommit,
        3 => Point::ProjectionCommitted,
        _ => panic!("closed stage"),
    }
}

#[tokio::test]
async fn a4_migration_failures_leave_truthful_two_or_three_and_restore_retirement() {
    for version in [1, 2] {
        for stage in 0..4 {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let (id, path) = populated(version, &root).await;
            let mut sql = connect(&path).await;
            let before = snapshot(&mut sql).await;
            sql.close().await.unwrap();
            let store = SessionStore::open(root.clone()).await.unwrap();
            store
                .inner
                .hooks
                .arm(point(stage), Action::Fail(StorageErrorKind::Io));
            let error = store.open_session(id.clone()).await.unwrap_err();
            assert_eq!(error.code(), "storage.io");
            assert_eq!(
                error.certainty(),
                if stage == 3 {
                    CommitCertainty::Unknown
                } else {
                    CommitCertainty::NotCommitted
                }
            );
            let (admitted, opened, closed, _) = store.inner.lifecycle.gauge();
            assert_eq!(admitted, 0);
            assert_eq!(opened, closed);
            assert_complete(&path, if stage == 3 { 3 } else { 2 }, &before).await;
            let guard = store.inner.lifecycle.admit().unwrap();
            let mut sql = database::open(&path, false, &store.inner.lifecycle)
                .await
                .unwrap();
            database::check_settings(&mut sql, true).await.unwrap();
            database::close(sql, &store.inner.lifecycle).await.unwrap();
            guard.finish();
            store.close().await.unwrap();
            let store = SessionStore::open(root).await.unwrap();
            store.open_session(id).await.unwrap();
            store.close().await.unwrap();
            assert_complete(&path, 3, &before).await;
        }
    }
}

#[test]
#[ignore = "closed schema3 subprocess helper; synthetic stdin fixture only"]
fn projection_child() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).unwrap();
    let (root, id, stage): (PathBuf, ApplicationSessionId, u8) =
        serde_json::from_str(&text).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let store = SessionStore::open(root).await.unwrap();
        if stage < 4 {
            store.inner.hooks.arm(point(stage), Action::Exit);
        }
        store.open_session(id).await.unwrap();
        store.close().await.unwrap();
    });
}

fn process(root: &Path, id: &ApplicationSessionId, stage: u8) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "storage::b2_tests::migration::activation::projection_child",
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
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
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
        Some(if stage < 4 { 73 } else { 0 }),
        "closed schema3 child failed"
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains("SELECT"));
}

#[tokio::test]
async fn a4_process_death_pre_post_projection_commit_and_idempotent_reopen() {
    for version in [1, 2] {
        for stage in [1, 2, 3] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("root");
            let (id, path) = populated(version, &root).await;
            let mut sql = connect(&path).await;
            let before = snapshot(&mut sql).await;
            sql.close().await.unwrap();
            process(&root, &id, stage);
            assert_complete(&path, if stage == 3 { 3 } else { 2 }, &before).await;
            process(&root, &id, 4);
            assert_complete(&path, 3, &before).await;
            let mut sql = connect(&path).await;
            let projected = projection_snapshot(&mut sql).await;
            sql.close().await.unwrap();
            process(&root, &id, 4);
            let mut sql = connect(&path).await;
            assert_eq!(projection_snapshot(&mut sql).await, projected);
            sql.close().await.unwrap();
        }
    }
}
