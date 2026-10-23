// Storage sibling access supplies exact manifest values without public test constructors.
use crate::{
    conversation::{ConversationPage, ConversationQuery, LiveCursor, wire::DisplayJson},
    storage::{ApplicationSessionId, SessionManifest},
};
use serde_json::json;

#[test]
fn a5a_session_shape_signed_timestamps_and_full_u64_head() {
    for (created, updated) in [(i64::MIN, -1), (0, i64::MAX)] {
        let session = SessionManifest {
            session_id: ApplicationSessionId::new(),
            title: "Title\0雪".into(),
            workspace: Some("/synthetic/<workspace>".into()),
            created_at_ms: created,
            updated_at_ms: updated,
            head_sequence: u64::MAX,
        };
        let sid = session.session_id().clone();
        let page = ConversationPage::new(
            &ConversationQuery::Latest,
            u64::MAX,
            session,
            None,
            vec![],
            None,
            None,
            Some(LiveCursor::new(sid.clone(), u64::MAX, 3, None, None).unwrap()),
        )
        .unwrap();
        let bytes = DisplayJson::Page(&page).encode().unwrap();
        assert_eq!(DisplayJson::Page(&page).json_size().unwrap(), bytes.len());
        let wire: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            wire["session"],
            json!({"api_version":1,"session_id":sid,"title":"Title\0雪","workspace":"/synthetic/<workspace>",
            "created_at_ms":created.to_string(),"updated_at_ms":updated.to_string(),"head_sequence":u64::MAX.to_string(),"view":"canonical"})
        );
        assert_eq!(wire["snapshot_head"], u64::MAX.to_string());
    }
}

#[test]
fn a5a_session_header_exact_page_boundary_and_escape_overhead() {
    let make = |title: String| {
        let sid = ApplicationSessionId::new();
        let session = SessionManifest {
            session_id: sid.clone(),
            title,
            workspace: None,
            created_at_ms: 0,
            updated_at_ms: 0,
            head_sequence: 1,
        };
        ConversationPage::new(
            &ConversationQuery::Latest,
            1,
            session,
            None,
            vec![],
            None,
            None,
            Some(LiveCursor::new(sid, 1, 3, None, None).unwrap()),
        )
        .unwrap()
    };
    let trial = make("x".repeat(10_000));
    let n = 10_000 + 524_288 - DisplayJson::Page(&trial).json_size().unwrap();
    let at = make("x".repeat(n));
    assert_eq!(DisplayJson::Page(&at).encode().unwrap().len(), 524_288);
    assert!(
        DisplayJson::Page(&make("x".repeat(n + 1)))
            .encode()
            .is_err()
    );
    let escaped = make("\0".repeat(100_000));
    assert!(DisplayJson::Page(&escaped).encode().is_err());
}
