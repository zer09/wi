use super::*;
use crate::{
    conversation::{
        ConversationChanges, DisplayChange, EntryChange, LiveCursor, wire::ACTIVITY_LIMIT,
    },
    storage::SessionManifest,
};

const BLOCKS: &str = "SELECT changed_sequence,run_id FROM conversation_blocks WHERE (changed_sequence,run_id)>(?,?) AND changed_sequence<=? ORDER BY changed_sequence,run_id LIMIT 65";
const ENTRIES: &str = "SELECT changed_sequence,run_id,entry_id FROM conversation_entries WHERE (changed_sequence,run_id,entry_id)>(?,?,?) AND changed_sequence<=? ORDER BY changed_sequence,run_id,entry_id LIMIT 65";

const ACCEPTANCE: &str = "SELECT b.accepted_sequence,r.accepted_sequence,b.changed_sequence FROM conversation_blocks b JOIN runs r ON r.run_id=b.run_id JOIN events e ON e.sequence=r.accepted_sequence WHERE b.run_id=? AND e.run_id=r.run_id AND e.event_type='run.accepted'";

// Live identity order is ASCII, not the chronological numeric EntryId order.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    sequence: u64,
    rank: u8,
    run: String,
    entry: String,
}
impl Key {
    fn after(cursor: &LiveCursor) -> Self {
        Self {
            sequence: cursor.sequence(),
            rank: cursor.rank(),
            run: cursor.run_id().map(RunId::to_string).unwrap_or_default(),
            entry: cursor
                .entry_id()
                .map(|id| id.to_string())
                .unwrap_or_default(),
        }
    }
    fn cursor(&self, session: &ApplicationSessionId) -> Result<LiveCursor> {
        let run = if self.run.is_empty() {
            None
        } else {
            Some(self.run.parse().map_err(|_| integrity())?)
        };
        let entry = if self.entry.is_empty() {
            None
        } else {
            Some(self.entry.parse().map_err(|_| integrity())?)
        };
        LiveCursor::new(session.clone(), self.sequence, self.rank, run, entry)
            .map_err(|_| integrity().into())
    }
}

pub(in crate::storage) async fn read(
    sql: &mut SqliteConnection,
    session: &ApplicationSessionId,
    provenance: &crate::storage::CreationProvenance,
    after: LiveCursor,
) -> Result<ConversationChanges> {
    let mut transaction = sql.begin().await.map_err(database::error)?;
    #[cfg(test)]
    crate::storage::test_hooks::read_transaction();
    let result = async {
        let manifest =
            session_schema::validate(&mut transaction, session, Some(provenance)).await?;
        let head = manifest.head_sequence();
        #[cfg(test)]
        crate::storage::test_hooks::hit(
            crate::storage::test_hooks::Point::ConversationHeadCaptured,
        )
        .await?;
        validate(&mut transaction, session, head, &after).await?;
        let metadata: i64 = sqlx::query_scalar(
            "SELECT metadata_sequence FROM conversation_projection WHERE singleton=1",
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(database::error)?;
        let after_key = Key::after(&after);
        let mut keys = Vec::new();
        let metadata = Key {
            sequence: unsigned(metadata)?,
            rank: 0,
            run: String::new(),
            entry: String::new(),
        };
        if metadata > after_key {
            keys.push(metadata);
        }
        // '~' sorts after every canonical ASCII identity. No numeric H+1 sentinel is bound.
        let block_run = if after.rank() > 1 {
            "~"
        } else {
            after_key.run.as_str()
        };
        let blocks: Vec<(i64, String)> = sqlx::query_as(BLOCKS)
            .bind(integer(after.sequence())?)
            .bind(block_run)
            .bind(integer(head)?)
            .fetch_all(&mut *transaction)
            .await
            .map_err(database::error)?;
        let entry_run = if after.rank() == 3 {
            "~"
        } else if after.rank() < 2 {
            ""
        } else {
            after_key.run.as_str()
        };
        let entries: Vec<(i64, String, String)> = sqlx::query_as(ENTRIES)
            .bind(integer(after.sequence())?)
            .bind(entry_run)
            .bind(&after_key.entry)
            .bind(integer(head)?)
            .fetch_all(&mut *transaction)
            .await
            .map_err(database::error)?;
        #[cfg(test)]
        metrics::candidates(blocks.len(), entries.len());
        for (sequence, run) in blocks {
            keys.push(Key {
                sequence: unsigned(sequence)?,
                rank: 1,
                run,
                entry: String::new(),
            });
        }
        for (sequence, run, entry) in entries {
            keys.push(Key {
                sequence: unsigned(sequence)?,
                rank: 2,
                run,
                entry,
            });
        }
        keys.sort();
        keys.truncate(ACTIVITY_LIMIT + 1);
        let mut changes = Vec::new();
        let mut last = None;
        for (index, key) in keys.iter().take(ACTIVITY_LIMIT).enumerate() {
            let more = index + 1 < keys.len();
            let accepts = |change: &DisplayChange| {
                let mut candidate = changes.clone();
                candidate.push(change.clone());
                assemble(session, head, candidate, Some(key), more)
                    .is_ok_and(|batch| DisplayJson::Changes(&batch).json_size().is_ok())
            };
            let candidate = entity(&mut transaction, &manifest, key, accepts).await;
            match candidate {
                Ok(change) => {
                    changes.push(change);
                    last = Some(key);
                }
                // Stop at the first nonfitting entity, never skip it for a smaller one.
                Err(ConversationError::DisplayUnavailable) if !changes.is_empty() => break,
                Err(error) => return Err(error),
            }
        }
        let more = changes.len() < keys.len();
        let batch = assemble(session, head, changes, last, more)?;
        if DisplayJson::Changes(&batch).json_size().is_err() {
            return Err(ConversationError::DisplayUnavailable);
        }
        Ok(batch)
    }
    .await;
    let retirement = transaction.rollback().await.map_err(database::error);
    match result {
        Ok(batch) => {
            retirement?;
            Ok(batch)
        }
        Err(error) => Err(error),
    }
}

fn assemble(
    session: &ApplicationSessionId,
    head: u64,
    changes: Vec<DisplayChange>,
    last: Option<&Key>,
    more: bool,
) -> Result<ConversationChanges> {
    let next = if more {
        last.ok_or_else(integrity)?.cursor(session)?
    } else {
        LiveCursor::new(session.clone(), head, 3, None, None).map_err(|_| integrity())?
    };
    ConversationChanges::new(session.clone(), head, changes, next, more)
        .map_err(|_| integrity().into())
}

async fn validate(
    sql: &mut SqliteConnection,
    session: &ApplicationSessionId,
    head: u64,
    after: &LiveCursor,
) -> Result<()> {
    if after.session_id() != session
        || after.sequence() > head
        || after.sequence() > i64::MAX as u64
        || after
            .entry_id()
            .is_some_and(|id| id.position_slot() > i64::MAX as u64)
    {
        return Err(ConversationError::CursorInvalid);
    }
    match after.rank() {
        0 => {
            let kind: Option<String> =
                sqlx::query_scalar("SELECT event_type FROM events WHERE sequence=?")
                    .bind(integer(after.sequence())?)
                    .fetch_optional(sql)
                    .await
                    .map_err(database::error)?;
            if !matches!(kind.as_deref(), Some("session.created" | "session.renamed")) {
                return Err(ConversationError::CursorInvalid);
            }
        }
        1 => {
            let run = after.run_id().ok_or_else(integrity)?;
            let canonical: Option<i64> = sqlx::query_scalar("SELECT r.accepted_sequence FROM runs r JOIN events e ON e.sequence=r.accepted_sequence WHERE r.run_id=? AND e.run_id=r.run_id AND e.event_type='run.accepted'")
                .bind(run.as_str()).fetch_optional(&mut *sql).await.map_err(database::error)?;
            let projected: Option<(i64, i64)> = sqlx::query_as(
                "SELECT accepted_sequence,changed_sequence FROM conversation_blocks WHERE run_id=?",
            )
            .bind(run.as_str())
            .fetch_optional(&mut *sql)
            .await
            .map_err(database::error)?;
            if canonical.is_none() && projected.is_none() {
                return Err(StorageError::new(StorageErrorKind::NotFound).into());
            }
            let canonical = unsigned(canonical.ok_or_else(integrity)?)?;
            let (accepted, revision) = projected.ok_or_else(integrity)?;
            if unsigned(accepted)? != canonical
                || unsigned(revision)? > head
                || unsigned(revision)? < canonical
            {
                return Err(integrity().into());
            }
            if after.sequence() < canonical || after.sequence() > unsigned(revision)? {
                return Err(ConversationError::CursorInvalid);
            }
            anchor(sql, run, head, canonical, unsigned(revision)?).await?;
        }
        2 => {
            let run = after.run_id().ok_or_else(integrity)?;
            let id = after.entry_id().ok_or_else(integrity)?;
            let owner: Option<Option<String>> =
                sqlx::query_scalar("SELECT run_id FROM events WHERE sequence=?")
                    .bind(integer(id.first_sequence())?)
                    .fetch_optional(&mut *sql)
                    .await
                    .map_err(database::error)?;
            if owner
                .as_ref()
                .is_some_and(|owner| owner.as_deref() != Some(run.as_str()))
            {
                return Err(ConversationError::CursorInvalid);
            }
            let row = addressed(sql, run, id, head).await?;
            #[cfg(test)]
            metrics::decoded();
            if owner.is_none() {
                return Err(integrity().into());
            }
            // An exhausted entry cursor still needs its run's canonical acceptance, without decoding content.
            let (projected, canonical, revision): (i64, i64, i64) = sqlx::query_as(ACCEPTANCE)
                .bind(run.as_str())
                .fetch_optional(&mut *sql)
                .await
                .map_err(database::error)?
                .ok_or_else(integrity)?;
            if projected != canonical {
                return Err(integrity().into());
            }
            // Saved rows coalesce revisions; a previously issued cursor survives a newer revision.
            if after.sequence() > row.revision {
                return Err(ConversationError::CursorInvalid);
            }
            anchor(sql, run, head, unsigned(projected)?, unsigned(revision)?).await?;
        }
        3 => {}
        _ => return Err(ConversationError::CursorInvalid),
    }
    Ok(())
}

// Validate the mandatory anchor even when an addressed cursor emits no entities.
async fn anchor(
    sql: &mut SqliteConnection,
    run: &RunId,
    head: u64,
    accepted: u64,
    revision: u64,
) -> Result<(rows::BlockHeader, rows::Entry)> {
    let header = rows::block(sql, run, head + 1).await?;
    #[cfg(test)]
    metrics::decoded();
    let human_id: EntryId = header.human.parse().map_err(|_| integrity())?;
    if human_id.first_sequence() != accepted || human_id.position_slot() != 0 || revision > head {
        return Err(integrity().into());
    }
    // Decode only scalar entry metadata. A corrupt nonhuman anchor must not read tool fields.
    let row = sqlx::query("SELECT entry_id,source_key,first_sequence,position_slot,changed_sequence,content_epoch,kind,metadata_json FROM conversation_entries WHERE run_id=? AND entry_id=?")
        .bind(run.as_str()).bind(human_id.to_string()).fetch_optional(&mut *sql).await.map_err(database::error)?.ok_or_else(integrity)?;
    let human = rows::entry_row(&row, run, head)?;
    #[cfg(test)]
    metrics::decoded();
    if !matches!(human.metadata.source, rows::Source::Human) || human.revision > revision {
        return Err(integrity().into());
    }
    let first: Option<String> = sqlx::query_scalar("SELECT entry_id FROM conversation_entries WHERE run_id=? ORDER BY first_sequence,position_slot LIMIT 1")
        .bind(run.as_str()).fetch_optional(sql).await.map_err(database::error)?;
    if first.as_deref() != Some(header.human.as_str()) {
        return Err(integrity().into());
    }
    Ok((header, human))
}

async fn entity(
    sql: &mut SqliteConnection,
    manifest: &SessionManifest,
    key: &Key,
    accepts: impl Fn(&DisplayChange) -> bool,
) -> Result<DisplayChange> {
    if key.rank == 0 {
        let change = DisplayChange::SessionUpsert(manifest.clone());
        return if accepts(&change) {
            Ok(change)
        } else {
            Err(ConversationError::DisplayUnavailable)
        };
    }
    let session = manifest.session_id();
    let head = manifest.head_sequence();
    let run: RunId = key.run.parse().map_err(|_| integrity())?;
    let (accepted, revision, canonical): (i64, i64, i64) = sqlx::query_as("SELECT b.accepted_sequence,b.changed_sequence,r.accepted_sequence FROM conversation_blocks b JOIN runs r ON r.run_id=b.run_id JOIN events e ON e.sequence=r.accepted_sequence WHERE b.run_id=? AND e.run_id=b.run_id AND e.event_type='run.accepted'")
        .bind(run.as_str()).fetch_optional(&mut *sql).await.map_err(database::error)?.ok_or_else(integrity)?;
    if accepted != canonical {
        return Err(integrity().into());
    }
    let accepted = unsigned(accepted)?;
    let revision = unsigned(revision)?;
    let (header, human_row) = anchor(sql, &run, head, accepted, revision).await?;
    let human = compact_entry(sql, session, &run, &human_row, None).await?;
    let entry = if key.rank == 2 {
        let id = key.entry.parse().map_err(|_| integrity())?;
        let row = addressed(sql, &run, &id, head).await?;
        #[cfg(test)]
        metrics::decoded();
        if row.revision != key.sequence {
            return Err(integrity().into());
        }
        let owner: Option<Option<String>> =
            sqlx::query_scalar("SELECT run_id FROM events WHERE sequence=?")
                .bind(integer(id.first_sequence())?)
                .fetch_optional(&mut *sql)
                .await
                .map_err(database::error)?;
        if owner.as_ref().and_then(|owner| owner.as_deref()) != Some(run.as_str()) {
            return Err(integrity().into());
        }
        Some(compact_entry(sql, session, &run, &row, None).await?)
    } else {
        if revision != key.sequence {
            return Err(integrity().into());
        }
        None
    };
    let make = |human: &EntryView, entry: Option<&EntryView>| -> Result<DisplayChange> {
        let block = build_block(&run, accepted, revision, &header, human.clone())?;
        if let Some(entry) = entry {
            // A human upsert carries the exact same compact anchor, not another identity.
            let entry = if entry.entry_id() == human.entry_id() {
                human.clone()
            } else {
                entry.clone()
            };
            Ok(DisplayChange::EntryUpsert(Box::new(
                EntryChange::new(block, entry).map_err(|_| integrity())?,
            )))
        } else {
            Ok(DisplayChange::BlockUpsert(Box::new(block)))
        }
    };
    if accepts(&make(&human, entry.as_ref())?) {
        return make(&human, entry.as_ref());
    }
    let small_human = compact::minimum(session, human.clone())?;
    let entry = entry
        .map(|entry| {
            compact::fit(session, entry, |entry| {
                make(&small_human, Some(entry)).is_ok_and(|change| accepts(&change))
            })
        })
        .transpose()?;
    let human = compact::fit(session, human, |human| {
        make(human, entry.as_ref()).is_ok_and(|change| accepts(&change))
    })?;
    make(&human, entry.as_ref())
}

#[cfg(test)]
mod metrics {
    use std::cell::Cell;
    thread_local! { static COUNTS: Cell<(usize, usize, usize)> = const { Cell::new((0, 0, 0)) }; }
    pub(super) fn candidates(blocks: usize, entries: usize) {
        COUNTS.with(|c| {
            let (_, _, decoded) = c.get();
            c.set((blocks, entries, decoded));
        });
    }
    pub(super) fn decoded() {
        COUNTS.with(|c| {
            let (blocks, entries, decoded) = c.get();
            c.set((blocks, entries, decoded + 1));
        });
    }
    pub(super) fn reset() {
        COUNTS.with(|c| c.set((0, 0, 0)));
    }
    pub(super) fn get() -> (usize, usize, usize) {
        COUNTS.with(Cell::get)
    }
}
#[cfg(test)]
mod tests;
