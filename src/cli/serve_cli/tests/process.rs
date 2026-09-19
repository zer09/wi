use super::{process_support::Process, *};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncBufReadExt, BufReader};
use wi::{
    CallOrigin, Capability, ConversationReplay, DeltaKind, EventEnvelope, FunctionCall, InputItem,
    ItemKind, ModelResponse, OutputItem, Provider, ProviderCapabilities, ProviderEvent,
    ProviderSession, ReplayIdentity, RequestReceipt, ResponseOutcome, SessionControl,
    SessionOptions,
    providers::openai_codex::PROVIDER_ID,
    storage::{OperationId, RunId},
};

#[derive(Clone, Copy, Serialize, Deserialize)]
enum Mode {
    Complete,
    Partial,
    Unbound,
}
#[derive(Serialize, Deserialize)]
struct ChildInput {
    config: PathBuf,
    mode: Mode,
}
#[derive(Default)]
struct Counts {
    validates: AtomicUsize,
    opens: AtomicUsize,
    installs: AtomicUsize,
    generates: AtomicUsize,
    tool_results: AtomicUsize,
    replay_runs: AtomicUsize,
}
impl Counts {
    fn snapshot(&self) -> [usize; 6] {
        [
            &self.validates,
            &self.opens,
            &self.installs,
            &self.generates,
            &self.tool_results,
            &self.replay_runs,
        ]
        .map(|value| value.load(Ordering::SeqCst))
    }
}
struct Script {
    counts: Arc<Counts>,
    mode: Mode,
}
struct Control {
    counts: Arc<Counts>,
    generated: tokio::sync::mpsc::UnboundedSender<usize>,
    turns: AtomicUsize,
}
#[async_trait]
impl Provider for Script {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let yes = Capability {
            implemented: true,
            verification: "scripted process test".into(),
        };
        ProviderCapabilities {
            websocket: yes.clone(),
            sse: yes.clone(),
            continuation: yes.clone(),
            function_tools: yes,
            advanced: vec![],
        }
    }
    fn validate_replay(
        &self,
        _: &SessionOptions,
        replay: &ConversationReplay,
        _: &[InputItem],
    ) -> wi::Result<()> {
        self.counts.validates.fetch_add(1, Ordering::SeqCst);
        self.counts
            .replay_runs
            .store(replay.runs().len(), Ordering::SeqCst);
        // Complete historical tool exchanges must be restored, not executed during reopen.
        for run in replay.runs() {
            assert!(
                run.exchanges()
                    .iter()
                    .any(|exchange| !exchange.tool_results().is_empty())
            );
        }
        Ok(())
    }
    async fn open_session(&self, _: SessionOptions) -> wi::Result<ProviderSession> {
        self.counts.opens.fetch_add(1, Ordering::SeqCst);
        if matches!(self.mode, Mode::Unbound) {
            std::future::pending::<()>().await;
        }
        let (generated, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mode = self.mode;
        Ok(ProviderSession {
            id: "private-session-canary".into(),
            control: Arc::new(Control {
                counts: self.counts.clone(),
                generated,
                turns: AtomicUsize::new(0),
            }),
            events: Box::pin(async_stream::stream! {
                let mut sequence = 0;
                while let Some(turn) = receiver.recv().await {
                    let response_id = format!("response-{turn}");
                    let mut events = vec![ProviderEvent::ResponseStarted { response_id: response_id.clone() }];
                    if matches!(mode, Mode::Partial) {
                        events.push(ProviderEvent::OutputItemUpdated {
                            response_id, item_id: "item".into(), output_index: 0,
                            content_index: Some(0), summary_index: None, kind: DeltaKind::Text,
                            delta: "actual partial 雪\r\n".into(),
                        });
                    } else {
                        events.push(ProviderEvent::ResponseFinished { response: response(turn) });
                    }
                    for event in events {
                        sequence += 1;
                        yield EventEnvelope {
                            schema_version: 1, sequence, event_id: format!("event-{sequence}"),
                            session_id: "private-session-canary".into(), request_id: Some(format!("request-{turn}")),
                            provider: PROVIDER_ID.into(), provider_sequence: None, event,
                        };
                    }
                }
            }),
        })
    }
}
#[async_trait]
impl SessionControl for Control {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        Some(ReplayIdentity::new(PROVIDER_ID.into(), "script-v1".into(), "a".repeat(64)).unwrap())
    }
    async fn install_replay(&self, _: ConversationReplay) -> wi::Result<()> {
        self.counts.installs.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn generate(&self, input: Vec<InputItem>) -> wi::Result<RequestReceipt> {
        let turn = self.turns.fetch_add(1, Ordering::SeqCst);
        if turn == 1 {
            let [InputItem::ToolResult { output, .. }] = input.as_slice() else {
                panic!("expected actual AddNumbers result")
            };
            assert_eq!(
                serde_json::from_str::<Value>(output).unwrap(),
                json!({"sum":42})
            );
            self.counts.tool_results.fetch_add(1, Ordering::SeqCst);
        }
        self.counts.generates.fetch_add(1, Ordering::SeqCst);
        self.generated.send(turn).unwrap();
        Ok(RequestReceipt {
            request_id: format!("request-{turn}"),
        })
    }
    fn close(&self) {}
}
fn response(turn: usize) -> ModelResponse {
    let output = if turn == 0 {
        vec![OutputItem {
            id: Some("call-item".into()),
            kind: ItemKind::FunctionCall,
            native_type: "function_call".into(),
            function_call: Some(FunctionCall {
                call_id: "sum-call".into(),
                name: "add_numbers".into(),
                arguments: r#"{"a":17,"b":25}"#.into(),
                origin: CallOrigin::Direct,
                namespace: None,
                complete: true,
            }),
            native: json!({"type":"function_call","id":"call-item","call_id":"sum-call","name":"add_numbers","arguments":"{\"a\":17,\"b\":25}"}),
        }]
    } else {
        vec![]
    };
    ModelResponse {
        id: format!("response-{turn}"),
        model: Some("synthetic-model".into()),
        outcome: ResponseOutcome::Completed,
        output,
        text: if turn == 0 {
            String::new()
        } else {
            "answer 42 雪\r\n".into()
        },
        usage: None,
        native: json!({"private":"private-native-canary"}),
        output_provenance: Default::default(),
    }
}

#[test]
#[ignore = "isolated scripted server helper; parent supplies synthetic config on stdin"]
fn server_child() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        let input: ChildInput =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let counts = Arc::new(Counts::default());
        let observed = counts.clone();
        let code = handle(
            ServeArgs {
                config: input.config,
            },
            move |_| {
                let mut gateway = Gateway::new();
                gateway
                    .register(Arc::new(Script {
                        counts,
                        mode: input.mode,
                    }))
                    .unwrap();
                Ok(gateway)
            },
            || {
                Ok(async move {
                    while let Some(line) = lines.next_line().await? {
                        match line.as_str() {
                            "counts" => {
                                println!(
                                    "COUNTS {}",
                                    serde_json::to_string(&observed.snapshot()).unwrap()
                                );
                                io::stdout().flush()?;
                            }
                            "stop" => return Ok(()),
                            "crash" => std::process::exit(73),
                            _ => panic!("unknown test command"),
                        }
                    }
                    panic!("test control pipe closed")
                })
            },
            &mut io::stderr(),
        )
        .await
        .unwrap();
        assert_eq!(code, 0);
    });
}

fn send(process: &mut Process, line: &str) {
    writeln!(process.child.stdin.as_mut().unwrap(), "{line}").unwrap();
}
fn spawn(f: &Fixture, mode: Mode) -> (Process, SocketAddr) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args([
        "--exact",
        "cli::serve_cli::tests::process::server_child",
        "--ignored",
        "--nocapture",
    ]);
    let mut process = Process::start(command, f.temp.path());
    send(
        &mut process,
        &serde_json::to_string(&ChildInput {
            config: f.path.clone(),
            mode,
        })
        .unwrap(),
    );
    let address = process.line("api.listening ").parse().unwrap();
    (process, address)
}
fn counts(process: &mut Process) -> [usize; 6] {
    send(process, "counts");
    serde_json::from_str(&process.line("COUNTS ")).unwrap()
}
fn finish(mut process: Process, crash: bool) {
    send(&mut process, if crash { "crash" } else { "stop" });
    let (stdout, stderr) = process.finish(if crash { 73 } else { 0 });
    for output in [&stdout, &stderr] {
        assert!(!output.contains(TOKEN));
        assert!(!output.contains("canary"));
    }
    assert_eq!(
        stderr
            .lines()
            .filter(|line| line.starts_with("api.listening "))
            .count(),
        1
    );
    if !crash {
        assert!(stderr.ends_with("api.shutdown_closed\n"));
    }
}
fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .build()
        .unwrap()
}
fn get(client: &reqwest::Client, address: SocketAddr, path: &str) -> reqwest::RequestBuilder {
    client
        .get(format!("http://{address}{path}"))
        .bearer_auth(TOKEN)
}
fn post(
    client: &reqwest::Client,
    address: SocketAddr,
    path: &str,
    body: &Value,
) -> reqwest::RequestBuilder {
    client
        .post(format!("http://{address}{path}"))
        .bearer_auth(TOKEN)
        .json(body)
}
async fn json_response(request: reqwest::RequestBuilder, status: u16) -> Value {
    let response = watchdog(request.send()).await.unwrap();
    assert_eq!(response.status().as_u16(), status);
    watchdog(response.json()).await.unwrap()
}
fn task() -> Value {
    json!({"operation_id":OperationId::new(),"run_id":RunId::new(),"text":"explicit task 雪\r\n"})
}
async fn history(client: &reqwest::Client, address: SocketAddr, session: &str) -> Value {
    json_response(
        get(
            client,
            address,
            &format!("/v1/sessions/{session}/history?limit=128"),
        ),
        200,
    )
    .await
}
async fn wait_history(
    client: &reqwest::Client,
    address: SocketAddr,
    session: &str,
    kind: &str,
) -> Value {
    watchdog(async {
        loop {
            let page = history(client, address, session).await;
            if page["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == kind)
            {
                return page;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_process_reads_complete_partial_and_unbound_history_without_resume() {
    for mode in [Mode::Complete, Mode::Partial, Mode::Unbound] {
        let f = Fixture::new();
        let (mut first, address) = spawn(&f, mode);
        assert_eq!(counts(&mut first), [0; 6]);
        let client = client();
        let created = json_response(
            post(
                &client,
                address,
                "/v1/sessions",
                &json!({
                    "operation_id":OperationId::new(),"title":"persisted conversation",
                    "workspace":fs::canonicalize(f.temp.path().join("workspace")).unwrap()
                }),
            ),
            201,
        )
        .await;
        let session = created["session_id"].as_str().unwrap();
        let command = task();
        let runs_path = format!("/v1/sessions/{session}/runs");
        let accepted = json_response(post(&client, address, &runs_path, &command), 202).await;
        let kind = match mode {
            Mode::Complete => "run.result",
            Mode::Partial => "response.delta",
            Mode::Unbound => "run.started",
        };
        let before = wait_history(&client, address, session, kind).await;
        assert_eq!(before["has_more"], false);
        if matches!(mode, Mode::Complete) {
            assert_eq!(counts(&mut first), [1, 1, 1, 2, 1, 0]);
            assert!(
                before["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["kind"] == "tool.result")
            );
        } else if matches!(mode, Mode::Partial) {
            assert_eq!(counts(&mut first), [1, 1, 1, 1, 0, 0]);
        } else {
            // The provider open has started, but has not supplied a binding or model output.
            watchdog(async {
                while counts(&mut first)[1] == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            assert_eq!(counts(&mut first), [1, 1, 0, 0, 0, 0]);
            assert_eq!(
                before["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|event| event["kind"] == "checkpoint")
                    .count(),
                1
            );
        }
        let interrupted = !matches!(mode, Mode::Complete);
        finish(first, interrupted);

        let (mut fresh, address) = spawn(&f, Mode::Complete);
        assert_eq!(counts(&mut fresh), [0; 6]);
        let reopened = history(&client, address, session).await;
        let original = before["events"].as_array().unwrap();
        let events = reopened["events"].as_array().unwrap();
        assert_eq!(&events[..original.len()], original);
        assert_eq!(events.len(), original.len() + usize::from(interrupted));
        assert_eq!(
            events
                .iter()
                .filter(|event| event["kind"] == "run.interrupted")
                .count(),
            usize::from(interrupted)
        );
        let record = json_response(
            get(
                &client,
                address,
                &format!("{runs_path}/{}", command["run_id"].as_str().unwrap()),
            ),
            200,
        )
        .await;
        assert_eq!(
            record["state"],
            if interrupted {
                "interrupted"
            } else {
                "completed"
            }
        );
        assert_eq!(record["result_recorded"], !interrupted);
        assert_eq!(history(&client, address, session).await, reopened);
        for _ in 0..2 {
            let stream = watchdog(
                get(
                    &client,
                    address,
                    &format!(
                        "/v1/sessions/{session}/events?after={}",
                        reopened["next_after"].as_str().unwrap()
                    ),
                )
                .send(),
            )
            .await
            .unwrap();
            assert_eq!(stream.status(), 200);
            drop(stream);
        }
        assert_eq!(counts(&mut fresh), [0; 6]);
        let duplicate = json_response(post(&client, address, &runs_path, &command), 202).await;
        assert_eq!(duplicate["receipt"], accepted["receipt"]);
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(counts(&mut fresh), [0; 6]);
        let next = task();
        if interrupted {
            let error = json_response(post(&client, address, &runs_path, &next), 422).await;
            assert_eq!(error["code"], "invalid_request");
            assert_eq!(error["stage"], "history");
            assert!(error["acceptance"].is_null());
            assert_eq!(history(&client, address, session).await, reopened);
            assert_eq!(counts(&mut fresh), [0; 6]);
        } else {
            json_response(post(&client, address, &runs_path, &next), 202).await;
            watchdog(async {
                loop {
                    let record = json_response(
                        get(
                            &client,
                            address,
                            &format!("{runs_path}/{}", next["run_id"].as_str().unwrap()),
                        ),
                        200,
                    )
                    .await;
                    if record["result_recorded"] == true {
                        assert_eq!(record["state"], "completed");
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            assert_eq!(counts(&mut fresh), [1, 1, 1, 2, 1, 1]);
        }
        finish(fresh, false);
        // A third process proves the interruption is not appended again across restarts.
        let (mut third, address) = spawn(&f, Mode::Complete);
        let page = history(&client, address, session).await;
        assert_eq!(
            page["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["kind"] == "run.interrupted")
                .count(),
            usize::from(interrupted)
        );
        assert_eq!(counts(&mut third), [0; 6]);
        finish(third, false);
    }
}
