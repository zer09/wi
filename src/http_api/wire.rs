use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::storage::ApplicationSessionId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("api.invalid_decimal")]
pub struct DecimalError;

/// Unsigned values retain all 64 bits in JSON and accept only canonical decimal strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Decimal(u64);

impl Decimal {
    pub fn get(self) -> u64 {
        self.0
    }
}
impl From<u64> for Decimal {
    fn from(value: u64) -> Self {
        Self(value)
    }
}
impl TryFrom<i64> for Decimal {
    type Error = DecimalError;
    fn try_from(value: i64) -> Result<Self, Self::Error> {
        u64::try_from(value).map(Self).map_err(|_| DecimalError)
    }
}
impl FromStr for Decimal {
    type Err = DecimalError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.is_empty()
            || !value.bytes().all(|b| b.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return Err(DecimalError);
        }
        value.parse().map(Self).map_err(|_| DecimalError)
    }
}
impl fmt::Display for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl Serialize for Decimal {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for Decimal {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

pub fn parse_sequence(value: &str) -> Result<u64, DecimalError> {
    let number = value.parse::<Decimal>()?.get();
    if number > i64::MAX as u64 {
        return Err(DecimalError);
    }
    Ok(number)
}

pub fn parse_page_limit(value: &str) -> Result<u32, DecimalError> {
    let number = value.parse::<Decimal>()?.get();
    if !(1..=128).contains(&number) {
        return Err(DecimalError);
    }
    Ok(number as u32)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("api.cursor_invalid")]
pub struct CursorError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
    session_id: ApplicationSessionId,
    sequence: u64,
}
impl Cursor {
    pub fn new(session_id: ApplicationSessionId, sequence: u64) -> Result<Self, CursorError> {
        if sequence > i64::MAX as u64 {
            return Err(CursorError);
        }
        Ok(Self {
            session_id,
            sequence,
        })
    }
    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn validate(
        &self,
        session_id: &ApplicationSessionId,
        head: u64,
    ) -> Result<(), CursorError> {
        if &self.session_id != session_id || self.sequence > head {
            return Err(CursorError);
        }
        Ok(())
    }
}
impl FromStr for Cursor {
    type Err = CursorError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (session, sequence) = value.split_once(':').ok_or(CursorError)?;
        Self::new(
            session.parse().map_err(|_| CursorError)?,
            parse_sequence(sequence).map_err(|_| CursorError)?,
        )
    }
}
impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.session_id, self.sequence)
    }
}
impl Serialize for Cursor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for Cursor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimals_preserve_range_and_reject_noncanonical_syntax() {
        for number in [0, 1, (1 << 53) + 1, i64::MAX as u64, u64::MAX] {
            let value: Decimal = number.to_string().parse().unwrap();
            assert_eq!(value.get(), number);
            let encoded = serde_json::to_string(&value).unwrap();
            assert_eq!(encoded, format!("\"{number}\""));
            assert_eq!(serde_json::from_str::<Decimal>(&encoded).unwrap(), value);
        }
        for text in [
            "",
            "00",
            "01",
            "+1",
            "-1",
            " 1",
            "1\n",
            "1.0",
            "1e2",
            "１",
            "18446744073709551616",
        ] {
            assert!(text.parse::<Decimal>().is_err(), "{text}");
        }
        for json in ["1", "null", "true", "[]", "{}"] {
            assert!(serde_json::from_str::<Decimal>(json).is_err());
        }
        assert!(Decimal::try_from(-1i64).is_err());
        assert_eq!(
            parse_sequence(&i64::MAX.to_string()).unwrap(),
            i64::MAX as u64
        );
        assert!(parse_sequence(&(i64::MAX as u64 + 1).to_string()).is_err());
        for size in ["1", "32", "128"] {
            assert!(parse_page_limit(size).is_ok());
        }
        for size in ["0", "129", "01", "-1", "1.0"] {
            assert!(parse_page_limit(size).is_err());
        }
    }

    #[test]
    fn cursors_require_session_qualification_and_current_head() {
        let session = ApplicationSessionId::new();
        for sequence in [0, (1 << 53) + 1, i64::MAX as u64] {
            let cursor = Cursor::new(session.clone(), sequence).unwrap();
            assert_eq!(cursor.to_string().parse::<Cursor>().unwrap(), cursor);
            assert_eq!(
                serde_json::from_str::<Cursor>(&serde_json::to_string(&cursor).unwrap()).unwrap(),
                cursor
            );
            assert!(cursor.validate(&session, sequence).is_ok());
            assert!(
                cursor
                    .validate(&ApplicationSessionId::new(), sequence)
                    .is_err()
            );
            if sequence > 0 {
                assert!(cursor.validate(&session, sequence - 1).is_err());
            }
        }
        for suffix in ["", "01", "-1", "+1", "1:2", " 1", "9223372036854775808"] {
            assert!(format!("{session}:{suffix}").parse::<Cursor>().is_err());
        }
        for prefix in [
            "",
            "not-uuid",
            "00000000-0000-0000-0000-000000000000",
            "01234567-89AB-4CDE-8FAB-0123456789AB",
        ] {
            assert!(format!("{prefix}:0").parse::<Cursor>().is_err());
        }
        assert!(session.to_string().parse::<Cursor>().is_err());
    }
}
