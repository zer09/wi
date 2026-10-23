use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("conversation.entry_id_invalid")]
pub struct EntryIdError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntryPosition {
    sequence: u64,
    slot: u64,
}
impl EntryPosition {
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn slot(&self) -> u64 {
        self.slot
    }
}

/// An immutable position within a run, not a globally unique ID or a path.
/// Every reference to this ID must also carry its RunId.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntryId(EntryPosition);
impl EntryId {
    pub(crate) fn new(first_sequence: u64, position_slot: u64) -> Result<Self, EntryIdError> {
        if first_sequence == 0 {
            return Err(EntryIdError);
        }
        Ok(Self(EntryPosition {
            sequence: first_sequence,
            slot: position_slot,
        }))
    }
    pub fn position(&self) -> &EntryPosition {
        &self.0
    }
    pub fn first_sequence(&self) -> u64 {
        self.0.sequence
    }
    pub fn position_slot(&self) -> u64 {
        self.0.slot
    }
}
impl FromStr for EntryId {
    type Err = EntryIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (sequence, slot) = value
            .strip_prefix("e:")
            .and_then(|value| value.split_once(':'))
            .ok_or(EntryIdError)?;
        Self::new(
            super::decimal(sequence).ok_or(EntryIdError)?,
            super::decimal(slot).ok_or(EntryIdError)?,
        )
    }
}
impl fmt::Display for EntryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "e:{}:{}", self.first_sequence(), self.position_slot())
    }
}
impl fmt::Debug for EntryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::RunId;

    #[test]
    fn entry_ids_are_checked_positions_scoped_by_run() {
        for sequence in [1, (1 << 53) + 1, u64::MAX] {
            for slot in [0, 1, u64::MAX] {
                let id = EntryId::new(sequence, slot).unwrap();
                assert_eq!(id.to_string().parse::<EntryId>().unwrap(), id);
                assert_eq!(id.position().sequence(), sequence);
                assert_eq!(id.position().slot(), slot);
                assert_ne!((RunId::new(), id), (RunId::new(), id));
            }
        }
        assert!(EntryId::new(0, 0).is_err());
        for value in [
            "",
            "e:0:0",
            "e:01:0",
            "e:1:00",
            "e:1:-1",
            "e:+1:0",
            "e:1:0:0",
            "E:1:0",
            "e:1: 0",
            "e:1:0\n",
            "e:1:１",
            "e:1:1e2",
            "../e:1:0",
            "e:18446744073709551616:0",
            "e:1:18446744073709551616",
        ] {
            let error = value.parse::<EntryId>().unwrap_err();
            assert_eq!(error.to_string(), "conversation.entry_id_invalid");
        }
    }
}
