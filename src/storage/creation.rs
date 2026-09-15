use super::{catalog_ops::CreationState, dto::CreationProvenance, *};

type Result<T> = std::result::Result<T, StorageError>;

fn incomplete(error: StorageError) -> StorageError {
    if error.kind() == StorageErrorKind::CommitUnknown {
        error
    } else {
        StorageError::new(StorageErrorKind::CreationIncomplete).unknown()
    }
}

pub(super) async fn create(inner: &StoreInner, input: CreateSession) -> Result<CreateResult> {
    let (reserved, duplicate) = catalog_ops::reserve(inner, &input).await?;
    let provenance = reserved.provenance;
    #[cfg(test)]
    test_hooks::hit(test_hooks::Point::Reserved).await?;
    if reserved.state == CreationState::Accepted {
        // The catalog receipt is final; this retry needs no session ownership or database checks.
        return Ok(CreateResult::new(CommitResult::new(
            provenance.receipt,
            true,
            None,
        )));
    }
    let _session = inner.session_lock(&provenance.session_id).await;
    // Another identical admitted operation may have completed while this one waited.
    let entry = catalog_ops::entry(inner, &provenance.session_id)
        .await
        .map_err(incomplete)?;
    if entry.reservation.provenance != provenance {
        return Err(incomplete(session_schema::integrity()));
    }
    match entry.reservation.state {
        CreationState::Accepted => {
            return Ok(CreateResult::new(CommitResult::new(
                provenance.receipt,
                duplicate,
                None,
            )));
        }
        CreationState::Failed(error) => return Err(error),
        CreationState::Creating => {}
    }
    let (manifest, warning) = match materialize(inner, &provenance).await {
        Ok(result) => result,
        Err(error) => {
            if matches!(
                error.kind(),
                StorageErrorKind::Integrity
                    | StorageErrorKind::UnsupportedVersion
                    | StorageErrorKind::Unavailable
            ) {
                catalog_ops::fail(inner, &provenance, error)
                    .await
                    .map_err(incomplete)?;
                return Err(error.not_committed());
            }
            // Operational failures are not proof of a foreign or broken reservation.
            // Keep its identity so a later identical request can inspect committed evidence.
            return Err(incomplete(error));
        }
    };
    #[cfg(test)]
    test_hooks::hit(test_hooks::Point::Materialized).await?;
    let catalog_warning = catalog_ops::complete(inner, &provenance, &manifest)
        .await
        .map_err(incomplete)?;
    #[cfg(test)]
    test_hooks::hit(test_hooks::Point::CatalogAccepted).await?;
    Ok(CreateResult::new(CommitResult::new(
        provenance.receipt,
        duplicate,
        warning.or(catalog_warning),
    )))
}

pub(super) async fn materialize(
    inner: &StoreInner,
    provenance: &CreationProvenance,
) -> Result<(SessionManifest, Option<CleanupWarning>)> {
    let path = filesystem::session_path(&inner.root, &provenance.session_id, true)?;
    if filesystem::check_database(&path)?.is_none() {
        drop(filesystem::open_file(&path, true)?);
    } else {
        let mut connection = database::open(&path, true, &inner.lifecycle).await?;
        let result = async {
            if session_schema::empty(&mut connection).await? {
                return Ok(None);
            }
            session_schema::validate(&mut connection, &provenance.session_id, Some(provenance))
                .await
                .map(Some)
        }
        .await;
        let result = database::finish_read(connection, &inner.lifecycle, result).await?;
        if let Some(manifest) = result {
            return Ok((manifest, None));
        }
    }
    let mut connection = database::open(&path, false, &inner.lifecycle).await?;
    let result = session_schema::initialize(
        &mut connection,
        provenance,
        #[cfg(test)]
        false,
    )
    .await;
    database::finish_write(
        connection,
        &inner.lifecycle,
        result,
        #[cfg(test)]
        false,
    )
    .await
}
