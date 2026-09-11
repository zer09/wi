use super::*;
use crate::OutputItem;
use std::sync::Mutex;

mod authority_validation;
mod cancellation;
mod execution_results;
mod result_reuse;
mod workloads;

mod single_call {
    use super::*;

    pub(super) fn response(outcome: ResponseOutcome) -> ModelResponse {
        let call = FunctionCall {
            call_id: "call1".into(),
            name: "add_numbers".into(),
            arguments: "{\"a\":2,\"b\":3}".into(),
            origin: CallOrigin::Direct,
            namespace: None,
            complete: true,
        };
        ModelResponse {
            output_provenance: Default::default(),
            id: "r1".into(),
            model: None,
            outcome,
            output: vec![OutputItem {
                id: Some("item1".into()),
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                function_call: Some(call),
                native: Value::Null,
            }],
            text: String::new(),
            usage: None,
            native: Value::Null,
        }
    }

    pub(super) fn registry() -> ToolRegistry {
        let mut r = ToolRegistry::new();
        r.register(Arc::new(AddNumbers)).unwrap();
        r
    }
}

fn response(ids: &[&str]) -> ModelResponse {
    ModelResponse {
        output_provenance: Default::default(),
        id: "response".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output: ids
            .iter()
            .map(|id| OutputItem {
                id: Some(format!("item-{id}")),
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                function_call: Some(FunctionCall {
                    call_id: (*id).into(),
                    name: "add_numbers".into(),
                    arguments: json!({"a":2,"b":3}).to_string(),
                    origin: CallOrigin::Direct,
                    namespace: None,
                    complete: true,
                }),
                native: json!({"opaque_fixture":true}),
            })
            .collect(),
        text: String::new(),
        usage: None,
        native: Value::Null,
    }
}

struct RecordingTool {
    calls: Arc<Mutex<Vec<Value>>>,
    oversized: bool,
    name: &'static str,
}

#[async_trait]
impl Tool for RecordingTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = add_numbers_definition();
        definition.name = self.name.into();
        definition
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.calls.lock().unwrap().push(arguments.clone());
        if self.oversized {
            return Ok(json!("x".repeat(64 * 1024)));
        }
        AddNumbers.execute(arguments).await
    }
}

fn registry() -> (ToolRegistry, Arc<Mutex<Vec<Value>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut registry = ToolRegistry::new();
    for name in ["add_numbers", "other"] {
        registry
            .register(Arc::new(RecordingTool {
                calls: calls.clone(),
                oversized: false,
                name,
            }))
            .unwrap();
    }
    (registry, calls)
}
