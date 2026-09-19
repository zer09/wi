//! Authenticated loopback HTTP service, validated settings and closed browser projections.
mod boundary;
mod config;
pub mod dto;
mod files;
mod input;
mod router;
mod serve;
mod token;
pub mod wire;

pub use config::{ApiConfig, ApiSettings, ConfigError, ConfigFile, validate_listener};
pub use serve::{ServeError, ServeOutcome, serve};
pub use token::{OwnerToken, TokenError};
