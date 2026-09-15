use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use super::{StorageError, StorageErrorKind};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ApplicationSessionId(String);

impl ApplicationSessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ApplicationSessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl FromStr for ApplicationSessionId {
    type Err = StorageError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let invalid = || StorageError::new(StorageErrorKind::InvalidInput);
        let id = Uuid::parse_str(value).map_err(|_| invalid())?;
        if id.is_nil() || id.hyphenated().to_string() != value {
            return Err(invalid());
        }
        Ok(Self(value.to_owned()))
    }
}

impl<'de> Deserialize<'de> for ApplicationSessionId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for ApplicationSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Debug for ApplicationSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApplicationSessionId([redacted])")
    }
}

macro_rules! storage_id {
    ($name:ident) => {
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(ApplicationSessionId);

        impl $name {
            pub fn new() -> Self {
                Self(ApplicationSessionId::new())
            }

            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl FromStr for $name {
            type Err = StorageError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                value.parse().map(Self)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                ApplicationSessionId::deserialize(deserializer).map(Self)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([redacted])"))
            }
        }
    };
}

storage_id!(OperationId);
storage_id!(RunId);
storage_id!(StoredEventId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_ids_validate_construction_and_deserialization() {
        let canonical = "01234567-89ab-4cde-8fab-0123456789ab";
        let id: ApplicationSessionId = canonical.parse().unwrap();
        assert_eq!(id.as_str(), canonical);
        assert_eq!(id.to_string(), canonical);
        assert_eq!(
            serde_json::to_string(&id).unwrap(),
            format!("\"{canonical}\"")
        );
        assert_eq!(
            serde_json::from_str::<ApplicationSessionId>(&format!("\"{canonical}\"")).unwrap(),
            id
        );
        for value in [
            "",
            "../session",
            "00000000-0000-0000-0000-000000000000",
            "01234567-89AB-4CDE-8FAB-0123456789AB",
            "0123456789ab4cde8fab0123456789ab",
            "{01234567-89ab-4cde-8fab-0123456789ab}",
            "urn:uuid:01234567-89ab-4cde-8fab-0123456789ab",
            " synthetic-token-canary ",
        ] {
            let error = value.parse::<ApplicationSessionId>().unwrap_err();
            assert_eq!(error.code(), "storage.invalid_input");
            let error = serde_json::from_str::<ApplicationSessionId>(
                &serde_json::to_string(value).unwrap(),
            )
            .unwrap_err();
            assert!(!error.to_string().contains(value) || value.is_empty());
        }
        let generated = ApplicationSessionId::new();
        assert_eq!(
            generated.as_str().parse::<ApplicationSessionId>().unwrap(),
            generated
        );
        assert_eq!(
            Uuid::parse_str(generated.as_str())
                .unwrap()
                .get_version_num(),
            4
        );
        assert_ne!(generated, ApplicationSessionId::new());
        assert!(!format!("{id:?}").contains(canonical));
    }
}
