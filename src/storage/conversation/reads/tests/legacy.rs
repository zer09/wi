use super::*;
use crate::{
    conversation::wire::PAGE_BYTES,
    run::RunSummary,
    storage::{
        self, CommitReceipt, CreateSession, SessionStore, StoredEventId, dto, identifier_tests,
    },
};
use serde_json::json;

// Independently populate released schema2. These bytes never pass new admission.
async fn seed(
    summary: &str,
    human: &str,
) -> (
    tempfile::TempDir,
    std::path::PathBuf,
    ApplicationSessionId,
    RunId,
    RunId,
    OperationId,
    AppendRunRecord,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("synthetic-legacy");
    SessionStore::open(root.clone())
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let id = ApplicationSessionId::new();
    let path = storage::filesystem::session_path(&root, &id, true).unwrap();
    drop(storage::filesystem::open_file(&path, true).unwrap());
    let mut sql = connect(&path).await;
    sqlx::raw_sql(storage::session_schema::V2)
        .execute(&mut sql)
        .await
        .unwrap();
    let create = CreateSession::new(OperationId::new(), "synthetic".into(), None).unwrap();
    let creation_event = StoredEventId::new();
    let request = dto::canonical_json(&create.request()).unwrap();
    let hash = dto::hash(&request);
    let creation_receipt = json!({"operation_id":create.operation_id(),"session_id":id,"run_id":null,"first_sequence":1,"last_sequence":1});
    let provenance = json!({"operation_id":create.operation_id(),"method":"create_session","session_id":id,"creation_event_id":creation_event,"created_at_ms":42,"request_json":request,"payload_hash":hash,"receipt":creation_receipt});
    sqlx::query("INSERT INTO manifest VALUES (1,?,2,1,'synthetic',NULL,42,42,5,?)")
        .bind(id.as_str())
        .bind(provenance.to_string())
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events VALUES (1,?,'session.created',1,42,NULL,NULL,NULL,?)")
        .bind(creation_event.as_str())
        .bind(
            json!({"title":"synthetic","workspace":null,"creation_provenance":provenance})
                .to_string(),
        )
        .execute(&mut sql)
        .await
        .unwrap();
    let run = RunId::new();
    let healthy = RunId::new();
    let operation = OperationId::new();
    let old = identifier_tests::result(
        &run,
        RunSummary {
            last_request_id: Some(summary.into()),
            ..Default::default()
        },
    );
    for (run, sequence, text, record, op) in [
        (&run, 2_i64, human, &old, operation.clone()),
        (
            &healthy,
            4_i64,
            "healthy block",
            &identifier_tests::result(&healthy, RunSummary::default()),
            OperationId::new(),
        ),
    ] {
        let owner = StoredEventId::new();
        let AppendRunRecord::Result(result) = record else {
            unreachable!()
        };
        let payload = format!(" \n{}\n ", serde_json::to_string_pretty(result).unwrap());
        sqlx::query("INSERT INTO events VALUES (?,?,'run.accepted',1,42,?,NULL,NULL,?)")
            .bind(sequence)
            .bind(StoredEventId::new().as_str())
            .bind(run.as_str())
            .bind(json!({"run_id":run,"input":input(text),"owner_instance_id":owner}).to_string())
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query("INSERT INTO events VALUES (?,?,'run.result.recorded',1,42,?,NULL,NULL,?)")
            .bind(sequence + 1)
            .bind(StoredEventId::new().as_str())
            .bind(run.as_str())
            .bind(&payload)
            .execute(&mut sql)
            .await
            .unwrap();
        sqlx::query("INSERT INTO runs VALUES (?,?,'failed',0,?,NULL,?,?,?)")
            .bind(run.as_str())
            .bind(sequence)
            .bind(owner.as_str())
            .bind(sequence + 1)
            .bind(&payload)
            .bind(sequence + 1)
            .execute(&mut sql)
            .await
            .unwrap();
        let receipt = CommitReceipt::run_batch(
            op.clone(),
            id.clone(),
            run.clone(),
            sequence + 1,
            sequence + 1,
        )
        .unwrap();
        let command =
            json!({"session_id":id,"run_id":run,"method":"append_run_records","records":[record]});
        let digest = dto::hash(&dto::canonical_json(&command).unwrap());
        sqlx::query("INSERT INTO commands VALUES (?,'append_run_records',?,?,?,?)")
            .bind(op.as_str())
            .bind(digest.as_slice())
            .bind(sequence + 1)
            .bind(sequence + 1)
            .bind(format!("\n {} ", serde_json::to_string(&receipt).unwrap()))
            .execute(&mut sql)
            .await
            .unwrap();
    }
    sql.close().await.unwrap();
    let mut catalog = connect(&root.join("catalog.sqlite3")).await;
    sqlx::query("INSERT INTO sessions (session_id,relative_path,title,created_at_ms,updated_at_ms,head_sequence,schema_version,availability) VALUES (?,?,'synthetic',42,42,1,2,'ready')")
        .bind(id.as_str()).bind(storage::filesystem::session_relative_path(&id)).execute(&mut catalog).await.unwrap();
    sqlx::query("INSERT INTO creation_commands VALUES (?,?,?,?,?,42,'accepted',?,NULL)")
        .bind(create.operation_id().as_str())
        .bind(hash.as_slice())
        .bind(request)
        .bind(id.as_str())
        .bind(creation_event.as_str())
        .bind(creation_receipt.to_string())
        .execute(&mut catalog)
        .await
        .unwrap();
    catalog.close().await.unwrap();
    (temp, root, id, run, healthy, operation, old)
}

async fn canonical(path: &std::path::Path) -> (Vec<String>, String) {
    let mut sql = connect(path).await;
    let mut values = Vec::new();
    for query in [
        "SELECT json_group_array(json_array(sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,source_sequence,payload_json)) FROM (SELECT * FROM events ORDER BY sequence)",
        "SELECT json_group_array(json_array(operation_id,method,hex(payload_hash),first_sequence,last_sequence,receipt_json)) FROM (SELECT * FROM commands ORDER BY operation_id)",
        "SELECT json_group_array(json_array(run_id,accepted_sequence,state,last_runtime_sequence,owner_instance_id,provider_session_id,terminal_sequence,terminal_json,result_sequence)) FROM (SELECT * FROM runs ORDER BY run_id)",
    ] {
        values.push(sqlx::query_scalar(query).fetch_one(&mut sql).await.unwrap());
    }
    let digest = storage::history_prefix::digest(&mut sql, 5, &[])
        .await
        .unwrap();
    sql.close().await.unwrap();
    (values, digest)
}

#[tokio::test]
async fn a5b1_legacy_unrepresentable_header_migrates_and_preserves_raw_receipt_digest() {
    let summary = "LEGACY_PRIVATE_SUMMARY".repeat(PAGE_BYTES / 21 + 1);
    let (temp, root, id, run, healthy, op, old) = seed(&summary, "anchor").await;
    let path = storage::filesystem::session_path(&root, &id, false).unwrap();
    let before = canonical(&path).await;
    let store = SessionStore::open(root).await.unwrap();
    let handle = store.open_session(id).await.unwrap();
    let mut sql = connect(&path).await;
    assert_eq!(storage::session_schema::version(&mut sql).await.unwrap(), 3);
    sql.close().await.unwrap();
    assert_eq!(canonical(&path).await, before);
    let error = handle
        .conversation_entry(run.clone(), "e:2:0".parse().unwrap())
        .await
        .err()
        .unwrap();
    assert_eq!(error, ConversationError::DisplayUnavailable);
    assert_eq!(error.to_string(), "conversation.display_unavailable");
    assert_eq!(format!("{error:?}"), "conversation.display_unavailable");
    assert!(std::error::Error::source(&error).is_none());
    let raw = handle.run_record(run.clone()).await.unwrap().unwrap();
    assert_eq!(
        raw.result().unwrap().summary.last_request_id.as_deref(),
        Some(summary.as_str())
    );
    let history = handle.history_page(0, None, 20).await.unwrap();
    assert_eq!(history.records().len(), 5);
    let duplicate = handle
        .append_run_records(op.clone(), run.clone(), vec![old])
        .await
        .unwrap();
    assert!(duplicate.duplicate());
    assert_eq!(
        handle.lookup_receipt(op).await.unwrap().as_ref(),
        Some(duplicate.receipt())
    );
    let healthy = handle
        .conversation_entry(healthy, "e:4:0".parse().unwrap())
        .await
        .unwrap();
    assert_eq!(healthy.entry().fields()[0].text(), "healthy block");
    bounded(&healthy);
    assert_eq!(canonical(&path).await, before);
    store.close().await.unwrap();
    drop(temp);
}

#[tokio::test]
async fn a5b1_near_cap_legacy_header_reduces_fragments_with_exact_progress() {
    let human = "雪\0".repeat(300);
    let summary = "s".repeat(PAGE_BYTES - 2500);
    let (_temp, root, id, run, _healthy, _op, _old) = seed(&summary, &human).await;
    let path = storage::filesystem::session_path(&root, &id, false).unwrap();
    let before = canonical(&path).await;
    let store = SessionStore::open(root).await.unwrap();
    let handle = store.open_session(id).await.unwrap();
    let mut page = handle
        .conversation_entry(run, "e:2:0".parse().unwrap())
        .await
        .unwrap();
    let bytes = DisplayJson::EntryPage(&page).encode().unwrap();
    println!(
        "a5b1 near-cap page={} human={} entry={}",
        bytes.len(),
        DisplayJson::Entry(page.block().human())
            .json_size()
            .unwrap(),
        DisplayJson::Entry(page.entry()).json_size().unwrap()
    );
    assert!(bytes.len() <= PAGE_BYTES);
    assert!(
        DisplayJson::Entry(page.block().human())
            .json_size()
            .unwrap()
            < ENTRY_BYTES
    );
    assert!(DisplayJson::Entry(page.entry()).json_size().unwrap() < ENTRY_BYTES);
    assert_eq!(
        page.block().summary().unwrap().last_request_id(),
        Some(summary.as_str())
    );
    assert!(page.entry().earlier_content().is_some());
    assert!(page.entry().fields()[0].text().len() < human.len());
    let mut restored = String::new();
    let mut count = 0;
    loop {
        let field = &page.entry().fields()[0];
        assert!(!field.text().is_empty());
        restored.insert_str(0, field.text());
        count += 1;
        assert!(DisplayJson::EntryPage(&page).encode().unwrap().len() <= PAGE_BYTES);
        let Some(cursor) = page.entry().earlier_content().cloned() else {
            break;
        };
        page = handle.conversation_content(cursor).await.unwrap();
    }
    assert_eq!(restored, human);
    assert!(count > 2);
    assert_eq!(canonical(&path).await, before);
    store.close().await.unwrap();
}

#[tokio::test]
async fn a5b2_legacy_page_header_error_and_near_cap_progress_preserve_history() {
    use crate::conversation::{BlockCursor, ConversationQuery};
    for near_cap in [false, true] {
        let human = "雪\0".repeat(5000);
        let summary = "s".repeat(if near_cap {
            PAGE_BYTES - 2300
        } else {
            PAGE_BYTES + 1
        });
        let (_temp, root, id, run, healthy, op, old) = seed(&summary, &human).await;
        let path = storage::filesystem::session_path(&root, &id, false).unwrap();
        let before = canonical(&path).await;
        let store = SessionStore::open(root).await.unwrap();
        let handle = store.open_session(id.clone()).await.unwrap();
        let newest = handle
            .conversation_page(ConversationQuery::Latest)
            .await
            .unwrap();
        assert_eq!(newest.block().unwrap().run_id(), &healthy);
        let query = ConversationQuery::Before(BlockCursor::new(id, 4).unwrap());
        let page = handle.conversation_page(query).await;
        if near_cap {
            let page = page.unwrap();
            let bytes = DisplayJson::Page(&page).encode().unwrap();
            println!(
                "a5b2 near-cap page={} anchor={}",
                bytes.len(),
                DisplayJson::Entry(page.block().unwrap().human())
                    .json_size()
                    .unwrap()
            );
            assert!(bytes.len() <= PAGE_BYTES);
            assert!(bytes.len() > PAGE_BYTES - 20);
            assert_eq!(
                page.block().unwrap().summary().unwrap().last_request_id(),
                Some(summary.as_str())
            );
            let human_view = page.block().unwrap().human();
            assert!(!human_view.fields()[0].text().is_empty());
            assert!(human_view.earlier_content().is_some());
            let mut restored = human_view.fields()[0].text().to_owned();
            let mut cursor = human_view.earlier_content().cloned();
            while let Some(next) = cursor {
                let page = handle.conversation_content(next).await.unwrap();
                bounded(&page);
                restored.insert_str(0, page.entry().fields()[0].text());
                cursor = page.entry().earlier_content().cloned();
            }
            assert_eq!(restored, human);
        } else {
            assert_eq!(page.err(), Some(ConversationError::DisplayUnavailable));
        }
        assert_eq!(
            handle
                .run_record(run.clone())
                .await
                .unwrap()
                .unwrap()
                .result()
                .unwrap()
                .summary
                .last_request_id
                .as_deref(),
            Some(summary.as_str())
        );
        assert!(
            handle
                .append_run_records(op, run, vec![old])
                .await
                .unwrap()
                .duplicate()
        );
        assert_eq!(canonical(&path).await, before);
        store.close().await.unwrap();
    }
}
