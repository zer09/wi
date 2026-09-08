use super::*;
use managed_auth::{AuthManager, Exchange};
use managed_store::{Profile, Store};
use std::sync::atomic::{AtomicUsize, Ordering};
fn profile(account: &str) -> Profile {
    Profile {
        incarnation: uuid::Uuid::new_v4().to_string(),
        account: account.into(),
        access: "synthetic-oauth-token".into(),
        refresh: "synthetic-refresh".into(),
        expires: u64::MAX,
        enabled: true,
        reauth: false,
    }
}
struct Renew;
#[async_trait]
impl Exchange for Renew {
    fn configured(&self) -> Result<()> {
        Ok(())
    }
    async fn refresh(&self, _: &str) -> Result<Profile> {
        let mut p = profile("synthetic-account");
        p.access = "synthetic-rotated-access".into();
        p.refresh = "synthetic-rotated-refresh".into();
        Ok(p)
    }
}
fn manager() -> (tempfile::TempDir, Store, AuthManager) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::synthetic(temp.path().join("wi/auth"));
    let manager = AuthManager::synthetic(store.clone(), Arc::new(Renew));
    manager
        .login("a", profile("synthetic-account"), false)
        .unwrap();
    (temp, store, manager)
}
static SELECTIONS: AtomicUsize = AtomicUsize::new(0);
#[tokio::test]
async fn managed_ws_profile_selected_per_open_and_continuation_keeps_handshake() {
    SELECTIONS.store(0, Ordering::SeqCst);
    let (_temp, _store, manager) = manager();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        #[allow(clippy::result_large_err)]
        let mut socket = accept_hdr_async(tcp, |req: &Request, response: Response| {
            assert_eq!(req.headers()["chatgpt-account-id"], "synthetic-account");
            Ok(response)
        })
        .await
        .unwrap();
        incoming(&mut socket).await;
        text_response(&mut socket, "r1", "one").await;
        let next = incoming(&mut socket).await;
        assert_eq!(next["previous_response_id"], "r1");
        assert_eq!(next["input"].as_array().unwrap().len(), 1);
        text_response(&mut socket, "r2", "two").await;
        let _ = socket.next().await;
        let (tcp, _) = listener.accept().await.unwrap();
        #[allow(clippy::result_large_err)]
        let mut socket = accept_hdr_async(tcp, |req: &Request, response: Response| {
            assert_eq!(req.headers()["chatgpt-account-id"], "other-account");
            Ok(response)
        })
        .await
        .unwrap();
        incoming(&mut socket).await;
        text_response(&mut socket, "r3", "three").await;
        let _ = socket.next().await;
    });
    let mut provider =
        OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::WebSocket, address)
            .with_profile_observer(|name| {
                assert!(name == "a" || name == "b");
                SELECTIONS.fetch_add(1, Ordering::SeqCst);
            });
    provider.credentials = ProviderAuth::Managed(manager.clone(), None);
    let mut session = provider
        .open_session(SessionOptions::new("synthetic"))
        .await
        .unwrap();
    let a = session
        .control
        .generate(vec![InputItem::user("one")])
        .await
        .unwrap();
    response(&mut session, &a.request_id).await;
    manager.logout("a").unwrap();
    manager.login("b", profile("other-account"), false).unwrap();
    let b = session
        .control
        .generate(vec![InputItem::user("two")])
        .await
        .unwrap();
    response(&mut session, &b.request_id).await;
    assert_eq!(SELECTIONS.load(Ordering::SeqCst), 1);
    session.control.close();
    let mut session = provider
        .open_session(SessionOptions::new("synthetic"))
        .await
        .unwrap();
    let c = session
        .control
        .generate(vec![InputItem::user("three")])
        .await
        .unwrap();
    response(&mut session, &c.request_id).await;
    session.control.close();
    assert_eq!(SELECTIONS.load(Ordering::SeqCst), 2);
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
async fn http_request(socket: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    loop {
        bytes.push(socket.read_u8().await.unwrap());
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
        assert!(bytes.len() < 8192);
    }
    let headers = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            line.strip_prefix("content-length: ")
                .map(|v| v.parse().unwrap())
        })
        .unwrap();
    assert!(length < 65536);
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await.unwrap();
    (headers, serde_json::from_slice(&body).unwrap())
}
#[tokio::test]
async fn managed_sse_renews_same_profile_for_tool_result_and_rejects_relogin() {
    let (_temp, store, manager) = manager();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for turn in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (headers, body) = http_request(&mut socket).await;
            assert!(headers.contains("chatgpt-account-id: synthetic-account\r\n"));
            let token = if turn == 0 {
                "synthetic-oauth-token"
            } else {
                "synthetic-rotated-access"
            };
            assert!(headers.contains(&format!("authorization: bearer {token}\r\n")));
            let output = if turn == 0 {
                json!([{"type":"function_call","id":"item1","call_id":"call1","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}","status":"completed"}])
            } else {
                let input = body["input"].as_array().unwrap();
                assert!(
                    input
                        .iter()
                        .any(|v| v["type"] == "function_call" && v["call_id"] == "call1")
                );
                let result = input
                    .iter()
                    .find(|v| v["type"] == "function_call_output")
                    .unwrap();
                assert_eq!(result["call_id"], "call1");
                assert_eq!(
                    serde_json::from_str::<Value>(result["output"].as_str().unwrap()).unwrap()["sum"],
                    42
                );
                json!([{"type":"message","id":"m1","content":[{"type":"output_text","text":"42"}]}])
            };
            let event = json!({"type":"response.completed","response":{"id":format!("r{turn}"),"status":"completed","output":output}});
            let body = format!("data: {event}\n\n");
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        assert!(
            timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
    });
    let mut provider = OpenAiCodexProvider::loopback(Arc::new(FakeAuth), Transport::Sse, address);
    provider.credentials = ProviderAuth::Managed(manager.clone(), Some("a".into()));
    let mut tools = ToolRegistry::new();
    tools.register(Arc::new(AddNumbers)).unwrap();
    let mut options = SessionOptions::new("synthetic");
    options.transport = Transport::Sse;
    options.tools = tools.definitions();
    let mut session = provider.open_session(options).await.unwrap();
    let a = session
        .control
        .generate(vec![InputItem::user("add")])
        .await
        .unwrap();
    let first = response(&mut session, &a.request_id).await;
    {
        let lock = store.locked(false).unwrap();
        let mut doc = lock.read().unwrap();
        doc.profiles.get_mut("a").unwrap().expires = 1;
        lock.write(&doc).unwrap();
    }
    let result = tools.execute_response(&first, |_| {}).await.unwrap();
    let b = session.control.generate(result).await.unwrap();
    assert_eq!(response(&mut session, &b.request_id).await.text, "42");
    manager
        .login("a", profile("synthetic-account"), true)
        .unwrap();
    let c = session
        .control
        .generate(vec![InputItem::user("must not send")])
        .await
        .unwrap();
    loop {
        let event = timeout(Duration::from_secs(3), session.events.next())
            .await
            .unwrap()
            .unwrap();
        if let ProviderEvent::RequestFailed {
            upstream_outcome, ..
        } = event.event
        {
            assert_eq!(event.request_id.as_deref(), Some(c.request_id.as_str()));
            assert_eq!(upstream_outcome, UpstreamOutcome::NotSubmitted);
            break;
        }
    }
    session.control.close();
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
