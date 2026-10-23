use super::*;
use crate::{
    SessionOptions,
    storage::{CreateSession, OperationId, SessionStore},
};

#[tokio::test]
async fn test_tool_defaults_empty_and_uses_ordinary_duplicate_validation() {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = ApiSettings::new(
        "http://127.0.0.1:1",
        vec![temp.path().to_owned()],
        temp.path().join("skills"),
        "test".into(),
        SessionOptions::new("test"),
        true,
    )
    .unwrap();
    assert!(settings.test_tool().is_none());
    let store = SessionStore::open(temp.path().join("data")).await.unwrap();
    let created = store
        .create_session(
            CreateSession::new(
                OperationId::new(),
                "test".into(),
                Some(settings.workspaces()[0].clone()),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let session = store
        .open_session(created.session_id().clone())
        .await
        .unwrap();
    let (input, tools, _) = prepare(&settings, &session, "test".into(), Arc::default())
        .await
        .unwrap_or_else(|_| panic!("test preparation failed"));
    assert_eq!(tools.definitions().len(), 1);
    assert_eq!(input.tool_definitions().len(), 1);
    settings.set_test_tool(Arc::new(AddNumbers));
    let error = prepare(&settings, &session, "test".into(), Arc::default())
        .await
        .err()
        .unwrap();
    assert!(serde_json::to_value(error).unwrap()["code"] == "invalid_request");
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 1);
    store.close().await.unwrap();
}
