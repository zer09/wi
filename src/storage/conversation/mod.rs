// Storage owns projection writes inside canonical transactions.
#![cfg_attr(not(test), allow(dead_code))]

mod error;
mod fields;
pub(super) mod reads;

pub use error::ConversationError;
pub(super) mod projector;

pub(super) const SCHEMA: &str = include_str!("../session_v3.sql");

#[cfg(test)]
mod activation_tests;
#[cfg(test)]
mod bounded_header_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "../../conversation/wire/storage_tests.rs"]
mod wire_tests;
