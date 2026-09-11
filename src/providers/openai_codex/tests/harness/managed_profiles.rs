use super::*;

pub(super) fn profile(account: &str) -> Profile {
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
pub(super) fn manager() -> (tempfile::TempDir, Store, AuthManager) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::synthetic(temp.path().join("wi/auth"));
    let manager = AuthManager::synthetic(store.clone(), Arc::new(Renew));
    manager
        .login("a", profile("synthetic-account"), false)
        .unwrap();
    (temp, store, manager)
}
pub(super) async fn http_request(socket: &mut TcpStream) -> (String, Value) {
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
