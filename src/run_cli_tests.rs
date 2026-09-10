use super::*;
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
    options: Mutex<Vec<SessionOptions>>,
    entered: tokio::sync::Notify,
}
struct Fake {
    records: Arc<Records>,
    response: ModelResponse,
    pending: bool,
}
struct Control {
    records: Arc<Records>,
}
#[async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        assert!(matches!(&input[..], [InputItem::User { text }] if text == "hello"));
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
        let response = self.response.clone();
        let wait = self.pending;
        let events = Box::pin(async_stream::stream! {
            if wait { pending::<()>().await; }
            for (i, event) in [
                ProviderEvent::ResponseStarted { response_id: "r".into() },
                ProviderEvent::OutputItemUpdated { response_id: "r".into(), item_id: "m".into(), output_index: 0, content_index: Some(0), summary_index: None, kind: DeltaKind::Text, delta: "partial\x1b\r\x07\u{009b}".into() },
                ProviderEvent::ResponseFinished { response },
            ].into_iter().enumerate() {
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
    let cli = crate::Cli::try_parse_from(
        ["wi", "run", "--model", "synthetic", "--prompt", "hello"]
            .into_iter()
            .chain(extra.iter().copied()),
    )
    .unwrap();
    let crate::Command::Run(args) = cli.command else {
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
    let records = Arc::new(Records::default());
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(Fake {
            records: records.clone(),
            response,
            pending: wait,
        }))
        .unwrap();
    (gateway, records)
}
fn count(n: &AtomicUsize) -> usize {
    n.load(Ordering::SeqCst)
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
    writes_after_failure: usize,
    failed: bool,
}
impl Write for Broken {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.failed {
            self.writes_after_failure += 1;
        }
        if !self.final_only
            || bytes
                .windows(b"run_finished".len())
                .any(|w| w == b"run_finished")
        {
            self.failed = true;
            return Err(std::io::Error::from(self.kind));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
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
                writes_after_failure: 0,
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
                a.base.auth.auth_source = crate::SourceArg::Gateway;
                a.base.auth.auth_file = Some("absent".into());
            }
            7 => {
                a.base.auth.auth_source = crate::SourceArg::Gateway;
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
                Err(GatewayError::InvalidAuth("invalid local profile name"))
            ));
        } else {
            assert!(
                matches!(result, Err(GatewayError::InvalidRequest(_))),
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
            assert!(matches!(auth.auth_source, crate::SourceArg::Gateway));
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
