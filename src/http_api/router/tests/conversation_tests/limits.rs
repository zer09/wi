use super::*;

#[tokio::test]
async fn b1_large_b_byte_limited_segments_are_contiguous_without_loading_a() {
    let server = Server::new().await;
    let session = server.session().await;
    let a = Writer::accept(&session, "older A").await;
    a.result().await;
    let mut b = Writer::accept(&session, "anchor B").await;
    b.start().await;
    let output = "雪\0\\\"".repeat(22000);
    let mut ordered = Vec::new();
    for index in 0..20 {
        let call_id = format!("large-{index}");
        b.runtime(RunEvent::ToolEvent {
            event: ToolExecutionEvent::ToolExecutionStarted {
                call_id: call_id.clone(),
                tool_name: "synthetic".into(),
            },
        })
        .await;
        let accepted = session.manifest().await.unwrap().head_sequence();
        ordered.push(format!("e:{accepted}:0"));
        session
            .append_run_records(
                OperationId::new(),
                b.run.clone(),
                vec![AppendRunRecord::ToolResult {
                    call_id,
                    request_id: Some(REQUEST.into()),
                    output: output.clone(),
                    is_error: false,
                }],
            )
            .await
            .unwrap();
    }
    let before = snapshot(&server, &session).await;
    let mut page = session
        .conversation_page(ConversationQuery::Latest)
        .await
        .unwrap();
    let count = page.entries().len();
    let bytes = DisplayJson::Page(&page).encode().unwrap().len();
    assert!(count < 20);
    assert!(bytes <= PAGE_BYTES);
    assert!(bytes > 450000);
    println!(
        "b1 byte-limited B first entries={count} bytes={bytes} stored tool bytes={}",
        output.len()
    );
    exact(server.get(&base(&session)), DisplayJson::Page(&page)).await;
    let mut actual = Vec::new();
    loop {
        assert_eq!(page.block().unwrap().run_id(), &b.run);
        let segment: Vec<_> = page
            .entries()
            .iter()
            .filter(|entry| entry.kind() == crate::conversation::EntryKind::Tool)
            .map(|entry| entry.entry_id().to_string())
            .collect();
        actual.splice(0..0, segment);
        let Some(cursor) = page.earlier_activity().cloned() else {
            break;
        };
        page = session
            .conversation_page(ConversationQuery::Within(cursor.clone()))
            .await
            .unwrap();
        exact(
            server.get(&format!("{}?within={cursor}", base(&session))),
            DisplayJson::Page(&page),
        )
        .await;
    }
    assert_eq!(actual, ordered);
    let entry = ordered.last().unwrap().parse().unwrap();
    let addressed_page = session
        .conversation_entry(b.run.clone(), entry)
        .await
        .unwrap();
    exact(
        server.get(&addressed(&session, &b.run, entry)),
        DisplayJson::EntryPage(&addressed_page),
    )
    .await;
    let fields = restore(&server, &session, addressed_page).await;
    assert_eq!(
        fields
            .values()
            .filter(|text| text.as_str() == output)
            .count(),
        1
    );
    assert_eq!(snapshot(&server, &session).await, before);
    server.finish().await;
}
