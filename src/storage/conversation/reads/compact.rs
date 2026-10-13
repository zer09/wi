use super::*;
#[cfg(test)]
mod tests;
use crate::conversation::{EntryKind, EntryReference, RecordedState, interpretation::State};

pub(super) fn view(
    session: &ApplicationSessionId,
    run: &RunId,
    entry: &rows::Entry,
    fields: Vec<FieldFragment>,
    earlier: Option<ContentCursor>,
) -> Result<EntryView> {
    let metadata = &entry.metadata;
    let kind = match metadata.source {
        rows::Source::Human => EntryKind::Human,
        rows::Source::Assistant { .. } => EntryKind::Assistant,
        rows::Source::Tool { .. } => EntryKind::Tool,
        rows::Source::Reuse { .. } => EntryKind::Reuse,
        rows::Source::Notice { .. } => EntryKind::Notice,
    };
    let state = match metadata.state {
        State::Accepted => RecordedState::Accepted,
        State::InProgress => RecordedState::InProgress,
        State::Completed => RecordedState::Completed,
        State::Incomplete => RecordedState::Incomplete,
        State::Failed => RecordedState::Failed,
        State::Cancelled => RecordedState::Cancelled,
        State::Interrupted => RecordedState::Interrupted,
        State::Unknown => RecordedState::Unknown,
    };
    let reference = metadata
        .reference
        .as_ref()
        .map(|id| {
            id.parse()
                .map(|id| EntryReference::new(run.clone(), id))
                .map_err(|_| integrity())
        })
        .transpose()?;
    let complete = earlier.is_none() && fields.iter().all(|f| !f.has_earlier() && !f.has_later());
    let value = EntryView::new(
        run.clone(),
        entry.id,
        entry.revision,
        entry.epoch,
        kind,
        state,
        metadata.provisional,
        reference,
        metadata.result_recorded,
        metadata.finish_recorded,
        metadata.is_error,
        fields,
        earlier,
        complete,
    )
    .map_err(|_| integrity())?;
    if value
        .earlier_content()
        .is_some_and(|c| c.session_id() != session)
    {
        return Err(integrity().into());
    }
    Ok(value)
}

fn boundary(
    session: &ApplicationSessionId,
    entry: &EntryView,
    field: &FieldFragment,
    from: u64,
) -> Result<ContentCursor> {
    ContentCursor::new(
        session.clone(),
        entry.run_id().clone(),
        *entry.entry_id(),
        entry.content_epoch(),
        field.field_id().into(),
        field.generation(),
        from,
    )
    .map_err(|_| integrity().into())
}

fn rebuild(
    entry: &EntryView,
    fields: Vec<FieldFragment>,
    earlier: Option<ContentCursor>,
) -> Result<EntryView> {
    let complete = earlier.is_none() && fields.iter().all(|f| !f.has_earlier() && !f.has_later());
    EntryView::new(
        entry.run_id().clone(),
        *entry.entry_id(),
        entry.revision(),
        entry.content_epoch(),
        entry.kind(),
        entry.recorded_state(),
        entry.provisional(),
        entry.reference().cloned(),
        entry.result_recorded(),
        entry.finish_recorded(),
        entry.is_error(),
        fields,
        earlier,
        complete,
    )
    .map_err(|_| integrity().into())
}

fn suffix_view(
    session: &ApplicationSessionId,
    entry: &EntryView,
    skip: usize,
) -> Result<EntryView> {
    let fields = entry.fields()[skip..].to_vec();
    let first = &fields[0];
    let earlier = Some(boundary(session, entry, first, first.from_byte())?);
    rebuild(entry, fields, earlier)
}

fn text_suffix(session: &ApplicationSessionId, entry: &EntryView, cut: usize) -> Result<EntryView> {
    let mut fields = entry.fields().to_vec();
    let first = &fields[0];
    let from = first.from_byte() + cut as u64;
    fields[0] = FieldFragment::new(
        first.field_id().into(),
        first.order_key().into(),
        first.kind(),
        first.generation(),
        first.total_bytes(),
        from,
        first.to_byte(),
        first.text()[cut..].into(),
    )
    .map_err(|_| integrity())?;
    let earlier = Some(boundary(session, entry, &fields[0], from)?);
    rebuild(entry, fields, earlier)
}

// Keep the newest contiguous suffix. Even the smallest representation retains
// one new descriptor or one scalar, so an earlier-content read always progresses.
pub(super) fn fit(
    session: &ApplicationSessionId,
    entry: EntryView,
    accepts: impl Fn(&EntryView) -> bool,
) -> Result<EntryView> {
    if accepts(&entry) {
        return Ok(entry);
    }
    if entry.fields().is_empty() {
        return Err(ConversationError::DisplayUnavailable);
    }
    let mut candidate = entry;
    // Drop older descriptors before shrinking the newest field's bytes.
    while candidate.fields().len() > 1 {
        candidate = suffix_view(session, &candidate, 1)?;
        if accepts(&candidate) {
            return Ok(candidate);
        }
    }
    let text = candidate.fields()[0].text();
    if text.is_empty() {
        return Err(ConversationError::DisplayUnavailable);
    }
    let offsets: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    let minimum = minimum(session, candidate.clone())?;
    if !accepts(&minimum) {
        return Err(ConversationError::DisplayUnavailable);
    }
    let mut low = 0;
    let mut high = offsets
        .iter()
        .position(|cut| {
            candidate.fields()[0].from_byte() + *cut as u64 == minimum.fields()[0].from_byte()
        })
        .ok_or_else(integrity)?;
    while low < high {
        let mid = (low + high) / 2;
        if accepts(&text_suffix(session, &candidate, offsets[mid])?) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    text_suffix(session, &candidate, offsets[low])
}

pub(super) fn minimum(session: &ApplicationSessionId, entry: EntryView) -> Result<EntryView> {
    let mut best = entry.clone();
    let mut size = DisplayJson::Entry(&best).json_size().unwrap_or(usize::MAX);
    for skip in 0..entry.fields().len() {
        let tail = if skip == 0 {
            entry.clone()
        } else {
            suffix_view(session, &entry, skip)?
        };
        let tail_size = DisplayJson::Entry(&tail).json_size().unwrap_or(usize::MAX);
        if tail_size < size {
            size = tail_size;
            best = tail.clone();
        }
        let field = &tail.fields()[0];
        let offsets: Vec<usize> = field.text().char_indices().map(|(i, _)| i).collect();
        let Some(last) = offsets.last() else {
            continue;
        };
        let mut cuts = vec![*last];
        // Cursor/from-byte decimal widths can grow at powers of ten. Just before
        // each width change can be smaller than the one-scalar representation.
        let mut power = 10_u64;
        loop {
            if let Some(cut) = offsets
                .iter()
                .rev()
                .find(|cut| field.from_byte() + (**cut as u64) < power)
            {
                cuts.push(*cut);
            }
            if power > field.to_byte() {
                break;
            }
            let Some(next) = power.checked_mul(10) else {
                break;
            };
            power = next;
        }
        cuts.sort_unstable();
        cuts.dedup();
        for cut in cuts {
            if cut == 0 {
                continue;
            }
            let candidate = text_suffix(session, &tail, cut)?;
            let candidate_size = DisplayJson::Entry(&candidate)
                .json_size()
                .unwrap_or(usize::MAX);
            if candidate_size < size {
                size = candidate_size;
                best = candidate;
            }
        }
    }
    if size == usize::MAX {
        return Err(ConversationError::DisplayUnavailable);
    }
    Ok(best)
}
