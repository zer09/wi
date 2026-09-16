use super::{RunEventEnvelope, RunSinkError};
use std::future::{Future, ready};

pub(crate) trait RunObserver {
    fn event(
        &mut self,
        event: &RunEventEnvelope,
    ) -> impl Future<Output = Result<(), RunSinkError>> + Send;

    fn tool_result(
        &mut self,
        request_id: &str,
        call_id: &str,
        output: &str,
        is_error: bool,
    ) -> impl Future<Output = Result<(), RunSinkError>> + Send;
}

pub(super) struct SyncObserver<F>(pub F);
impl<F: FnMut(&RunEventEnvelope) -> Result<(), RunSinkError>> RunObserver for SyncObserver<F> {
    fn event(
        &mut self,
        event: &RunEventEnvelope,
    ) -> impl Future<Output = Result<(), RunSinkError>> + Send {
        // Evaluate now so the ready future does not contain the possibly non-Send callback.
        ready((self.0)(event))
    }

    fn tool_result(
        &mut self,
        _: &str,
        _: &str,
        _: &str,
        _: bool,
    ) -> impl Future<Output = Result<(), RunSinkError>> + Send {
        ready(Ok(()))
    }
}
