use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{ReplayIdentity, SessionOptions, provider::replay::valid_digest};

use super::{RecordedRunInput, RunId, StorageError, records::invalid};

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SelectionFields")]
pub struct StoredHistorySelection {
    policy: String,
    through_sequence: u64,
    history_digest: String,
    provider_id: String,
    requested_model: String,
    expected_identity: Option<ReplayIdentity>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectionFields {
    policy: String,
    through_sequence: u64,
    history_digest: String,
    provider_id: String,
    requested_model: String,
    expected_identity: Option<ReplayIdentity>,
}

impl TryFrom<SelectionFields> for StoredHistorySelection {
    type Error = StorageError;

    fn try_from(value: SelectionFields) -> Result<Self> {
        if value.policy != "closed-exchanges-v1" {
            return Err(invalid());
        }
        Self::new(
            value.through_sequence,
            value.history_digest,
            value.provider_id,
            value.requested_model,
            value.expected_identity,
        )
    }
}

impl StoredHistorySelection {
    pub fn new(
        through_sequence: u64,
        history_digest: String,
        provider_id: String,
        requested_model: String,
        expected_identity: Option<ReplayIdentity>,
    ) -> Result<Self> {
        if through_sequence == 0
            || through_sequence > i64::MAX as u64
            || !valid_digest(&history_digest)
            || provider_id.trim().is_empty()
            || expected_identity
                .as_ref()
                .is_some_and(|identity| identity.provider_id() != provider_id)
        {
            return Err(invalid());
        }
        SessionOptions::new(requested_model.clone())
            .validate()
            .map_err(|_| invalid())?;
        Ok(Self {
            policy: "closed-exchanges-v1".into(),
            through_sequence,
            history_digest,
            provider_id,
            requested_model,
            expected_identity,
        })
    }

    pub fn policy(&self) -> &str {
        &self.policy
    }
    pub fn through_sequence(&self) -> u64 {
        self.through_sequence
    }
    pub fn history_digest(&self) -> &str {
        &self.history_digest
    }
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }
    pub fn requested_model(&self) -> &str {
        &self.requested_model
    }
    pub fn expected_identity(&self) -> Option<&ReplayIdentity> {
        self.expected_identity.as_ref()
    }

    pub(super) fn matches_input(&self, input: &RecordedRunInput) -> bool {
        self.provider_id == input.prepared_request().provider_id
            && self.requested_model == input.prepared_request().options.model
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "BindingFields")]
pub struct RecordedProviderBinding {
    run_id: RunId,
    provider_session_id: String,
    requested_model: String,
    identity: ReplayIdentity,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BindingFields {
    run_id: RunId,
    provider_session_id: String,
    requested_model: String,
    identity: ReplayIdentity,
}

impl TryFrom<BindingFields> for RecordedProviderBinding {
    type Error = StorageError;

    fn try_from(value: BindingFields) -> Result<Self> {
        Self::new(
            value.run_id,
            value.provider_session_id,
            value.requested_model,
            value.identity,
        )
    }
}

impl RecordedProviderBinding {
    pub fn new(
        run_id: RunId,
        provider_session_id: String,
        requested_model: String,
        identity: ReplayIdentity,
    ) -> Result<Self> {
        if provider_session_id.trim().is_empty() {
            return Err(invalid());
        }
        SessionOptions::new(requested_model.clone())
            .validate()
            .map_err(|_| invalid())?;
        Ok(Self {
            run_id,
            provider_session_id,
            requested_model,
            identity,
        })
    }

    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }
    pub fn provider_session_id(&self) -> &str {
        &self.provider_session_id
    }
    pub fn requested_model(&self) -> &str {
        &self.requested_model
    }
    pub fn identity(&self) -> &ReplayIdentity {
        &self.identity
    }

    pub(super) fn matches_input(&self, input: &RecordedRunInput) -> bool {
        self.identity.provider_id() == input.prepared_request().provider_id
            && self.requested_model == input.prepared_request().options.model
    }
}

impl fmt::Debug for StoredHistorySelection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoredHistorySelection([redacted])")
    }
}
impl fmt::Debug for RecordedProviderBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordedProviderBinding([redacted])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p1b2_04_metadata_validation_and_redaction() {
        let identity =
            ReplayIdentity::new("fixture".into(), "native-v1".into(), "a".repeat(64)).unwrap();
        let selection = StoredHistorySelection::new(
            1,
            "b".repeat(64),
            "fixture".into(),
            "model".into(),
            Some(identity.clone()),
        )
        .unwrap();
        let binding =
            RecordedProviderBinding::new(RunId::new(), "session".into(), "model".into(), identity)
                .unwrap();
        let json = serde_json::to_value(&selection).unwrap();
        assert_eq!(
            serde_json::from_value::<StoredHistorySelection>(json.clone()).unwrap(),
            selection
        );
        for (key, value) in [
            ("policy", serde_json::json!("other")),
            ("through_sequence", serde_json::json!(0)),
            ("through_sequence", serde_json::json!(u64::MAX)),
            ("history_digest", serde_json::json!("A".repeat(64))),
            ("provider_id", serde_json::json!("other")),
            ("requested_model", serde_json::json!(" ")),
        ] {
            let mut bad = json.clone();
            bad[key] = value;
            assert!(serde_json::from_value::<StoredHistorySelection>(bad).is_err());
        }
        let json = serde_json::to_value(&binding).unwrap();
        assert_eq!(
            serde_json::from_value::<RecordedProviderBinding>(json.clone()).unwrap(),
            binding
        );
        for key in ["run_id", "provider_session_id", "requested_model"] {
            let mut bad = json.clone();
            bad[key] = "".into();
            assert!(serde_json::from_value::<RecordedProviderBinding>(bad).is_err());
        }
        assert_eq!(
            format!("{selection:?}"),
            "StoredHistorySelection([redacted])"
        );
        assert_eq!(
            format!("{binding:?}"),
            "RecordedProviderBinding([redacted])"
        );
    }
}
