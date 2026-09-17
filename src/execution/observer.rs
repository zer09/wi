use super::{PersistentRunFailure, PersistentRunStage, check_commit};
use crate::{
    ReplayIdentity,
    run::{RunEventEnvelope, RunObserver, RunSinkError},
    storage::{AppendRunRecord, OperationId, RecordedProviderBinding, RunId, SessionHandle},
};

pub(super) struct PersistentObserver<'a> {
    session: &'a SessionHandle,
    run_id: RunId,
    pub(super) failure: Option<PersistentRunFailure>,
}

impl<'a> PersistentObserver<'a> {
    pub(super) fn new(session: &'a SessionHandle, run_id: RunId) -> Self {
        Self {
            session,
            run_id,
            failure: None,
        }
    }

    async fn append(
        &mut self,
        stage: PersistentRunStage,
        record: AppendRunRecord,
    ) -> Result<(), RunSinkError> {
        if self.failure.is_some() {
            return Err(RunSinkError::Failed);
        }
        let operation_id = OperationId::new();
        let result = self
            .session
            .append_run_records(operation_id.clone(), self.run_id.clone(), vec![record])
            .await;
        if let Err(failure) = check_commit(stage, operation_id, result) {
            self.failure = Some(failure);
            return Err(RunSinkError::Failed);
        }
        Ok(())
    }
}

impl RunObserver for PersistentObserver<'_> {
    async fn provider_opened(
        &mut self,
        session_id: &str,
        requested_model: &str,
        identity: &ReplayIdentity,
    ) -> Result<(), RunSinkError> {
        if self.failure.is_some() {
            return Err(RunSinkError::Failed);
        }
        let binding = RecordedProviderBinding::new(
            self.run_id.clone(),
            session_id.into(),
            requested_model.into(),
            identity.clone(),
        )
        .map_err(|error| {
            self.failure = Some(PersistentRunFailure::storage(
                PersistentRunStage::ProviderBinding,
                OperationId::new(),
                error,
            ));
            RunSinkError::Failed
        })?;
        self.append(
            PersistentRunStage::ProviderBinding,
            AppendRunRecord::ProviderBinding(binding),
        )
        .await
    }

    async fn event(&mut self, event: &RunEventEnvelope) -> Result<(), RunSinkError> {
        self.append(
            PersistentRunStage::RuntimeEvent,
            AppendRunRecord::Runtime(event.clone()),
        )
        .await
    }

    async fn tool_result(
        &mut self,
        request_id: &str,
        call_id: &str,
        output: &str,
        is_error: bool,
    ) -> Result<(), RunSinkError> {
        self.append(
            PersistentRunStage::ToolResult,
            AppendRunRecord::ToolResult {
                request_id: Some(request_id.to_owned()),
                call_id: call_id.to_owned(),
                output: output.to_owned(),
                is_error,
            },
        )
        .await
    }
}
