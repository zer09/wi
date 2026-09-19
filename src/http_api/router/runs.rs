use super::{ApiState, input};
use crate::{
    context::{ContextRoots, discover, prepare_run_with_skill_loading},
    execution::{
        PersistentRunCause, PersistentRunRequest, PersistentRunResult, PersistentRunStage,
    },
    http_api::{
        ApiSettings,
        dto::{ApiError, ErrorView, NoticeView, TaskAcceptedView},
    },
    run::RunRequest,
    service::{RunCompletion, RunHostError},
    storage::{
        ApplicationSessionId, CommitCertainty, CommitReceipt, RecordedRunInput, SessionHandle,
        StoredEventPayload,
    },
    tools::{AddNumbers, ToolRegistry},
};
use std::sync::Arc;

#[cfg(test)]
pub(super) mod test_hooks;

// Validate the canonical command, not merely a receipt with a non-null run ID.
async fn raw_receipt(
    session: &SessionHandle,
    command: &input::Task,
) -> Result<Option<CommitReceipt>, Box<ErrorView>> {
    let Some(receipt) = session
        .lookup_receipt(command.operation_id.clone())
        .await
        .map_err(|error| ErrorView::storage(&error))?
    else {
        return Ok(None);
    };
    if receipt.session_id() != session.session_id()
        || receipt.operation_id() != &command.operation_id
    {
        return Err(ErrorView::integrity().into());
    }
    if receipt.run_id() != Some(&command.run_id)
        || receipt.first_sequence().checked_add(1) != Some(receipt.last_sequence())
    {
        return Err(ErrorView::command_conflict().into());
    }
    let page = session
        .history_page(
            receipt.first_sequence() - 1,
            Some(receipt.last_sequence()),
            2,
        )
        .await
        .map_err(|error| ErrorView::storage(&error))?;
    let [accepted, selected] = page.records() else {
        return Err(ErrorView::integrity().into());
    };
    if accepted.application_session_id() != session.session_id()
        || selected.application_session_id() != session.session_id()
        || accepted.sequence() != receipt.first_sequence()
        || selected.sequence() != receipt.last_sequence()
        || accepted.run_id() != Some(&command.run_id)
        || selected.run_id() != Some(&command.run_id)
    {
        return Err(ErrorView::integrity().into());
    }
    let (
        StoredEventPayload::RunAccepted(accepted),
        StoredEventPayload::RunHistorySelected(selected),
    ) = (accepted.payload(), selected.payload())
    else {
        return Err(ErrorView::command_conflict().into());
    };
    let run = session
        .run_record(command.run_id.clone())
        .await
        .map_err(|error| ErrorView::storage(&error))?
        .ok_or_else(ErrorView::integrity)?;
    if run.run_id() != &command.run_id
        || run.accepted_sequence() != receipt.first_sequence()
        || accepted.run_id() != &command.run_id
        || selected.run_id() != &command.run_id
    {
        return Err(ErrorView::integrity().into());
    }
    // This public typed read also verifies the actual accept_history method and command hash.
    let selection = session
        .history_selection(command.run_id.clone())
        .await
        .map_err(|error| ErrorView::storage(&error))?
        .ok_or_else(ErrorView::integrity)?;
    if &selection != selected.selection() {
        return Err(ErrorView::integrity().into());
    }
    if run.input().user_text() != command.text || accepted.input().user_text() != command.text {
        return Err(ErrorView::command_conflict().into());
    }
    Ok(Some(receipt))
}

pub(super) async fn submit(
    state: &ApiState,
    sid: ApplicationSessionId,
    command: input::Task,
) -> Result<TaskAcceptedView, Box<ErrorView>> {
    #[cfg(test)]
    let _waiter = test_hooks::Waiter(state.run_hooks.clone());
    let session = state
        .host
        .storage()
        .open_session(sid.clone())
        .await
        .map_err(|error| ErrorView::storage(&error))?;
    if let Some(receipt) = raw_receipt(&session, &command).await? {
        return Ok(TaskAcceptedView::receipt(&receipt, true, None, vec![]));
    }
    let prepared = prepare(
        state.config.settings(),
        &session,
        command.text.clone(),
        #[cfg(test)]
        state.run_hooks.clone(),
    )
    .await;
    let (input, tools, notices) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => return reconcile(&session, &command, error).await,
    };
    // Only this waiter can dispatch. The blocking reader never owns a RunClient.
    #[cfg(test)]
    state
        .run_hooks
        .dispatched
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let ticket = match state.client.submit(
        sid,
        PersistentRunRequest {
            operation_id: command.operation_id.clone(),
            run_id: command.run_id.clone(),
            input,
        },
        tools,
    ) {
        Ok(ticket) => ticket,
        Err(error) => {
            let error = host_error(error).with_notices(notices);
            return reconcile(&session, &command, error.into()).await;
        }
    };
    match ticket.accepted().await {
        Ok(commit) => Ok(TaskAcceptedView::new(&commit, notices)),
        Err(completion) => match completion_view(&completion, notices) {
            Ok(accepted) => Ok(accepted),
            Err(error) => reconcile(&session, &command, error).await,
        },
    }
}

async fn reconcile(
    session: &SessionHandle,
    command: &input::Task,
    observed: Box<ErrorView>,
) -> Result<TaskAcceptedView, Box<ErrorView>> {
    // One point-in-time read, never another dispatch or a wait for a competing writer.
    if let Ok(Some(receipt)) = raw_receipt(session, command).await {
        return Ok(TaskAcceptedView::receipt(&receipt, true, None, vec![]));
    }
    // Absence or a failed read cannot turn the original uncertainty into rollback evidence.
    Err(observed)
}

type Prepared = (RecordedRunInput, ToolRegistry, Vec<NoticeView>);

async fn prepare(
    settings: &ApiSettings,
    session: &SessionHandle,
    text: String,
    #[cfg(test)] hooks: Arc<test_hooks::Hooks>,
) -> Result<Prepared, Box<ErrorView>> {
    let manifest = session
        .manifest()
        .await
        .map_err(|error| ErrorView::storage(&error))?;
    let workspace = manifest
        .workspace()
        .and_then(|workspace| settings.workspace(workspace))
        .ok_or_else(|| ErrorView::api(ApiError::WorkspaceForbidden))?
        .to_owned();
    let settings = settings.clone();
    tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        let _reader = hooks.enter();
        settings
            .revalidate_workspace(workspace.to_str().expect("configured UTF-8 workspace"))
            .map_err(|_| ErrorView::api(ApiError::WorkspaceForbidden))?;
        let catalog = Arc::new(
            discover(ContextRoots {
                workspace,
                global_skills: settings.global_skills_root().to_owned(),
            })
            .map_err(|error| ErrorView::context(&error, vec![]))?,
        );
        let notices: Vec<NoticeView> = catalog.diagnostics().iter().map(Into::into).collect();
        let mut template = ToolRegistry::new();
        if settings.enable_add_numbers() {
            template
                .register(Arc::new(AddNumbers))
                .map_err(|error| ErrorView::gateway(&error).with_notices(notices.clone()))?;
        }
        let (prepared, tools) = prepare_run_with_skill_loading(
            RunRequest {
                provider_id: settings.provider_id().to_owned(),
                options: settings.options().clone(),
                prompt: text.clone(),
            },
            catalog,
            &[],
            &template,
        )
        .map_err(|error| ErrorView::context(&error, notices.clone()))?;
        let input = RecordedRunInput::capture(text, &prepared, &tools)
            .map_err(|error| ErrorView::storage(&error).with_notices(notices.clone()))?;
        #[cfg(test)]
        hooks.after();
        Ok((input, tools, notices))
    })
    .await
    .map_err(|_| ErrorView::api(ApiError::WorkerLost))?
}

fn host_error(error: RunHostError) -> ErrorView {
    match error {
        RunHostError::Closed => ErrorView::api(ApiError::Closed),
        RunHostError::RuntimeUnavailable => ErrorView::api(ApiError::WorkerLost),
    }
}

fn completion_view(
    completion: &RunCompletion,
    notices: Vec<NoticeView>,
) -> Result<TaskAcceptedView, Box<ErrorView>> {
    let error = match completion {
        RunCompletion::Execution(Ok(
            PersistentRunResult::Executed { acceptance, .. }
            | PersistentRunResult::Duplicate { acceptance, .. },
        )) => {
            return Ok(TaskAcceptedView::new(acceptance, notices));
        }
        RunCompletion::Execution(Err(failure)) => {
            let (error, warning) = match failure.cause() {
                PersistentRunCause::Gateway(error) => (ErrorView::gateway(error), error.code()),
                PersistentRunCause::Storage(error) => (ErrorView::storage(error), error.code()),
                PersistentRunCause::Cleanup { warning, commit } => {
                    if let Some(receipt) = failure.acceptance() {
                        return Ok(TaskAcceptedView::receipt(
                            receipt,
                            commit.duplicate(),
                            Some(warning.code()),
                            notices,
                        ));
                    }
                    return Err(Box::new(
                        ErrorView::integrity()
                            .with_stage(failure.stage())
                            .with_notices(notices),
                    ));
                }
            };
            if let Some(receipt) = failure.acceptance() {
                return Ok(TaskAcceptedView::receipt(
                    receipt,
                    false,
                    Some(warning),
                    notices,
                ));
            }
            error.with_stage(failure.stage())
        }
        RunCompletion::SessionOpenFailed(error) => {
            ErrorView::storage(error).with_stage(PersistentRunStage::Lookup)
        }
        RunCompletion::WorkerLost => {
            ErrorView::api(ApiError::WorkerLost).with_certainty(CommitCertainty::Unknown)
        }
    };
    Err(Box::new(error.with_notices(notices)))
}
