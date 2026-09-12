use super::*;
use std::{
    cell::Cell,
    fs,
    future::pending,
    path::PathBuf,
    sync::{Mutex, mpsc},
};

use tokio::sync::oneshot;

use crate::{
    CallOrigin, FunctionCall, InputItem, ItemKind, ModelResponse, OutputItem, ResponseOutcome,
    context::{ContextRoots, discover},
    provider::MAX_INPUT_BYTES,
    tools::{ToolExecutionEvent, ToolRegistry},
};

// Per-instance controls exist only in test builds and carry no source data.
#[derive(Debug)]
pub(super) enum Worker {
    Fail,
    Pending {
        started: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<Option<mpsc::Receiver<()>>>,
        finished: Mutex<Option<oneshot::Sender<()>>>,
    },
}

impl Worker {
    pub(super) fn before_read(&self) {
        match self {
            Self::Fail => panic!("synthetic skill worker failure"),
            Self::Pending {
                started, release, ..
            } => {
                if let Some(started) = started.lock().unwrap().take() {
                    started.send(()).unwrap();
                }
                if let Some(release) = release.lock().unwrap().take() {
                    let _ = release.recv();
                }
            }
        }
    }

    pub(super) fn after_read(&self) {
        if let Self::Pending { finished, .. } = self
            && let Some(finished) = finished.lock().unwrap().take()
        {
            finished.send(()).unwrap();
        }
    }
}

const HEADER: &str = "---\nname: review\ndescription: PRIVATE_METADATA\n---\n";

struct Fixture {
    temp: tempfile::TempDir,
    file: PathBuf,
    catalog: Arc<SkillCatalog>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let roots = ContextRoots {
            workspace: temp.path().join("workspace"),
            global_skills: temp.path().join("global"),
        };
        fs::create_dir(&roots.workspace).unwrap();
        let file = roots.global_skills.join("review/SKILL.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, format!("{HEADER}PRIVATE_BODY")).unwrap();
        let catalog = Arc::new(discover(roots).unwrap());
        Self {
            temp,
            file,
            catalog,
        }
    }

    fn loader(&self) -> SkillLoader {
        SkillLoader::new(self.catalog.clone())
    }
}

fn response(ids: &[&str]) -> ModelResponse {
    ModelResponse {
        id: "response".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output_provenance: Default::default(),
        output: ids
            .iter()
            .map(|id| OutputItem {
                id: Some(format!("item-{id}")),
                kind: ItemKind::FunctionCall,
                native_type: "function_call".into(),
                native: Value::Null,
                function_call: Some(FunctionCall {
                    call_id: (*id).into(),
                    name: "load_skill".into(),
                    arguments: json!({"id":"global:review"}).to_string(),
                    origin: CallOrigin::Direct,
                    namespace: None,
                    complete: true,
                }),
            })
            .collect(),
        text: String::new(),
        usage: None,
        native: Value::Null,
    }
}

fn output(result: &[InputItem]) -> &str {
    let [InputItem::ToolResult { call_id, output }] = result else {
        panic!("expected one result")
    };
    assert_eq!(call_id, "first");
    output
}

#[tokio::test]
async fn direct_validation_is_strict_pure_and_execute_defends_itself() {
    let f = Fixture::new();
    let loader = f.loader();
    fs::remove_file(&f.file).unwrap();
    for arguments in [
        Value::Null,
        json!(1),
        json!("global:review"),
        json!([]),
        json!({}),
        json!({"id":false}),
        json!({"id":null}),
        json!({"id":1}),
        json!({"id":{}}),
        json!({"id":["global:review"]}),
        json!({"name":"global:review"}),
        json!({"id":"global:review","extra":null}),
        json!({"id":"review"}),
        json!({"id":"project:review"}),
        json!({"id":"global:unknown"}),
        json!({"id":"unknown:review"}),
        json!({"id":"/tmp/review"}),
        json!({"id":"./review"}),
        json!({"id":"https://example.invalid/review"}),
        json!({"id":"global:../review"}),
        json!({"id":"global:review/SKILL.md"}),
        json!({"id":"global:UPPER"}),
        json!({"id":"global:review\n"}),
    ] {
        assert!(matches!(
            loader.validate(&arguments),
            Err(GatewayError::InvalidToolArguments)
        ));
        assert!(matches!(
            loader.execute(arguments).await,
            Err(GatewayError::InvalidToolArguments)
        ));
    }
    let valid = json!({"id":"global:review"});
    loader.validate(&valid).unwrap();
    assert!(matches!(
        loader.execute(valid.clone()).await,
        Err(GatewayError::ToolFailed)
    ));
    let debug = format!("{loader:?}");
    for secret in [
        "PRIVATE_METADATA",
        "PRIVATE_BODY",
        f.temp.path().to_str().unwrap(),
    ] {
        assert!(!debug.contains(secret));
    }
    for bytes in [
        b"---\nname: review\ndescription: CHANGED\n---\nBODY".to_vec(),
        b"---\nname: [invalid\n---\nBODY".to_vec(),
        format!("{HEADER} \r\n").into_bytes(),
        [HEADER.as_bytes(), &[0xff]].concat(),
        format!("{HEADER}{}", "x".repeat(MAX_INPUT_BYTES)).into_bytes(),
    ] {
        fs::write(&f.file, bytes).unwrap();
        loader.validate(&valid).unwrap();
        assert!(matches!(
            loader.execute(valid.clone()).await,
            Err(GatewayError::ToolFailed)
        ));
    }
}

#[tokio::test]
async fn worker_join_failure_uses_existing_tool_failed_mapping_and_error_event() {
    let f = Fixture::new();
    let mut loader = f.loader();
    loader.worker = Some(Arc::new(Worker::Fail));
    let error = loader
        .execute(json!({"id":"global:review"}))
        .await
        .unwrap_err();
    assert!(matches!(error, GatewayError::ToolFailed));
    assert_eq!(error.code(), "gateway_error");
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(loader)).unwrap();
    let mut events = Vec::new();
    let results = registry
        .execute_response(&response(&["first"]), |event| {
            events.push(serde_json::to_value(event).unwrap())
        })
        .await
        .unwrap();
    assert_eq!(output(&results), "{\"error\":{\"code\":\"gateway_error\"}}");
    assert_eq!(
        events,
        [
            json!({"type":"tool_execution_started","call_id":"first","tool_name":"load_skill"}),
            json!({"type":"tool_execution_finished","call_id":"first","tool_name":"load_skill","is_error":true}),
        ]
    );
}

#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Cancelled,
    Sink,
    Gateway,
}
impl From<GatewayError> for Stop {
    fn from(_: GatewayError) -> Self {
        Self::Gateway
    }
}

#[tokio::test]
async fn pending_blocking_load_cancel_or_waiter_drop_cannot_publish_or_cache() {
    for mode in ["cancel", "drop"] {
        let f = Fixture::new();
        let (started_tx, mut started_rx) = oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = oneshot::channel();
        let mut loader = f.loader();
        loader.worker = Some(Arc::new(Worker::Pending {
            started: Mutex::new(Some(started_tx)),
            release: Mutex::new(Some(release_rx)),
            finished: Mutex::new(Some(finished_tx)),
        }));
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(loader)).unwrap();
        let mut batch = registry.preflight(&response(&["first", "later"])).unwrap();
        let mut events = Vec::new();
        if mode == "cancel" {
            let result = batch
                .execute_next(
                    || Ok(()),
                    async {
                        started_rx.await.unwrap();
                        Stop::Cancelled
                    },
                    |event| {
                        events.push(event);
                        Ok(())
                    },
                )
                .await;
            assert_eq!(result.unwrap_err(), Stop::Cancelled);
            assert!(
                batch
                    .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap()
                    .is_none()
            );
        } else {
            let mut future = Box::pin(batch.execute_next(
                || Ok(()),
                pending::<Stop>(),
                |event| {
                    events.push(event);
                    Ok(())
                },
            ));
            tokio::select! {
                result = &mut started_rx => result.unwrap(),
                _ = &mut future => panic!("worker must remain pending"),
            }
            drop(future);
        }
        drop(batch);
        release_tx.send(()).unwrap();
        finished_rx.await.unwrap();
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], ToolExecutionEvent::ToolExecutionStarted { call_id, .. } if call_id == "first")
        );
        // A completed abandoned worker cannot save a result into the registry.
        fs::write(&f.file, format!("{HEADER}AFTER_DROP")).unwrap();
        events.clear();
        let result = registry
            .execute_response(&response(&["first"]), |event| events.push(event))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(output(&result)).unwrap()["body"],
            "AFTER_DROP"
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            ToolExecutionEvent::ToolExecutionStarted { .. }
        ));
        assert!(matches!(
            events[1],
            ToolExecutionEvent::ToolExecutionFinished {
                is_error: false,
                ..
            }
        ));
    }
}

#[tokio::test]
async fn cancellation_and_sink_failure_keep_completed_cache_and_stop_later_loads() {
    for mode in ["before", "start", "finish", "between"] {
        let f = Fixture::new();
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(f.loader())).unwrap();
        let mut batch = registry.preflight(&response(&["first", "later"])).unwrap();
        let cancelled = Cell::new(mode == "before");
        let checkpoint = || {
            if cancelled.get() {
                Err(Stop::Cancelled)
            } else {
                Ok(())
            }
        };
        let mut events = Vec::new();
        let result = batch
            .execute_next(checkpoint, pending::<Stop>(), |event| {
                let finished = matches!(event, ToolExecutionEvent::ToolExecutionFinished { .. });
                events.push(event);
                if (mode == "start" && !finished) || (mode == "finish" && finished) {
                    return Err(Stop::Sink);
                }
                if mode == "between" && finished {
                    cancelled.set(true);
                }
                Ok(())
            })
            .await;
        if mode == "between" {
            assert!(result.unwrap().is_some());
            assert_eq!(
                batch
                    .execute_next(checkpoint, pending::<Stop>(), |_| panic!())
                    .await
                    .unwrap_err(),
                Stop::Cancelled
            );
        } else {
            let expected = if mode == "before" {
                Stop::Cancelled
            } else {
                Stop::Sink
            };
            assert_eq!(result.unwrap_err(), expected);
        }
        assert!(
            batch
                .execute_next(|| panic!(), pending::<Stop>(), |_| panic!())
                .await
                .unwrap()
                .is_none()
        );
        drop(batch);
        let completed = mode == "finish" || mode == "between";
        let expected_events = match mode {
            "before" => 0,
            "start" => 1,
            _ => 2,
        };
        assert_eq!(events.len(), expected_events);
        fs::remove_file(&f.file).unwrap();
        events.clear();
        let result = registry
            .execute_response(&response(&["first"]), |event| events.push(event))
            .await
            .unwrap();
        if completed {
            assert_eq!(
                serde_json::from_str::<Value>(output(&result)).unwrap()["body"],
                "PRIVATE_BODY"
            );
            assert_eq!(events.len(), 1);
            assert!(matches!(
                events[0],
                ToolExecutionEvent::ToolResultReused { .. }
            ));
        } else {
            assert_eq!(output(&result), "{\"error\":{\"code\":\"gateway_error\"}}");
            assert_eq!(events.len(), 2);
        }
        events.clear();
        registry
            .execute_response(&response(&["later"]), |event| events.push(event))
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            ToolExecutionEvent::ToolExecutionStarted { .. }
        ));
    }
}
