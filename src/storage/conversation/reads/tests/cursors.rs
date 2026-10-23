use super::*;
use crate::{ItemKind, OutputItem, ProviderEvent};

fn changed(cursor: &ContentCursor, index: usize, value: serde_json::Value) -> ContentCursor {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let encoded = cursor.to_string();
    let mut fields: serde_json::Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(encoded.strip_prefix("g11c.").unwrap())
            .unwrap(),
    )
    .unwrap();
    fields[index] = value;
    format!("g11c.{}", URL_SAFE_NO_PAD.encode(fields.to_string()))
        .parse()
        .unwrap()
}

#[tokio::test]
async fn a5b1_cursor_append_membership_replacement_and_resource_validation() {
    let mut f = Fixture::new("anchor").await;
    f.start().await;
    let text = "雪é\0".repeat(20000);
    f.delta(0, &text).await;
    let first = f.entry("e:5:0").await;
    let cursor = first.entry().earlier_content().unwrap().clone();
    let previous = f.handle.conversation_content(cursor.clone()).await.unwrap();
    let old_head = previous.snapshot_head();
    f.delta(0, "appended 🦀").await;
    f.delta(1, "new field").await;
    let appended = f.handle.conversation_content(cursor.clone()).await.unwrap();
    assert!(appended.snapshot_head() > old_head);
    assert!(appended.entry().revision() > previous.entry().revision());
    assert_eq!(
        appended.entry().fields()[0].to_byte(),
        cursor.exclusive_upper_byte()
    );
    assert_eq!(
        appended.entry().fields()[0].text(),
        previous.entry().fields()[0].text()
    );
    assert!(appended.entry().fields()[0].has_later());
    let zero: ContentCursor = changed(&cursor, 7, "0".into());
    assert_eq!(
        f.handle.conversation_content(zero).await.err(),
        Some(ConversationError::CursorInvalid)
    );
    for (index, value) in [
        (1, ApplicationSessionId::new().as_str().into()),
        (4, (appended.snapshot_head() + 1).to_string().into()),
        (6, (appended.snapshot_head() + 1).to_string().into()),
        (5, "f".repeat(64).into()),
        (7, (text.len() as u64 + 1000).to_string().into()),
        (7, "1".into()),
    ] {
        assert_eq!(
            f.handle
                .conversation_content(changed(&cursor, index, value))
                .await
                .err(),
            Some(ConversationError::CursorInvalid)
        );
    }
    let missing = f
        .handle
        .conversation_entry(f.run.clone(), "e:9999:0".parse().unwrap())
        .await
        .err()
        .unwrap();
    assert!(
        matches!(missing, ConversationError::Storage(error) if error.kind() == StorageErrorKind::NotFound)
    );
    let other = Fixture::new("other").await;
    assert_eq!(
        other
            .handle
            .conversation_content(cursor.clone())
            .await
            .err(),
        Some(ConversationError::CursorInvalid)
    );
    other.store.close().await.unwrap();
    // Replace the addressed layout and remove its old field entirely.
    f.provider(ProviderEvent::OutputItemFinished {
        response_id: "PRIVATE_RESPONSE_".repeat(10000),
        output_index: 0,
        item: OutputItem {
            id: Some("replacement".into()),
            kind: ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: serde_json::json!({"content":[{"type":"refusal","refusal":"replacement"}]}),
        },
    })
    .await;
    assert_eq!(
        f.handle.conversation_content(cursor).await.err(),
        Some(ConversationError::CursorStale)
    );
    let fresh = f.entry("e:5:0").await;
    assert!(fresh.entry().content_epoch() > first.entry().content_epoch());
    assert_eq!(fresh.block().human().fields()[0].text(), "anchor");
    bounded(&fresh);
    f.store.close().await.unwrap();
}

#[tokio::test]
async fn a5b1_field_generation_replacement_is_stale_without_changing_epoch() {
    let mut f = Fixture::new("anchor").await;
    f.start().await;
    f.delta(0, &"é".repeat(30000)).await;
    let first = f.entry("e:5:0").await;
    let cursor = first.entry().earlier_content().unwrap().clone();
    f.provider(ProviderEvent::OutputItemFinished {
        response_id: "PRIVATE_RESPONSE_".repeat(10000),
        output_index: 0,
        item: OutputItem {
            id: Some("replacement".into()),
            kind: ItemKind::Message,
            native_type: "message".into(),
            function_call: None,
            native: serde_json::json!({"content":[{"type":"output_text","text":"different text"}]}),
        },
    })
    .await;
    let fresh = f.entry("e:5:0").await;
    assert_eq!(fresh.entry().content_epoch(), first.entry().content_epoch());
    assert_eq!(
        f.handle.conversation_content(cursor).await.err(),
        Some(ConversationError::CursorStale)
    );
    f.store.close().await.unwrap();
}
