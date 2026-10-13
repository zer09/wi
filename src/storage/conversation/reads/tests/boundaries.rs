use super::*;

#[tokio::test]
async fn a5b1_multiple_nonempty_fields_and_empty_boundary_reconstruct_without_gaps() {
    let mut f = Fixture::new("anchor").await;
    f.start().await;
    let expected = [
        "α\0".repeat(14000),
        String::new(),
        "雪\"".repeat(17000),
        "tail".into(),
    ];
    for (index, text) in expected.iter().enumerate() {
        f.delta(index as u64, text).await;
    }
    let mut page = f.entry("e:5:0").await;
    let mut restored = std::collections::BTreeMap::<String, String>::new();
    let mut intervals = std::collections::BTreeMap::<String, u64>::new();
    loop {
        bounded(&page);
        for field in page.entry().fields() {
            let next = intervals
                .entry(field.field_id().into())
                .or_insert(field.total_bytes());
            assert_eq!(*next, field.to_byte());
            *next = field.from_byte();
            restored
                .entry(field.order_key().into())
                .or_default()
                .insert_str(0, field.text());
        }
        let Some(cursor) = page.entry().earlier_content().cloned() else {
            break;
        };
        page = f.handle.conversation_content(cursor).await.unwrap();
    }
    assert_eq!(restored.into_values().collect::<Vec<_>>(), expected);
    assert!(intervals.values().all(|offset| *offset == 0));
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b1_cursor_wrong_run_entry_and_future_entry_are_invalid() {
    let mut f = Fixture::new("anchor").await;
    f.start().await;
    f.delta(0, &"雪".repeat(20000)).await;
    let page = f.entry("e:5:0").await;
    let issued = page.entry().earlier_content().unwrap();
    for (run, entry) in [
        (RunId::new(), *issued.entry_id()),
        (f.run.clone(), "e:2:0".parse().unwrap()),
        (f.run.clone(), "e:99999:0".parse().unwrap()),
    ] {
        let epoch = issued.content_epoch().max(entry.first_sequence());
        let generation = issued.upper_generation().max(entry.first_sequence());
        let cursor = ContentCursor::new(
            f.handle.session_id().clone(),
            run,
            entry,
            epoch,
            issued.upper_field_id().into(),
            generation,
            issued.exclusive_upper_byte(),
        )
        .unwrap();
        assert_eq!(
            f.handle.conversation_content(cursor).await.err(),
            Some(ConversationError::CursorInvalid)
        );
    }
    f.store.close().await.unwrap();
}
