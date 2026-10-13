use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::json;

use super::*;
use crate::{
    conversation::{ContentCursor, FieldFragment, FieldKind},
    storage::ApplicationSessionId,
};

#[test]
fn source_keys_are_deterministic_scoped_and_domain_separated() {
    let run: RunId = "11111111-1111-4111-8111-111111111111".parse().unwrap();
    let other: RunId = "22222222-2222-4222-8222-222222222222".parse().unwrap();
    let human = SourceKey::entry(&run, EntrySource::Human).unwrap();
    let expected = digest(
        &SHA256,
        br#"[1,"wi.conversation.entry","11111111-1111-4111-8111-111111111111","human"]"#,
    );
    assert_eq!(human.bytes().as_slice(), expected.as_ref());
    let keys = [
        human,
        SourceKey::entry(&other, EntrySource::Human).unwrap(),
        SourceKey::entry(&run, EntrySource::Assistant { turn_id: "same" }).unwrap(),
        SourceKey::entry(&run, EntrySource::Tool { call_id: "same" }).unwrap(),
        SourceKey::entry(
            &run,
            EntrySource::Reuse {
                sequence: 1,
                slot: 23,
            },
        )
        .unwrap(),
        SourceKey::entry(
            &run,
            EntrySource::Reuse {
                sequence: 12,
                slot: 3,
            },
        )
        .unwrap(),
        SourceKey::entry(
            &run,
            EntrySource::Notice {
                sequence: 1,
                slot: 23,
            },
        )
        .unwrap(),
        SourceKey::entry(
            &run,
            EntrySource::Assistant {
                turn_id: "a\0b:\"雪",
            },
        )
        .unwrap(),
        SourceKey::entry(
            &run,
            EntrySource::Assistant {
                turn_id: "a\\0b:\"雪",
            },
        )
        .unwrap(),
        SourceKey::entry(&other, EntrySource::Tool { call_id: "same" }).unwrap(),
    ];
    assert!(human == SourceKey::entry(&run, EntrySource::Human).unwrap());
    assert_eq!(
        keys.into_iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        keys.len()
    );
    let entry = EntryId::new(1, 0).unwrap();
    let order = OrderKey::new(Some(u64::MAX), FieldRank::Content, None, Some(0));
    let field = SourceKey::field(&run, &entry, &order).unwrap();
    assert!(field == SourceKey::field(&run, &entry, &order).unwrap());
    assert!(field != human);
    assert!(field != SourceKey::field(&other, &entry, &order).unwrap());
    assert!(field != SourceKey::field(&run, &EntryId::new(1, 1).unwrap(), &order).unwrap());
    assert_eq!(field.field_id().len(), 64);
    assert!(
        field
            .field_id()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
}

#[test]
fn field_ids_preserve_logical_source_bytes_not_fallback_placement() {
    let run: RunId = "11111111-1111-4111-8111-111111111111".parse().unwrap();
    let entry = EntryId::new(5, 0).unwrap();
    for (order, expected) in [
        (
            OrderKey::new(Some(0), FieldRank::Summary, Some(0), None),
            "03f319c17b2a57dc9c05b05e5dd98949bca67fafc452076b8cd1eb21660ed1a8",
        ),
        (
            OrderKey::new(Some(0), FieldRank::Content, None, Some(1)),
            "8390c1658a134f13d398192453a87a590520582730f162f1176deb20860b3075",
        ),
        (
            OrderKey::new(Some(0), FieldRank::Fallback, None, None),
            "70fda21b8d73de73349bf86106f0a375e84f615f1c340fcac1405f4b4e440d1c",
        ),
        (
            OrderKey::new(Some(1), FieldRank::FunctionArguments, None, None),
            "8e69fb08f3908b33677974358a89e1bce8813ed5efea3e52659d159213386eef",
        ),
    ] {
        // These hashes pin the pre-fix logical tuple, not the sortable spelling.
        assert_eq!(
            SourceKey::field(&run, &entry, &order).unwrap().field_id(),
            expected
        );
        assert_ne!(order.to_string(), order.source_spelling());
    }
    let fallback = OrderKey::new(Some(0), FieldRank::Fallback, None, None);
    for index in [None, Some(0), Some(1), Some(u64::MAX)] {
        let placed = OrderKey::new(Some(0), FieldRank::Fallback, None, index);
        assert_eq!(
            SourceKey::field(&run, &entry, &placed).unwrap().field_id(),
            SourceKey::field(&run, &entry, &fallback)
                .unwrap()
                .field_id()
        );
        let content = OrderKey::new(Some(0), FieldRank::Content, None, index);
        assert_ne!(placed.source_spelling(), content.source_spelling());
        assert!(placed < content);
        assert!(placed.to_string() < content.to_string());
        if let Some(index) = index.filter(|index| *index > 0) {
            let preceding = OrderKey::new(Some(0), FieldRank::Content, None, Some(index - 1));
            assert!(preceding < placed);
            assert!(preceding.to_string() < placed.to_string());
        }
    }
}

#[test]
fn field_identities_accept_text_hash_bytes_and_source_key_extremes() {
    let sid: ApplicationSessionId = "11111111-1111-4111-8111-111111111111".parse().unwrap();
    let run: RunId = "22222222-2222-4222-8222-222222222222".parse().unwrap();
    let check = |field_id: String, entry: EntryId, order: String| {
        let text = "/synthetic/displayed-text\n\0雪";
        let field = FieldFragment::new(
            field_id.clone(),
            order.clone(),
            FieldKind::Text,
            u64::MAX,
            u64::MAX,
            u64::MAX - text.len() as u64,
            u64::MAX,
            text.into(),
        )
        .unwrap();
        assert_eq!(field.field_id(), field_id);
        assert_eq!(field.order_key(), order);
        assert_eq!(field.text().as_bytes(), text.as_bytes());
        let cursor = ContentCursor::new(
            sid.clone(),
            run.clone(),
            entry,
            u64::MAX,
            field_id.clone(),
            u64::MAX,
            u64::MAX,
        )
        .unwrap();
        let fields = json!([
            1,
            sid.as_str(),
            run.as_str(),
            entry.to_string(),
            u64::MAX.to_string(),
            field_id,
            u64::MAX.to_string(),
            u64::MAX.to_string()
        ]);
        let encoded = format!("g11c.{}", URL_SAFE_NO_PAD.encode(fields.to_string()));
        assert_eq!(cursor.to_string(), encoded);
        assert_eq!(cursor.upper_field_id(), field_id);
        assert_eq!(encoded.parse::<ContentCursor>().unwrap(), cursor);
    };
    let entry = EntryId::new(u64::MAX, u64::MAX).unwrap();
    let order = OrderKey::new(None, FieldRank::Content, None, None).to_string();
    check("text".into(), entry, "0".into());
    // Every byte is legal in a hash, including all-zero and all-ff hashes.
    for byte in 0..=u8::MAX {
        let field_id = SourceKey([byte; 32]).field_id();
        assert_eq!(field_id, format!("{byte:02x}").repeat(32));
        check(field_id, entry, order.clone());
    }
    let mut leading_zeroes = [0; 32];
    leading_zeroes[31] = 1;
    let field_id = SourceKey(leading_zeroes).field_id();
    assert_eq!(field_id, format!("{}1", "0".repeat(63)));
    check(field_id, entry, order);

    let indices = [
        None,
        Some(0),
        Some(1),
        Some((1 << 53) + 1),
        Some(i64::MAX as u64),
        Some(u64::MAX),
    ];
    for (sequence, slot) in [(1, 0), (1, u64::MAX), (u64::MAX, 0), (u64::MAX, u64::MAX)] {
        let entry = EntryId::new(sequence, slot).unwrap();
        for output in indices {
            for rank in [
                FieldRank::Summary,
                FieldRank::Fallback,
                FieldRank::Content,
                FieldRank::FunctionName,
                FieldRank::FunctionArguments,
                FieldRank::ToolName,
                FieldRank::ToolOutput,
                FieldRank::Unsupported,
                FieldRank::Notice,
            ] {
                for summary in indices {
                    for content in indices {
                        let order = OrderKey::new(output, rank, summary, content);
                        let field_id = SourceKey::field(&run, &entry, &order).unwrap().field_id();
                        check(field_id, entry, order.to_string());
                    }
                }
            }
        }
    }
}

#[test]
fn order_key_numeric_and_lexical_orders_agree_at_extremes() {
    let indices = [
        None,
        Some(0),
        Some(1),
        Some(15),
        Some(16),
        Some((1 << 53) + 1),
        Some(i64::MAX as u64),
        Some(u64::MAX),
    ];
    let ranks = [
        FieldRank::Summary,
        FieldRank::Fallback,
        FieldRank::Content,
        FieldRank::FunctionName,
        FieldRank::FunctionArguments,
        FieldRank::ToolName,
        FieldRank::ToolOutput,
        FieldRank::Unsupported,
        FieldRank::Notice,
    ];
    let mut keys = Vec::new();
    for output in indices {
        for rank in ranks {
            for summary in indices {
                for content in indices {
                    let key = OrderKey::new(output, rank, summary, content);
                    assert_eq!(key.to_string().parse::<OrderKey>().unwrap(), key);
                    keys.push(key);
                }
            }
        }
    }
    keys.sort();
    assert!(
        keys.windows(2)
            .all(|pair| pair[0] < pair[1] && pair[0].to_string() < pair[1].to_string())
    );
    assert_eq!(component(None), "0");
    assert_eq!(component(Some(0)), "10000000000000000");
    assert_eq!(component(Some(u64::MAX)), "1ffffffffffffffff");
}

#[test]
fn order_key_parser_rejects_noncanonical_components() {
    for bad in [
        "",
        "1",
        "00",
        "10",
        "1000000000000000",
        "100000000000000000",
        "1FFFFFFFFFFFFFFFF",
        "1fffffffffffffffz",
        "-1",
        "1+000000000000000",
        "１",
    ] {
        assert!(parse_component(bad).is_err());
        assert!(
            format!("{bad}:0000000000000001:0:0:0000000000000002")
                .parse::<OrderKey>()
                .is_err()
        );
    }
    for bad in [
        "0",
        "0:2:0",
        "0:2:0:0:0",
        "0:9:0:0",
        "0:02:0:0",
        "0:2:0:0\n",
        "0:x:0:0",
        "0:0000000000000001:0:0:0000000000000009",
        "0:0000000000000000:0:0:0000000000000002",
        "0:1:0:0:0000000000000002",
        "0:0000000000000001:0:0:2",
        "0:0000000000000001:0:0:0000000000000002:0",
        "0:0000000000000001:0:0:0000000000000002\n",
        "0:0000000000000001:0:0:000000000000000A",
    ] {
        assert!(bad.parse::<OrderKey>().is_err());
    }
}

#[test]
fn chunks_preserve_exact_utf8_bytes_and_offsets_without_empty_rows() {
    for text in [
        String::new(),
        "\0\u{1}\r\n\u{1b}[31m雪🙂e\u{301}".into(),
        "a".repeat(CHUNK_BYTES),
        "\0".repeat(CHUNK_BYTES + 1),
        format!("{}🙂雪", "a".repeat(CHUNK_BYTES - 1)),
        "雪🙂\0\r\n\t\"\\e\u{301}".repeat(9000),
    ] {
        for start in [0, 7, (1 << 53) + 1] {
            let chunks = TextChunks::new(&text, start).unwrap();
            let mut joined = String::new();
            for chunk in chunks {
                assert_eq!(chunk.start_byte(), start + joined.len() as u64);
                assert!(!chunk.text().is_empty());
                assert!(chunk.text().len() <= CHUNK_BYTES);
                joined.push_str(chunk.text());
            }
            assert_eq!(joined.as_bytes(), text.as_bytes());
        }
    }
    let text = format!("{}🙂", "a".repeat(CHUNK_BYTES - 1));
    let chunks: Vec<_> = TextChunks::new(&text, 0).unwrap().collect();
    assert_eq!(chunks[0].text().len(), 8191);
    assert_eq!(chunks[1].start_byte(), 8191);
    assert_eq!(chunks[1].text(), "🙂");
    assert_eq!(TextChunks::new("", u64::MAX).unwrap().count(), 0);
    assert_eq!(
        TextChunks::new("a", u64::MAX - 1)
            .unwrap()
            .next()
            .unwrap()
            .start_byte(),
        u64::MAX - 1
    );
    assert!(TextChunks::new("a", u64::MAX).is_err());
    assert!(TextChunks::new("🙂", u64::MAX - 3).is_err());
}
