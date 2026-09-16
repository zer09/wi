//! Awaited capture of an explicitly supplied prepared run. This does not restore history.
mod observer;
mod types;

#[cfg(test)]
mod tests;

pub use types::{
    PersistentRunCause, PersistentRunFailure, PersistentRunRequest, PersistentRunResult,
    PersistentRunStage,
};

use crate::{
    Gateway, run,
    storage::{AppendRunRecord, CommitResult, OperationId, RunId, SessionHandle},
    tools::ToolRegistry,
};
use observer::PersistentObserver;
use tokio_util::sync::CancellationToken;
use types::check_commit;
use uuid::Uuid;

pub async fn run_persisted(
    gateway: &Gateway,
    session: &SessionHandle,
    request: PersistentRunRequest,
    tools: &ToolRegistry,
    cancel: CancellationToken,
) -> Result<PersistentRunResult, PersistentRunFailure> {
    let hold = session.execution_hold().map_err(|error| {
        PersistentRunFailure::storage(
            PersistentRunStage::Lookup,
            request.operation_id.clone(),
            error,
        )
    })?;
    let result = run_held(
        gateway,
        session,
        request,
        tools,
        cancel,
        hold.closing_token(),
    )
    .await;
    // Only a returned orchestration result proves local work has stopped. Drop/panic quarantines.
    hold.finish();
    result
}

async fn run_held(
    gateway: &Gateway,
    session: &SessionHandle,
    request: PersistentRunRequest,
    tools: &ToolRegistry,
    cancel: CancellationToken,
    closing: CancellationToken,
) -> Result<PersistentRunResult, PersistentRunFailure> {
    let PersistentRunRequest {
        operation_id,
        run_id,
        input,
    } = request;
    let receipt = session
        .lookup_receipt(operation_id.clone())
        .await
        .map_err(|error| {
            PersistentRunFailure::storage(PersistentRunStage::Lookup, operation_id.clone(), error)
        })?;
    let acceptance_guard = session.run_acceptance(operation_id.clone()).await;
    let receipt = if receipt.is_none() {
        // Another caller can commit after the first lookup. Recheck under shared acceptance ownership.
        session
            .lookup_receipt(operation_id.clone())
            .await
            .map_err(|error| {
                PersistentRunFailure::storage(
                    PersistentRunStage::Lookup,
                    operation_id.clone(),
                    error,
                )
            })?
    } else {
        receipt
    };
    if receipt.is_some() {
        // Storage verifies the original method and content before returning the old receipt.
        let acceptance = check_commit(
            PersistentRunStage::Acceptance,
            operation_id.clone(),
            acceptance_guard.accept_run(run_id.clone(), input).await,
        )?;
        return duplicate(session, run_id, acceptance).await;
    }

    let admitted = run::admit_with_snapshot(
        gateway,
        input.prepared_request().clone(),
        tools,
        &cancel,
        Some(input.tool_definitions()),
    )
    .map_err(PersistentRunFailure::preflight)?;
    // RunId is validated by storage. Use its exact UUID, not a new runtime identity.
    let uuid = Uuid::parse_str(run_id.as_str()).expect("validated storage run ID");
    let acceptance = check_commit(
        PersistentRunStage::Acceptance,
        operation_id.clone(),
        acceptance_guard.accept_run(run_id.clone(), input).await,
    )?;
    if acceptance.duplicate() {
        return duplicate(session, run_id, acceptance).await;
    }

    let local_cancel = cancel.child_token();
    let mut observer = PersistentObserver::new(session, run_id.clone());
    let result = {
        let running =
            run::run_admitted(gateway, admitted, uuid, local_cancel.clone(), &mut observer);
        tokio::pin!(running);
        tokio::select! {
            biased;
            _ = closing.cancelled() => {
                local_cancel.cancel();
                // Keep polling the same future, including any admitted persistence acknowledgment.
                running.await
            }
            result = &mut running => result,
        }
    };
    if let Some(failure) = observer.failure {
        return Err(failure.with_execution(&acceptance, result));
    }
    let operation_id = OperationId::new();
    let final_record = check_commit(
        PersistentRunStage::FinalResult,
        operation_id.clone(),
        session
            .append_run_records(
                operation_id,
                run_id,
                vec![AppendRunRecord::Result(result.clone())],
            )
            .await,
    );
    match final_record {
        Ok(final_record) => Ok(PersistentRunResult::Executed {
            acceptance,
            final_record,
            result: Box::new(result),
        }),
        Err(failure) => Err(failure.with_execution(&acceptance, result)),
    }
}

async fn duplicate(
    session: &SessionHandle,
    run_id: RunId,
    acceptance: CommitResult,
) -> Result<PersistentRunResult, PersistentRunFailure> {
    let run = session.accepted_run_record(run_id).await.map_err(|error| {
        PersistentRunFailure::storage(
            PersistentRunStage::Lookup,
            acceptance.receipt().operation_id().clone(),
            error,
        )
        .with_acceptance(&acceptance)
    })?;
    Ok(PersistentRunResult::Duplicate {
        acceptance,
        run: Box::new(run),
    })
}
