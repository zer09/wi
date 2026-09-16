use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::oneshot;

#[derive(Clone, Copy)]
enum Output {
    Success,
    Failed,
    Oversized,
    ErrorShaped,
}
struct ResultTool {
    output: Output,
    calls: Arc<AtomicUsize>,
}
#[async_trait]
impl Tool for ResultTool {
    fn definition(&self) -> ToolDefinition {
        add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, _: Value) -> Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.output {
            Output::Success => Ok(json!({"text":"λ\n\u{0}\"\\"})),
            Output::Failed => Err(GatewayError::ToolFailed),
            Output::Oversized => Ok(json!("x".repeat(64 * 1024))),
            Output::ErrorShaped => Ok(json!({"error":{"code":"gateway_error"}})),
        }
    }
}

#[derive(Debug)]
enum Observation {
    Event(ToolExecutionEvent),
    Result(String, String, bool),
}
#[derive(Default)]
struct Observer {
    observed: Arc<Mutex<Vec<Observation>>>,
    release: Option<oneshot::Receiver<()>>,
    fail_result: bool,
}
impl ToolObserver<GatewayError> for Observer {
    async fn event(&mut self, event: ToolExecutionEvent) -> Result<()> {
        self.observed
            .lock()
            .unwrap()
            .push(Observation::Event(event));
        Ok(())
    }
    async fn result(&mut self, call_id: &str, output: &str, is_error: bool) -> Result<()> {
        self.observed.lock().unwrap().push(Observation::Result(
            call_id.into(),
            output.into(),
            is_error,
        ));
        if let Some(release) = self.release.take() {
            release.await.unwrap();
        }
        if self.fail_result {
            return Err(GatewayError::Protocol("synthetic result observer failure"));
        }
        Ok(())
    }
}

#[tokio::test]
async fn awaited_result_observes_exact_serialization_and_flags_before_finish() {
    for (output, expected, is_error) in [
        (Output::Success, "{\"text\":\"λ\\n\\u0000\\\"\\\\\"}", false),
        (
            Output::Failed,
            "{\"error\":{\"code\":\"gateway_error\"}}",
            true,
        ),
        (
            Output::Oversized,
            "{\"error\":{\"code\":\"tool_output_limit\"}}",
            true,
        ),
        (
            Output::ErrorShaped,
            "{\"error\":{\"code\":\"gateway_error\"}}",
            false,
        ),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(ResultTool {
                output,
                calls: calls.clone(),
            }))
            .unwrap();
        let mut observer = Observer::default();
        let mut batch = registry.preflight(&response(&["one"])).unwrap();
        let result = batch
            .execute_next_observed(|| Ok(()), pending::<GatewayError>(), &mut observer)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(result, InputItem::ToolResult { call_id, output } if call_id == "one" && output == expected)
        );
        drop(batch);
        assert_eq!(registry.results["one"].output, expected);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let observed = observer.observed.lock().unwrap();
        assert_eq!(observed.len(), 3);
        assert!(
            matches!(&observed[0], Observation::Event(ToolExecutionEvent::ToolExecutionStarted { call_id, .. }) if call_id == "one")
        );
        assert!(
            matches!(&observed[1], Observation::Result(call_id, output, flag) if call_id == "one" && output == expected && *flag == is_error)
        );
        assert!(
            matches!(&observed[2], Observation::Event(ToolExecutionEvent::ToolExecutionFinished { is_error: flag, .. }) if *flag == is_error)
        );
    }
}

#[tokio::test]
async fn result_observer_failure_keeps_cache_without_finish_or_remaining_call() {
    let (mut registry, calls) = registry();
    let (release, receiver) = oneshot::channel();
    let mut observer = Observer {
        release: Some(receiver),
        fail_result: true,
        ..Observer::default()
    };
    let observed = observer.observed.clone();
    let mut batch = registry.preflight(&response(&["one", "later"])).unwrap();
    let mut work =
        Box::pin(batch.execute_next_observed(|| Ok(()), pending::<GatewayError>(), &mut observer));
    assert!(futures_util::poll!(work.as_mut()).is_pending());
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert_eq!(observed.lock().unwrap().len(), 2);
    release.send(()).unwrap();
    assert!(matches!(
        work.await,
        Err(GatewayError::Protocol("synthetic result observer failure"))
    ));
    assert!(
        batch
            .execute_next_observed(
                || panic!("discarded batch"),
                pending::<GatewayError>(),
                &mut observer
            )
            .await
            .unwrap()
            .is_none()
    );
    drop(batch);
    assert_eq!(registry.results.len(), 1);
    assert_eq!(registry.results["one"].output, "{\"sum\":5}");
    assert_eq!(observed.lock().unwrap().len(), 2);

    observer.fail_result = false;
    let mut batch = registry.preflight(&response(&["one"])).unwrap();
    let reused = batch
        .execute_next_observed(|| Ok(()), pending::<GatewayError>(), &mut observer)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(reused, InputItem::ToolResult { output, .. } if output == "{\"sum\":5}"));
    assert_eq!(calls.lock().unwrap().len(), 1);
    let observed = observed.lock().unwrap();
    assert_eq!(observed.len(), 3);
    assert!(
        matches!(&observed[2], Observation::Event(ToolExecutionEvent::ToolResultReused { call_id, .. }) if call_id == "one")
    );
}
