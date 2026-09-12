use std::{fmt, sync::Arc};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::{GatewayError, ToolDefinition, tools::Tool};

use super::{
    ContextError, ContextErrorKind, SkillCatalog, SkillId, SkillMetadata, frontmatter,
    preparation::read_bytes, valid_name,
};

/// Owned main instructions. Explicit content access is sensitive application data.
pub struct LoadedSkill {
    id: SkillId,
    frontmatter: Value,
    body: String,
}

impl LoadedSkill {
    pub fn id(&self) -> &SkillId {
        &self.id
    }

    pub fn frontmatter(&self) -> &Value {
        &self.frontmatter
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub(super) fn into_value(self) -> Value {
        let mut value = json!({
            "id": self.id.to_string(),
            "frontmatter": self.frontmatter,
            "body": self.body,
        });
        // Match S1 even when a downstream crate enables preserve_order.
        value.sort_all_objects();
        value
    }
}

impl fmt::Debug for LoadedSkill {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LoadedSkill { content: [redacted] }")
    }
}

pub(super) fn lookup<'a>(
    catalog: &'a SkillCatalog,
    id: &SkillId,
) -> Result<&'a SkillMetadata, ContextError> {
    // Public IDs can be constructed directly; never treat their names as paths.
    if !valid_name(&id.name) {
        return Err(ContextError {
            kind: ContextErrorKind::InvalidSkillId,
            scope: None,
            source: None,
        });
    }
    let index = catalog
        .entries
        .binary_search_by(|entry| entry.id.cmp(id))
        .map_err(|_| ContextError {
            kind: ContextErrorKind::UnknownSkill,
            scope: Some(id.scope),
            source: Some(id.to_string()),
        })?;
    Ok(&catalog.entries[index])
}

#[derive(Debug)]
pub(super) struct SkillLoader {
    catalog: Arc<SkillCatalog>,
    #[cfg(test)]
    worker: Option<Arc<tests::Worker>>,
}

impl SkillLoader {
    pub(super) fn new(catalog: Arc<SkillCatalog>) -> Self {
        Self {
            catalog,
            #[cfg(test)]
            worker: None,
        }
    }

    fn arguments_id(&self, arguments: &Value) -> crate::Result<SkillId> {
        let object = arguments
            .as_object()
            .ok_or(GatewayError::InvalidToolArguments)?;
        if object.len() != 1 {
            return Err(GatewayError::InvalidToolArguments);
        }
        let id: SkillId = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or(GatewayError::InvalidToolArguments)?
            .parse()
            .map_err(|_| GatewayError::InvalidToolArguments)?;
        lookup(&self.catalog, &id).map_err(|_| GatewayError::InvalidToolArguments)?;
        Ok(id)
    }
}

#[async_trait]
impl Tool for SkillLoader {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "load_skill".into(),
            description: "Load the main instructions for one advertised qualified skill ID. Supporting files and scripts are not read or executed.".into(),
            parameters: json!({
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
                "additionalProperties": false,
            }),
            strict: true,
        }
    }

    fn validate(&self, arguments: &Value) -> crate::Result<()> {
        self.arguments_id(arguments).map(|_| ())
    }

    async fn execute(&self, arguments: Value) -> crate::Result<Value> {
        let id = self.arguments_id(&arguments)?;
        let catalog = Arc::clone(&self.catalog);
        #[cfg(test)]
        let worker = self.worker.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(worker) = &worker {
                worker.before_read();
            }
            let loaded = load_skill(&catalog, &id);
            #[cfg(test)]
            if let Some(worker) = worker {
                worker.after_read();
            }
            loaded
        })
        .await
        .map_err(|_| GatewayError::ToolFailed)?
        .map_err(|_| GatewayError::ToolFailed)?;
        Ok(loaded.into_value())
    }
}

#[cfg(test)]
#[path = "skill_loading/tests.rs"]
mod tests;

/// Read only the recorded main file and revalidate its discovered frontmatter.
pub fn load_skill(catalog: &SkillCatalog, id: &SkillId) -> Result<LoadedSkill, ContextError> {
    let entry = lookup(catalog, id)?;
    let bytes = read_bytes(&entry.source)?;
    let mut body = bytes.as_slice();
    let metadata = frontmatter::read(&mut body)
        .map_err(|_| entry.source.error(ContextErrorKind::ContextChanged))?;
    if metadata != entry.frontmatter {
        return Err(entry.source.error(ContextErrorKind::ContextChanged));
    }
    // Check identity first so changed metadata is not reported as a body error.
    let body =
        std::str::from_utf8(body).map_err(|_| entry.source.error(ContextErrorKind::ReadFailed))?;
    if body.trim().is_empty() {
        return Err(entry.source.error(ContextErrorKind::InvalidBody));
    }
    Ok(LoadedSkill {
        id: entry.id.clone(),
        frontmatter: metadata,
        body: body.to_owned(),
    })
}
