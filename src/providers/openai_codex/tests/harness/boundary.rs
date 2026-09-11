use super::*;

pub(super) struct ReloadAuth {
    pub(super) loads: AtomicUsize,
    pub(super) mode: u8,
    pub(super) entered: Notify,
}
#[async_trait]
impl CredentialSource for ReloadAuth {
    async fn load(&self) -> Result<SubscriptionCredentials> {
        if self.loads.fetch_add(1, Ordering::SeqCst) == 0 {
            return FakeAuth.load().await;
        }
        self.entered.notify_one();
        match self.mode {
            0 => Err(GatewayError::AuthExpired),
            1 => SubscriptionCredentials::from_access_token(
                "synthetic".into(),
                Some("other-account".into()),
                None,
            ),
            _ => std::future::pending().await,
        }
    }
}
