#[path = "run_cli_context_tests.rs"]
mod context;

use super::*;
use crate::cli::presentation_tests::{Captured, FRAGMENTS, GOLDEN};
use async_trait::async_trait;
use clap::Parser;
use serde_json::{Value, json};
use std::{
    future::pending,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use wi::*;

#[derive(Default)]
struct Records {
    opens: AtomicUsize,
    generates: AtomicUsize,
    closes: AtomicUsize,
    provider_events: AtomicUsize,
    options: Mutex<Vec<SessionOptions>>,
    inputs: Mutex<Vec<Vec<InputItem>>>,
    entered: tokio::sync::Notify,
}
struct Fake {
    records: Arc<Records>,
    response: ModelResponse,
    pending: bool,
    deltas: Vec<(DeltaKind, String)>,
}
struct Control {
    records: Arc<Records>,
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        self.records.inputs.lock().unwrap().push(input);
        self.records.generates.fetch_add(1, Ordering::SeqCst);
        self.records.entered.notify_one();
        Ok(RequestReceipt {
            request_id: "q".into(),
        })
    }
    fn close(&self) {
        self.records.closes.fetch_add(1, Ordering::SeqCst);
    }
}
#[async_trait]
impl Provider for Fake {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "offline fake".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        self.records.opens.fetch_add(1, Ordering::SeqCst);
        self.records.options.lock().unwrap().push(options);
        let mut events = vec![ProviderEvent::ResponseStarted {
            response_id: "r".into(),
        }];
        events.extend(self.deltas.iter().map(|(kind, text)| delta(*kind, text)));
        events.push(ProviderEvent::ResponseFinished {
            response: self.response.clone(),
        });
        let wait = self.pending;
        let records = self.records.clone();
        let events = Box::pin(async_stream::stream! {
            if wait { pending::<()>().await; }
            for (i, event) in events.into_iter().enumerate() {
                records.provider_events.fetch_add(1, Ordering::SeqCst);
                yield EventEnvelope { schema_version: 1, sequence: i as u64 + 1, event_id: format!("e{i}"), session_id: "s".into(), request_id: Some("q".into()), provider: PROVIDER_ID.into(), provider_sequence: None, event };
            }
        });
        Ok(ProviderSession {
            id: "s".into(),
            control: Arc::new(Control {
                records: self.records.clone(),
            }),
            events,
        })
    }
}
fn args(extra: &[&str]) -> RunArgs {
    let cli = crate::cli::Cli::try_parse_from(
        ["wi", "run", "--model", "synthetic", "--prompt", "hello"]
            .into_iter()
            .chain(extra.iter().copied()),
    )
    .unwrap();
    let crate::cli::Command::Run(args) = cli.command else {
        panic!()
    };
    args
}
fn response() -> ModelResponse {
    ModelResponse {
        id: "r".into(),
        model: None,
        outcome: ResponseOutcome::Completed,
        output: vec![],
        text: "final\x1b\r\x07\u{009b}".into(),
        usage: None,
        native: json!({"other_plugin_opaque":true}),
        output_provenance: Default::default(),
    }
}
fn setup(response: ModelResponse, wait: bool) -> (Gateway, Arc<Records>) {
    setup_with_deltas(
        response,
        wait,
        vec![(DeltaKind::Text, "partial\x1b\r\x07\u{009b}".into())],
    )
}
fn setup_with_deltas(
    response: ModelResponse,
    wait: bool,
    deltas: Vec<(DeltaKind, String)>,
) -> (Gateway, Arc<Records>) {
    let records = Arc::new(Records::default());
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(Fake {
            records: records.clone(),
            response,
            pending: wait,
            deltas,
        }))
        .unwrap();
    (gateway, records)
}
fn count(n: &AtomicUsize) -> usize {
    n.load(Ordering::SeqCst)
}

// Each handler test supplies empty synthetic roots, regardless of the owner's cwd/env.
async fn handle<R, W, S, B>(
    args: RunArgs,
    input: R,
    build: B,
    output: &mut W,
    signal: S,
) -> CliResult<RunResult>
where
    R: AsyncRead + Unpin,
    W: Write,
    S: Future<Output = std::io::Result<()>>,
    B: FnOnce(&crate::cli::AuthArgs) -> Result<Gateway>,
{
    let temp = tempfile::tempdir().unwrap();
    let roots = ContextRoots {
        workspace: temp.path().to_owned(),
        global_skills: temp.path().join("missing-global"),
    };
    super::handle(
        args,
        input,
        build,
        output,
        signal,
        move |_| Ok(roots),
        &mut Vec::new(),
    )
    .await
}

fn delta(kind: DeltaKind, text: &str) -> ProviderEvent {
    ProviderEvent::OutputItemUpdated {
        response_id: "r".into(),
        item_id: "m".into(),
        output_index: 0,
        content_index: Some(0),
        summary_index: None,
        kind,
        delta: text.into(),
    }
}
fn outer(event: RunEvent) -> RunEventEnvelope {
    RunEventEnvelope {
        schema_version: 2,
        sequence: 1,
        event_id: "event".into(),
        run_id: "run".into(),
        turn_id: Some("turn".into()),
        session_id: Some("s".into()),
        request_id: Some("q".into()),
        event,
    }
}
fn nested(event: ProviderEvent) -> RunEventEnvelope {
    outer(RunEvent::ProviderEvent {
        event: Box::new(EventEnvelope {
            schema_version: 1,
            sequence: 1,
            event_id: "provider-event".into(),
            session_id: "s".into(),
            request_id: Some("q".into()),
            provider: PROVIDER_ID.into(),
            provider_sequence: None,
            event,
        }),
    })
}

#[test]
fn r1_a02_run_render_multiline_golden_and_raw_json() {
    for &(raw, plain) in GOLDEN {
        let mut events = vec![
            (
                delta(DeltaKind::Text, raw),
                format!("[Provisional text] {plain}\n"),
            ),
            (
                delta(DeltaKind::Refusal, raw),
                format!("[Provisional text] {plain}\n"),
            ),
        ];
        for (outcome, status) in [
            (ResponseOutcome::Completed, "completed"),
            (
                ResponseOutcome::Incomplete {
                    reason: Some("not displayed\x1b".into()),
                },
                "incomplete",
            ),
            (ResponseOutcome::Failed, "failed"),
            (ResponseOutcome::Cancelled, "cancelled"),
        ] {
            let mut response = response();
            response.outcome = outcome;
            response.text = raw.into();
            response.native = json!({"opaque": raw});
            events.push((
                ProviderEvent::ResponseFinished { response },
                format!("[Authoritative validated final response; {status}]\n{plain}\n"),
            ));
        }
        for (event, expected) in events {
            let envelope = nested(event);
            let original = serde_json::to_value(&envelope).unwrap();
            for json in [false, true] {
                let mut out = Captured::default();
                render(&mut out, json, &envelope).unwrap();
                assert_eq!(out.flushes, 1);
                assert_eq!(serde_json::to_value(&envelope).unwrap(), original);
                if json {
                    let text = String::from_utf8(out.bytes).unwrap();
                    assert_eq!(text.lines().count(), 1);
                    let decoded: RunEventEnvelope = serde_json::from_str(&text).unwrap();
                    assert_eq!(serde_json::to_value(decoded).unwrap(), original);
                } else {
                    assert_eq!(
                        String::from_utf8(out.bytes).unwrap(),
                        expected,
                        "A-02 raw {raw:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn r1_a02_run_render_split_sequences_match_whole_bodies_and_keep_run_labels() {
    let raw: String = FRAGMENTS.iter().map(|(raw, _)| *raw).collect();
    let plain: String = FRAGMENTS.iter().map(|(_, plain)| *plain).collect();
    for kind in [DeltaKind::Text, DeltaKind::Refusal] {
        let mut split_body = String::new();
        for &(raw, expected) in FRAGMENTS {
            let mut out = Captured::default();
            render(&mut out, false, &nested(delta(kind, raw))).unwrap();
            let text = String::from_utf8(out.bytes).unwrap();
            assert_eq!(text, format!("[Provisional text] {expected}\n"));
            split_body.push_str(
                text.strip_prefix("[Provisional text] ")
                    .unwrap()
                    .strip_suffix('\n')
                    .unwrap(),
            );
        }
        let mut whole = Vec::new();
        render(&mut whole, false, &nested(delta(kind, &raw))).unwrap();
        assert_eq!(
            String::from_utf8(whole).unwrap(),
            format!("[Provisional text] {split_body}\n")
        );
        assert_eq!(split_body, plain);
        let mut response = response();
        response.text = raw.clone();
        let mut final_out = Vec::new();
        render(
            &mut final_out,
            false,
            &nested(ProviderEvent::ResponseFinished { response }),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(final_out).unwrap(),
            format!("[Authoritative validated final response; completed]\n{split_body}\n")
        );
    }
    for (outcome, label) in [
        (RunOutcome::Completed, "Completed"),
        (RunOutcome::CancelledLocally, "Cancelled locally"),
        (
            RunOutcome::Failed {
                code: "not displayed\x1b".into(),
            },
            "Failed",
        ),
    ] {
        let mut out = Captured::default();
        render(
            &mut out,
            false,
            &outer(RunEvent::RunFinished {
                outcome,
                summary: Default::default(),
            }),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(out.bytes).unwrap(),
            format!("[Run: {label}]\n")
        );
        assert_eq!(out.flushes, 1);
    }
}

#[tokio::test]
async fn r1_a02_run_handler_multiline_outcomes_and_json_are_unmodified() {
    let raw = "first\r\n\tsecond\n```rust\n\tlet x = \"雪\";\n```\n\x1b[0m\x07\0\r\x7f\u{009b}";
    let plain = "first\n\tsecond\n```rust\n\tlet x = \"雪\";\n```\n[0m";
    let deltas: Vec<_> = FRAGMENTS
        .iter()
        .enumerate()
        .map(|(i, (raw, _))| {
            (
                if i % 2 == 0 {
                    DeltaKind::Text
                } else {
                    DeltaKind::Refusal
                },
                (*raw).to_string(),
            )
        })
        .collect();
    for (outcome, status, label, code) in [
        (ResponseOutcome::Completed, "completed", "Completed", 0),
        (
            ResponseOutcome::Incomplete {
                reason: Some("not displayed\x1b".into()),
            },
            "incomplete",
            "Failed",
            1,
        ),
        (ResponseOutcome::Failed, "failed", "Failed", 1),
        (ResponseOutcome::Cancelled, "cancelled", "Failed", 1),
    ] {
        for json in [false, true] {
            let mut response = response();
            response.outcome = outcome.clone();
            response.text = raw.into();
            response.native = json!({"opaque": {"text": raw}});
            response.output.push(OutputItem {
                id: Some("m".into()),
                kind: ItemKind::Message,
                native_type: "message".into(),
                native: json!({"content":[{"type":"output_text","text":raw}]}),
                function_call: None,
            });
            let original = serde_json::to_value(&response).unwrap();
            let (gateway, records) = setup_with_deltas(response, false, deltas.clone());
            let mut a = args(&[]);
            a.base.json = json;
            a.prompt = Some(raw.into());
            let mut out = Captured::default();
            let result = handle(a, &b""[..], |_| Ok(gateway), &mut out, pending())
                .await
                .unwrap();
            assert_eq!(exit_code(&result), code);
            assert!(result.events_complete);
            assert_eq!(result.sink_error, None);
            assert_eq!(
                serde_json::to_value(result.last_response.as_ref().unwrap()).unwrap(),
                original
            );
            assert_eq!(count(&records.opens), 1);
            assert_eq!(count(&records.generates), 1);
            assert_eq!(count(&records.closes), 1);
            assert_eq!(count(&records.provider_events), deltas.len() + 2);
            assert_eq!(result.summary.new_tool_dispatches, 0);
            assert!(
                matches!(&records.inputs.lock().unwrap()[0][..], [InputItem::User { text }] if text == raw)
            );
            assert_eq!(out.flushes, deltas.len() + 6);
            let text = String::from_utf8(out.bytes).unwrap();
            if json {
                let events: Vec<RunEventEnvelope> = text
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect();
                assert_eq!(events.len(), out.flushes);
                let mut decoded_deltas = Vec::new();
                let mut terminal_count = 0;
                for event in events {
                    if let RunEvent::ProviderEvent { event } = event.event {
                        match event.event {
                            ProviderEvent::OutputItemUpdated { kind, delta, .. } => {
                                decoded_deltas.push((kind, delta))
                            }
                            ProviderEvent::ResponseFinished { response } => {
                                assert_eq!(serde_json::to_value(response).unwrap(), original);
                                terminal_count += 1;
                            }
                            _ => {}
                        }
                    }
                }
                assert_eq!(decoded_deltas, deltas);
                assert_eq!(terminal_count, 1);
            } else {
                let provisional: String = FRAGMENTS
                    .iter()
                    .map(|(_, plain)| format!("[Provisional text] {plain}\n"))
                    .collect();
                assert_eq!(
                    text,
                    format!(
                        "{provisional}[Authoritative validated final response; {status}]\n{plain}\n[Run: {label}]\n"
                    )
                );
            }
        }
    }
}

#[tokio::test]
async fn r1_a02_run_sink_failures_stop_work_and_keep_exit_precedence() {
    for (kind, expected) in [
        (std::io::ErrorKind::BrokenPipe, RunSinkError::Closed),
        (std::io::ErrorKind::NotConnected, RunSinkError::Closed),
        (std::io::ErrorKind::WouldBlock, RunSinkError::Full),
        (std::io::ErrorKind::Other, RunSinkError::Failed),
    ] {
        for json in [false, true] {
            for on_flush in [false, true] {
                for final_only in [false, true] {
                    let mut response = response();
                    if !final_only {
                        response.output.push(OutputItem {
                            id: Some("call-item".into()),
                            kind: ItemKind::FunctionCall,
                            native_type: "function_call".into(),
                            native: Value::Null,
                            function_call: Some(FunctionCall {
                                call_id: "call".into(),
                                name: "add_numbers".into(),
                                arguments: "{\"a\":17,\"b\":25}".into(),
                                origin: CallOrigin::Direct,
                                namespace: None,
                                complete: true,
                            }),
                        });
                    }
                    let (gateway, records) = setup(response, false);
                    let mut out = Broken {
                        kind,
                        final_only,
                        on_flush,
                        final_seen: false,
                        writes_after_failure: 0,
                        flushes_after_failure: 0,
                        failed: false,
                    };
                    let mut a = args(&["--tool", "add_numbers"]);
                    a.base.json = json;
                    let result = handle(a, &b""[..], |_| Ok(gateway), &mut out, pending())
                        .await
                        .unwrap();
                    assert_eq!(result.sink_error, Some(expected));
                    assert_eq!(exit_code(&result), 1);
                    assert!(!result.events_complete);
                    assert_eq!(out.writes_after_failure, 0);
                    assert_eq!(out.flushes_after_failure, 0);
                    let entered = usize::from(final_only || (!json && !on_flush));
                    assert_eq!(count(&records.opens), entered);
                    assert_eq!(count(&records.generates), entered);
                    assert_eq!(count(&records.closes), entered);
                    let events = if final_only { 3 } else { entered * 2 };
                    assert_eq!(count(&records.provider_events), events);
                    assert_eq!(result.summary.new_tool_dispatches, 0);
                    if final_only {
                        assert_eq!(result.outcome, RunOutcome::Completed);
                    } else {
                        assert_eq!(
                            result.outcome,
                            RunOutcome::Failed {
                                code: "event_sink".into()
                            }
                        );
                        assert!(result.last_response.is_none());
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn r1_a02_run_plain_cancellation_label_and_final_sink_precedence() {
    for failure in [None, Some(std::io::ErrorKind::BrokenPipe)] {
        let (gateway, records) = setup(response(), true);
        let signal_records = records.clone();
        let signal = async move {
            signal_records.entered.notified().await;
            Ok(())
        };
        let mut out = Captured::default();
        let result = if let Some(kind) = failure {
            let mut broken = Broken {
                kind,
                final_only: true,
                on_flush: false,
                final_seen: false,
                writes_after_failure: 0,
                flushes_after_failure: 0,
                failed: false,
            };
            let result = handle(args(&[]), &b""[..], |_| Ok(gateway), &mut broken, signal)
                .await
                .unwrap();
            assert_eq!(broken.writes_after_failure, 0);
            assert_eq!(broken.flushes_after_failure, 0);
            assert_eq!(result.sink_error, Some(RunSinkError::Closed));
            assert!(!result.events_complete);
            assert_eq!(exit_code(&result), 1);
            result
        } else {
            let result = handle(args(&[]), &b""[..], |_| Ok(gateway), &mut out, signal)
                .await
                .unwrap();
            assert_eq!(
                String::from_utf8(out.bytes).unwrap(),
                "[Run: Cancelled locally]\n"
            );
            assert_eq!(exit_code(&result), 130);
            assert!(result.events_complete);
            result
        };
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert_eq!(count(&records.generates), 1);
        assert_eq!(count(&records.closes), 1);
        assert_eq!(count(&records.provider_events), 0);
    }
}

#[tokio::test]
async fn run_cli_real_handler_json_outer_only_defaults_and_opt_in_tools() {
    for selected in [false, true] {
        let mut a = args(&["--json"]);
        if selected {
            a.tool.push(ToolArg::AddNumbers);
        }
        let (gateway, records) = setup(response(), false);
        let mut out = Vec::new();
        let result = handle(a, &b""[..], |_| Ok(gateway), &mut out, pending())
            .await
            .unwrap();
        assert_eq!(exit_code(&result), 0);
        assert_eq!(count(&records.opens), 1);
        assert_eq!(count(&records.generates), 1);
        assert_eq!(count(&records.closes), 1);
        assert!(
            matches!(&records.inputs.lock().unwrap()[0][..], [InputItem::User { text }] if text == "hello")
        );
        let opts = records.options.lock().unwrap();
        assert_eq!(opts[0].tools.len(), usize::from(selected));
        assert_eq!(opts[0].instructions, "You are a helpful assistant.");
        assert_eq!(opts[0].transport, Transport::WebSocket);
        let events: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| {
                let _: RunEventEnvelope = serde_json::from_str(line).unwrap();
                serde_json::from_str(line).unwrap()
            })
            .collect();
        assert_eq!(events[0]["type"], "run_started");
        assert_eq!(events[0].as_object().unwrap().len(), 8);
        assert!(events[0].get("limits").is_none());
        assert_eq!(events.last().unwrap()["type"], "run_finished");
        for (i, event) in events.iter().enumerate() {
            assert_eq!(event["schema_version"], 2);
            if event["type"] == "provider_event" {
                assert_eq!(event["event"]["schema_version"], 1);
            }
            assert_eq!(event["sequence"], i + 1);
            assert!(event["run_id"].is_string());
        }
    }
}

#[tokio::test]
async fn run_cli_plain_filters_controls_labels_validated_and_partial_outcomes() {
    for outcome in [
        ResponseOutcome::Completed,
        ResponseOutcome::Incomplete {
            reason: Some("private\x1b".into()),
        },
        ResponseOutcome::Failed,
        ResponseOutcome::Cancelled,
    ] {
        let mut r = response();
        r.outcome = outcome.clone();
        let (gateway, _) = setup(r, false);
        let mut out = Vec::new();
        let result = handle(args(&[]), &b""[..], |_| Ok(gateway), &mut out, pending())
            .await
            .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(!text.chars().any(|c| c.is_control() && c != '\n'));
        assert!(text.contains("[Provisional text] partial"));
        assert!(text.contains("[Authoritative validated final response;"));
        assert!(!text.contains("private"));
        assert_eq!(
            text.contains("[Run: Completed]"),
            outcome == ResponseOutcome::Completed
        );
        assert_eq!(
            exit_code(&result),
            if outcome == ResponseOutcome::Completed {
                0
            } else {
                1
            }
        );
    }
}

#[tokio::test]
async fn run_cli_refusal_completed_exit_code() {
    let mut r = response();
    r.text = "I cannot comply".into();
    let (gateway, records) = setup(r, false);
    let result = handle(
        args(&["--tool", "add_numbers"]),
        &b""[..],
        |_| Ok(gateway),
        &mut Vec::new(),
        pending(),
    )
    .await
    .unwrap();
    assert_eq!(exit_code(&result), 0);
    assert_eq!(result.outcome, RunOutcome::Completed);
    assert_eq!(count(&records.generates), 1);
    assert_eq!(result.summary.new_tool_dispatches, 0);
}

struct Broken {
    kind: std::io::ErrorKind,
    final_only: bool,
    on_flush: bool,
    final_seen: bool,
    writes_after_failure: usize,
    flushes_after_failure: usize,
    failed: bool,
}
impl Write for Broken {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.failed {
            self.writes_after_failure += 1;
        }
        self.final_seen |= [b"run_finished".as_slice(), b"[Run: ".as_slice()]
            .iter()
            .any(|marker| bytes.windows(marker.len()).any(|w| w == *marker));
        if !self.on_flush && (!self.final_only || self.final_seen) {
            self.failed = true;
            return Err(std::io::Error::from(self.kind));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.flushes_after_failure += usize::from(self.failed);
        if self.on_flush && (!self.final_only || self.final_seen) {
            self.failed = true;
            return Err(std::io::Error::from(self.kind));
        }
        Ok(())
    }
}
#[tokio::test]
async fn run_cli_broken_output_stops_work_and_final_sink_error_overrides_completed() {
    for (kind, expected) in [
        (std::io::ErrorKind::BrokenPipe, RunSinkError::Closed),
        (std::io::ErrorKind::WouldBlock, RunSinkError::Full),
        (std::io::ErrorKind::Other, RunSinkError::Failed),
    ] {
        for final_only in [false, true] {
            let (gateway, records) = setup(response(), false);
            let mut out = Broken {
                kind,
                final_only,
                on_flush: false,
                final_seen: false,
                writes_after_failure: 0,
                flushes_after_failure: 0,
                failed: false,
            };
            let result = handle(
                args(&["--json"]),
                &b""[..],
                |_| Ok(gateway),
                &mut out,
                pending(),
            )
            .await
            .unwrap();
            assert_eq!(result.sink_error, Some(expected));
            assert_eq!(exit_code(&result), 1);
            assert!(!result.events_complete);
            assert_eq!(out.writes_after_failure, 0);
            assert_eq!(count(&records.generates), usize::from(final_only));
            assert_eq!(count(&records.opens), usize::from(final_only));
            assert_eq!(count(&records.closes), usize::from(final_only));
            if final_only {
                assert_eq!(result.outcome, RunOutcome::Completed);
            }
        }
    }
}

#[tokio::test]
async fn run_cli_signal_cancels_and_awaits_close_and_terminal_result() {
    let (gateway, records) = setup(response(), true);
    let signal_records = records.clone();
    let signal = async move {
        signal_records.entered.notified().await;
        Ok(())
    };
    let mut out = Vec::new();
    let result = handle(
        args(&["--json"]),
        &b""[..],
        |_| Ok(gateway),
        &mut out,
        signal,
    )
    .await
    .unwrap();
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    assert_eq!(exit_code(&result), 130);
    assert_eq!(count(&records.closes), 1);
    assert_eq!(count(&records.generates), 1);
    let last: Value =
        serde_json::from_str(String::from_utf8(out).unwrap().lines().last().unwrap()).unwrap();
    assert_eq!(last["type"], "run_finished");
    assert_eq!(last["outcome"]["type"], "cancelled_locally");
}

#[tokio::test]
async fn run_cli_handler_prevalidates_before_factory_and_reads_bounded_utf8() {
    for case in 0..11 {
        let mut a = args(&[]);
        let mut input = vec![];
        match case {
            0 => a.prompt = Some(" ".into()),
            1 => a.prompt = Some("x".repeat(MAX_INPUT_BYTES)),
            2 => a.instructions.clear(),
            3 => a.instructions = "x".repeat(MAX_INPUT_BYTES),
            4 => a.base.model = "x".repeat(257),
            5 => a.base.auth.account = Some("test".into()),
            6 => {
                a.base.auth.auth_source = crate::cli::SourceArg::Gateway;
                a.base.auth.auth_file = Some("absent".into());
            }
            7 => {
                a.base.auth.auth_source = crate::cli::SourceArg::Gateway;
                a.base.auth.account = Some("../invalid".into());
            }
            8 => a.tool = vec![ToolArg::AddNumbers; 2],
            9 => {
                a.stdin = true;
                a.prompt = None;
                input = vec![0xff];
            }
            10 => {
                a.stdin = true;
                a.prompt = None;
                input = vec![b'x'; MAX_INPUT_BYTES + 1];
            }
            _ => unreachable!(),
        }
        let result = handle(
            a,
            input.as_slice(),
            |_| panic!("factory called before validation: {case}"),
            &mut Vec::new(),
            pending(),
        )
        .await;
        if case == 7 {
            assert!(matches!(
                result,
                Err(CliError::Gateway(GatewayError::InvalidAuth(
                    "invalid local profile name"
                )))
            ));
        } else {
            assert!(
                matches!(
                    result,
                    Err(CliError::Gateway(GatewayError::InvalidRequest(_)))
                ),
                "case {case}"
            );
        }
    }
    let mut a = args(&[
        "--auth-source",
        "gateway",
        "--account",
        "synthetic",
        "--transport",
        "sse",
    ]);
    a.stdin = true;
    a.prompt = None;
    let (gateway, records) = setup(response(), false);
    let result = handle(
        a,
        &b"hello"[..],
        |auth| {
            assert!(matches!(auth.auth_source, crate::cli::SourceArg::Gateway));
            assert_eq!(auth.account.as_deref(), Some("synthetic"));
            Ok(gateway)
        },
        &mut Vec::new(),
        pending(),
    )
    .await
    .unwrap();
    assert_eq!(exit_code(&result), 0);
    assert_eq!(records.options.lock().unwrap()[0].transport, Transport::Sse);
}
