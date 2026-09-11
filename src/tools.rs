//! Optional demonstration executor, outside the provider plugin. Only explicitly
//! registered tools run. No shell, file access, sandbox, or dynamic code loader.
use crate::{
    CallOrigin, FunctionCall, GatewayError, InputItem, ItemKind, ModelResponse, ResponseOutcome,
    Result, ToolDefinition, provider::MAX_INPUT_ITEMS,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::{Future, pending},
    sync::Arc,
};

#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    /// Required local validation, independent of the provider's strict schema.
    fn validate(&self, arguments: &Value) -> Result<()>;
    async fn execute(&self, arguments: Value) -> Result<Value>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolExecutionEvent {
    ToolExecutionStarted {
        call_id: String,
        tool_name: String,
    },
    ToolExecutionFinished {
        call_id: String,
        tool_name: String,
        is_error: bool,
    },
    ToolResultReused {
        call_id: String,
        tool_name: String,
    },
}
struct CachedResult {
    name: String,
    arguments: Value,
    output: String,
}
#[derive(Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
    /// In-memory ONLY, scoped to the owning demo/session. Not crash durability.
    results: HashMap<String, CachedResult>,
}
impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    /// Share registered tools, but never share cached execution results.
    pub fn fresh_scope(&self) -> ToolRegistry {
        Self {
            tools: self.tools.clone(),
            results: HashMap::new(),
        }
    }
    pub fn register(&mut self, tool: Arc<dyn Tool>) -> Result<()> {
        let definition = tool.definition();
        definition.validate()?;
        if self.tools.contains_key(&definition.name) {
            return Err(GatewayError::InvalidRequest("duplicate tool registration"));
        }
        self.tools.insert(definition.name, tool);
        Ok(())
    }
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut result: Vec<_> = self.tools.values().map(|t| t.definition()).collect();
        result.sort_by(|a, b| a.name.cmp(&b.name));
        result
    }
    /// All calls are preflighted before any new execution. Incomplete responses,
    /// unknown executable items, unsupported callers, unknown tools, duplicate
    /// identifiers, and invalid arguments fail closed.
    pub async fn execute_response(
        &mut self,
        response: &ModelResponse,
        mut emit: impl FnMut(ToolExecutionEvent),
    ) -> Result<Vec<InputItem>> {
        let mut batch = self.preflight(response)?;
        let mut results = Vec::with_capacity(batch.calls.len());
        while let Some(result) = batch
            .execute_next(
                || Ok(()),
                pending::<GatewayError>(),
                |event| {
                    emit(event);
                    Ok(())
                },
            )
            .await?
        {
            results.push(result);
        }
        Ok(results)
    }

    /// Borrow the scope so cache/registration changes cannot invalidate preflight.
    pub(crate) fn preflight(&mut self, response: &ModelResponse) -> Result<PreparedBatch<'_>> {
        if response.outcome != ResponseOutcome::Completed {
            return Err(GatewayError::NotCompleted);
        }
        let mut calls: Vec<(FunctionCall, Value, Arc<dyn Tool>)> = Vec::new();
        let mut ids = HashSet::new();
        for item in &response.output {
            match item.kind {
                ItemKind::Message | ItemKind::Reasoning => continue,
                ItemKind::FunctionCall => {}
                _ => return Err(GatewayError::UnsupportedOutput),
            }
            let call = item
                .function_call
                .as_ref()
                .ok_or(GatewayError::UnsupportedOutput)?;
            // Normalization can omit a non-string namespace; native presence still blocks execution.
            if !call.complete
                || call.origin != CallOrigin::Direct
                || call.namespace.is_some()
                || item.native.get("namespace").is_some_and(|v| !v.is_null())
            {
                return Err(GatewayError::UnsupportedOutput);
            }
            if call.call_id.is_empty()
                || call.call_id.len() > 512
                || !ids.insert(call.call_id.clone())
            {
                return Err(GatewayError::Protocol(
                    "empty, oversized, or duplicate tool call identity",
                ));
            }
            if call.arguments.len() > 64 * 1024 {
                return Err(GatewayError::InvalidToolArguments);
            }
            let arguments: Value = serde_json::from_str(&call.arguments)
                .map_err(|_| GatewayError::InvalidToolArguments)?;
            if !arguments.is_object() {
                return Err(GatewayError::InvalidToolArguments);
            }
            let tool = self
                .tools
                .get(&call.name)
                .ok_or(GatewayError::UnknownTool)?
                .clone();
            tool.validate(&arguments)?;
            if let Some(saved) = self.results.get(&call.call_id)
                && (saved.name != call.name || saved.arguments != arguments)
            {
                return Err(GatewayError::Protocol(
                    "call identity reused with different arguments",
                ));
            }
            calls.push((call.clone(), arguments, tool));
        }
        // Every result must fit in the next request; never execute only part of a batch.
        if calls.len() > MAX_INPUT_ITEMS {
            return Err(GatewayError::InvalidRequest(
                "tool results exceed input item capacity",
            ));
        }
        Ok(PreparedBatch {
            registry: self,
            calls: calls.into_iter(),
        })
    }
}

pub(crate) struct PreparedBatch<'a> {
    registry: &'a mut ToolRegistry,
    calls: std::vec::IntoIter<(FunctionCall, Value, Arc<dyn Tool>)>,
}

impl PreparedBatch<'_> {
    /// Check stop/sink state before each call and after start observation. The
    /// caller's stop future interrupts cooperative work when cancellation is ready.
    /// Errors discard the remaining batch; dropping pending work creates no result.
    pub(crate) async fn execute_next<E: From<GatewayError>>(
        &mut self,
        mut checkpoint: impl FnMut() -> std::result::Result<(), E>,
        stop: impl Future<Output = E>,
        mut emit: impl FnMut(ToolExecutionEvent) -> std::result::Result<(), E>,
    ) -> std::result::Result<Option<InputItem>, E> {
        let Some((call, arguments, tool)) = self.calls.next() else {
            return Ok(None);
        };
        let result = async {
            checkpoint()?;
            if let Some(saved) = self.registry.results.get(&call.call_id) {
                emit(ToolExecutionEvent::ToolResultReused {
                    call_id: call.call_id.clone(),
                    tool_name: call.name.clone(),
                })?;
                return Ok(Some(InputItem::ToolResult {
                    call_id: call.call_id,
                    output: saved.output.clone(),
                }));
            }
            emit(ToolExecutionEvent::ToolExecutionStarted {
                call_id: call.call_id.clone(),
                tool_name: call.name.clone(),
            })?;
            checkpoint()?;
            let executed = tokio::select! {
                biased;
                error = stop => return Err(error),
                result = tool.execute(arguments.clone()) => result,
            };
            let (value, is_error) = match executed {
                Ok(value) => (value, false),
                Err(error) => (json!({"error":{"code":error.code()}}), true),
            };
            let mut output =
                serde_json::to_string(&value).map_err(|_| GatewayError::Serialization)?;
            let is_error = if output.len() > 64 * 1024 {
                output = "{\"error\":{\"code\":\"tool_output_limit\"}}".into();
                true
            } else {
                is_error
            };
            self.registry.results.insert(
                call.call_id.clone(),
                CachedResult {
                    name: call.name.clone(),
                    arguments,
                    output: output.clone(),
                },
            );
            emit(ToolExecutionEvent::ToolExecutionFinished {
                call_id: call.call_id.clone(),
                tool_name: call.name,
                is_error,
            })?;
            Ok(Some(InputItem::ToolResult {
                call_id: call.call_id,
                output,
            }))
        }
        .await;
        if result.is_err() {
            // A failed observer must never receive another event from this batch.
            self.calls = Vec::new().into_iter();
        }
        result
    }
}

pub struct AddNumbers;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddArguments {
    a: i64,
    b: i64,
}

pub fn add_numbers_definition() -> ToolDefinition {
    ToolDefinition {
        name: "add_numbers".into(),
        description: "Add two signed 64-bit integers; no file, process, or network access.".into(),
        parameters: json!({"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"],"additionalProperties":false}),
        strict: true,
    }
}
#[async_trait]
impl Tool for AddNumbers {
    fn definition(&self) -> ToolDefinition {
        add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        let _: AddArguments = serde_json::from_value(arguments.clone())
            .map_err(|_| GatewayError::InvalidToolArguments)?;
        Ok(())
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        let args: AddArguments =
            serde_json::from_value(arguments).map_err(|_| GatewayError::InvalidToolArguments)?;
        let sum = args.a.checked_add(args.b).ok_or(GatewayError::ToolFailed)?;
        Ok(json!({"sum":sum}))
    }
}

#[cfg(test)]
#[path = "tools/tests/mod.rs"]
mod tests;
