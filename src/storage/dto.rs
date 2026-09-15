use std::{fmt, path::Path, time::SystemTime};

use ring::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};

use super::{
    ApplicationSessionId, OperationId, RunId, StorageError, StorageErrorKind, StoredEventId,
};

type Result<T> = std::result::Result<T, StorageError>;

macro_rules! redacted_debug {
    ($($name:ident),+ $(,)?) => {$(
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([redacted])"))
            }
        }
    )+};
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CreateFields")]
pub struct CreateSession {
    operation_id: OperationId,
    title: String,
    workspace: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateFields {
    operation_id: OperationId,
    title: String,
    workspace: Option<String>,
}

impl TryFrom<CreateFields> for CreateSession {
    type Error = StorageError;

    fn try_from(value: CreateFields) -> Result<Self> {
        Self::new(value.operation_id, value.title, value.workspace)
    }
}

impl CreateSession {
    pub fn new(
        operation_id: OperationId,
        title: String,
        workspace: Option<String>,
    ) -> Result<Self> {
        validate_workspace(workspace.as_deref())?;
        Ok(Self {
            operation_id,
            title,
            workspace,
        })
    }

    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn workspace(&self) -> Option<&str> {
        self.workspace.as_deref()
    }

    pub(super) fn request(&self) -> CreationRequest {
        CreationRequest {
            method: "create_session".to_owned(),
            title: self.title.clone(),
            workspace: self.workspace.clone(),
        }
    }
}

pub(super) fn validate_workspace(workspace: Option<&str>) -> Result<()> {
    if workspace.is_some_and(|value| !Path::new(value).is_absolute() || value.contains('\0')) {
        return Err(StorageError::new(StorageErrorKind::InvalidInput));
    }
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ReceiptFields")]
pub struct CommitReceipt {
    operation_id: OperationId,
    session_id: ApplicationSessionId,
    run_id: Option<RunId>,
    first_sequence: u64,
    last_sequence: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptFields {
    operation_id: OperationId,
    session_id: ApplicationSessionId,
    run_id: Option<RunId>,
    first_sequence: u64,
    last_sequence: u64,
}

impl TryFrom<ReceiptFields> for CommitReceipt {
    type Error = StorageError;

    fn try_from(value: ReceiptFields) -> Result<Self> {
        if value.first_sequence == 0
            || value.last_sequence < value.first_sequence
            || value.last_sequence > i64::MAX as u64
        {
            return Err(StorageError::new(StorageErrorKind::InvalidInput));
        }
        Ok(Self {
            operation_id: value.operation_id,
            session_id: value.session_id,
            run_id: value.run_id,
            first_sequence: value.first_sequence,
            last_sequence: value.last_sequence,
        })
    }
}

impl CommitReceipt {
    pub(super) fn single(
        operation_id: OperationId,
        session_id: ApplicationSessionId,
        sequence: i64,
    ) -> Result<Self> {
        let sequence = u64::try_from(sequence)
            .map_err(|_| StorageError::new(StorageErrorKind::InvalidInput))?;
        ReceiptFields {
            operation_id,
            session_id,
            run_id: None,
            first_sequence: sequence,
            last_sequence: sequence,
        }
        .try_into()
    }

    pub(super) fn run_batch(
        operation_id: OperationId,
        session_id: ApplicationSessionId,
        run_id: RunId,
        first: i64,
        last: i64,
    ) -> Result<Self> {
        ReceiptFields {
            operation_id,
            session_id,
            run_id: Some(run_id),
            first_sequence: u64::try_from(first)
                .map_err(|_| StorageError::new(StorageErrorKind::InvalidInput))?,
            last_sequence: u64::try_from(last)
                .map_err(|_| StorageError::new(StorageErrorKind::InvalidInput))?,
        }
        .try_into()
    }

    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }
    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }
    pub fn first_sequence(&self) -> u64 {
        self.first_sequence
    }
    pub fn last_sequence(&self) -> u64 {
        self.last_sequence
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupWarning {
    ConnectionCloseFailed,
}

impl CleanupWarning {
    pub fn code(self) -> &'static str {
        "storage.connection_cleanup_failed"
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct CommitResult {
    receipt: CommitReceipt,
    duplicate: bool,
    cleanup_warning: Option<CleanupWarning>,
}

impl CommitResult {
    pub(super) fn new(
        receipt: CommitReceipt,
        duplicate: bool,
        cleanup_warning: Option<CleanupWarning>,
    ) -> Self {
        Self {
            receipt,
            duplicate,
            cleanup_warning,
        }
    }

    pub fn receipt(&self) -> &CommitReceipt {
        &self.receipt
    }
    pub fn duplicate(&self) -> bool {
        self.duplicate
    }
    pub fn cleanup_warning(&self) -> Option<CleanupWarning> {
        self.cleanup_warning
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct CreateResult {
    session_id: ApplicationSessionId,
    commit: CommitResult,
}

impl CreateResult {
    pub(super) fn new(commit: CommitResult) -> Self {
        Self {
            session_id: commit.receipt.session_id.clone(),
            commit,
        }
    }

    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn commit(&self) -> &CommitResult {
        &self.commit
    }
    pub fn receipt(&self) -> &CommitReceipt {
        self.commit.receipt()
    }
    pub fn duplicate(&self) -> bool {
        self.commit.duplicate()
    }
    pub fn cleanup_warning(&self) -> Option<CleanupWarning> {
        self.commit.cleanup_warning()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct SessionManifest {
    pub(super) session_id: ApplicationSessionId,
    pub(super) title: String,
    pub(super) workspace: Option<String>,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
    pub(super) head_sequence: u64,
}

impl SessionManifest {
    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn workspace(&self) -> Option<&str> {
        self.workspace.as_deref()
    }
    pub fn created_at_ms(&self) -> i64 {
        self.created_at_ms
    }
    pub fn updated_at_ms(&self) -> i64 {
        self.updated_at_ms
    }
    pub fn head_sequence(&self) -> u64 {
        self.head_sequence
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionAvailability {
    Creating,
    Ready,
    Missing,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordedRunState {
    Accepted,
    Running,
    Completed,
    Failed,
    CancelledLocally,
    Interrupted,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct SessionSummary {
    pub(super) manifest: SessionManifest,
    pub(super) schema_version: u64,
    pub(super) availability: SessionAvailability,
    pub(super) fault_code: Option<&'static str>,
    pub(super) last_run_id: Option<RunId>,
    pub(super) last_run_state: Option<RecordedRunState>,
}

impl SessionSummary {
    /// These fields are the catalog's observation, not the current canonical manifest.
    pub fn observed_manifest(&self) -> &SessionManifest {
        &self.manifest
    }
    pub fn session_id(&self) -> &ApplicationSessionId {
        self.manifest.session_id()
    }
    pub fn title(&self) -> &str {
        self.manifest.title()
    }
    pub fn observed_head_sequence(&self) -> u64 {
        self.manifest.head_sequence()
    }
    pub fn schema_version(&self) -> u64 {
        self.schema_version
    }
    pub fn availability(&self) -> SessionAvailability {
        self.availability
    }
    pub fn fault_code(&self) -> Option<&'static str> {
        self.fault_code
    }
    pub fn last_run_id(&self) -> Option<&RunId> {
        self.last_run_id.as_ref()
    }
    pub fn last_run_state(&self) -> Option<RecordedRunState> {
        self.last_run_state
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct SessionPage {
    pub(super) sessions: Vec<SessionSummary>,
    pub(super) next_after: Option<ApplicationSessionId>,
    pub(super) has_more: bool,
}

impl SessionPage {
    pub fn sessions(&self) -> &[SessionSummary] {
        &self.sessions
    }
    pub fn next_after(&self) -> Option<&ApplicationSessionId> {
        self.next_after.as_ref()
    }
    pub fn has_more(&self) -> bool {
        self.has_more
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreationRequest {
    pub method: String,
    pub title: String,
    pub workspace: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreationProvenance {
    pub(super) operation_id: OperationId,
    pub(super) method: String,
    pub(super) request_json: String,
    pub(super) payload_hash: [u8; 32],
    pub(super) session_id: ApplicationSessionId,
    pub(super) creation_event_id: StoredEventId,
    pub(super) created_at_ms: i64,
    pub(super) receipt: CommitReceipt,
}

impl CreationProvenance {
    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }
    pub fn request_json(&self) -> &str {
        &self.request_json
    }
    pub fn payload_hash(&self) -> &[u8; 32] {
        &self.payload_hash
    }
    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.session_id
    }
    pub fn creation_event_id(&self) -> &StoredEventId {
        &self.creation_event_id
    }
    pub fn created_at_ms(&self) -> i64 {
        self.created_at_ms
    }
    pub fn receipt(&self) -> &CommitReceipt {
        &self.receipt
    }

    pub(super) fn new(input: &CreateSession) -> Result<Self> {
        let session_id = ApplicationSessionId::new();
        let request_json = canonical_json(&input.request())?;
        Ok(Self {
            operation_id: input.operation_id.clone(),
            method: "create_session".into(),
            payload_hash: hash(&request_json),
            request_json,
            receipt: CommitReceipt::single(input.operation_id.clone(), session_id.clone(), 1)?,
            session_id,
            creation_event_id: StoredEventId::new(),
            created_at_ms: now_ms()?,
        })
    }

    pub(super) fn request(&self) -> Result<CreateSession> {
        let request: CreationRequest = decode(&self.request_json)?;
        let expected_receipt =
            CommitReceipt::single(self.operation_id.clone(), self.session_id.clone(), 1)?;
        if self.method != "create_session"
            || request.method != self.method
            || canonical_json(&request)? != self.request_json
            || hash(&self.request_json) != self.payload_hash
            || self.receipt != expected_receipt
            || self.created_at_ms < 0
        {
            return Err(StorageError::new(StorageErrorKind::Integrity));
        }
        CreateSession::new(self.operation_id.clone(), request.title, request.workspace)
            .map_err(|_| StorageError::new(StorageErrorKind::Integrity))
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreatedPayload {
    pub(super) title: String,
    pub(super) workspace: Option<String>,
    pub(super) creation_provenance: CreationProvenance,
}

impl CreatedPayload {
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn workspace(&self) -> Option<&str> {
        self.workspace.as_deref()
    }
    pub fn creation_provenance(&self) -> &CreationProvenance {
        &self.creation_provenance
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RenamedPayload {
    pub title: String,
}

#[derive(Serialize)]
pub(super) struct RenameRequest<'a> {
    pub method: &'static str,
    pub session_id: &'a ApplicationSessionId,
    pub title: &'a str,
}

// Wi typed JSON sorts every object recursively. Arrays and embedded strings stay exact;
// this is not RFC 8785 and does not equate integer and floating-point encodings.
pub(super) fn canonical_json(value: &impl Serialize) -> Result<String> {
    fn sorted(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(map) => {
                let ordered: std::collections::BTreeMap<_, _> = map
                    .into_iter()
                    .map(|(key, value)| (key, sorted(value)))
                    .collect();
                serde_json::Value::Object(ordered.into_iter().collect())
            }
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(sorted).collect())
            }
            other => other,
        }
    }
    serde_json::to_value(value)
        .and_then(|value| serde_json::to_string(&sorted(value)))
        .map_err(|_| StorageError::new(StorageErrorKind::InvalidInput))
}

pub(super) fn hash(value: &str) -> [u8; 32] {
    let mut bytes = [0; 32];
    bytes.copy_from_slice(digest(&SHA256, value.as_bytes()).as_ref());
    bytes
}

pub(super) fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|_| StorageError::new(StorageErrorKind::Integrity))
}

pub(super) fn now_ms() -> Result<i64> {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| StorageError::new(StorageErrorKind::InvalidInput))
}

pub(super) fn page_limit(page_size: u64) -> Result<i64> {
    if page_size == 0 {
        return Err(StorageError::new(StorageErrorKind::InvalidInput));
    }
    page_size
        .checked_add(1)
        .and_then(|size| i64::try_from(size).ok())
        .filter(|limit| usize::try_from(*limit).is_ok())
        .ok_or_else(|| StorageError::new(StorageErrorKind::InvalidInput))
}

redacted_debug!(
    CreateSession,
    CommitReceipt,
    CommitResult,
    CreateResult,
    SessionManifest,
    SessionSummary,
    SessionPage,
    CreationRequest,
    CreationProvenance,
    CreatedPayload,
    RenamedPayload
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_typed_json_ids_and_dtos_are_strict_and_redacted() {
        let path = std::env::temp_dir()
            .join("nonexistent-workspace-canary")
            .to_str()
            .unwrap()
            .to_owned();
        let input =
            CreateSession::new(OperationId::new(), "title-canary\n雪".into(), Some(path)).unwrap();
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(
            serde_json::from_value::<CreateSession>(json.clone()).unwrap(),
            input
        );
        let mut unknown = json.clone();
        unknown["extra"] = true.into();
        assert!(serde_json::from_value::<CreateSession>(unknown).is_err());
        let mut relative = json;
        relative["workspace"] = "relative".into();
        assert!(serde_json::from_value::<CreateSession>(relative).is_err());
        for bad in [
            "",
            "../id",
            "00000000-0000-0000-0000-000000000000",
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        ] {
            assert!(bad.parse::<OperationId>().is_err());
            assert!(bad.parse::<StoredEventId>().is_err());
            assert!(bad.parse::<RunId>().is_err());
        }
        let provenance = CreationProvenance::new(&input).unwrap();
        assert_eq!(provenance.request().unwrap(), input);
        let mut receipt = serde_json::to_value(&provenance.receipt).unwrap();
        receipt["last_sequence"] = 0.into();
        assert!(serde_json::from_value::<CommitReceipt>(receipt.clone()).is_err());
        receipt["last_sequence"] = u64::MAX.into();
        assert!(serde_json::from_value::<CommitReceipt>(receipt).is_err());
        assert!(!format!("{input:?} {provenance:?}").contains("canary"));
        let a: serde_json::Value =
            serde_json::from_str(r#"{"z":[{"b":" {\\\"z\\\":1} ","a":1.0}],"a":null}"#).unwrap();
        let encoded = canonical_json(&a).unwrap();
        assert!(encoded.starts_with(r#"{"a":null,"z":[{"a":1.0,"b":"#));
        assert_eq!(decode::<serde_json::Value>(&encoded).unwrap(), a);
        assert_ne!(hash("1"), hash("1.0"));
        assert_eq!(page_limit(1).unwrap(), 2);
        for bad in [0, i64::MAX as u64, u64::MAX] {
            assert!(page_limit(bad).is_err());
        }
    }
}
