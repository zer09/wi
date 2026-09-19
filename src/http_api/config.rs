use std::{
    collections::BTreeSet,
    fmt, fs,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use reqwest::Url;
use serde::Deserialize;
use zeroize::Zeroizing;

use super::OwnerToken;
use crate::{MAX_INPUT_BYTES, SessionOptions, Transport};

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("api.config_invalid")]
    Invalid,
    #[error("api.config_file_invalid")]
    File,
    #[error("api.config_too_large")]
    TooLarge,
    #[error("api.listener_invalid")]
    Listener,
    #[error("api.origin_invalid")]
    Origin,
    #[error("api.path_invalid")]
    Path,
    #[error("api.workspace_forbidden")]
    Workspace,
    #[error("api.options_invalid")]
    Options,
}

/// Validate the actual bound address too, including listeners supplied by library callers.
pub fn validate_listener(address: SocketAddr) -> Result<(), ConfigError> {
    if address.ip().is_loopback() {
        Ok(())
    } else {
        Err(ConfigError::Listener)
    }
}

#[derive(Clone)]
pub struct ApiSettings {
    public_origin: String,
    workspaces: Vec<String>,
    global_skills_root: PathBuf,
    provider_id: String,
    options: SessionOptions,
    enable_add_numbers: bool,
}

impl ApiSettings {
    pub fn new(
        public_origin: &str,
        workspaces: Vec<PathBuf>,
        global_skills_root: PathBuf,
        provider_id: String,
        options: SessionOptions,
        enable_add_numbers: bool,
    ) -> Result<Self, ConfigError> {
        let public_origin = origin(public_origin)?;
        if provider_id.trim().is_empty() || !options.tools.is_empty() {
            return Err(ConfigError::Options);
        }
        options.validate().map_err(|_| ConfigError::Options)?;
        absolute(&global_skills_root)?;
        match fs::symlink_metadata(&global_skills_root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(ConfigError::Path),
            Ok(_) if global_skills_root.is_dir() => (),
            Ok(_) => return Err(ConfigError::Path),
        }
        let mut canonical = BTreeSet::new();
        for path in workspaces {
            absolute(&path)?;
            let path = fs::canonicalize(path).map_err(|_| ConfigError::Workspace)?;
            if !path.is_dir() {
                return Err(ConfigError::Workspace);
            }
            canonical.insert(path.to_str().ok_or(ConfigError::Workspace)?.to_owned());
        }
        if canonical.is_empty() {
            return Err(ConfigError::Workspace);
        }
        Ok(Self {
            public_origin,
            workspaces: canonical.into_iter().collect(),
            global_skills_root,
            provider_id,
            options,
            enable_add_numbers,
        })
    }

    pub fn public_origin(&self) -> &str {
        &self.public_origin
    }
    pub fn workspaces(&self) -> &[String] {
        &self.workspaces
    }
    pub fn global_skills_root(&self) -> &Path {
        &self.global_skills_root
    }
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }
    pub fn options(&self) -> &SessionOptions {
        &self.options
    }
    pub fn enable_add_numbers(&self) -> bool {
        self.enable_add_numbers
    }

    /// Pure membership check. An unapproved caller path is never probed.
    pub fn workspace(&self, candidate: &str) -> Option<&Path> {
        self.workspaces
            .iter()
            .find(|path| path.as_str() == candidate)
            .map(Path::new)
    }

    pub fn revalidate_workspace(&self, candidate: &str) -> Result<&Path, ConfigError> {
        let path = self.workspace(candidate).ok_or(ConfigError::Workspace)?;
        let current = fs::canonicalize(path).map_err(|_| ConfigError::Workspace)?;
        if current != path || !current.is_dir() {
            return Err(ConfigError::Workspace);
        }
        Ok(path)
    }
}

pub struct ApiConfig {
    settings: ApiSettings,
    owner_token: OwnerToken,
}

impl ApiConfig {
    pub fn new(settings: ApiSettings, owner_token: OwnerToken) -> Self {
        Self {
            settings,
            owner_token,
        }
    }
    pub fn settings(&self) -> &ApiSettings {
        &self.settings
    }
    pub fn owner_token(&self) -> &OwnerToken {
        &self.owner_token
    }
}

/// Strict startup input for a later CLI adapter. Parsing does not load credentials or storage.
pub struct ConfigFile {
    listen: SocketAddr,
    data_root: PathBuf,
    client_token_file: PathBuf,
    account: Option<String>,
    settings: ApiSettings,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fields {
    schema_version: u32,
    listen: String,
    public_origin: String,
    data_root: PathBuf,
    client_token_file: PathBuf,
    global_skills_root: PathBuf,
    workspaces: Vec<PathBuf>,
    model: String,
    instructions: String,
    provider_transport: ConfigTransport,
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    account: Option<String>,
    enable_add_numbers: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ConfigTransport {
    Websocket,
    Sse,
}

impl ConfigFile {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        absolute(path)?;
        let file = super::files::open_regular(path, false).map_err(|_| ConfigError::File)?;
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_INPUT_BYTES + 1));
        file.take((MAX_INPUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ConfigError::File)?;
        Self::parse(&bytes)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ConfigError> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(ConfigError::TooLarge);
        }
        let fields: Fields = serde_json::from_slice(bytes).map_err(|_| ConfigError::Invalid)?;
        if fields.schema_version != 1 {
            return Err(ConfigError::Invalid);
        }
        let listen = fields.listen.parse().map_err(|_| ConfigError::Listener)?;
        validate_listener(listen)?;
        absolute(&fields.data_root)?;
        absolute(&fields.client_token_file)?;
        if let Some(account) = &fields.account {
            crate::providers::openai_codex::profile_selection::validate_name(account)
                .map_err(|_| ConfigError::Options)?;
        }
        let mut options = SessionOptions::new(fields.model);
        options.instructions = fields.instructions;
        options.transport = match fields.provider_transport {
            ConfigTransport::Websocket => Transport::WebSocket,
            ConfigTransport::Sse => Transport::Sse,
        };
        let settings = ApiSettings::new(
            &fields.public_origin,
            fields.workspaces,
            fields.global_skills_root,
            crate::providers::openai_codex::PROVIDER_ID.to_owned(),
            options,
            fields.enable_add_numbers,
        )?;
        Ok(Self {
            listen,
            data_root: fields.data_root,
            client_token_file: fields.client_token_file,
            account: fields.account,
            settings,
        })
    }

    pub fn listen(&self) -> SocketAddr {
        self.listen
    }
    pub fn data_root(&self) -> &Path {
        &self.data_root
    }
    pub fn client_token_file(&self) -> &Path {
        &self.client_token_file
    }
    pub fn account(&self) -> Option<&str> {
        self.account.as_deref()
    }
    pub fn settings(&self) -> &ApiSettings {
        &self.settings
    }
}

fn absolute(path: &Path) -> Result<(), ConfigError> {
    if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(ConfigError::Path);
    }
    Ok(())
}

fn origin(value: &str) -> Result<String, ConfigError> {
    // Reject URL parser repairs: whitespace, backslashes, credentials and normalized-away paths.
    if value
        .bytes()
        .any(|b| b.is_ascii_whitespace() || b.is_ascii_control() || b == b'\\')
    {
        return Err(ConfigError::Origin);
    }
    let (_, rest) = value.split_once("://").ok_or(ConfigError::Origin)?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') || !matches!(&rest[end..], "" | "/") {
        return Err(ConfigError::Origin);
    }
    let authority: axum::http::uri::Authority =
        authority.parse().map_err(|_| ConfigError::Origin)?;
    let url = Url::parse(value).map_err(|_| ConfigError::Origin)?;
    // Check the parsed host so URL-encoded commas cannot bypass authority validation.
    if url.host_str().is_none_or(|host| host.contains(','))
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ConfigError::Origin);
    }
    match url.scheme() {
        "https" => (),
        "http" => {
            let host = authority
                .host()
                .trim_start_matches('[')
                .trim_end_matches(']');
            let ip: std::net::IpAddr = host.parse().map_err(|_| ConfigError::Origin)?;
            if !ip.is_loopback() {
                return Err(ConfigError::Origin);
            }
        }
        _ => return Err(ConfigError::Origin),
    }
    Ok(url.origin().ascii_serialization())
}

macro_rules! redacted {
    ($($name:ident),+) => {$(
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([redacted])"))
            }
        }
    )+};
}
redacted!(ApiSettings, ApiConfig, ConfigFile);

#[cfg(test)]
mod tests;
