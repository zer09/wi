use std::{fmt, str::FromStr};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use super::{ConstructionError, EntryId};
use crate::storage::{ApplicationSessionId, RunId};

const MAX_CURSOR_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("conversation.cursor_invalid")]
pub struct CursorError;

// Syntax uses all u64 bits. Storage checks database representability and the
// referenced resource/head separately; parsing never opens a session.
fn decode<const N: usize>(value: &str, prefix: &str) -> Result<[Value; N], CursorError> {
    if value.len() > MAX_CURSOR_BYTES {
        return Err(CursorError);
    }
    let encoded = value.strip_prefix(prefix).ok_or(CursorError)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| CursorError)?;
    let fields: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| CursorError)?;
    if fields.first().and_then(Value::as_u64) != Some(1)
        || serde_json::to_vec(&fields).map_err(|_| CursorError)? != bytes
    {
        return Err(CursorError);
    }
    fields.try_into().map_err(|_| CursorError)
}
fn text(value: &Value) -> Result<&str, CursorError> {
    value.as_str().ok_or(CursorError)
}
fn number(value: &Value) -> Result<u64, CursorError> {
    super::decimal(text(value)?).ok_or(CursorError)
}
fn id<T: FromStr>(value: &Value) -> Result<T, CursorError> {
    text(value)?.parse().map_err(|_| CursorError)
}
fn encode(f: &mut fmt::Formatter<'_>, prefix: &str, fields: Value) -> fmt::Result {
    write!(f, "{prefix}{}", URL_SAFE_NO_PAD.encode(fields.to_string()))
}

#[derive(Clone, PartialEq, Eq)]
pub struct BlockCursor {
    session_id: ApplicationSessionId,
    before_accepted_sequence: u64,
}
impl BlockCursor {
    pub(crate) fn new(
        session_id: ApplicationSessionId,
        before_accepted_sequence: u64,
    ) -> Result<Self, ConstructionError> {
        if before_accepted_sequence == 0 {
            return Err(ConstructionError);
        }
        Ok(Self {
            session_id,
            before_accepted_sequence,
        })
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn before_accepted_sequence(&self) -> u64 {
        self.before_accepted_sequence
    }
}
impl FromStr for BlockCursor {
    type Err = CursorError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let fields = decode::<3>(value, "g11b.")?;
        Self::new(id(&fields[1])?, number(&fields[2])?).map_err(|_| CursorError)
    }
}
impl fmt::Display for BlockCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        encode(
            f,
            "g11b.",
            json!([
                1,
                self.session_id.as_str(),
                self.before_accepted_sequence.to_string()
            ]),
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ActivityCursor {
    session_id: ApplicationSessionId,
    run_id: RunId,
    before_entry_sequence: u64,
    before_slot: u64,
}
impl ActivityCursor {
    pub(crate) fn new(
        session_id: ApplicationSessionId,
        run_id: RunId,
        before_entry_sequence: u64,
        before_slot: u64,
    ) -> Result<Self, ConstructionError> {
        if before_entry_sequence == 0 {
            return Err(ConstructionError);
        }
        Ok(Self {
            session_id,
            run_id,
            before_entry_sequence,
            before_slot,
        })
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn before_entry_sequence(&self) -> u64 {
        self.before_entry_sequence
    }
    pub fn before_slot(&self) -> u64 {
        self.before_slot
    }
}
impl FromStr for ActivityCursor {
    type Err = CursorError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let fields = decode::<5>(value, "g11s.")?;
        Self::new(
            id(&fields[1])?,
            id(&fields[2])?,
            number(&fields[3])?,
            number(&fields[4])?,
        )
        .map_err(|_| CursorError)
    }
}
impl fmt::Display for ActivityCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        encode(
            f,
            "g11s.",
            json!([
                1,
                self.session_id.as_str(),
                self.run_id.as_str(),
                self.before_entry_sequence.to_string(),
                self.before_slot.to_string()
            ]),
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ContentCursor {
    session_id: ApplicationSessionId,
    run_id: RunId,
    entry_id: EntryId,
    content_epoch: u64,
    upper_field_id: String,
    upper_generation: u64,
    exclusive_upper_byte: u64,
}
impl ContentCursor {
    pub(crate) fn new(
        session_id: ApplicationSessionId,
        run_id: RunId,
        entry_id: EntryId,
        content_epoch: u64,
        upper_field_id: String,
        upper_generation: u64,
        exclusive_upper_byte: u64,
    ) -> Result<Self, ConstructionError> {
        if content_epoch < entry_id.first_sequence()
            || upper_generation < entry_id.first_sequence()
            || !super::valid_field_id(&upper_field_id)
        {
            return Err(ConstructionError);
        }
        let cursor = Self {
            session_id,
            run_id,
            entry_id,
            content_epoch,
            upper_field_id,
            upper_generation,
            exclusive_upper_byte,
        };
        // Construction must not emit a token that the bounded parser rejects.
        if cursor.to_string().len() > MAX_CURSOR_BYTES {
            return Err(ConstructionError);
        }
        Ok(cursor)
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn entry_id(&self) -> &EntryId {
        &self.entry_id
    }
    pub fn content_epoch(&self) -> u64 {
        self.content_epoch
    }
    pub fn upper_field_id(&self) -> &str {
        &self.upper_field_id
    }
    pub fn upper_generation(&self) -> u64 {
        self.upper_generation
    }
    pub fn exclusive_upper_byte(&self) -> u64 {
        self.exclusive_upper_byte
    }
}
impl FromStr for ContentCursor {
    type Err = CursorError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let fields = decode::<8>(value, "g11c.")?;
        Self::new(
            id(&fields[1])?,
            id(&fields[2])?,
            id(&fields[3])?,
            number(&fields[4])?,
            text(&fields[5])?.to_owned(),
            number(&fields[6])?,
            number(&fields[7])?,
        )
        .map_err(|_| CursorError)
    }
}
impl fmt::Display for ContentCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        encode(
            f,
            "g11c.",
            json!([
                1,
                self.session_id.as_str(),
                self.run_id.as_str(),
                self.entry_id.to_string(),
                self.content_epoch.to_string(),
                self.upper_field_id,
                self.upper_generation.to_string(),
                self.exclusive_upper_byte.to_string()
            ]),
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct LiveCursor {
    session_id: ApplicationSessionId,
    sequence: u64,
    rank: u8,
    run_id: Option<RunId>,
    entry_id: Option<EntryId>,
}
impl LiveCursor {
    pub(crate) fn new(
        session_id: ApplicationSessionId,
        sequence: u64,
        rank: u8,
        run_id: Option<RunId>,
        entry_id: Option<EntryId>,
    ) -> Result<Self, ConstructionError> {
        let valid_identity = match rank {
            0 | 3 => run_id.is_none() && entry_id.is_none(),
            1 => run_id.is_some() && entry_id.is_none(),
            2 => run_id.is_some() && entry_id.is_some(),
            _ => false,
        };
        if sequence == 0
            || !valid_identity
            || entry_id.is_some_and(|id| id.first_sequence() > sequence)
        {
            return Err(ConstructionError);
        }
        Ok(Self {
            session_id,
            sequence,
            rank,
            run_id,
            entry_id,
        })
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn rank(&self) -> u8 {
        self.rank
    }
    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }
    pub fn entry_id(&self) -> Option<&EntryId> {
        self.entry_id.as_ref()
    }
}
impl FromStr for LiveCursor {
    type Err = CursorError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let fields = decode::<6>(value, "g11l.")?;
        let rank = number(&fields[3])?;
        let run = text(&fields[4])?;
        let entry = text(&fields[5])?;
        let run_id = if run.is_empty() {
            None
        } else {
            Some(id(&fields[4])?)
        };
        let entry_id = if entry.is_empty() {
            None
        } else {
            Some(id(&fields[5])?)
        };
        Self::new(
            id(&fields[1])?,
            number(&fields[2])?,
            u8::try_from(rank).map_err(|_| CursorError)?,
            run_id,
            entry_id,
        )
        .map_err(|_| CursorError)
    }
}
impl fmt::Display for LiveCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        encode(
            f,
            "g11l.",
            json!([
                1,
                self.session_id.as_str(),
                self.sequence.to_string(),
                self.rank.to_string(),
                self.run_id.as_ref().map(RunId::as_str).unwrap_or(""),
                self.entry_id.map(|id| id.to_string()).unwrap_or_default()
            ]),
        )
    }
}

macro_rules! opaque_debug {
    ($($name:ty),+ $(,)?) => {$(
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([redacted])"))
            }
        }
    )+};
}
opaque_debug!(BlockCursor, ActivityCursor, ContentCursor, LiveCursor);

#[cfg(test)]
mod tests;
