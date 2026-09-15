use super::*;

// Repair derives state from history, never from the mutable state it is checking.
// Keyset reads release each row before point reads on the same connection.
pub(in crate::storage) async fn validate_run(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run_id: &RunId,
) -> Result<()> {
    let projection = run_record(connection, id, run_id)
        .await?
        .ok_or_else(integrity)?;
    let mut replay = RecordedRun {
        run_id: run_id.clone(),
        accepted_sequence: projection.accepted_sequence,
        input: projection.input.clone(),
        state: RecordedRunState::Accepted,
        last_runtime_sequence: 0,
        owner_instance_id: projection.owner_instance_id.clone(),
        provider_session_id: None,
        terminal: None,
        result_sequence: None,
        result: None,
    };
    let mut correlation = Correlation::default();
    let mut after = 0_i64;
    while let Some(row) = sqlx::query(
        "SELECT * FROM events WHERE run_id=? AND sequence > ? ORDER BY sequence LIMIT 1",
    )
    .bind(run_id.as_str())
    .bind(after)
    .fetch_optional(&mut *connection)
    .await
    .map_err(database::error)?
    {
        let stored = history::decode(&row, id)?;
        let sequence = stored.sequence();
        if after == 0 && !matches!(stored.payload(), StoredEventPayload::RunAccepted(_)) {
            return Err(integrity());
        }
        match stored.payload() {
            StoredEventPayload::RunAccepted(_) => {
                if after != 0 || sequence != replay.accepted_sequence {
                    return Err(integrity());
                }
            }
            StoredEventPayload::RuntimeObserved(event) => {
                correlation
                    .observe(connection, &replay, event, sequence as i64)
                    .await
                    .map_err(|error| match error.kind() {
                        StorageErrorKind::InvalidInput
                        | StorageErrorKind::InvalidTransition
                        | StorageErrorKind::CommandConflict => integrity(),
                        _ => error,
                    })?;
                match &event.event {
                    RunEvent::RunStarted => replay.state = RecordedRunState::Running,
                    RunEvent::RunFinished { outcome, .. } => {
                        require_outputs_before(connection, run_id, outcome, sequence).await?;
                        replay.state = outcome_state(outcome);
                        replay.terminal = Some(stored.clone());
                    }
                    RunEvent::ToolEvent { event: tool } => {
                        validate_tool_event(connection, id, run_id, sequence, event, tool).await?;
                    }
                    _ => {}
                }
                replay.last_runtime_sequence = event.sequence;
                replay.provider_session_id = event.session_id.clone();
            }
            StoredEventPayload::ToolResultRecorded(payload) => {
                if replay.state != RecordedRunState::Running {
                    return Err(integrity());
                }
                let saved = tool_result(connection, id, run_id, payload.call_id())
                    .await?
                    .ok_or_else(integrity)?;
                if saved.result_sequence != Some(sequence) {
                    return Err(integrity());
                }
            }
            StoredEventPayload::RunResultRecorded(result) => {
                if replay.state == RecordedRunState::Interrupted || replay.result_sequence.is_some()
                {
                    return Err(integrity());
                }
                if active(replay.state) {
                    if result.events_complete
                        || (replay.provider_session_id.is_some()
                            && replay.provider_session_id != result.session_id)
                    {
                        return Err(integrity());
                    }
                    require_outputs_before(connection, run_id, &result.outcome, sequence).await?;
                    replay.state = outcome_state(&result.outcome);
                    replay.provider_session_id = result.session_id.clone();
                    replay.terminal = Some(stored.clone());
                } else {
                    let (outcome, provider) =
                        history::terminal_outcome(replay.terminal.as_ref().ok_or_else(integrity)?)
                            .ok_or_else(integrity)?;
                    if *outcome != result.outcome || provider != result.session_id.as_deref() {
                        return Err(integrity());
                    }
                }
                replay.result_sequence = Some(sequence);
            }
            StoredEventPayload::RunInterrupted(_) => {
                if !active(replay.state) {
                    return Err(integrity());
                }
                replay.state = RecordedRunState::Interrupted;
                replay.terminal = Some(stored.clone());
            }
            _ => return Err(integrity()),
        }
        after = sequence as i64;
    }
    if replay.state != projection.state
        || replay.last_runtime_sequence != projection.last_runtime_sequence
        || replay.provider_session_id != projection.provider_session_id
        || replay.terminal_sequence() != projection.terminal_sequence()
        || replay.result_sequence != projection.result_sequence
    {
        return Err(integrity());
    }

    // The event pass detects missing/cleared links. This reverse pass also finds extra rows.
    // The run cursor and this call cursor together cover the (run_id, call_id) primary key.
    let mut after_call: Option<String> = None;
    loop {
        let query = if let Some(call) = &after_call {
            sqlx::query("SELECT call_id FROM tool_results WHERE run_id=? AND call_id > ? ORDER BY call_id LIMIT 1")
                .bind(run_id.as_str()).bind(call)
        } else {
            sqlx::query("SELECT call_id FROM tool_results WHERE run_id=? ORDER BY call_id LIMIT 1")
                .bind(run_id.as_str())
        };
        let Some(row) = query
            .fetch_optional(&mut *connection)
            .await
            .map_err(database::error)?
        else {
            break;
        };
        let call: String = row.try_get(0).map_err(database::error)?;
        tool_result(connection, id, run_id, &call)
            .await?
            .ok_or_else(integrity)?;
        after_call = Some(call);
    }
    Ok(())
}

async fn require_outputs_before(
    connection: &mut SqliteConnection,
    run: &RunId,
    outcome: &RunOutcome,
    sequence: u64,
) -> Result<()> {
    // A later result cannot justify an earlier completed transition.
    if matches!(outcome, RunOutcome::Completed)
        && sqlx::query("SELECT 1 FROM tool_results WHERE run_id=? AND (result_sequence IS NULL OR result_sequence >= ?) LIMIT 1")
            .bind(run.as_str()).bind(sequence as i64)
            .fetch_optional(connection).await.map_err(database::error)?.is_some()
    {
        return Err(integrity());
    }
    Ok(())
}

async fn validate_tool_event(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    run: &RunId,
    sequence: u64,
    envelope: &RunEventEnvelope,
    event: &ToolExecutionEvent,
) -> Result<()> {
    let call = match event {
        ToolExecutionEvent::ToolExecutionStarted { call_id, .. }
        | ToolExecutionEvent::ToolExecutionFinished { call_id, .. }
        | ToolExecutionEvent::ToolResultReused { call_id, .. } => call_id,
    };
    // The existing typed point read checks identity, request, name, output and error flag
    // against all referenced events. Also require each canonical event to point back here.
    let saved = tool_result(connection, id, run, call)
        .await?
        .ok_or_else(integrity)?;
    match event {
        ToolExecutionEvent::ToolExecutionStarted { .. } => {
            if saved.started_sequence != sequence {
                return Err(integrity());
            }
        }
        ToolExecutionEvent::ToolExecutionFinished { .. } => {
            if saved.finished_sequence != Some(sequence) {
                return Err(integrity());
            }
            let started = history::event(connection, id, saved.started_sequence).await?;
            let StoredEventPayload::RuntimeObserved(started) = started.payload() else {
                return Err(integrity());
            };
            if started.turn_id != envelope.turn_id {
                return Err(integrity());
            }
        }
        ToolExecutionEvent::ToolResultReused { tool_name, .. } => {
            if saved.tool_name != *tool_name
                || saved.request_id.is_none()
                || !saved
                    .result_sequence
                    .is_some_and(|result| result < sequence)
            {
                return Err(integrity());
            }
        }
    }
    Ok(())
}
