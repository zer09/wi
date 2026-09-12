use super::*;
use serde_json::json;
use std::{
    future::pending,
    pin::Pin,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use wi::{EventEnvelope, ItemKind, OutputItem, RequestReceipt, SessionControl, UpstreamOutcome};

#[derive(Default)]
struct Records {
    factories: AtomicUsize,
    credentials: AtomicUsize,
    opens: AtomicUsize,
    generates: AtomicUsize,
    closes: AtomicUsize,
    inputs: Mutex<Vec<Vec<InputItem>>>,
    options: Mutex<Vec<SessionOptions>>,
    auth: Mutex<Vec<AuthArgs>>,
    entered: tokio::sync::Notify,
}
impl Records {
    fn counts(&self) -> [usize; 5] {
        [
            &self.factories,
            &self.credentials,
            &self.opens,
            &self.generates,
            &self.closes,
        ]
        .map(|counter| counter.load(Ordering::SeqCst))
    }
}
struct Control {
    records: Arc<Records>,
    error_at: Option<usize>,
    pending_at: Option<usize>,
}
#[async_trait::async_trait]
impl SessionControl for Control {
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        let request = self.records.generates.fetch_add(1, Ordering::SeqCst) + 1;
        // Keep the provider control's defensive validation, even with CLI preflight.
        wi::validate_input(&input)?;
        self.records.inputs.lock().unwrap().push(input);
        self.records.entered.notify_one();
        if self.error_at == Some(request) {
            return Err(GatewayError::Busy);
        }
        if self.pending_at == Some(request) {
            pending::<()>().await;
        }
        Ok(RequestReceipt {
            request_id: format!("q{request}"),
        })
    }
    fn close(&self) {
        self.records.closes.fetch_add(1, Ordering::SeqCst);
    }
}
struct Fake {
    records: Arc<Records>,
    events: wi::ProviderStream,
    open_error: Option<GatewayError>,
    generate_error_at: Option<usize>,
    pending_generate_at: Option<usize>,
}
impl Fake {
    fn new(events: Vec<EventEnvelope>) -> Self {
        Self {
            records: Arc::new(Records::default()),
            events: Box::pin(futures_util::stream::iter(events)),
            open_error: None,
            generate_error_at: None,
            pending_generate_at: None,
        }
    }
    async fn open(self, base: ModelArgs, options: SessionOptions) -> Result<ProviderSession> {
        self.records.factories.fetch_add(1, Ordering::SeqCst);
        self.records.auth.lock().unwrap().push(base.auth);
        // This callback replaces the whole real factory/auth/gateway/open path.
        self.records.credentials.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = self.open_error {
            return Err(error);
        }
        assert_eq!(base.model, options.model);
        options.validate()?;
        self.records.options.lock().unwrap().push(options);
        self.records.opens.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderSession {
            id: "s".into(),
            control: Arc::new(Control {
                records: self.records,
                error_at: self.generate_error_at,
                pending_at: self.pending_generate_at,
            }),
            events: self.events,
        })
    }
}
fn args(prompt: Option<&str>, follow_up: Option<&str>, json_mode: bool) -> GenerateArgs {
    let mut argv = vec!["wi", "generate", "--model", "synthetic"];
    if let Some(prompt) = prompt {
        argv.extend(["--prompt", prompt]);
    } else {
        argv.push("--stdin");
    }
    if let Some(follow_up) = follow_up {
        argv.extend(["--follow-up", follow_up]);
    }
    if json_mode {
        argv.push("--json");
    }
    let Command::Generate(args) = Cli::try_parse_from(argv).unwrap().command else {
        panic!("expected generate")
    };
    args
}
fn envelope(request: usize, event: ProviderEvent) -> EventEnvelope {
    EventEnvelope {
        schema_version: 1,
        sequence: request as u64,
        event_id: format!("e{request}"),
        session_id: "s".into(),
        request_id: Some(format!("q{request}")),
        provider: PROVIDER_ID.into(),
        provider_sequence: None,
        event,
    }
}
fn terminal(request: usize) -> EventEnvelope {
    envelope(
        request,
        ProviderEvent::ResponseFinished {
            response: ModelResponse {
                id: format!("r{request}"),
                model: None,
                outcome: ResponseOutcome::Completed,
                output: vec![OutputItem {
                    id: None,
                    kind: ItemKind::Message,
                    native_type: "message".into(),
                    function_call: None,
                    native: json!({"opaque": "unchanged"}),
                }],
                text: format!("answer {request}"),
                usage: None,
                native: json!({"opaque": "unchanged"}),
                output_provenance: Default::default(),
            },
        },
    )
}
fn assert_error(error: GatewayError, expected: GatewayError) {
    assert_eq!(error.code(), expected.code());
    assert_eq!(error.to_string(), expected.to_string());
}
fn assert_inputs(records: &Records, expected: &[&str]) {
    let inputs = records.inputs.lock().unwrap();
    assert_eq!(inputs.len(), expected.len());
    for (input, expected) in inputs.iter().zip(expected) {
        let [InputItem::User { text }] = input.as_slice() else {
            panic!("expected exactly one user item per request")
        };
        assert!(text.as_str() == *expected, "submitted input bytes changed");
    }
}
async fn rejected(
    args: GenerateArgs,
    input: impl AsyncRead + Unpin,
    expected: GatewayError,
    case: &str,
) {
    let fake = Fake::new(vec![terminal(1), terminal(2)]);
    let records = fake.records.clone();
    let mut out = Vec::new();
    let error = generate_with(
        args,
        input,
        |base, options| fake.open(base, options),
        &mut out,
        pending(),
    )
    .await
    .unwrap_err();
    assert_error(error, expected);
    assert_eq!(
        records.counts(),
        [0; 5],
        "A-03 {case}: factory/credential/open/generate/close; stdout_bytes={}",
        out.len()
    );
    assert!(out.is_empty(), "A-03 {case}: unexpected stdout");
    assert!(records.inputs.lock().unwrap().is_empty());
    assert!(records.options.lock().unwrap().is_empty());
    assert!(records.auth.lock().unwrap().is_empty());
}
fn invalid_inputs() -> Vec<(&'static str, String, &'static str)> {
    vec![
        ("empty", String::new(), "empty user input"),
        ("whitespace", " \t\r\n\u{2003}".into(), "empty user input"),
        (
            "raw oversized",
            "x".repeat(wi::MAX_INPUT_BYTES + 1),
            "input exceeds 1 MiB",
        ),
        (
            "serialized envelope overflow",
            "x".repeat(wi::MAX_INPUT_BYTES),
            "input exceeds 1 MiB",
        ),
        (
            "serialized escaping overflow",
            "\0".repeat(wi::MAX_INPUT_BYTES / 6),
            "input exceeds 1 MiB",
        ),
    ]
}

#[tokio::test]
async fn r1_a03_initial_prompt_preflight_before_open() {
    for (case, text, message) in invalid_inputs() {
        for json_mode in [false, true] {
            rejected(
                args(Some(&text), None, json_mode),
                &b"unused stdin"[..],
                GatewayError::InvalidRequest(message),
                case,
            )
            .await;
        }
    }
}

#[tokio::test]
async fn r1_a03_initial_stdin_preflight_before_open() {
    for (case, text, message) in invalid_inputs() {
        let message = if text.len() > wi::MAX_INPUT_BYTES {
            "stdin exceeds 1 MiB"
        } else {
            message
        };
        for json_mode in [false, true] {
            rejected(
                args(None, None, json_mode),
                text.as_bytes(),
                GatewayError::InvalidRequest(message),
                case,
            )
            .await;
        }
    }
}

struct BrokenInput;
impl AsyncRead for BrokenInput {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::ErrorKind::PermissionDenied.into()))
    }
}

#[tokio::test]
async fn r1_a03_stdin_source_errors_and_read_bound_precede_validation() {
    for json_mode in [false, true] {
        for (bytes, message) in [
            (vec![0xff], "stdin is not UTF-8"),
            (vec![0xff; wi::MAX_INPUT_BYTES + 9], "stdin exceeds 1 MiB"),
        ] {
            let expected_read = bytes.len().min(wi::MAX_INPUT_BYTES + 1);
            let mut input = io::Cursor::new(bytes);
            let mut args = args(None, Some(""), json_mode);
            args.base.model.clear();
            rejected(
                args,
                &mut input,
                GatewayError::InvalidRequest(message),
                "stdin source before follow-up/options",
            )
            .await;
            assert_eq!(input.position() as usize, expected_read);
        }
        rejected(
            args(None, Some(""), json_mode),
            BrokenInput,
            GatewayError::Io(io::ErrorKind::PermissionDenied),
            "stdin read error",
        )
        .await;
    }
}

#[tokio::test]
async fn r1_a03_follow_up_preflight_before_first_generation() {
    for (case, text, message) in invalid_inputs() {
        for json_mode in [false, true] {
            for stdin in [false, true] {
                let prompt = if stdin { None } else { Some("initial") };
                rejected(
                    args(prompt, Some(&text), json_mode),
                    &b"initial"[..],
                    GatewayError::InvalidRequest(message),
                    case,
                )
                .await;
            }
        }
    }
}

#[tokio::test]
async fn r1_a03_options_preflight_before_open() {
    for json_mode in [false, true] {
        for stdin in [false, true] {
            for case in 0..8 {
                let prompt = if stdin { None } else { Some("initial") };
                let mut args = args(prompt, Some("follow-up"), json_mode);
                let message = if case < 5 {
                    "model and instructions are required"
                } else {
                    "session configuration exceeds 1 MiB"
                };
                match case {
                    0 => args.base.model.clear(),
                    1 => args.base.model = " \t\n".into(),
                    2 => args.base.model = "m".repeat(257),
                    3 => args.instructions.clear(),
                    4 => args.instructions = " \t\n".into(),
                    5 => args.instructions = "i".repeat(wi::MAX_INPUT_BYTES + 1),
                    6 => args.instructions = "i".repeat(wi::MAX_INPUT_BYTES),
                    7 => args.instructions = "\0".repeat(wi::MAX_INPUT_BYTES / 6),
                    _ => unreachable!(),
                }
                rejected(
                    args,
                    &b"initial"[..],
                    GatewayError::InvalidRequest(message),
                    "options",
                )
                .await;
            }
        }
    }
}

#[tokio::test]
async fn r1_a03_initial_then_follow_up_then_options_error_precedence() {
    let oversized = "x".repeat(wi::MAX_INPUT_BYTES + 1);
    for json_mode in [false, true] {
        for source in [SourceArg::Codex, SourceArg::Pi, SourceArg::Gateway] {
            for (initial, follow_up, message) in [
                ("", oversized.as_str(), "empty user input"),
                (oversized.as_str(), "", "input exceeds 1 MiB"),
                ("initial", "", "empty user input"),
                ("initial", oversized.as_str(), "input exceeds 1 MiB"),
            ] {
                let mut args = args(Some(initial), Some(follow_up), json_mode);
                args.base.model.clear();
                args.instructions.clear();
                args.base.auth.auth_source = source;
                rejected(
                    args,
                    BrokenInput,
                    GatewayError::InvalidRequest(message),
                    "initial > follow-up > options > auth/open",
                )
                .await;
            }
        }
    }
}

#[tokio::test]
async fn r1_a03_valid_requests_preserve_bytes_options_auth_and_legacy_output() {
    let temp = tempfile::tempdir().unwrap();
    let prompt = " \n\t雪\r\n\"\\\0 ";
    let follow_up = "\t follow-up é\n ";
    let instructions = " \n unchanged instructions é\t\r\n";
    for json_mode in [false, true] {
        for stdin in [false, true] {
            for follow in [false, true] {
                for source in [SourceArg::Codex, SourceArg::Pi, SourceArg::Gateway] {
                    for transport in [TransportArg::Websocket, TransportArg::Sse] {
                        let mut args = args(
                            if stdin { None } else { Some(prompt) },
                            if follow { Some(follow_up) } else { None },
                            json_mode,
                        );
                        args.base.model = " synthetic ".into();
                        args.base.transport = transport;
                        args.instructions = instructions.into();
                        args.base.auth.auth_source = source;
                        let auth_file = temp.path().join("not-read.json");
                        if matches!(source, SourceArg::Gateway) {
                            args.base.auth.account = Some("synthetic".into());
                        } else {
                            args.base.auth.auth_file = Some(auth_file.clone());
                        }
                        let requests = if follow { 2 } else { 1 };
                        let events: Vec<_> = (1..=requests).map(terminal).collect();
                        let expected_json = serde_json::to_value(&events).unwrap();
                        let fake = Fake::new(events);
                        let records = fake.records.clone();
                        let mut input = io::Cursor::new(prompt.as_bytes());
                        let mut out = Vec::new();
                        generate_with(
                            args,
                            &mut input,
                            |base, options| fake.open(base, options),
                            &mut out,
                            pending(),
                        )
                        .await
                        .unwrap();
                        assert_eq!(records.counts(), [1, 1, 1, requests, 1]);
                        assert_eq!(
                            input.position(),
                            if stdin { prompt.len() as u64 } else { 0 }
                        );
                        let mut expected = vec![prompt];
                        if follow {
                            expected.push(follow_up);
                        }
                        assert_inputs(&records, &expected);
                        let options = records.options.lock().unwrap();
                        assert_eq!(options.len(), 1);
                        assert_eq!(options[0].model, " synthetic ");
                        assert_eq!(options[0].instructions, instructions);
                        assert!(options[0].tools.is_empty());
                        assert!(options[0].required_features.is_empty());
                        let expected_transport = match transport {
                            TransportArg::Websocket => Transport::WebSocket,
                            TransportArg::Sse => Transport::Sse,
                        };
                        assert_eq!(options[0].transport, expected_transport);
                        let auth = records.auth.lock().unwrap();
                        assert_eq!(auth.len(), 1);
                        assert_eq!(auth[0].auth_source as u8, source as u8);
                        if matches!(source, SourceArg::Gateway) {
                            assert_eq!(auth[0].account.as_deref(), Some("synthetic"));
                            assert!(auth[0].auth_file.is_none());
                        } else {
                            assert_eq!(auth[0].auth_file.as_ref(), Some(&auth_file));
                            assert!(auth[0].account.is_none());
                        }
                        if json_mode {
                            let events: Vec<EventEnvelope> = out
                                .split(|byte| *byte == b'\n')
                                .filter(|line| !line.is_empty())
                                .map(|line| serde_json::from_slice(line).unwrap())
                                .collect();
                            assert_eq!(serde_json::to_value(events).unwrap(), expected_json);
                        } else {
                            let expected: String =
                                (1..=requests).map(|n| format!("answer {n}\n")).collect();
                            assert_eq!(out, expected.as_bytes());
                        }
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn r1_a03_inputs_validate_separately_and_accept_exact_serialized_limit() {
    let overhead = serde_json::to_vec(&vec![InputItem::user("")])
        .unwrap()
        .len();
    for length in [wi::MAX_INPUT_BYTES / 2, wi::MAX_INPUT_BYTES - overhead] {
        let initial = "i".repeat(length);
        let follow_up = "f".repeat(length);
        let initial_items = vec![InputItem::user(&initial)];
        let follow_up_items = vec![InputItem::user(&follow_up)];
        wi::validate_input(&initial_items).unwrap();
        wi::validate_input(&follow_up_items).unwrap();
        assert!(
            wi::validate_input(&[InputItem::user(&initial), InputItem::user(&follow_up)]).is_err()
        );
        if length == wi::MAX_INPUT_BYTES - overhead {
            assert_eq!(
                serde_json::to_vec(&initial_items).unwrap().len(),
                wi::MAX_INPUT_BYTES
            );
        }
        let fake = Fake::new(vec![terminal(1), terminal(2)]);
        let records = fake.records.clone();
        generate_with(
            args(Some(&initial), Some(&follow_up), false),
            BrokenInput,
            |base, options| fake.open(base, options),
            &mut Vec::new(),
            pending(),
        )
        .await
        .unwrap();
        assert_eq!(records.counts(), [1, 1, 1, 2, 1]);
        assert_inputs(&records, &[&initial, &follow_up]);
    }
}

#[tokio::test]
async fn r1_a03_first_and_follow_up_response_checks_stop_and_close() {
    for request in [1, 2] {
        for json_mode in [false, true] {
            for case in 0..10 {
                let mut events = vec![terminal(1), terminal(2)];
                let ProviderEvent::ResponseFinished { response } = &mut events[request - 1].event
                else {
                    unreachable!()
                };
                let expected = if case < 3 {
                    response.outcome = match case {
                        0 => ResponseOutcome::Incomplete { reason: None },
                        1 => ResponseOutcome::Failed,
                        _ => ResponseOutcome::Cancelled,
                    };
                    GatewayError::NotCompleted
                } else {
                    response.output[0].kind = [
                        ItemKind::FunctionCall,
                        ItemKind::CustomToolCall,
                        ItemKind::ToolSearchCall,
                        ItemKind::ToolSearchOutput,
                        ItemKind::Program,
                        ItemKind::ProgramOutput,
                        ItemKind::Unknown,
                    ][case - 3]
                        .clone();
                    GatewayError::UnsupportedOutput
                };
                let fake = Fake::new(events);
                let records = fake.records.clone();
                let mut out = Vec::new();
                let error = generate_with(
                    args(Some("initial"), Some("follow-up"), json_mode),
                    BrokenInput,
                    |base, options| fake.open(base, options),
                    &mut out,
                    pending(),
                )
                .await
                .unwrap_err();
                assert_error(error, expected);
                assert_eq!(records.counts(), [1, 1, 1, request, 1]);
                assert_eq!(out.split(|byte| *byte == b'\n').count() - 1, request);
            }
        }
    }
}

#[tokio::test]
async fn r1_a03_open_and_generation_failures_preserve_close_behavior() {
    for failure_at in 0..=2 {
        let mut fake = Fake::new(vec![terminal(1), terminal(2)]);
        let expected = if failure_at == 0 {
            fake.open_error = Some(GatewayError::Io(io::ErrorKind::NotFound));
            GatewayError::Io(io::ErrorKind::NotFound)
        } else {
            fake.generate_error_at = Some(failure_at);
            GatewayError::Busy
        };
        let records = fake.records.clone();
        let mut out = Vec::new();
        let error = generate_with(
            args(Some("initial"), Some("follow-up"), false),
            BrokenInput,
            |base, options| fake.open(base, options),
            &mut out,
            pending(),
        )
        .await
        .unwrap_err();
        assert_error(error, expected);
        let opened = usize::from(failure_at != 0);
        assert_eq!(records.counts(), [1, 1, opened, failure_at, opened]);
        assert_eq!(
            out,
            if failure_at == 2 {
                &b"answer 1\n"[..]
            } else {
                &b""[..]
            }
        );
    }
}

#[tokio::test]
async fn r1_a03_collection_failures_prevent_follow_up_and_close() {
    for json_mode in [false, true] {
        for case in 0..4 {
            let (events, expected) = match case {
                0 => (vec![], GatewayError::UnexpectedEnd),
                1 => (
                    vec![envelope(
                        1,
                        ProviderEvent::SessionClosed {
                            reason: "synthetic".into(),
                        },
                    )],
                    GatewayError::SessionClosed,
                ),
                2 => (
                    vec![envelope(
                        1,
                        ProviderEvent::RequestFailed {
                            code: "synthetic_failure".into(),
                            message: "synthetic failure".into(),
                            upstream_outcome: UpstreamOutcome::Unknown,
                        },
                    )],
                    GatewayError::ProviderFailed,
                ),
                _ => (
                    vec![terminal(2)],
                    GatewayError::Protocol("unexpected request identity"),
                ),
            };
            let expected_json = serde_json::to_value(&events).unwrap();
            let fake = Fake::new(events);
            let records = fake.records.clone();
            let mut out = Vec::new();
            let error = generate_with(
                args(Some("initial"), Some("follow-up"), json_mode),
                BrokenInput,
                |base, options| fake.open(base, options),
                &mut out,
                pending(),
            )
            .await
            .unwrap_err();
            assert_error(error, expected);
            assert_eq!(records.counts(), [1, 1, 1, 1, 1]);
            if json_mode {
                let events: Vec<serde_json::Value> = out
                    .split(|byte| *byte == b'\n')
                    .filter(|line| !line.is_empty())
                    .map(|line| serde_json::from_slice(line).unwrap())
                    .collect();
                assert_eq!(serde_json::to_value(events).unwrap(), expected_json);
            } else {
                assert!(out.is_empty());
            }
        }
    }
}

struct BrokenOutput(io::ErrorKind);
impl Write for BrokenOutput {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(self.0.into())
    }
    fn flush(&mut self) -> io::Result<()> {
        panic!("must not flush after failed write")
    }
}

#[tokio::test]
async fn r1_a03_output_failure_prevents_follow_up_and_closes() {
    for json_mode in [false, true] {
        for kind in [
            io::ErrorKind::BrokenPipe,
            io::ErrorKind::WouldBlock,
            io::ErrorKind::Other,
        ] {
            let fake = Fake::new(vec![terminal(1), terminal(2)]);
            let records = fake.records.clone();
            let error = generate_with(
                args(Some("initial"), Some("follow-up"), json_mode),
                BrokenInput,
                |base, options| fake.open(base, options),
                &mut BrokenOutput(kind),
                pending(),
            )
            .await
            .unwrap_err();
            let expected = if json_mode {
                GatewayError::Serialization
            } else {
                GatewayError::Io(kind)
            };
            assert_error(error, expected);
            assert_eq!(records.counts(), [1, 1, 1, 1, 1]);
        }
    }
}

#[tokio::test]
async fn r1_a03_cancellation_during_generation_or_collection_closes_once() {
    for request in [1, 2] {
        for during_generate in [false, true] {
            let mut fake = Fake::new(vec![terminal(1), terminal(2)]);
            if during_generate {
                fake.pending_generate_at = Some(request);
            } else {
                let prefix = (1..request).map(terminal);
                fake.events = Box::pin(
                    futures_util::stream::iter(prefix).chain(futures_util::stream::pending()),
                );
            }
            let records = fake.records.clone();
            let signal_records = records.clone();
            let signal = async move {
                loop {
                    let entered = signal_records.entered.notified();
                    if signal_records.generates.load(Ordering::SeqCst) >= request {
                        return Ok(());
                    }
                    entered.await;
                }
            };
            let mut out = Vec::new();
            let error = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                generate_with(
                    args(Some("initial"), Some("follow-up"), false),
                    BrokenInput,
                    |base, options| fake.open(base, options),
                    &mut out,
                    signal,
                ),
            )
            .await
            .expect("synthetic cancellation stalled")
            .unwrap_err();
            assert_error(error, GatewayError::Cancelled);
            assert_eq!(records.counts(), [1, 1, 1, request, 1]);
            assert_eq!(
                out,
                if request == 2 {
                    &b"answer 1\n"[..]
                } else {
                    &b""[..]
                }
            );
        }
    }
}

#[test]
fn r1_a03_legacy_clap_errors_defaults_and_empty_values_are_unchanged() {
    for extra in [
        vec![],
        vec!["--prompt", "initial", "--stdin"],
        vec!["--prompt"],
        vec!["--unknown"],
    ] {
        let result = Cli::try_parse_from(
            ["wi", "generate", "--model", "synthetic"]
                .into_iter()
                .chain(extra),
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("invalid syntax parsed"),
        };
        assert_eq!(error.exit_code(), 2);
    }
    let args = args(Some(""), Some(""), false);
    assert_eq!(args.prompt.as_deref(), Some(""));
    assert_eq!(args.follow_up.as_deref(), Some(""));
    assert_eq!(args.instructions, "You are a helpful assistant.");
    assert!(matches!(args.base.auth.auth_source, SourceArg::Codex));
    assert!(matches!(args.base.transport, TransportArg::Websocket));
    assert!(!args.base.json);
}
