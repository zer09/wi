use super::*;
use crate::{InputItem, tools::ToolRegistry};
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct View {
    blocks: BTreeMap<String, Value>,
    entries: BTreeMap<(String, String), Value>,
}
impl View {
    fn apply(&mut self, value: &Value) {
        for change in value["changes"].as_array().unwrap() {
            if change["kind"] == "block.upsert" || change["kind"] == "entry.upsert" {
                let block = &change["block"];
                self.blocks
                    .insert(block["run_id"].as_str().unwrap().into(), block.clone());
            }
            if change["kind"] == "entry.upsert" {
                let entry = &change["entry"];
                self.entries.insert(
                    (
                        entry["run_id"].as_str().unwrap().into(),
                        entry["entry_id"].as_str().unwrap().into(),
                    ),
                    entry.clone(),
                );
            }
        }
    }
    async fn same(&self, server: &Server, session: &SessionHandle) {
        let page = response(server.get(&base(session)), 200).await;
        let block = &page["block"];
        let run = block["run_id"].as_str().unwrap();
        assert_eq!(&self.blocks[run], block);
        let mut entries: Vec<_> = self
            .entries
            .iter()
            .filter(|((rid, _), entry)| rid == run && entry["kind"] != "human")
            .map(|(_, entry)| entry.clone())
            .collect();
        entries.sort_by_key(|e| {
            (
                e["position"]["sequence"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap(),
                e["position"]["slot"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap(),
            )
        });
        assert_eq!(json!(entries), page["entries"]);
        for entry in entries {
            let read = response(
                server.get(&addressed(
                    session,
                    &run.parse().unwrap(),
                    entry["entry_id"].as_str().unwrap(),
                )),
                200,
            )
            .await;
            assert_eq!(read["entry"], entry);
            assert_eq!(read["block"], *block);
            assert_eq!(read["snapshot_head"], page["snapshot_head"]);
        }
    }
}
async fn sync(
    reader: &mut Reader,
    session: &SessionHandle,
    after: &mut LiveCursor,
    view: &mut View,
) {
    loop {
        let batch = session.conversation_changes(after.clone()).await.unwrap();
        if batch.next_after() == after && batch.changes().is_empty() {
            break;
        }
        view.apply(&reader.exact(&batch).await);
        *after = batch.next_after().clone();
        if !batch.has_more() {
            break;
        }
    }
}

#[tokio::test]
async fn b2_actual_registry_pending_result_reuse_terminal_and_partial_page_parity() {
    for mode in 0..3 {
        let server = Server::new().await;
        let session = server.session().await;
        let (_, mut after) = latest(&server, &session).await;
        let mut writer = Writer::accept(&session, "one human anchor").await;
        writer.start().await;
        writer.delta(0, "partial 雪\0").await;
        let mut reader = Reader::new(server.get(&path(&session, &after))).await;
        let mut view = View::default();
        sync(&mut reader, &session, &mut after, &mut view).await;
        view.same(&server, &session).await;
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(tools::SyntheticTool {
                mode,
                calls: calls.clone(),
            }))
            .unwrap();
        let mut events = vec![];
        let results = registry
            .execute_response(&tools::response_call(), |event| events.push(event))
            .await
            .unwrap();
        let InputItem::ToolResult { output, .. } = &results[0] else {
            unreachable!()
        };
        let ToolExecutionEvent::ToolExecutionFinished { is_error, .. } = events[1] else {
            unreachable!()
        };
        writer
            .runtime(RunEvent::ToolEvent {
                event: events[0].clone(),
            })
            .await;
        sync(&mut reader, &session, &mut after, &mut view).await;
        view.same(&server, &session).await;
        let pending = view.entries.values().find(|e| e["kind"] == "tool").unwrap();
        assert_eq!(pending["is_error"], Value::Null);
        assert_eq!(pending["result_recorded"], false);
        assert_eq!(pending["finish_recorded"], false);
        writer
            .session
            .append_run_records(
                OperationId::new(),
                writer.run.clone(),
                vec![AppendRunRecord::ToolResult {
                    call_id: "call".into(),
                    request_id: Some(REQUEST.into()),
                    output: output.clone(),
                    is_error,
                }],
            )
            .await
            .unwrap();
        sync(&mut reader, &session, &mut after, &mut view).await;
        view.same(&server, &session).await;
        let tool = view.entries.values().find(|e| e["kind"] == "tool").unwrap();
        assert_eq!(tool["fields"][1]["text"], *output);
        assert_eq!(tool["is_error"], is_error);
        assert_eq!(tool["finish_recorded"], false);
        let mut reused = vec![];
        registry
            .execute_response(&tools::response_call(), |event| reused.push(event))
            .await
            .unwrap();
        writer
            .runtime(RunEvent::ToolEvent {
                event: reused[0].clone(),
            })
            .await;
        sync(&mut reader, &session, &mut after, &mut view).await;
        writer
            .runtime(RunEvent::ToolEvent {
                event: events[1].clone(),
            })
            .await;
        sync(&mut reader, &session, &mut after, &mut view).await;
        view.same(&server, &session).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let tool = view.entries.values().find(|e| e["kind"] == "tool").unwrap();
        let reuse = view
            .entries
            .values()
            .find(|e| e["kind"] == "reuse")
            .unwrap();
        assert_eq!(tool["finish_recorded"], true);
        assert_eq!(reuse["finish_recorded"], false);
        assert_eq!(reuse["reference"]["entry_id"], tool["entry_id"]);
        writer
            .runtime(RunEvent::TurnFinished {
                number: 1,
                response_id: None,
                outcome: crate::run::TurnOutcome::Stopped {
                    reason: RunOutcome::CancelledLocally,
                },
                upstream_outcome: None,
            })
            .await;
        sync(&mut reader, &session, &mut after, &mut view).await;
        writer
            .runtime(RunEvent::RunFinished {
                outcome: RunOutcome::CancelledLocally,
                summary: RunSummary::default(),
            })
            .await;
        sync(&mut reader, &session, &mut after, &mut view).await;
        view.same(&server, &session).await;
        writer
            .session
            .append_run_records(
                OperationId::new(),
                writer.run.clone(),
                vec![AppendRunRecord::Result(RunResult {
                    run_id: writer.run.to_string(),
                    session_id: Some("private-provider-session-canary".into()),
                    outcome: RunOutcome::CancelledLocally,
                    summary: RunSummary::default(),
                    last_response: None,
                    events_complete: true,
                    sink_error: None,
                })],
            )
            .await
            .unwrap();
        sync(&mut reader, &session, &mut after, &mut view).await;
        view.same(&server, &session).await;
        assert_eq!(view.blocks[writer.run.as_str()]["result_recorded"], true);
        let before = snapshot(&server, &session).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(snapshot(&server, &session).await, before);
        drop(reader);
        server.finish().await;
    }
}

#[tokio::test]
async fn b2_restart_interrupted_partial_stream_matches_page_without_resuming() {
    let server = Server::new().await;
    let session = server.session().await;
    let (_, after) = latest(&server, &session).await;
    let mut writer = Writer::accept(&session, "interrupted anchor").await;
    writer.start().await;
    writer.delta(0, "retained partial\0雪").await;
    let id = session.session_id().clone();
    let run = writer.run.clone();
    drop(writer);
    drop(session);
    let (temp, host) = server.stop_http().await;
    assert!(matches!(
        &*host.begin_shutdown().wait().await,
        crate::service::ShutdownOutcome::Closed
    ));
    drop(host);
    let store = SessionStore::open(temp.path().join("private-data-canary"))
        .await
        .unwrap();
    let host = Arc::new(RunHost::new(store, Arc::new(Gateway::new())).unwrap());
    let restarted = Server::start(temp, host, false).await;
    let session = restarted.host.storage().open_session(id).await.unwrap();
    let batch = session.conversation_changes(after.clone()).await.unwrap();
    let mut reader = Reader::new(restarted.get(&path(&session, &after))).await;
    let mut view = View::default();
    view.apply(&reader.exact(&batch).await);
    view.same(&restarted, &session).await;
    assert_eq!(view.blocks[run.as_str()]["state"], "interrupted");
    assert!(
        view.entries
            .values()
            .any(|e| e.to_string().contains("retained partial"))
    );
    drop(reader);
    restarted.finish().await;
}
