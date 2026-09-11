//! Real loopback WebSocket/HTTP protocol tests. All authentication is SYNTHETIC.
//! These never read ~/.codex, ~/.pi, or real environment credentials.
use super::*;
use crate::{
    GatewayError, InputItem, ItemKind, ProviderEvent, ResponseOutcome, UpstreamOutcome,
    tools::{AddNumbers, ToolRegistry},
};
use auth::{CredentialSource, SubscriptionCredentials};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{Duration, timeout},
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

mod harness;
use harness::*;

#[path = "authentication/requirements_tests.rs"]
mod authentication_tests;
#[path = "transport/boundary_tests.rs"]
mod boundary_tests;
#[path = "consistency/consistency_loopback_tests.rs"]
mod consistency_loopback_tests;
#[path = "run_continuation/session_tests.rs"]
mod continuation_tests;
#[path = "observation/diagnostic_tests.rs"]
mod diagnostic_tests;
#[path = "recovery/lifecycle_tests.rs"]
mod lifecycle_tests;
#[cfg(target_os = "linux")]
#[path = "managed_profiles/managed_loopback_tests.rs"]
mod managed_loopback_tests;
#[path = "observation/observation_tests.rs"]
mod observation_tests;
#[path = "recovery/recovery_loopback_tests.rs"]
mod recovery_loopback_tests;
#[path = "run_continuation/run_loopback_tests.rs"]
mod run_loopback_tests;
#[path = "wire_format/sse_prolog_loopback_tests.rs"]
mod sse_prolog_loopback_tests;
#[path = "transport/session_tests.rs"]
mod transport_tests;
#[path = "wire_format/decoded_tests.rs"]
mod wire_format_tests;
