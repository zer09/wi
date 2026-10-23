use sqlx::SqliteConnection;

use super::super::fields::{self, FieldKey, FieldOrder};
use super::{
    Result,
    content::{self, Part},
    integer, integrity,
    rows::{self, BlockHeader, Entry, EntryMetadata, Outcome, Source, Summary},
};
use crate::{
    ProviderEvent, UpstreamOutcome,
    conversation::{
        FieldKind,
        interpretation::{State, delta_field, part_order},
        primitives::{FieldRank, OrderKey},
        projection::{project_item, project_response},
        safe_code,
    },
    run::{RunEvent, RunEventEnvelope, TurnOutcome},
    storage::{RecordedRunState, RunId, database},
    tools::ToolExecutionEvent,
};

pub(super) async fn observe(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    event: &RunEventEnvelope,
) -> Result<()> {
    if event.run_id != run.as_str() || event.schema_version != 2 {
        return Err(integrity());
    }
    let mut header = rows::block(sql, run, sequence).await?;
    if !matches!(
        header.state,
        RecordedRunState::Accepted | RecordedRunState::Running
    ) {
        return Err(integrity());
    }
    match &event.event {
        RunEvent::RunStarted => {
            if header.state != RecordedRunState::Accepted {
                return Err(integrity());
            }
            header.state = RecordedRunState::Running;
        }
        RunEvent::TurnStarted { .. } => {
            if header.current_turn.is_some() {
                return Err(integrity());
            }
            header.current_turn = Some(event.turn_id.clone().ok_or_else(integrity)?);
            header.current_assistant = None;
        }
        RunEvent::TurnFinished {
            outcome,
            upstream_outcome,
            ..
        } => {
            let turn = current_turn(&header, event)?;
            let entry = rows::lookup(
                sql,
                run,
                sequence,
                &Source::Assistant {
                    turn_id: turn.into(),
                },
            )
            .await?;
            if entry.as_ref().map(|entry| entry.id.to_string()) != header.current_assistant {
                return Err(integrity());
            }
            if let Some(mut entry) = entry
                && entry.metadata.provisional
            {
                if let TurnOutcome::Stopped { reason } = outcome
                    && matches!(
                        entry.metadata.state,
                        State::Accepted | State::InProgress | State::Unknown
                    )
                {
                    entry.metadata.state = State::unfinished(reason);
                }
                entry.metadata.upstream_outcome = *upstream_outcome;
                rows::save(sql, run, sequence, &entry).await?;
            }
            header.current_turn = None;
            header.current_assistant = None;
        }
        RunEvent::RunFinished { outcome, summary } => {
            let outcome_view = Outcome::new(outcome);
            header.state = outcome_view.state();
            header.outcome = Some(outcome_view);
            header.summary = Some(Summary::from(summary));
            header.current_turn = None;
            header.current_assistant = None;
            settle(sql, run, sequence, State::unfinished(outcome)).await?;
        }
        RunEvent::ProviderEvent { event: provider } => {
            if provider.schema_version != 1 {
                return Err(integrity());
            }
            provider_event(sql, run, sequence, &mut header, event, &provider.event).await?;
        }
        RunEvent::ToolEvent { event: tool } => {
            current_turn(&header, event)?;
            tool_event(sql, run, sequence, event, tool).await?;
        }
    }
    rows::save_block(sql, run, sequence, &header).await
}

fn current_turn<'a>(header: &'a BlockHeader, event: &RunEventEnvelope) -> Result<&'a str> {
    let turn = header.current_turn.as_deref().ok_or_else(integrity)?;
    if event.turn_id.as_deref() != Some(turn) {
        return Err(integrity());
    }
    Ok(turn)
}

async fn assistant(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    turn: &str,
    response_id: &str,
    expected: Option<&str>,
) -> Result<Entry> {
    let source = Source::Assistant {
        turn_id: turn.into(),
    };
    let entry = match rows::lookup(sql, run, sequence, &source).await? {
        Some(entry) => {
            if expected != Some(entry.id.to_string().as_str()) {
                return Err(integrity());
            }
            entry
        }
        None => {
            if expected.is_some() {
                return Err(integrity());
            }
            let mut metadata = EntryMetadata::new(source, State::InProgress, true);
            metadata.response_id = Some(response_id.into());
            rows::create(sql, run, sequence, metadata).await?
        }
    };
    Ok(entry)
}

async fn provider_event(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    header: &mut BlockHeader,
    envelope: &RunEventEnvelope,
    event: &ProviderEvent,
) -> Result<()> {
    let response_id = match event {
        ProviderEvent::ResponseStarted { response_id }
        | ProviderEvent::ResponseStatus { response_id, .. }
        | ProviderEvent::OutputItemStarted { response_id, .. }
        | ProviderEvent::OutputItemUpdated { response_id, .. }
        | ProviderEvent::OutputItemFinished { response_id, .. } => response_id,
        ProviderEvent::ResponseFinished { response } => &response.id,
        ProviderEvent::RequestFailed {
            code,
            upstream_outcome,
            ..
        } => {
            return observation(
                sql,
                run,
                sequence,
                header,
                envelope,
                Some((safe_code(code).as_str(), *upstream_outcome)),
                false,
            )
            .await;
        }
        ProviderEvent::SessionClosed { .. } => {
            return observation(sql, run, sequence, header, envelope, None, true).await;
        }
        ProviderEvent::ProviderExtension { .. } => {
            let mut entry = rows::create(
                sql,
                run,
                sequence,
                EntryMetadata::new(Source::Notice { sequence, slot: 0 }, State::Unknown, false),
            )
            .await?;
            let part = Part {
                order: OrderKey::new(None, FieldRank::Unsupported, None, None),
                kind: FieldKind::Unsupported,
                text: "Unsupported content",
            };
            content::delta(sql, run, &mut entry, sequence, part).await?;
            return Ok(());
        }
    };
    let turn = current_turn(header, envelope)?;
    let mut entry = assistant(
        sql,
        run,
        sequence,
        turn,
        response_id,
        header.current_assistant.as_deref(),
    )
    .await?;
    header.current_assistant = Some(entry.id.to_string());
    // Canonical storage permits a different terminal response ID. The turn fixes display identity.
    entry.metadata.response_id = Some(response_id.clone());
    if matches!(
        event,
        ProviderEvent::OutputItemUpdated { .. }
            | ProviderEvent::OutputItemStarted { .. }
            | ProviderEvent::OutputItemFinished { .. }
    ) {
        // Storage permits later content in the active turn, even after a recorded terminal response.
        entry.metadata.provisional = true;
        entry.metadata.state = State::InProgress;
    }
    match event {
        ProviderEvent::ResponseStarted { .. } => {}
        ProviderEvent::ResponseStatus { status, .. } => {
            entry.metadata.state = State::status(status)
        }
        ProviderEvent::OutputItemUpdated {
            output_index,
            content_index,
            summary_index,
            kind,
            delta,
            ..
        } => {
            let (order, field_kind) =
                delta_field(*output_index, *summary_index, *content_index, *kind);
            let text = if field_kind == FieldKind::Unsupported {
                "Unsupported content"
            } else {
                delta
            };
            content::delta(
                sql,
                run,
                &mut entry,
                sequence,
                Part {
                    order,
                    kind: field_kind,
                    text,
                },
            )
            .await?;
        }
        ProviderEvent::OutputItemStarted {
            output_index, item, ..
        }
        | ProviderEvent::OutputItemFinished {
            output_index, item, ..
        } => {
            let projection = project_item(item);
            let parts = projection
                .parts
                .iter()
                .map(|part| {
                    Ok(Part {
                        order: part_order(*output_index, part.source).map_err(|_| integrity())?,
                        kind: part.kind,
                        text: part.text,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            content::snapshot(sql, run, &mut entry, sequence, Some(*output_index), &parts).await?;
        }
        ProviderEvent::ResponseFinished { response } => {
            let projection = project_response(response);
            let parts = projection
                .fields
                .iter()
                .map(|field| {
                    Ok(Part {
                        order: part_order(
                            u64::try_from(field.output_index).map_err(|_| integrity())?,
                            field.part.source,
                        )
                        .map_err(|_| integrity())?,
                        kind: field.part.kind,
                        text: field.part.text,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            content::snapshot(sql, run, &mut entry, sequence, None, &parts).await?;
            entry.metadata.state = State::response(&response.outcome);
            entry.metadata.provisional = false;
            entry.metadata.provenance = Some(projection.output_provenance);
        }
        _ => return Err(integrity()),
    }
    rows::save(sql, run, sequence, &entry).await
}

async fn observation(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    header: &BlockHeader,
    envelope: &RunEventEnvelope,
    failure: Option<(&str, UpstreamOutcome)>,
    closed: bool,
) -> Result<()> {
    // A missing/different current turn must never select an earlier response.
    let current = match current_turn(header, envelope) {
        Ok(turn) => {
            let entry = rows::lookup(
                sql,
                run,
                sequence,
                &Source::Assistant {
                    turn_id: turn.into(),
                },
            )
            .await?;
            if entry.as_ref().map(|entry| entry.id.to_string()) != header.current_assistant {
                return Err(integrity());
            }
            entry
        }
        Err(_) => None,
    };
    let mut entry = match current {
        Some(entry) => entry,
        None => {
            rows::create(
                sql,
                run,
                sequence,
                EntryMetadata::new(Source::Notice { sequence, slot: 0 }, State::Unknown, false),
            )
            .await?
        }
    };
    if let Some((code, upstream)) = failure {
        entry.metadata.failure = Some(code.into());
        entry.metadata.upstream_outcome = Some(upstream);
        if entry.metadata.provisional || matches!(entry.metadata.source, Source::Notice { .. }) {
            entry.metadata.state = State::Failed;
        }
    }
    if closed {
        entry.metadata.closed = true;
        if entry.metadata.provisional && entry.metadata.failure.is_none() {
            entry.metadata.state = State::Unknown;
        }
    }
    let text = if closed {
        "Response closed"
    } else {
        "Request failed"
    };
    content::delta(
        sql,
        run,
        &mut entry,
        sequence,
        Part {
            order: OrderKey::new(None, FieldRank::Notice, None, Some(sequence)),
            kind: FieldKind::Notice,
            text,
        },
    )
    .await?;
    rows::save(sql, run, sequence, &entry).await
}

pub(in crate::storage::conversation) fn tool_order(rank: FieldRank) -> OrderKey {
    OrderKey::new(None, rank, None, None)
}

async fn tool_event(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    envelope: &RunEventEnvelope,
    event: &ToolExecutionEvent,
) -> Result<()> {
    let (call_id, tool_name) = match event {
        ToolExecutionEvent::ToolExecutionStarted { call_id, tool_name }
        | ToolExecutionEvent::ToolExecutionFinished {
            call_id, tool_name, ..
        }
        | ToolExecutionEvent::ToolResultReused { call_id, tool_name } => (call_id, tool_name),
    };
    let source = Source::Tool {
        call_id: call_id.clone(),
    };
    if matches!(event, ToolExecutionEvent::ToolExecutionStarted { .. }) {
        let mut metadata = EntryMetadata::new(source, State::InProgress, true);
        metadata.turn_id = envelope.turn_id.clone();
        metadata.request_id = envelope.request_id.clone();
        metadata.result_recorded = Some(false);
        metadata.finish_recorded = Some(false);
        let mut entry = rows::create(sql, run, sequence, metadata).await?;
        content::delta(
            sql,
            run,
            &mut entry,
            sequence,
            Part {
                order: tool_order(FieldRank::ToolName),
                kind: FieldKind::ToolName,
                text: tool_name,
            },
        )
        .await?;
        return Ok(());
    }
    let mut entry = rows::lookup(sql, run, sequence, &source)
        .await?
        .ok_or_else(integrity)?;
    let key = FieldKey::new(
        run.clone(),
        entry.id,
        FieldOrder::Indexed(tool_order(FieldRank::ToolName)),
        FieldKind::ToolName,
    )?;
    if !content::same_text(sql, &key, run, &entry, tool_name).await? {
        return Err(integrity());
    }
    match event {
        ToolExecutionEvent::ToolExecutionFinished { is_error, .. } => {
            if entry.metadata.finish_recorded != Some(false)
                || entry.metadata.turn_id != envelope.turn_id
                || entry.metadata.request_id != envelope.request_id
            {
                return Err(integrity());
            }
            entry.metadata.finish_recorded = Some(true);
            entry.metadata.finish_is_error = Some(*is_error);
            if entry.metadata.result_recorded == Some(false) {
                entry.metadata.is_error = Some(*is_error);
                entry.metadata.state = State::Unknown;
            }
            rows::save(sql, run, sequence, &entry).await?;
        }
        ToolExecutionEvent::ToolResultReused { .. } => {
            if entry.metadata.result_recorded != Some(true) {
                return Err(integrity());
            }
            let mut metadata = EntryMetadata::new(
                Source::Reuse { sequence, slot: 0 },
                entry.metadata.state,
                false,
            );
            metadata.reference = Some(entry.id.to_string());
            metadata.turn_id = envelope.turn_id.clone();
            metadata.request_id = envelope.request_id.clone();
            metadata.result_recorded = entry.metadata.result_recorded;
            metadata.finish_recorded = entry.metadata.finish_recorded;
            metadata.is_error = entry.metadata.is_error;
            metadata.finish_is_error = entry.metadata.finish_is_error;
            rows::create(sql, run, sequence, metadata).await?;
        }
        ToolExecutionEvent::ToolExecutionStarted { .. } => return Err(integrity()),
    }
    Ok(())
}

pub(super) async fn tool_result(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    request: Option<&str>,
    call: &str,
    output: &str,
    is_error: bool,
) -> Result<()> {
    let header = rows::block(sql, run, sequence).await?;
    if header.state != RecordedRunState::Running {
        return Err(integrity());
    }
    let mut entry = rows::lookup(
        sql,
        run,
        sequence,
        &Source::Tool {
            call_id: call.into(),
        },
    )
    .await?
    .ok_or_else(integrity)?;
    if entry.metadata.result_recorded != Some(false)
        || entry.metadata.request_id.as_deref() != request
    {
        return Err(integrity());
    }
    let key = FieldKey::new(
        run.clone(),
        entry.id,
        FieldOrder::Indexed(tool_order(FieldRank::ToolOutput)),
        FieldKind::ToolResult,
    )?;
    fields::insert(sql, &key, sequence, output).await?;
    entry.metadata.result_recorded = Some(true);
    entry.metadata.is_error = Some(is_error);
    entry.metadata.provisional = false;
    entry.metadata.state = if is_error {
        State::Failed
    } else {
        State::Completed
    };
    rows::save(sql, run, sequence, &entry).await
}

pub(super) async fn settle(
    sql: &mut SqliteConnection,
    run: &RunId,
    sequence: u64,
    state: State,
) -> Result<()> {
    let mut after = (0i64, 0i64);
    loop {
        // Visit only provisional rows, one at a time. Authoritative response/tool state is untouched.
        let row = sqlx::query("SELECT entry_id,source_key,first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json FROM conversation_entries WHERE run_id=? AND (first_sequence,position_slot)>(?,?) AND kind IN ('assistant','tool') AND json_extract(metadata_json,'$.provisional')=1 ORDER BY first_sequence,position_slot LIMIT 1")
            .bind(run.as_str()).bind(after.0).bind(after.1).fetch_optional(&mut *sql).await.map_err(database::error)?;
        let Some(row) = row else {
            break;
        };
        let mut entry = rows::entry_row(&row, run, sequence)?;
        if matches!(entry.metadata.source, Source::Tool { .. }) {
            entry.metadata.state = State::Unknown;
        } else if matches!(
            entry.metadata.state,
            State::Accepted | State::InProgress | State::Unknown
        ) {
            entry.metadata.state = state;
        }
        rows::save(sql, run, sequence, &entry).await?;
        after = (
            integer(entry.id.first_sequence())?,
            integer(entry.id.position_slot())?,
        );
    }
    Ok(())
}
