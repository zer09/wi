//! Private two-run evidence. Identities and raw SQLite snapshots never leave this module.
use super::*;
use crate::{run::RunSummary, storage::AppendRunRecord};
use sqlx::{Column, TypeInfo, ValueRef, sqlite::SqliteRow};

const ACCOUNT_Y: &str = "synthetic-account-y";

pub(super) fn failed(outcome: &RunOutcome) -> bool {
    matches!(outcome, RunOutcome::Failed { code } if code == "history_identity")
}

fn checked<T, E>(value: std::result::Result<T, E>) -> T {
    value.unwrap_or_else(|_| panic!("account-mismatch evidence rejected"))
}

fn identity(token: &str, account: &str) -> ReplayIdentity {
    let credentials = checked(SubscriptionCredentials::from_access_token(
        token.into(),
        Some(account.into()),
        None,
    ));
    checked(crate::providers::openai_codex::replay::identity(
        &credentials,
    ))
}

// Only a close frame or EOF is allowed. Even binary, ping or close-reason bytes fail privately.
fn empty_frame(frame: &Message) -> bool {
    match frame {
        Message::Close(None) => true,
        Message::Text(_) | Message::Binary(_) | Message::Frame(_) => false,
        Message::Ping(bytes) | Message::Pong(bytes) => bytes.is_empty(),
        Message::Close(Some(close)) => close.reason.is_empty(),
    }
}

// Count post-upgrade bytes without retaining them. A truncated frame must not look like an empty EOF.
struct SocketProbe {
    tcp: TcpStream,
    header: usize,
    bytes: Arc<AtomicUsize>,
}
impl tokio::io::AsyncRead for SocketProbe {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = std::pin::Pin::new(&mut self.tcp).poll_read(cx, buf);
        for &byte in &buf.filled()[before..] {
            if self.header == 4 {
                self.bytes.fetch_add(1, Ordering::SeqCst);
            } else if byte == b"\r\n\r\n"[self.header] {
                self.header += 1;
            } else {
                self.header = usize::from(byte == b'\r');
            }
        }
        result
    }
}
impl tokio::io::AsyncWrite for SocketProbe {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.tcp).poll_write(cx, bytes)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.tcp).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.tcp).poll_shutdown(cx)
    }
}

pub(super) async fn socket(tcp: TcpStream) {
    let bytes = Arc::new(AtomicUsize::new(0));
    let probe = SocketProbe {
        tcp,
        header: 0,
        bytes: bytes.clone(),
    };
    // tungstenite fixes the callback's error response type; boxing it would break the signature.
    #[allow(clippy::result_large_err)]
    let mut socket = checked(
        accept_hdr_async(probe, |request: &Request, response: Response| {
            assert!(
                request
                    .headers()
                    .get("authorization")
                    .is_some_and(|value| value == format!("Bearer {TOKEN_B}").as_str())
                    && request
                        .headers()
                        .get("chatgpt-account-id")
                        .is_some_and(|value| value == ACCOUNT_Y),
                "account-mismatch handshake rejected"
            );
            Ok(response)
        })
        .await,
    );
    watch(async {
        let mut consumed = 0;
        while let Some(frame) = socket.next().await {
            match frame {
                Ok(frame) => {
                    assert!(empty_frame(&frame), "account-mismatch payload rejected");
                    // Client control frames are masked: six framing bytes, plus an optional close code.
                    consumed += if matches!(frame, Message::Close(Some(_))) { 8 } else { 6 };
                    if matches!(frame, Message::Close(_)) { break; }
                    checked(socket.flush().await);
                }
                // The production mismatch path may drop the unused socket without a close handshake.
                Err(tokio_tungstenite::tungstenite::Error::Protocol(
                    tokio_tungstenite::tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
                )) => break,
                Err(_) => panic!("account-mismatch socket rejected"),
            }
        }
        assert!(bytes.load(Ordering::SeqCst) == consumed, "account-mismatch partial payload rejected");
    }).await;
}

#[derive(Clone, PartialEq)]
struct Snapshot {
    events: Vec<Value>,
    commands: Vec<Value>,
    runs: Vec<Value>,
    tools: Vec<Value>,
    manifest: Vec<Value>,
}

fn rows(rows: Vec<SqliteRow>) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut value = serde_json::Map::new();
            for column in row.columns() {
                let raw = checked(row.try_get_raw(column.ordinal()));
                let field = if raw.is_null() {
                    Value::Null
                } else {
                    match raw.type_info().name() {
                        "INTEGER" => json!(checked(row.try_get::<i64, _>(column.ordinal()))),
                        "TEXT" => json!(checked(row.try_get::<String, _>(column.ordinal()))),
                        "BLOB" => json!(checked(row.try_get::<Vec<u8>, _>(column.ordinal()))),
                        _ => panic!("account-mismatch column rejected"),
                    }
                };
                value.insert(column.name().into(), field);
            }
            Value::Object(value)
        })
        .collect()
}

async fn snapshot(db: &Database) -> Snapshot {
    let mut reader = db.reader.lock().await;
    let mut sql = checked(
        reader
            .as_mut()
            .expect("account-mismatch reader missing")
            .begin()
            .await,
    );
    let result = Snapshot {
        events: rows(checked(
            sqlx::query("SELECT * FROM events ORDER BY sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        commands: rows(checked(
            sqlx::query("SELECT * FROM commands ORDER BY first_sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        runs: rows(checked(
            sqlx::query("SELECT * FROM runs ORDER BY accepted_sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        tools: rows(checked(
            sqlx::query("SELECT * FROM tool_results ORDER BY started_sequence")
                .fetch_all(&mut *sql)
                .await,
        )),
        manifest: rows(checked(
            sqlx::query("SELECT * FROM manifest")
                .fetch_all(&mut *sql)
                .await,
        )),
    };
    checked(sql.rollback().await);
    result
}

fn prefix_digest(events: &[Value]) -> String {
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    digest.update(b"wi.history-prefix.v1\0");
    for row in events {
        let bytes = json!({"sequence":row["sequence"],"event_id":row["event_id"],"event_type":row["event_type"],
            "event_version":row["event_version"],"created_at_ms":row["created_at_ms"],"run_id":row["run_id"],
            "source_event_id":row["source_event_id"],"source_sequence":row["source_sequence"],
            "payload":checked(serde_json::from_str::<Value>(row["payload_json"].as_str().unwrap()))}).to_string();
        digest.update(&(bytes.len() as u64).to_be_bytes());
        digest.update(bytes.as_bytes());
    }
    digest
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Default)]
pub(super) struct Gate {
    pub(super) armed: bool,
    baseline: Option<Snapshot>,
}

impl Gate {
    pub(super) fn check_control(&self, control: &Control) {
        if self.armed {
            assert!(
                matches!(
                    control,
                    Control::Inspect { .. } | Control::InspectTask { .. } | Control::Stop { .. }
                ),
                "account-mismatch control rejected"
            );
        }
    }

    pub(super) async fn capture(&mut self, db: &Database) {
        let state = snapshot(db).await;
        let records = db.records().await;
        let views: Vec<Value> = records
            .iter()
            .map(|record| {
                checked(serde_json::to_value(crate::http_api::dto::EventView::from(
                    record,
                )))
            })
            .collect();
        let kinds: Vec<_> = views
            .iter()
            .map(|view| view["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds
                == [
                    "session.created",
                    "run.accepted",
                    "checkpoint",
                    "run.started",
                    "checkpoint",
                    "turn.started",
                    "response.started",
                    "response.finished",
                    "tool.started",
                    "tool.result",
                    "tool.finished",
                    "turn.finished",
                    "turn.started",
                    "response.started",
                    "response.item.started",
                    "response.delta",
                    "response.finished",
                    "turn.finished",
                    "run.finished",
                    "run.result"
                ],
            "account-mismatch first sequence rejected"
        );
        let StoredEventPayload::RunAccepted(accepted) = records[1].payload() else {
            panic!("account-mismatch acceptance missing")
        };
        let StoredEventPayload::RunProviderBound(binding) = records[4].payload() else {
            panic!("account-mismatch binding missing")
        };
        let responses: Vec<_> = records
            .iter()
            .filter_map(|record| match record.payload() {
                StoredEventPayload::RuntimeObserved(runtime) => match &runtime.event {
                    RunEvent::ProviderEvent { event } => match &event.event {
                        ProviderEvent::ResponseFinished { response } => Some(response.clone()),
                        _ => None,
                    },
                    _ => None,
                },
                _ => None,
            })
            .collect();
        let StoredEventPayload::RunResultRecorded(result) = records.last().unwrap().payload()
        else {
            panic!("account-mismatch result missing")
        };
        assert!(
            responses.len() == 2
                && binding.identity() == &identity(TOKEN_A, ACCOUNT)
                && responses[1].text == ANSWERS[0]
                && result.outcome == RunOutcome::Completed
                && result.events_complete
                && result.sink_error.is_none()
                && result.summary.model_requests_attempted == 2
                && result.summary.model_requests_admitted == 2
                && result.summary.new_tool_dispatches == 1
                && result.summary.tool_results_prepared == 1
                && state.tools.len() == 1
                && state.tools[0]["output"] == OUTPUTS[0]
                && state.tools[0]["is_error"] == 0,
            "account-mismatch first history rejected"
        );
        let StoredEventPayload::RuntimeObserved(tool_start) = records[8].payload() else {
            unreachable!()
        };
        let StoredEventPayload::ToolResultRecorded(tool_result) = records[9].payload() else {
            unreachable!()
        };
        assert!(
            tool_result.call_id() == "add-雪"
                && tool_result.request_id() == tool_start.request_id.as_deref()
                && tool_result.output() == OUTPUTS[0]
                && !tool_result.is_error(),
            "account-mismatch first tool rejected"
        );
        let expected_tool = json!({"run_id":accepted.run_id(),"call_id":"add-雪","tool_name":"add_numbers",
            "request_id":tool_start.request_id,"started_sequence":9,"finished_sequence":11,"result_sequence":10,
            "is_error":0,"output":OUTPUTS[0]});
        assert!(
            state.tools == vec![expected_tool]
                && result.summary.turns_started == 2
                && result.summary.turns_finished == 2
                && result.summary.reused_results == 0
                && result.summary.last_request_id.is_some()
                && result.summary.last_upstream_outcome
                    == Some(crate::UpstreamOutcome::TerminalReceived)
                && checked(serde_json::to_value(&result.last_response))
                    == checked(serde_json::to_value(Some(&responses[1])))
                && views[18]["data"]["summary"] == views[19]["data"]["summary"],
            "account-mismatch first result rejected"
        );
        let replay = checked(ConversationReplay::new(
            PROVIDER_ID.into(),
            MODEL.into(),
            Some(binding.identity().clone()),
            vec![checked(ReplayRun::new(
                accepted.run_id().to_string(),
                accepted.input().prepared_request().prompt.clone(),
                vec![
                    checked(ReplayExchange::new(
                        responses[0].clone(),
                        vec![crate::InputItem::ToolResult {
                            call_id: tool_result.call_id().into(),
                            output: tool_result.output().into(),
                        }],
                    )),
                    checked(ReplayExchange::new(responses[1].clone(), vec![])),
                ],
            ))],
        ));
        // Compile actual persisted native exchanges without opening a provider or installing replay.
        let compiled = checked(crate::providers::openai_codex::replay::compile(
            &accepted.input().prepared_request().options,
            &replay,
        ));
        assert!(compiled.len() == 4, "account-mismatch replay rejected");
        if let Some(previous) = &self.baseline {
            assert!(*previous == state, "account-mismatch first history changed");
        } else {
            self.baseline = Some(state);
        }
    }

    pub(super) async fn arm(
        &mut self,
        db: &Database,
        proof: &Mutex<Proof>,
        auth: &CountedAuth,
        compatible: bool,
    ) {
        assert!(
            compatible && !self.armed && self.baseline.is_some(),
            "account-mismatch control rejected"
        );
        assert!(
            self.baseline.as_ref() == Some(&snapshot(db).await),
            "account-mismatch history changed"
        );
        let mut p = proof.lock().unwrap();
        assert!(
            p.completed == 1
                && p.requests == 2
                && p.connections == 1
                && p.prepared_exact == 2
                && p.fresh_empty
                && !p.restored_history
                && p.fresh_parents == 1
                && p.continuations == 1
                && p.gate.is_none()
                && p.provider_stage == Some("finished")
                && !p.provider_failed
                && auth.loads.load(Ordering::SeqCst) == 1
                && auth.prepares.load(Ordering::SeqCst) == 1
                && *auth.current.lock().unwrap() == (TOKEN_A, ACCOUNT),
            "account-mismatch control rejected"
        );
        auth.rotate(TOKEN_B, ACCOUNT_Y);
        p.mismatch_armed = true;
        self.armed = true;
    }

    pub(super) async fn inspect(
        &self,
        db: &Database,
        id: u32,
        proof: &Mutex<Proof>,
        auth: &CountedAuth,
    ) -> Value {
        let state = snapshot(db).await;
        let records = db.records().await;
        let receipt = audit(self.baseline.as_ref().unwrap(), &state, &records);
        let p = proof.lock().unwrap();
        assert!(
            p.mismatch_closed
                && !p.provider_failed
                && p.connections == 2
                && p.requests == 2
                && p.completed == 1
                && p.prepared_exact == 2
                && p.fresh_parents == 1
                && p.continuations == 1
                && !p.restored_history
                && p.gate.is_none()
                && p.provider_stage == Some("finished")
                && auth.loads.load(Ordering::SeqCst) == 2
                && auth.prepares.load(Ordering::SeqCst) == 2
                && *auth.current.lock().unwrap() == (TOKEN_B, ACCOUNT_Y),
            "account-mismatch work rejected"
        );
        json!({"id":id,"event":"account_mismatch_inspect","exact":true,"receipt":receipt,
            "first_head":self.baseline.as_ref().unwrap().events.len().to_string(),"sequence_count":records.len().to_string(),
            "second_records":6,"run_state":"failed","code":"history_identity","result_recorded":true,
            "history_unchanged":true,"identity_checked":true,"socket_closed":true,"seed_head":"1"})
    }
}

fn append(record: &StoredEvent) -> AppendRunRecord {
    match record.payload() {
        StoredEventPayload::RunProviderBound(binding) => {
            AppendRunRecord::ProviderBinding(binding.clone())
        }
        StoredEventPayload::RuntimeObserved(runtime) => AppendRunRecord::Runtime(runtime.clone()),
        StoredEventPayload::RunResultRecorded(result) => AppendRunRecord::Result(result.clone()),
        _ => panic!("account-mismatch append rejected"),
    }
}

fn audit(base: &Snapshot, state: &Snapshot, records: &[StoredEvent]) -> Value {
    let head = base.events.len();
    assert!(
        state.events.len() == head + 6
            && records.len() == head + 6
            && state.events[..head] == base.events
            && state.tools == base.tools
            && state.runs.len() == 2
            && state.runs[0] == base.runs[0]
            && state.commands.len() > base.commands.len()
            && state.commands[..base.commands.len()] == base.commands,
        "account-mismatch prefix rejected"
    );
    let second = &records[head..];
    let kinds: Vec<_> = second.iter().map(StoredEvent::event_type).collect();
    assert!(
        kinds
            == [
                "run.accepted",
                "run.history.selected",
                "runtime.observed",
                "run.provider.bound",
                "runtime.observed",
                "run.result.recorded"
            ],
        "account-mismatch sequence rejected"
    );
    let StoredEventPayload::RunAccepted(accepted) = second[0].payload() else {
        unreachable!()
    };
    let StoredEventPayload::RunHistorySelected(selected) = second[1].payload() else {
        unreachable!()
    };
    let StoredEventPayload::RunProviderBound(binding) = second[3].payload() else {
        unreachable!()
    };
    let StoredEventPayload::RunResultRecorded(result) = second[5].payload() else {
        unreachable!()
    };
    let StoredEventPayload::RuntimeObserved(started) = second[2].payload() else {
        unreachable!()
    };
    let StoredEventPayload::RuntimeObserved(finished) = second[4].payload() else {
        unreachable!()
    };
    let run = accepted.run_id();
    let sid = records[0].application_session_id();
    let selection = selected.selection();
    let zero = checked(serde_json::to_value(RunSummary::default()));
    assert!(
        accepted.input().user_text() == TASKS[1]
            && checked(serde_json::from_str::<Value>(
                &accepted.input().prepared_request().prompt
            ))["task"]
                == TASKS[1]
            && accepted.input().prepared_request().provider_id == PROVIDER_ID
            && accepted.input().prepared_request().options.model == MODEL
            && selected.run_id() == run
            && selection.through_sequence() == head as u64
            && selection.policy() == "closed-exchanges-v1"
            && selection.history_digest() == prefix_digest(&base.events)
            && selection.provider_id() == PROVIDER_ID
            && selection.requested_model() == MODEL
            && selection.expected_identity() == Some(&identity(TOKEN_A, ACCOUNT))
            && binding.run_id() == run
            && binding.requested_model() == MODEL
            && binding.identity() == &identity(TOKEN_B, ACCOUNT_Y)
            && selection.expected_identity() != Some(binding.identity())
            && matches!(started.event, RunEvent::RunStarted)
            && started.sequence == 1
            && started.session_id.is_none()
            && finished.sequence == 2
            && finished.session_id.as_deref() == Some(binding.provider_session_id())
            && matches!(&finished.event, RunEvent::RunFinished { outcome, summary } if failed(outcome) && checked(serde_json::to_value(summary)) == zero)
            && result.run_id == run.as_str()
            && result.session_id.as_deref() == Some(binding.provider_session_id())
            && failed(&result.outcome)
            && checked(serde_json::to_value(&result.summary)) == zero
            && result.last_response.is_none()
            && result.events_complete
            && result.sink_error.is_none(),
        "account-mismatch run rejected"
    );
    let mut expected_manifest = base.manifest.clone();
    expected_manifest[0]["head_sequence"] = json!(head + 6);
    expected_manifest[0]["updated_at_ms"] = json!(second[5].created_at_ms());
    assert!(
        state.manifest == expected_manifest,
        "account-mismatch manifest rejected"
    );
    let mut ids = std::collections::HashSet::new();
    for (index, (record, row)) in records.iter().zip(&state.events).enumerate() {
        assert!(
            record.sequence() == (index + 1) as u64
                && ids.insert(record.event_id())
                && row["sequence"] == (index + 1) as u64,
            "account-mismatch envelope rejected"
        );
        if index < head {
            continue;
        }
        let serialized = checked(serde_json::to_value(record));
        assert!(
            record.run_id() == Some(run)
                && row["run_id"] == run.as_str()
                && row["event_id"] == record.event_id().as_str()
                && row["event_type"] == record.event_type()
                && row["event_version"] == record.event_version()
                && row["created_at_ms"] == record.created_at_ms()
                && checked(serde_json::from_str::<Value>(
                    row["payload_json"].as_str().unwrap()
                )) == serialized["payload"],
            "account-mismatch run identity rejected"
        );
        if let StoredEventPayload::RuntimeObserved(runtime) = record.payload() {
            assert!(
                row["source_event_id"] == runtime.event_id
                    && row["source_sequence"] == runtime.sequence
                    && runtime.run_id == run.as_str()
                    && runtime.request_id.is_none()
                    && runtime.turn_id.is_none(),
                "account-mismatch runtime rejected"
            );
        } else {
            assert!(
                row["source_event_id"].is_null() && row["source_sequence"].is_null(),
                "account-mismatch source rejected"
            );
        }
    }
    let saved = &state.runs[1];
    assert!(
        saved["run_id"] == run.as_str()
            && saved["owner_instance_id"] == accepted.owner_instance_id().as_str()
            && saved["accepted_sequence"] == head + 1
            && saved["state"] == "failed"
            && saved["last_runtime_sequence"] == 2
            && saved["provider_session_id"] == binding.provider_session_id()
            && saved["terminal_sequence"] == head + 5
            && saved["result_sequence"] == head + 6
            && checked(serde_json::from_str::<Value>(
                saved["terminal_json"].as_str().unwrap()
            )) == checked(serde_json::to_value(finished))
            && state.manifest.len() == 1
            && state.manifest[0]["head_sequence"] == head + 6
            && state.manifest[0]["updated_at_ms"] == second[5].created_at_ms(),
        "account-mismatch projection rejected"
    );
    let mut last = head;
    let mut receipt = None;
    let mut operations = std::collections::HashSet::new();
    for command in &state.commands {
        assert!(
            operations.insert(command["operation_id"].as_str()),
            "account-mismatch duplicate command"
        );
    }
    for command in &state.commands[base.commands.len()..] {
        let stored: crate::storage::CommitReceipt = checked(serde_json::from_str(
            command["receipt_json"].as_str().unwrap(),
        ));
        assert!(
            stored.session_id() == sid
                && stored.run_id() == Some(run)
                && command["operation_id"] == stored.operation_id().as_str()
                && stored.first_sequence() == (last + 1) as u64
                && stored.last_sequence() >= stored.first_sequence()
                && stored.last_sequence() <= records.len() as u64
                && command["first_sequence"] == stored.first_sequence()
                && command["last_sequence"] == stored.last_sequence(),
            "account-mismatch receipt rejected"
        );
        let batch = &records[last..stored.last_sequence() as usize];
        assert!(
            batch
                .iter()
                .all(|event| event.created_at_ms() == batch[0].created_at_ms()),
            "account-mismatch timestamp rejected"
        );
        let canonical = if last == head {
            assert!(
                command["method"] == "accept_history_run"
                    && stored.last_sequence() == (head + 2) as u64,
                "account-mismatch acceptance rejected"
            );
            receipt = Some(json!(crate::http_api::dto::ReceiptView::from(&stored)));
            json!({"session_id":sid,"run_id":run,"method":"accept_history_run","input":accepted.input(),"selection":selection})
        } else {
            assert!(
                command["method"] == "append_run_records",
                "account-mismatch extra command"
            );
            json!({"session_id":sid,"run_id":run,"method":"append_run_records","records":batch.iter().map(append).collect::<Vec<_>>()})
        };
        let hash = ring::digest::digest(&ring::digest::SHA256, canonical.to_string().as_bytes());
        assert!(
            command["payload_hash"] == json!(hash.as_ref()),
            "account-mismatch command bytes rejected"
        );
        last = stored.last_sequence() as usize;
    }
    assert!(
        last == records.len(),
        "account-mismatch command coverage rejected"
    );
    receipt.unwrap()
}

#[cfg(test)]
#[path = "account_mismatch/tests.rs"]
mod tests;
