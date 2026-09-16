use super::*;
use crate::run::RunSummary;

fn no_activity(summary: &RunSummary) -> bool {
    summary.turns_started == 0
        && summary.turns_finished == 0
        && summary.model_requests_attempted == 0
        && summary.model_requests_admitted == 0
        && summary.new_tool_dispatches == 0
        && summary.tool_results_prepared == 0
        && summary.reused_results == 0
        && summary.last_request_id.is_none()
        && summary.last_upstream_outcome.is_none()
}

pub(super) fn validate_unbound_runtime(event: &RunEventEnvelope) -> Result<()> {
    match &event.event {
        RunEvent::RunStarted => Ok(()),
        // Final delivery may precede the actual result. It does not prove no submission.
        RunEvent::RunFinished { summary, .. }
            if no_activity(summary) && event.request_id.is_none() =>
        {
            Ok(())
        }
        _ => Err(transition()),
    }
}

pub(super) fn validate_unbound_result(result: &RunResult) -> Result<()> {
    if !no_activity(&result.summary) || result.last_response.is_some() {
        return Err(transition());
    }
    Ok(())
}

async fn metadata_event(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run: &RunId,
    kind: &str,
) -> Result<Option<StoredEvent>> {
    let rows = sqlx::query(
        "SELECT * FROM events WHERE run_id=? AND event_type=? ORDER BY sequence LIMIT 2",
    )
    .bind(run.as_str())
    .bind(kind)
    .fetch_all(connection)
    .await
    .map_err(database::error)?;
    if rows.len() > 1 {
        return Err(integrity());
    }
    rows.first().map(|row| history::decode(row, id)).transpose()
}

pub(in crate::storage) async fn history_selection(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run_id: &RunId,
) -> Result<Option<StoredHistorySelection>> {
    let Some(event) = metadata_event(connection, id, run_id, "run.history.selected").await? else {
        return Ok(None);
    };
    let StoredEventPayload::RunHistorySelected(payload) = event.payload() else {
        return Err(integrity());
    };
    let run = run_record(connection, id, run_id)
        .await?
        .ok_or_else(integrity)?;
    let selection = payload.selection();
    if event.sequence() != run.accepted_sequence + 1
        || selection.through_sequence() != run.accepted_sequence - 1
        || !selection.matches_input(&run.input)
    {
        return Err(integrity());
    }
    // Both records belong to one command, not two independent appends. Recompute its
    // identity from canonical acceptance data rather than trusting the receipt alone.
    let rows = sqlx::query("SELECT operation_id FROM commands WHERE first_sequence <= ? AND last_sequence >= ? LIMIT 2")
        .bind(event.sequence() as i64).bind(run.accepted_sequence as i64).fetch_all(&mut *connection).await.map_err(database::error)?;
    if rows.len() != 1 {
        return Err(integrity());
    }
    let operation: OperationId = rows[0]
        .try_get::<String, _>(0)
        .map_err(database::error)?
        .parse()
        .map_err(|_| integrity())?;
    let command = session::command(connection, id, &operation)
        .await?
        .ok_or_else(integrity)?;
    let mutation = Mutation::AcceptHistory {
        input: Box::new(run.input),
        selection: selection.clone(),
    };
    if command.method != mutation.method()
        || command.receipt.run_id() != Some(run_id)
        || command.receipt.first_sequence() != run.accepted_sequence
        || command.receipt.last_sequence() != event.sequence()
        || command.payload_hash != command_hash(id, run_id, &mutation)?
    {
        return Err(integrity());
    }
    Ok(Some(selection.clone()))
}

pub(in crate::storage) async fn provider_binding(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run_id: &RunId,
) -> Result<Option<RecordedProviderBinding>> {
    let Some(event) = metadata_event(connection, id, run_id, "run.provider.bound").await? else {
        return Ok(None);
    };
    let StoredEventPayload::RunProviderBound(binding) = event.payload() else {
        return Err(integrity());
    };
    let run = run_record(connection, id, run_id)
        .await?
        .ok_or_else(integrity)?;
    validate_binding(connection, id, &run, binding, event.sequence())
        .await
        .map_err(|error| {
            if error.kind() == StorageErrorKind::InvalidTransition {
                integrity()
            } else {
                error
            }
        })?;
    if run.provider_session_id() != Some(binding.provider_session_id()) {
        return Err(integrity());
    }
    Ok(Some(binding.clone()))
}

pub(super) async fn validate_binding(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run: &RecordedRun,
    binding: &RecordedProviderBinding,
    sequence: u64,
) -> Result<()> {
    if binding.run_id() != &run.run_id
        || !binding.matches_input(&run.input)
        || history_selection(connection, id, &run.run_id)
            .await?
            .is_none()
    {
        return Err(transition());
    }
    // Only acceptance, its adjacent selection and one RunStarted may precede a binding.
    // Renames from other scopes do not prevent binding an otherwise fresh run.
    let rows = sqlx::query("SELECT * FROM events WHERE run_id=? AND sequence>? AND sequence<? ORDER BY sequence LIMIT 2")
        .bind(run.run_id.as_str()).bind((run.accepted_sequence + 1) as i64).bind(sequence as i64)
        .fetch_all(connection).await.map_err(database::error)?;
    if rows.len() != 1 {
        return Err(transition());
    }
    let started = history::decode(&rows[0], id)?;
    if !matches!(
        started.payload(),
        StoredEventPayload::RuntimeObserved(RunEventEnvelope {
            event: RunEvent::RunStarted,
            ..
        })
    ) {
        return Err(transition());
    }
    Ok(())
}
