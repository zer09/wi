use super::*;
use crate::{
    conversation::{
        ActivityCursor, BlockCursor, ConversationPage, ConversationQuery, LiveCursor,
        wire::ACTIVITY_LIMIT,
    },
    storage::SessionManifest,
};

// Select identities only. No older block header or entry text is decoded here.
const LATEST: &str = "SELECT run_id FROM conversation_blocks WHERE accepted_sequence<=? ORDER BY accepted_sequence DESC LIMIT 1";
const BEFORE: &str = "SELECT run_id FROM conversation_blocks WHERE accepted_sequence<? ORDER BY accepted_sequence DESC LIMIT 1";
const PREVIOUS_PROJECTED: &str = "SELECT run_id,accepted_sequence FROM conversation_blocks WHERE accepted_sequence<? ORDER BY accepted_sequence DESC LIMIT 1";
const PREVIOUS_CANONICAL: &str = "SELECT run_id,accepted_sequence FROM runs WHERE accepted_sequence<? ORDER BY accepted_sequence DESC LIMIT 1";
const BOUNDARY_PROJECTED: &str = "SELECT run_id FROM conversation_blocks WHERE accepted_sequence=?";
const BOUNDARY_CANONICAL: &str = "SELECT run_id FROM runs WHERE accepted_sequence=?";
const SELECTED_POSITION: &str = "SELECT b.accepted_sequence,b.changed_sequence,r.accepted_sequence FROM conversation_blocks b JOIN runs r ON r.run_id=b.run_id WHERE b.run_id=?";
const ACTIVITY: &str = "SELECT entry_id FROM conversation_entries WHERE run_id=? AND (first_sequence,position_slot)>(?,0) AND (first_sequence,position_slot)<(?,?) ORDER BY first_sequence DESC,position_slot DESC LIMIT ?";
const ACTIVITY_HEAD: &str = "SELECT entry_id FROM conversation_entries WHERE run_id=? AND (first_sequence,position_slot)>(?,0) AND first_sequence<=? ORDER BY first_sequence DESC,position_slot DESC LIMIT ?";

pub(in crate::storage) async fn read(
    sql: &mut SqliteConnection,
    session: &ApplicationSessionId,
    provenance: &crate::storage::CreationProvenance,
    query: ConversationQuery,
) -> Result<ConversationPage> {
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
        let run = select(&mut transaction, session, head, &query).await?;
        let Some(run) = run else {
            return assemble(&query, &manifest, None, vec![], None, None);
        };
        let header = rows::block(&mut transaction, &run, head + 1).await?;
        let (accepted, revision, canonical): (i64, i64, i64) = sqlx::query_as(SELECTED_POSITION)
            .bind(run.as_str())
            .fetch_one(&mut *transaction)
            .await
            .map_err(database::error)?;
        let accepted = unsigned(accepted)?;
        // Matching run IDs do not prove that the saved acceptance positions agree.
        if accepted != unsigned(canonical)? {
            return Err(integrity().into());
        }
        let revision = unsigned(revision)?;
        let human_id = header.human.parse().map_err(|_| integrity())?;
        let human_row = addressed(&mut transaction, &run, &human_id, head)
            .await
            .map_err(|error| match error {
                ConversationError::Storage(error) if error.kind() == StorageErrorKind::NotFound => {
                    integrity().into()
                }
                error => error,
            })?;
        // Corrupt anchor revisions are not a transfer-budget failure.
        if human_row.revision > revision { return Err(integrity().into()); }
        let human = compact_entry(&mut transaction, session, &run, &human_row, None).await?;
        // The anchor is the first saved position; malformed earlier rows must not disappear.
        let first: String = sqlx::query_scalar("SELECT entry_id FROM conversation_entries WHERE run_id=? ORDER BY first_sequence,position_slot LIMIT 1")
            .bind(run.as_str()).fetch_one(&mut *transaction).await.map_err(database::error)?;
        if first != human_id.to_string() { return Err(integrity().into()); }
        let projected: Option<(String, i64)> = sqlx::query_as(PREVIOUS_PROJECTED)
            .bind(integer(accepted)?)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(database::error)?;
        let canonical: Option<(String, i64)> = sqlx::query_as(PREVIOUS_CANONICAL)
            .bind(integer(accepted)?)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(database::error)?;
        // A missing immediate predecessor must not look like end-of-history or skip to an older row.
        if projected != canonical {
            return Err(integrity().into());
        }
        let previous = projected
            .map(|_| BlockCursor::new(session.clone(), accepted).map_err(|_| integrity()))
            .transpose()?;
        let ids: Vec<String> = match &query {
            ConversationQuery::Within(cursor) => sqlx::query_scalar(ACTIVITY)
                .bind(run.as_str())
                .bind(integer(accepted)?)
                .bind(integer(cursor.before_entry_sequence())?)
                .bind(integer(cursor.before_slot())?)
                .bind((ACTIVITY_LIMIT + 1) as i64)
                .fetch_all(&mut *transaction)
                .await
                .map_err(database::error)?,
            // Include every slot at H without binding H+1, which can exceed SQLite's i64 range.
            ConversationQuery::Latest | ConversationQuery::Before(_) => {
                sqlx::query_scalar(ACTIVITY_HEAD)
                    .bind(run.as_str())
                    .bind(integer(accepted)?)
                    .bind(integer(head)?)
                    .bind((ACTIVITY_LIMIT + 1) as i64)
                    .fetch_all(&mut *transaction)
                    .await
                    .map_err(database::error)?
            }
        };
        #[cfg(test)]
        metrics::candidates(ids.len());
        let make =
            |human: &EntryView, entries: &[EntryView], more: bool| -> Result<ConversationPage> {
                let block = build_block(&run, accepted, revision, &header, human.clone())?;
                let earlier = if more {
                    let first = entries.first().ok_or_else(integrity)?;
                    Some(
                        ActivityCursor::new(
                            session.clone(),
                            run.clone(),
                            first.entry_id().first_sequence(),
                            first.entry_id().position_slot(),
                        )
                        .map_err(|_| integrity())?,
                    )
                } else {
                    None
                };
                assemble(
                    &query,
                    &manifest,
                    Some(block),
                    entries.to_vec(),
                    earlier,
                    previous.clone(),
                )
            };
        let mut human = human;
        let mut entries = Vec::new();
        if ids.is_empty() {
            human = compact::fit(session, human, |human| {
                make(human, &[], false).is_ok_and(|page| fits(&page))
            })?;
        }
        for (index, id) in ids.iter().take(ACTIVITY_LIMIT).enumerate() {
            let id = id.parse().map_err(|_| integrity())?;
            let row = addressed(&mut transaction, &run, &id, head).await?;
            #[cfg(test)]
            metrics::decoded();
            let entry = compact_entry(&mut transaction, session, &run, &row, None).await?;
            let more = index + 1 < ids.len();
            // Fit the newest activity first. Optional anchor bytes cannot prevent its progress.
            if entries.is_empty() {
                let small_human = compact::minimum(session, human.clone())?;
                let entry = compact::fit(session, entry, |entry| {
                    make(&small_human, std::slice::from_ref(entry), more)
                        .is_ok_and(|page| fits(&page))
                })?;
                human = compact::fit(session, human, |human| {
                    make(human, std::slice::from_ref(&entry), more).is_ok_and(|page| fits(&page))
                })?;
                entries.push(entry);
                continue;
            }
            // Prepend only the immediately preceding entry; never skip one to fill space.
            let candidate = compact::fit(session, entry, |entry| {
                let mut candidate = entries.clone();
                candidate.insert(0, entry.clone());
                make(&human, &candidate, more).is_ok_and(|page| fits(&page))
            });
            match candidate {
                Ok(entry) => entries.insert(0, entry),
                Err(ConversationError::DisplayUnavailable) => break,
                Err(error) => return Err(error),
            }
        }
        make(&human, &entries, entries.len() < ids.len())
    }
    .await;
    let retirement = transaction.rollback().await.map_err(database::error);
    match result {
        Ok(page) => {
            retirement?;
            if !fits(&page) {
                return Err(ConversationError::DisplayUnavailable);
            }
            Ok(page)
        }
        Err(error) => Err(error),
    }
}

fn fits(page: &ConversationPage) -> bool {
    DisplayJson::Page(page).json_size().is_ok()
}

fn assemble(
    query: &ConversationQuery,
    manifest: &SessionManifest,
    block: Option<BlockView>,
    entries: Vec<EntryView>,
    earlier: Option<ActivityCursor>,
    previous: Option<BlockCursor>,
) -> Result<ConversationPage> {
    let live = if matches!(query, ConversationQuery::Latest) {
        Some(
            LiveCursor::new(
                manifest.session_id().clone(),
                manifest.head_sequence(),
                3,
                None,
                None,
            )
            .map_err(|_| integrity())?,
        )
    } else {
        None
    };
    ConversationPage::new(
        query,
        manifest.head_sequence(),
        manifest.clone(),
        block,
        entries,
        earlier,
        previous,
        live,
    )
    .map_err(|_| integrity().into())
}

async fn select(
    sql: &mut SqliteConnection,
    session: &ApplicationSessionId,
    head: u64,
    query: &ConversationQuery,
) -> Result<Option<RunId>> {
    let selected: Option<String> = match query {
        ConversationQuery::Latest => sqlx::query_scalar(LATEST)
            .bind(integer(head)?)
            .fetch_optional(&mut *sql)
            .await
            .map_err(database::error)?,
        ConversationQuery::Before(cursor) => {
            if cursor.session_id() != session || cursor.before_accepted_sequence() > head {
                return Err(ConversationError::CursorInvalid);
            }
            let boundary: Option<String> = sqlx::query_scalar(BOUNDARY_PROJECTED)
                .bind(integer(cursor.before_accepted_sequence())?)
                .fetch_optional(&mut *sql)
                .await
                .map_err(database::error)?;
            let canonical: Option<String> = sqlx::query_scalar(BOUNDARY_CANONICAL)
                .bind(integer(cursor.before_accepted_sequence())?)
                .fetch_optional(&mut *sql)
                .await
                .map_err(database::error)?;
            // A projected row alone cannot prove that this is a canonical acceptance boundary.
            if boundary != canonical {
                return Err(integrity().into());
            }
            if boundary.is_none() {
                return Err(ConversationError::CursorInvalid);
            }
            sqlx::query_scalar(BEFORE)
                .bind(integer(cursor.before_accepted_sequence())?)
                .fetch_optional(&mut *sql)
                .await
                .map_err(database::error)?
        }
        ConversationQuery::Within(cursor) => {
            if cursor.session_id() != session
                || cursor.before_entry_sequence() > head
                || cursor.before_slot() > i64::MAX as u64
            {
                return Err(ConversationError::CursorInvalid);
            }
            let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM runs WHERE run_id=?")
                .bind(cursor.run_id().as_str())
                .fetch_optional(&mut *sql)
                .await
                .map_err(database::error)?;
            if exists.is_none() {
                return Err(StorageError::new(StorageErrorKind::NotFound).into());
            }
            let owner: Option<Option<String>> =
                sqlx::query_scalar("SELECT run_id FROM events WHERE sequence=?")
                    .bind(integer(cursor.before_entry_sequence())?)
                    .fetch_optional(&mut *sql)
                    .await
                    .map_err(database::error)?;
            if owner
                .as_ref()
                .is_some_and(|owner| owner.as_deref() != Some(cursor.run_id().as_str()))
            {
                return Err(ConversationError::CursorInvalid);
            }
            let id = EntryId::new(cursor.before_entry_sequence(), cursor.before_slot())
                .map_err(|_| ConversationError::CursorInvalid)?;
            let boundary = addressed(sql, cursor.run_id(), &id, head).await?;
            // Look up the projection first so two absent records still return NotFound.
            if owner.is_none() {
                return Err(integrity().into());
            }
            if matches!(boundary.metadata.source, rows::Source::Human) {
                return Err(ConversationError::CursorInvalid);
            }
            Some(cursor.run_id().to_string())
        }
    };
    if !matches!(query, ConversationQuery::Within(_)) {
        let (sql_query, boundary) = match query {
            ConversationQuery::Before(cursor) => (
                "SELECT run_id FROM runs WHERE accepted_sequence<? ORDER BY accepted_sequence DESC LIMIT 1",
                cursor.before_accepted_sequence(),
            ),
            _ => (
                "SELECT run_id FROM runs WHERE accepted_sequence<=? ORDER BY accepted_sequence DESC LIMIT 1",
                head,
            ),
        };
        let canonical: Option<String> = sqlx::query_scalar(sql_query)
            .bind(integer(boundary)?)
            .fetch_optional(sql)
            .await
            .map_err(database::error)?;
        if canonical != selected {
            return Err(integrity().into());
        }
    }
    selected
        .map(|run| run.parse().map_err(|_| integrity().into()))
        .transpose()
}

#[cfg(test)]
mod metrics {
    use std::cell::Cell;
    thread_local! {
        static COUNTS: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
    }
    pub(super) fn candidates(n: usize) {
        COUNTS.with(|c| {
            let (rows, decoded) = c.get();
            c.set((rows + n, decoded));
        });
    }
    pub(super) fn decoded() {
        COUNTS.with(|c| {
            let (rows, decoded) = c.get();
            c.set((rows, decoded + 1));
        });
    }
    pub(super) fn reset() {
        COUNTS.with(|c| c.set((0, 0)));
    }
    pub(super) fn get() -> (usize, usize) {
        COUNTS.with(Cell::get)
    }
}

#[cfg(test)]
mod tests;
