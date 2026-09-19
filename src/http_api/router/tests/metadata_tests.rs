use super::*;
use crate::storage::test_hooks::{Action, Pause, Point};

#[tokio::test]
async fn create_is_durable_idempotent_and_retired_workspace_remains_readable() {
    let server = Server::new().await;
    let oid = OperationId::new();
    let title = "  雪\r\nsecond line\n";
    let command = json!({"operation_id":oid,"title":title,"workspace":server.workspace()});
    let created = response(server.post("/v1/sessions", &command), 201).await;
    let sid = created["session_id"].as_str().unwrap();
    assert_eq!(
        created,
        json!({"api_version":1,"session_id":sid,"duplicate":false,"warning_code":null,
        "receipt":{"operation_id":oid,"session_id":sid,"run_id":null,"first_sequence":"1","last_sequence":"1"}})
    );
    let duplicate = response(server.post("/v1/sessions", &command), 200).await;
    assert_eq!(duplicate["receipt"], created["receipt"]);
    assert_eq!(duplicate["session_id"], sid);
    assert_eq!(duplicate["duplicate"], true);
    let mut different = command.clone();
    different["title"] = json!("different");
    assert_eq!(
        error(
            server.post("/v1/sessions", &different),
            409,
            "storage.command_conflict"
        )
        .await["certainty"],
        "not_committed"
    );
    let canonical = response(server.get(&format!("/v1/sessions/{sid}")), 200).await;
    assert_eq!(canonical["title"], title);
    assert_eq!(canonical["workspace"], server.workspace());
    assert_eq!(canonical["head_sequence"], "1");
    assert_eq!(canonical["view"], "canonical");
    assert!(canonical["created_at_ms"].is_string());
    assert!(canonical["updated_at_ms"].is_string());
    assert!(canonical.get("last_run_id").is_none());
    for workspace in [
        "relative".to_owned(),
        server
            .temp
            .path()
            .join("not-allowed-canary")
            .to_str()
            .unwrap()
            .to_owned(),
        format!("{}/.", server.workspace()),
    ] {
        error(
            server.post(
                "/v1/sessions",
                &json!({"operation_id":OperationId::new(),"title":"","workspace":workspace}),
            ),
            403,
            "api.workspace_forbidden",
        )
        .await;
    }
    assert!(!server.temp.path().join("not-allowed-canary").exists());
    assert_eq!(
        response(server.get("/v1/sessions"), 200).await["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let sid = sid.to_owned();
    let (temp, host) = server.stop_http().await;
    let server = Server::start(temp, host, true).await;
    error(
        server.post("/v1/sessions", &command),
        403,
        "api.workspace_forbidden",
    )
    .await;
    response(server.get(&format!("/v1/sessions/{sid}")), 200).await;
    response(server.get(&format!("/v1/sessions/{sid}/history")), 200).await;
    let renamed = response(
        server.post(
            &format!("/v1/sessions/{sid}/rename"),
            &json!({"operation_id":OperationId::new(),"title":""}),
        ),
        200,
    )
    .await;
    assert_eq!(renamed["catalog_refresh"], "updated");
    let oid = renamed["receipt"]["operation_id"].as_str().unwrap();
    let receipt = response(
        server.get(&format!("/v1/sessions/{sid}/operations/{oid}")),
        200,
    )
    .await;
    assert_eq!(receipt["last_sequence"], "2");
    response(
        server.post(
            &format!("/v1/sessions/{sid}/runs/{}/cancel", RunId::new()),
            &json!({}),
        ),
        200,
    )
    .await;
    server.finish().await;
}

#[tokio::test]
async fn lost_create_reply_retries_original_catalog_receipt() {
    let server = Server::new().await;
    let sentinel = server.session().await;
    let pause = Arc::new(Pause::default());
    sentinel
        .test_hooks()
        .arm(Point::CatalogAccepted, Action::Pause(pause.clone()));
    let command = json!({"operation_id":OperationId::new(),"title":"lost reply","workspace":server.workspace()});
    let body = command.to_string();
    let mut socket = TcpStream::connect(server.address).await.unwrap();
    socket.write_all(format!("POST /v1/sessions HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", server.address, body.len()).as_bytes()).await.unwrap();
    watchdog(pause.reached.notified()).await;
    let listed = response(server.get("/v1/sessions"), 200).await;
    let original = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["title"] == "lost reply")
        .unwrap();
    drop(socket);
    pause.release.notify_one();
    let duplicate = response(server.post("/v1/sessions", &command), 200).await;
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["session_id"], original["session_id"]);
    assert_eq!(duplicate["receipt"]["first_sequence"], "1");
    assert_eq!(
        response(server.get("/v1/sessions"), 200).await["entries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    server.finish().await;
}

#[tokio::test]
async fn catalog_keyset_is_as_of_and_rename_refresh_preserve_exact_titles() {
    let server = Server::new().await;
    let mut ids = Vec::new();
    for title in ["", "one", "two", "three", "four"] {
        let created = response(server.post("/v1/sessions", &json!({"operation_id":OperationId::new(),"title":title,"workspace":server.workspace()})), 201).await;
        ids.push(created["session_id"].as_str().unwrap().to_owned());
    }
    ids.sort();
    let mut observed = Vec::new();
    let mut path = "/v1/sessions?limit=2".to_owned();
    loop {
        let page = response(server.get(&path), 200).await;
        let entries = page["entries"].as_array().unwrap();
        assert!(entries.len() <= 2);
        for entry in entries {
            assert_eq!(entry["view"], "catalog");
            assert_eq!(entry["availability"], "ready");
            assert_eq!(entry["fault_code"], Value::Null);
            assert_eq!(entry["observed_head_sequence"], "1");
            assert_eq!(entry["last_run_id"], Value::Null);
            assert_eq!(entry["last_run_state"], Value::Null);
            observed.push(entry["session_id"].as_str().unwrap().to_owned());
        }
        if page["has_more"] == false {
            break;
        }
        assert_eq!(page["next_after_id"], entries.last().unwrap()["session_id"]);
        path = format!(
            "/v1/sessions?limit=2&after_id={}",
            page["next_after_id"].as_str().unwrap()
        );
    }
    assert_eq!(observed, ids);
    let sid = &ids[0];
    let session = server
        .host
        .storage()
        .open_session(sid.parse().unwrap())
        .await
        .unwrap();
    session
        .rename(OperationId::new(), "canonical only".into())
        .await
        .unwrap();
    let old = response(server.get("/v1/sessions"), 200).await;
    assert_eq!(old["entries"][0]["observed_head_sequence"], "1");
    assert_eq!(
        response(server.get(&format!("/v1/sessions/{sid}")), 200).await["title"],
        "canonical only"
    );
    for disposition in ["updated", "unchanged"] {
        let refreshed = response(
            server.post(&format!("/v1/sessions/{sid}/refresh"), &json!({})),
            200,
        )
        .await;
        assert_eq!(
            refreshed,
            json!({"api_version":1,"session_id":sid,"disposition":disposition})
        );
    }
    let title = "\r\n雪\n  ";
    let oid = OperationId::new();
    let command = json!({"operation_id":oid,"title":title});
    let renamed = response(
        server.post(&format!("/v1/sessions/{sid}/rename"), &command),
        200,
    )
    .await;
    assert_eq!(renamed["duplicate"], false);
    assert_eq!(renamed["catalog_refresh"], "updated");
    assert_eq!(renamed["receipt"]["last_sequence"], "3");
    let repeated = response(
        server.post(&format!("/v1/sessions/{sid}/rename"), &command),
        200,
    )
    .await;
    assert_eq!(repeated["duplicate"], true);
    assert_eq!(repeated["catalog_refresh"], "unchanged");
    assert_eq!(repeated["receipt"], renamed["receipt"]);
    error(
        server.post(
            &format!("/v1/sessions/{sid}/rename"),
            &json!({"operation_id":oid,"title":"changed"}),
        ),
        409,
        "storage.command_conflict",
    )
    .await;
    let manifest = response(server.get(&format!("/v1/sessions/{sid}")), 200).await;
    assert_eq!(manifest["title"], title);
    assert_eq!(manifest["head_sequence"], "3");
    assert_eq!(
        response(server.get("/v1/sessions"), 200).await["entries"][0]["title"],
        title
    );
    server.finish().await;
}

#[tokio::test]
async fn rename_receipt_survives_cleanup_warning_and_failed_or_dropped_refresh() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    let hooks = session.test_hooks();
    // Pause after real retirement, then report a cleanup failure without losing the receipt.
    let warning = Arc::new(Pause {
        rollback: true,
        ..Pause::default()
    });
    hooks.arm(Point::WriteClosed, Action::Pause(warning.clone()));
    let command = json!({"operation_id":OperationId::new(),"title":"warning"});
    let pending = tokio::spawn(response(
        server.post(&format!("/v1/sessions/{sid}/rename"), &command),
        200,
    ));
    watchdog(warning.reached.notified()).await;
    hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    warning.release.notify_one();
    let renamed = watchdog(pending).await.unwrap();
    assert_eq!(renamed["warning_code"], "storage.connection_cleanup_failed");
    assert_eq!(renamed["catalog_refresh"], "not_attempted");
    // A skipped refresh leaves the open hook untouched.
    error(
        server.get(&format!("/v1/sessions/{sid}")),
        503,
        "storage.io",
    )
    .await;
    assert_eq!(renamed["receipt"]["last_sequence"], "2");
    let pause = Arc::new(Pause::default());
    hooks.arm(Point::WriteClosed, Action::Pause(pause.clone()));
    let command = json!({"operation_id":OperationId::new(),"title":"refresh fails"});
    let pending = tokio::spawn(response(
        server.post(&format!("/v1/sessions/{sid}/rename"), &command),
        200,
    ));
    watchdog(pause.reached.notified()).await;
    hooks.arm(Point::Open, Action::Fail(StorageErrorKind::Io));
    pause.release.notify_one();
    let renamed = watchdog(pending).await.unwrap();
    assert_eq!(renamed["catalog_refresh"], "failed");
    assert_eq!(renamed["warning_code"], Value::Null);
    let oid = renamed["receipt"]["operation_id"].as_str().unwrap();
    assert_eq!(
        response(
            server.get(&format!("/v1/sessions/{sid}/operations/{oid}")),
            200
        )
        .await["last_sequence"],
        "3"
    );
    assert_eq!(
        response(server.get("/v1/sessions"), 200).await["entries"][0]["title"],
        "original"
    );
    let pause = Arc::new(Pause::default());
    hooks.arm(Point::WriteClosed, Action::Pause(pause.clone()));
    let command = json!({"operation_id":OperationId::new(),"title":"dropped refresh waiter"});
    let body = command.to_string();
    let mut socket = TcpStream::connect(server.address).await.unwrap();
    socket.write_all(format!("POST /v1/sessions/{sid}/rename HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", server.address, body.len()).as_bytes()).await.unwrap();
    watchdog(pause.reached.notified()).await;
    let refresh = Arc::new(Pause::default());
    hooks.arm(Point::Open, Action::Pause(refresh.clone()));
    pause.release.notify_one();
    watchdog(refresh.reached.notified()).await;
    drop(socket);
    refresh.release.notify_one();
    let repeated = response(
        server.post(&format!("/v1/sessions/{sid}/rename"), &command),
        200,
    )
    .await;
    assert_eq!(repeated["duplicate"], true);
    assert_eq!(repeated["receipt"]["last_sequence"], "4");
    assert_eq!(session.manifest().await.unwrap().head_sequence(), 4);
    server.finish().await;
}

#[tokio::test]
async fn storage_errors_retain_certainty_and_receipt_absence_is_not_rollback() {
    let server = Server::new().await;
    let session = server.session().await;
    let sid = session.session_id();
    for (point, kind, code, certainty, committed) in [
        (
            Point::BeforeCommit,
            StorageErrorKind::Io,
            "storage.io",
            "not_committed",
            false,
        ),
        (
            Point::CommitStart,
            StorageErrorKind::CommitUnknown,
            "storage.commit_unknown",
            "unknown",
            false,
        ),
        (
            Point::AfterCommit,
            StorageErrorKind::CommitUnknown,
            "storage.commit_unknown",
            "unknown",
            true,
        ),
    ] {
        // Explicit open has its own maintenance transaction. Fail only the following rename.
        let opened = Arc::new(Pause::default());
        session
            .test_hooks()
            .arm(Point::AfterCommit, Action::Pause(opened.clone()));
        let oid = OperationId::new();
        let request = server.post(
            &format!("/v1/sessions/{sid}/rename"),
            &json!({"operation_id":oid,"title":"uncertain"}),
        );
        let pending = tokio::spawn(error(request, 503, code));
        watchdog(opened.reached.notified()).await;
        session.test_hooks().arm(point, Action::Fail(kind));
        opened.release.notify_one();
        assert_eq!(watchdog(pending).await.unwrap()["certainty"], certainty);
        let path = format!("/v1/sessions/{sid}/operations/{oid}");
        if committed {
            assert_eq!(
                response(server.get(&path), 200).await["operation_id"],
                oid.as_str()
            );
        } else {
            error(server.get(&path), 404, "api.not_found").await;
        }
    }
    for (kind, status, code) in [
        (StorageErrorKind::Busy, 503, "storage.busy"),
        (StorageErrorKind::Integrity, 500, "storage.integrity"),
        (
            StorageErrorKind::UnsupportedVersion,
            500,
            "storage.unsupported_version",
        ),
    ] {
        session.test_hooks().arm(Point::Open, Action::Fail(kind));
        assert_eq!(
            error(server.get(&format!("/v1/sessions/{sid}")), status, code).await["certainty"],
            "not_applicable"
        );
    }
    error(
        server.get(&format!("/v1/sessions/{}", ApplicationSessionId::new())),
        404,
        "storage.not_found",
    )
    .await;
    server.finish().await;
}
