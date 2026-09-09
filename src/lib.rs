//! Minimal provider/session layer. No web server, filesystem tool, hosted
//! sandbox, database, or durable job scheduler is included.
#![forbid(unsafe_code)]

pub mod error;
pub mod gateway;
pub mod provider;
pub mod providers;
pub mod run;
pub mod tools;

pub use error::{GatewayError, Result};
pub use gateway::Gateway;
pub use provider::*;
