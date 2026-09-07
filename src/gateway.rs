use crate::{
    GatewayError, Provider, ProviderCapabilities, ProviderSession, Result, SessionOptions,
};
use std::{collections::HashMap, sync::Arc};

#[derive(Default)]
pub struct Gateway {
    providers: HashMap<String, Arc<dyn Provider>>,
}
impl Gateway {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register(&mut self, provider: Arc<dyn Provider>) -> Result<()> {
        if self.providers.contains_key(provider.id()) {
            return Err(GatewayError::DuplicateProvider);
        }
        self.providers.insert(provider.id().into(), provider);
        Ok(())
    }
    pub fn capabilities(&self, id: &str) -> Result<ProviderCapabilities> {
        Ok(self
            .providers
            .get(id)
            .ok_or(GatewayError::UnknownProvider)?
            .capabilities())
    }
    pub async fn open_session(&self, id: &str, options: SessionOptions) -> Result<ProviderSession> {
        options.validate()?;
        let provider = self
            .providers
            .get(id)
            .ok_or(GatewayError::UnknownProvider)?;
        provider
            .capabilities()
            .require(&options.required_features)?;
        provider.open_session(options).await
    }
}
