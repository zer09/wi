use sqlx::{Connection, Row, SqliteConnection};

use super::{
    catalog_ops::CreationState,
    dto::{self, CreationProvenance, RenameRequest, RenamedPayload},
    session_schema::integrity,
    *,
};

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone)]
pub struct SessionHandle {
    inner: Arc<StoreInner>,
    id: ApplicationSessionId,
}

impl fmt::Debug for SessionHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionHandle([redacted])")
    }
}

impl SessionHandle {
    pub fn session_id(&self) -> &ApplicationSessionId {
        &self.id
    }

    pub async fn manifest(&self) -> Result<SessionManifest> {
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(false, move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, provenance) = connection(&inner, &id, false).await?;
                let result =
                    session_schema::validate(&mut connection, &id, Some(&provenance)).await;
                database::finish_read(connection, &inner.lifecycle, result).await
            })
            .await
    }

    /// Publish a canonical observation separately from any earlier committed mutation.
    pub async fn refresh_catalog(&self) -> Result<RefreshResult> {
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(true, move |inner| async move {
                catalog_sync::refresh(&inner, &id).await.map_err(|error| {
                    if error.certainty() == CommitCertainty::Unknown {
                        error
                    } else {
                        error.not_committed()
                    }
                })
            })
            .await
    }

    pub async fn rename(&self, operation_id: OperationId, title: String) -> Result<CommitResult> {
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(true, move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, provenance) = connection(&inner, &id, true)
                    .await
                    .map_err(StorageError::not_committed)?;
                let result = rename_transaction(
                    &mut connection,
                    &provenance,
                    &operation_id,
                    &title,
                    #[cfg(test)]
                    None,
                )
                .await;
                let ((receipt, duplicate), warning) = database::finish_write(
                    connection,
                    &inner.lifecycle,
                    result,
                    #[cfg(test)]
                    false,
                )
                .await?;
                Ok(CommitResult::new(receipt, duplicate, warning))
            })
            .await
    }

    pub async fn accept_run(
        &self,
        operation_id: OperationId,
        run_id: RunId,
        input: RecordedRunInput,
    ) -> Result<CommitResult> {
        self.record(
            operation_id,
            run_id,
            run_store::Mutation::Accept {
                input: Box::new(input),
            },
        )
        .await
    }

    pub async fn append_run_records(
        &self,
        operation_id: OperationId,
        run_id: RunId,
        records: Vec<AppendRunRecord>,
    ) -> Result<CommitResult> {
        self.record(
            operation_id,
            run_id,
            run_store::Mutation::Append { records },
        )
        .await
    }

    async fn record(
        &self,
        operation: OperationId,
        run_id: RunId,
        mutation: run_store::Mutation,
    ) -> Result<CommitResult> {
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(true, move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, provenance) = connection(&inner, &id, true)
                    .await
                    .map_err(StorageError::not_committed)?;
                let result = run_store::mutate(
                    &mut connection,
                    &provenance,
                    &inner.instance_id,
                    &operation,
                    &run_id,
                    &mutation,
                    #[cfg(test)]
                    None,
                )
                .await;
                let ((receipt, duplicate), warning) = database::finish_write(
                    connection,
                    &inner.lifecycle,
                    result,
                    #[cfg(test)]
                    false,
                )
                .await?;
                Ok(CommitResult::new(receipt, duplicate, warning))
            })
            .await
    }

    pub async fn history_page(
        &self,
        after_sequence: u64,
        through_sequence: Option<u64>,
        page_size: u64,
    ) -> Result<HistoryPage> {
        let limit = dto::page_limit(page_size)?;
        if after_sequence > i64::MAX as u64 || through_sequence.is_some_and(|s| s > i64::MAX as u64)
        {
            return Err(records::invalid());
        }
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(false, move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, _) = connection(&inner, &id, false).await?;
                let result = history::page(
                    &mut connection,
                    &id,
                    after_sequence,
                    through_sequence,
                    limit,
                )
                .await;
                database::finish_read(connection, &inner.lifecycle, result).await
            })
            .await
    }

    pub async fn run_record(&self, run_id: RunId) -> Result<Option<RecordedRun>> {
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(false, move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, _) = connection(&inner, &id, false).await?;
                let result = run_store::run_record(&mut connection, &id, &run_id).await;
                database::finish_read(connection, &inner.lifecycle, result).await
            })
            .await
    }

    pub async fn tool_result(
        &self,
        run_id: RunId,
        call_id: String,
    ) -> Result<Option<RecordedToolResult>> {
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(false, move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, _) = connection(&inner, &id, false).await?;
                let result = run_store::tool_result(&mut connection, &id, &run_id, &call_id).await;
                database::finish_read(connection, &inner.lifecycle, result).await
            })
            .await
    }

    pub async fn lookup_receipt(&self, operation_id: OperationId) -> Result<Option<CommitReceipt>> {
        let id = self.id.clone();
        self.inner
            .clone()
            .operation(false, move |inner| async move {
                let _lock = inner.session_lock(&id).await;
                let (mut connection, _) = connection(&inner, &id, false).await?;
                let result = command(&mut connection, &id, &operation_id)
                    .await
                    .map(|command| command.map(|command| command.receipt));
                database::finish_read(connection, &inner.lifecycle, result).await
            })
            .await
    }
}

pub(super) async fn open(
    inner: Arc<StoreInner>,
    id: ApplicationSessionId,
) -> Result<SessionHandle> {
    let entry = catalog_ops::entry(&inner, &id).await?;
    if entry.summary.availability() == SessionAvailability::Creating {
        creation::create(&inner, entry.reservation.provenance.request()?).await?;
    }
    let _lock = inner.session_lock(&id).await;
    let (mut connection, provenance) = connection(&inner, &id, true).await?;
    let result = interruption::reconcile(&mut connection, &provenance, &inner.instance_id).await;
    database::finish_read(connection, &inner.lifecycle, result).await?;
    Ok(SessionHandle { inner, id })
}

pub(super) async fn connection(
    inner: &StoreInner,
    id: &ApplicationSessionId,
    writable: bool,
) -> Result<(SqliteConnection, CreationProvenance)> {
    let entry = catalog_ops::entry(inner, id).await?;
    match entry.summary.availability() {
        SessionAvailability::Ready => {}
        SessionAvailability::Creating => {
            return Err(StorageError::new(StorageErrorKind::CreationIncomplete).unknown());
        }
        SessionAvailability::Missing => return Err(StorageError::new(StorageErrorKind::NotFound)),
        SessionAvailability::Unavailable => {
            return Err(StorageError::new(StorageErrorKind::Unavailable));
        }
    }
    if entry.reservation.state != CreationState::Accepted {
        return Err(integrity());
    }
    let provenance = entry.reservation.provenance;
    let path = filesystem::session_path(&inner.root, id, false)?;
    let mut connection = database::open(&path, true, &inner.lifecycle).await?;
    let result = session_schema::validate(&mut connection, id, Some(&provenance))
        .await
        .and_then(|manifest| {
            let observed = entry.summary.observed_manifest();
            if observed.head_sequence() > manifest.head_sequence()
                || (observed.head_sequence() == manifest.head_sequence() && *observed != manifest)
            {
                return Err(integrity());
            }
            Ok(())
        });
    if !writable && result.is_ok() {
        return Ok((connection, provenance));
    }
    database::finish_read(connection, &inner.lifecycle, result).await?;
    database::open(&path, false, &inner.lifecycle)
        .await
        .map(|connection| (connection, provenance))
}

pub(super) struct Command {
    pub method: String,
    pub payload_hash: [u8; 32],
    pub receipt: CommitReceipt,
}

pub(super) async fn command(
    connection: &mut SqliteConnection,
    id: &ApplicationSessionId,
    operation: &OperationId,
) -> Result<Option<Command>> {
    let Some(row) = sqlx::query("SELECT * FROM commands WHERE operation_id=?")
        .bind(operation.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(database::error)?
    else {
        return Ok(None);
    };
    let receipt: CommitReceipt = dto::decode(
        &row.try_get::<String, _>("receipt_json")
            .map_err(database::error)?,
    )?;
    let first: i64 = row.try_get("first_sequence").map_err(database::error)?;
    let last: i64 = row.try_get("last_sequence").map_err(database::error)?;
    let head: i64 = sqlx::query("SELECT head_sequence FROM manifest WHERE singleton=1")
        .fetch_one(&mut *connection)
        .await
        .map_err(database::error)?
        .try_get(0)
        .map_err(database::error)?;
    if receipt.operation_id() != operation
        || receipt.session_id() != id
        || first <= 1
        || receipt.first_sequence() != first as u64
        || receipt.last_sequence() != last as u64
        || last > head
    {
        return Err(integrity());
    }
    Ok(Some(Command {
        receipt,
        method: row.try_get("method").map_err(database::error)?,
        payload_hash: row
            .try_get::<Vec<u8>, _>("payload_hash")
            .map_err(database::error)?
            .try_into()
            .map_err(|_| integrity())?,
    }))
}

pub(super) fn next_sequence(head: u64) -> Result<i64> {
    head.checked_add(1)
        .and_then(|next| i64::try_from(next).ok())
        .ok_or_else(|| StorageError::new(StorageErrorKind::InvalidInput))
}

#[cfg(test)]
#[derive(Clone, Copy)]
pub(super) enum RenameFault {
    AfterEvent,
    AfterManifest,
}

pub(super) async fn rename_transaction(
    connection: &mut SqliteConnection,
    provenance: &CreationProvenance,
    operation: &OperationId,
    title: &str,
    #[cfg(test)] fault: Option<RenameFault>,
) -> Result<(CommitReceipt, bool)> {
    let mut transaction = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| database::error(error).not_committed())?;
    let result = async {
        let id = &provenance.session_id;
        let request = dto::canonical_json(&RenameRequest { method: "rename", session_id: id, title })?;
        let payload_hash = dto::hash(&request);
        // Receipt precedes current-state eligibility, including sequence exhaustion.
        if let Some(command) = command(&mut transaction, id, operation).await? {
            if command.method != "rename" || command.payload_hash != payload_hash {
                return Err(StorageError::new(StorageErrorKind::CommandConflict));
            }
            if command.receipt.run_id().is_some() || command.receipt.first_sequence() != command.receipt.last_sequence() { return Err(integrity()); }
            return Ok((command.receipt, true));
        }
        let manifest = session_schema::validate(&mut transaction, id, Some(provenance)).await?;
        let sequence = next_sequence(manifest.head_sequence())?;
        let receipt = CommitReceipt::single(operation.clone(), id.clone(), sequence)?;
        let timestamp = dto::now_ms()?;
        sqlx::query("INSERT INTO events (sequence, event_id, event_type, event_version, created_at_ms, payload_json) VALUES (?, ?, 'session.renamed', 1, ?, ?)")
            .bind(sequence).bind(StoredEventId::new().as_str()).bind(timestamp).bind(dto::canonical_json(&RenamedPayload { title: title.to_owned() })?)
            .execute(&mut *transaction).await.map_err(database::error)?;
        #[cfg(test)]
        if matches!(fault, Some(RenameFault::AfterEvent)) { return Err(StorageError::new(StorageErrorKind::Io)); }
        sqlx::query("UPDATE manifest SET title=?, updated_at_ms=?, head_sequence=? WHERE singleton=1")
            .bind(title).bind(timestamp).bind(sequence).execute(&mut *transaction).await.map_err(database::error)?;
        #[cfg(test)]
        if matches!(fault, Some(RenameFault::AfterManifest)) { return Err(StorageError::new(StorageErrorKind::Io)); }
        sqlx::query("INSERT INTO commands (operation_id, method, payload_hash, first_sequence, last_sequence, receipt_json) VALUES (?, 'rename', ?, ?, ?, ?)")
            .bind(operation.as_str()).bind(payload_hash.as_slice()).bind(sequence).bind(sequence).bind(dto::canonical_json(&receipt)?)
            .execute(&mut *transaction).await.map_err(database::error)?;
        Ok((receipt, false))
    }.await;
    database::finish_transaction(transaction, result).await
}
