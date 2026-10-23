// These primitives are exercised here before the schema3 writer is connected.
#![cfg_attr(not(test), allow(dead_code))]

use std::{cmp::Ordering, fmt, str::FromStr};

use ring::digest::{SHA256, digest};
use serde::Serialize;

use super::EntryId;
use crate::storage::RunId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("conversation.projection_invalid")]
pub(crate) struct ProjectionError;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EntrySource<'a> {
    Human,
    Assistant { turn_id: &'a str },
    Tool { call_id: &'a str },
    Reuse { sequence: u64, slot: u64 },
    Notice { sequence: u64, slot: u64 },
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct SourceKey([u8; 32]);
impl SourceKey {
    pub(crate) fn entry(run: &RunId, source: EntrySource<'_>) -> Result<Self, ProjectionError> {
        Self::hash(&(1, "wi.conversation.entry", run.as_str(), source))
    }
    pub(crate) fn field(
        run: &RunId,
        entry: &EntryId,
        order: &OrderKey,
    ) -> Result<Self, ProjectionError> {
        Self::hash(&(
            1,
            "wi.conversation.field",
            run.as_str(),
            entry.to_string(),
            order.source_spelling(),
        ))
    }
    fn hash(tuple: &impl Serialize) -> Result<Self, ProjectionError> {
        // A typed, versioned JSON tuple preserves boundaries, types and escaping.
        // Never hash a separator-joined string or a provider's arbitrary map.
        let encoded = serde_json::to_vec(tuple).map_err(|_| ProjectionError)?;
        let mut bytes = [0; 32];
        bytes.copy_from_slice(digest(&SHA256, &encoded).as_ref());
        Ok(Self(bytes))
    }
    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub(crate) fn field_id(&self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum FieldRank {
    Summary,
    Fallback,
    Content,
    FunctionName,
    FunctionArguments,
    ToolName,
    ToolOutput,
    Unsupported,
    Notice,
}
impl FieldRank {
    fn code(self) -> u64 {
        match self {
            Self::Summary => 0,
            Self::Fallback => 1,
            Self::Content => 2,
            Self::FunctionName => 3,
            Self::FunctionArguments => 4,
            Self::ToolName => 5,
            Self::ToolOutput => 6,
            Self::Unsupported => 7,
            Self::Notice => 8,
        }
    }
    fn group(self) -> u64 {
        match self {
            Self::Summary => 0,
            Self::Fallback | Self::Content => 1,
            Self::FunctionName => 2,
            Self::FunctionArguments => 3,
            Self::ToolName => 4,
            Self::ToolOutput => 5,
            Self::Unsupported => 6,
            Self::Notice => 7,
        }
    }
}

/// ASCII tuple: output:section-group:summary:content-position:kind-rank.
/// Optional indices are `0` for null or `1` plus 16 lowercase hex digits.
/// Group/rank are 16 lowercase hex digits. Null sorts before zero.
/// Fallback shares the content group and uses the original first-answer index
/// as placement, before content at that index but after all preceding content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OrderKey {
    output: Option<u64>,
    rank: FieldRank,
    summary: Option<u64>,
    // For fallback this is placement only, never part of its source identity.
    content: Option<u64>,
}
impl OrderKey {
    fn sortable_tuple(self) -> (Option<u64>, u64, Option<u64>, Option<u64>, FieldRank) {
        (
            self.output,
            self.rank.group(),
            self.summary,
            self.content,
            self.rank,
        )
    }

    fn source_spelling(self) -> String {
        // Preserve the original logical source bytes when display placement changes.
        let content = if self.rank == FieldRank::Fallback {
            None
        } else {
            self.content
        };
        format!(
            "{}:{}:{}:{}",
            component(self.output),
            self.rank.code(),
            component(self.summary),
            component(content)
        )
    }

    pub(crate) fn output_range(output: u64) -> (String, String) {
        let prefix = component(Some(output));
        // ':' begins every field in this output; ';' sorts just after that prefix.
        (format!("{prefix}:"), format!("{prefix};"))
    }

    pub(crate) fn new(
        output: Option<u64>,
        rank: FieldRank,
        summary: Option<u64>,
        content: Option<u64>,
    ) -> Self {
        Self {
            output,
            rank,
            summary,
            content,
        }
    }
}
impl Ord for OrderKey {
    fn cmp(&self, other: &Self) -> Ordering {
        self.sortable_tuple().cmp(&other.sortable_tuple())
    }
}
impl PartialOrd for OrderKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn hex(value: u64) -> String {
    format!("{value:016x}")
}
fn parse_hex(value: &str) -> Result<u64, ProjectionError> {
    if value.len() != 16
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProjectionError);
    }
    u64::from_str_radix(value, 16).map_err(|_| ProjectionError)
}
fn component(value: Option<u64>) -> String {
    match value {
        None => "0".into(),
        Some(value) => format!("1{}", hex(value)),
    }
}
fn parse_component(value: &str) -> Result<Option<u64>, ProjectionError> {
    if value == "0" {
        return Ok(None);
    }
    parse_hex(value.strip_prefix('1').ok_or(ProjectionError)?).map(Some)
}
impl fmt::Display for OrderKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{}:{}:{}",
            component(self.output),
            hex(self.rank.group()),
            component(self.summary),
            component(self.content),
            hex(self.rank.code())
        )
    }
}
impl FromStr for OrderKey {
    type Err = ProjectionError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let mut parts = value.split(':');
        let output = parse_component(parts.next().ok_or(ProjectionError)?)?;
        let group = parse_hex(parts.next().ok_or(ProjectionError)?)?;
        let summary = parse_component(parts.next().ok_or(ProjectionError)?)?;
        let content = parse_component(parts.next().ok_or(ProjectionError)?)?;
        let rank = match parse_hex(parts.next().ok_or(ProjectionError)?)? {
            0 => FieldRank::Summary,
            1 => FieldRank::Fallback,
            2 => FieldRank::Content,
            3 => FieldRank::FunctionName,
            4 => FieldRank::FunctionArguments,
            5 => FieldRank::ToolName,
            6 => FieldRank::ToolOutput,
            7 => FieldRank::Unsupported,
            8 => FieldRank::Notice,
            _ => return Err(ProjectionError),
        };
        if group != rank.group() || parts.next().is_some() {
            return Err(ProjectionError);
        }
        Ok(Self::new(output, rank, summary, content))
    }
}

pub(crate) const CHUNK_BYTES: usize = 8192;

pub(crate) struct TextChunk<'a> {
    start_byte: u64,
    text: &'a str,
}
impl<'a> TextChunk<'a> {
    pub(crate) fn start_byte(&self) -> u64 {
        self.start_byte
    }
    pub(crate) fn text(&self) -> &'a str {
        self.text
    }
}

pub(crate) struct TextChunks<'a> {
    remaining: &'a str,
    next_byte: u64,
}
impl<'a> TextChunks<'a> {
    pub(crate) fn new(text: &'a str, start_byte: u64) -> Result<Self, ProjectionError> {
        let length = u64::try_from(text.len()).map_err(|_| ProjectionError)?;
        start_byte.checked_add(length).ok_or(ProjectionError)?;
        Ok(Self {
            remaining: text,
            next_byte: start_byte,
        })
    }
}
impl<'a> Iterator for TextChunks<'a> {
    type Item = TextChunk<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }
        let mut end = self.remaining.len().min(CHUNK_BYTES);
        while !self.remaining.is_char_boundary(end) {
            end -= 1;
        }
        let (text, remaining) = self.remaining.split_at(end);
        let chunk = TextChunk {
            start_byte: self.next_byte,
            text,
        };
        // Construction checked the whole range, so each bounded increment fits.
        self.next_byte += u64::try_from(end).expect("bounded chunk length");
        self.remaining = remaining;
        Some(chunk)
    }
}

#[cfg(test)]
mod tests;
