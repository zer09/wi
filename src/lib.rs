//! Provider/session layer and explicit-root application storage. No web server,
//! filesystem tool, hosted sandbox, or durable job scheduler is included.
#![forbid(unsafe_code)]

pub mod context;
pub mod error;
pub mod gateway;
pub mod provider;
pub mod providers;
pub mod run;
pub mod storage;
pub mod tools;

pub use error::{GatewayError, Result};
pub use gateway::Gateway;
pub use provider::*;
