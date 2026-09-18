use super::*;

pub(crate) fn identity(principal: char) -> ReplayIdentity {
    ReplayIdentity::new(
        ID.into(),
        "scripted-v1".into(),
        principal.to_string().repeat(64),
    )
    .unwrap()
}

pub(crate) struct Plan {
    pub identity: Option<ReplayIdentity>,
    pub responses: Vec<ModelResponse>,
    pub install_error: bool,
    pub install_pause: Option<Arc<Barrier>>,
    pub unsupported: bool,
    pub open_pause: Option<Arc<Barrier>>,
    pub panic_open: bool,
    pub response_pause: Option<Arc<Barrier>>,
}
impl Default for Plan {
    fn default() -> Self {
        Self {
            identity: Some(identity('a')),
            responses: vec![response("final", vec![], "done")],
            install_error: false,
            install_pause: None,
            unsupported: false,
            open_pause: None,
            panic_open: false,
            response_pause: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct ToolCounts {
    pub definitions: AtomicUsize,
    pub validations: AtomicUsize,
    pub effects: AtomicUsize,
}
struct SumTool {
    session: SessionHandle,
    counts: Arc<ToolCounts>,
}
#[async_trait]
impl Tool for SumTool {
    fn definition(&self) -> ToolDefinition {
        self.counts.definitions.fetch_add(1, Ordering::SeqCst);
        add_numbers_definition()
    }
    fn validate(&self, arguments: &Value) -> crate::Result<()> {
        self.counts.validations.fetch_add(1, Ordering::SeqCst);
        AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> crate::Result<Value> {
        let records = history(&self.session).await;
        assert!(
            matches!(records.last().unwrap().payload(), StoredEventPayload::RuntimeObserved(event)
            if matches!(event.event, RunEvent::ToolEvent { event: ToolExecutionEvent::ToolExecutionStarted { .. } }))
        );
        self.counts.effects.fetch_add(1, Ordering::SeqCst);
        AddNumbers.execute(arguments).await
    }
}

pub(crate) fn replay_tools(session: &SessionHandle) -> (Arc<ToolRegistry>, Arc<ToolCounts>) {
    let counts = Arc::new(ToolCounts::default());
    let mut tools = ToolRegistry::new();
    tools
        .register(Arc::new(SumTool {
            session: session.clone(),
            counts: counts.clone(),
        }))
        .unwrap();
    (Arc::new(tools), counts)
}

pub(crate) struct Fixture {
    pub temp: tempfile::TempDir,
    pub store: SessionStore,
    pub session: SessionHandle,
    pub tools: Arc<ToolRegistry>,
    pub counts: Arc<ToolCounts>,
}
impl Fixture {
    pub async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("root")).await.unwrap();
        let created = store
            .create_session(
                CreateSession::new(OperationId::new(), "synthetic replay".into(), None).unwrap(),
            )
            .await
            .unwrap();
        let session = store
            .open_session(created.session_id().clone())
            .await
            .unwrap();
        let (tools, counts) = replay_tools(&session);
        Self {
            temp,
            store,
            session,
            tools,
            counts,
        }
    }

    pub fn task(&self, prompt: &str, plan: Plan) -> Task {
        Task::new(&self.session, self.tools.clone(), prompt, plan)
    }
}

pub(crate) struct Task {
    pub gateway: Arc<Gateway>,
    pub session: SessionHandle,
    pub observed: Arc<Observations>,
    pub tools: Arc<ToolRegistry>,
    pub input: RecordedRunInput,
    pub run_id: RunId,
    pub operation_id: OperationId,
}
impl Task {
    pub fn new(
        session: &SessionHandle,
        tools: Arc<ToolRegistry>,
        prompt: &str,
        plan: Plan,
    ) -> Self {
        let mut options = SessionOptions::new("synthetic");
        options.instructions = format!("current instructions for {prompt}");
        let input = RecordedRunInput::new(
            prompt.into(),
            RunRequest {
                provider_id: ID.into(),
                options,
                prompt: format!("prepared {prompt}"),
            },
            tools.definitions(),
            vec![],
            vec![],
            None,
        )
        .unwrap();
        let run_id = RunId::new();
        let operation_id = OperationId::new();
        let observed = Arc::new(Observations::default());
        let script = Arc::new(ReplayScript {
            binding: Binding {
                session: session.clone(),
                operation_id: operation_id.clone(),
                run_id: run_id.clone(),
            },
            input: input.clone(),
            plan,
            observed: observed.clone(),
        });
        let mut gateway = Gateway::new();
        gateway.register(script.clone()).unwrap();
        Self {
            gateway: Arc::new(gateway),
            session: session.clone(),
            observed,
            tools,
            input,
            run_id,
            operation_id,
        }
    }
    pub fn request(&self) -> PersistentRunRequest {
        PersistentRunRequest {
            operation_id: self.operation_id.clone(),
            run_id: self.run_id.clone(),
            input: self.input.clone(),
        }
    }
    pub fn start(
        &self,
        cancel: CancellationToken,
    ) -> tokio::task::JoinHandle<Result<PersistentRunResult, PersistentRunFailure>> {
        let gateway = self.gateway.clone();
        let session = self.session.clone();
        let hooks = session.test_hooks();
        let tools = self.tools.clone();
        let request = self.request();
        // P1B2-01: this public future must remain Send despite ProviderStream not being Sync.
        fn send<T: Send>(future: T) -> T {
            future
        }
        tokio::spawn(send(async move {
            hooks
                .scope(run_in_session(&gateway, &session, request, &tools, cancel))
                .await
        }))
    }
    pub async fn execute(&self) -> (CommitResult, CommitResult, RunResult) {
        executed(
            watchdog(self.start(CancellationToken::new()))
                .await
                .unwrap()
                .unwrap(),
        )
    }
}

struct ReplayScript {
    binding: Binding,
    input: RecordedRunInput,
    plan: Plan,
    observed: Arc<Observations>,
}
#[derive(Default)]
pub(crate) struct Observations {
    pub records: Records,
    pub validations: AtomicUsize,
    pub identity_reads: AtomicUsize,
    pub installs: AtomicUsize,
    pub validated: Mutex<Option<ConversationReplay>>,
    pub installed: Mutex<Vec<ConversationReplay>>,
}
#[async_trait]
impl Provider for ReplayScript {
    fn id(&self) -> &'static str {
        ID
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.observed
            .records
            .capabilities
            .fetch_add(1, Ordering::SeqCst);
        capabilities()
    }
    fn validate_replay(
        &self,
        options: &SessionOptions,
        replay: &ConversationReplay,
        new_input: &[InputItem],
    ) -> crate::Result<()> {
        self.observed.validations.fetch_add(1, Ordering::SeqCst);
        if self.plan.unsupported {
            return Err(GatewayError::UnsupportedFeature("history_replay"));
        }
        options.validate()?;
        crate::validate_input(new_input)?;
        if replay.provider_id() != ID
            || replay.requested_model() != options.model
            || replay
                .expected_identity()
                .is_some_and(|id| id.format() != "scripted-v1")
        {
            return Err(GatewayError::InvalidRequest("incompatible scripted replay"));
        }
        let mut expected = self.input.prepared_request().options.clone();
        expected.tools = self.input.tool_definitions().to_vec();
        assert_eq!(value(options), value(&expected));
        assert_eq!(
            value(&new_input),
            value(&vec![InputItem::user(
                self.input.prepared_request().prompt.clone()
            )])
        );
        self.observed
            .records
            .options
            .lock()
            .unwrap()
            .push(options.clone());
        *self.observed.validated.lock().unwrap() = Some(replay.clone());
        Ok(())
    }
    async fn open_session(&self, options: SessionOptions) -> crate::Result<ProviderSession> {
        self.observed.records.opens.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            value(&options),
            value(&self.observed.records.options.lock().unwrap()[0])
        );
        let session = &self.binding.session;
        let run = session
            .run_record(self.binding.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.state(), RecordedRunState::Running);
        assert_eq!(run.last_runtime_sequence(), 1);
        assert!(
            session
                .history_selection(self.binding.run_id.clone())
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            session
                .provider_binding(self.binding.run_id.clone())
                .await
                .unwrap()
                .is_none()
        );
        if let Some(pause) = &self.plan.open_pause {
            pause.wait().await;
        }
        assert!(!self.plan.panic_open, "synthetic provider unwind");
        let (sender, mut receiver) = mpsc::unbounded_channel::<EventEnvelope>();
        let response_pause = self.plan.response_pause.clone();
        let control = ReplayControl {
            binding: self.binding.clone(),
            observed: self.observed.clone(),
            identity: self.plan.identity.clone(),
            install_error: self.plan.install_error,
            install_pause: self.plan.install_pause.clone(),
            sender,
            responses: Mutex::new(self.plan.responses.clone().into()),
            partial: response_pause.is_some(),
        };
        Ok(ProviderSession {
            id: format!("provider-{}", self.binding.run_id),
            control: Arc::new(control),
            events: Box::pin(async_stream::stream! {
                while let Some(event) = receiver.recv().await {
                    if matches!(event.event, ProviderEvent::ResponseFinished { .. })
                        && let Some(pause) = &response_pause {
                        pause.wait().await;
                    }
                    yield event;
                }
            }),
        })
    }
}

struct ReplayControl {
    binding: Binding,
    observed: Arc<Observations>,
    identity: Option<ReplayIdentity>,
    install_error: bool,
    install_pause: Option<Arc<Barrier>>,
    sender: mpsc::UnboundedSender<EventEnvelope>,
    responses: Mutex<VecDeque<ModelResponse>>,
    partial: bool,
}
#[async_trait]
impl SessionControl for ReplayControl {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        self.observed.identity_reads.fetch_add(1, Ordering::SeqCst);
        self.identity.clone()
    }
    async fn install_replay(&self, replay: ConversationReplay) -> crate::Result<()> {
        self.observed.installs.fetch_add(1, Ordering::SeqCst);
        let session = &self.binding.session;
        let binding = session
            .provider_binding(self.binding.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(Some(binding.identity()), self.identity.as_ref());
        assert_eq!(
            binding.provider_session_id(),
            format!("provider-{}", self.binding.run_id)
        );
        assert_eq!(binding.requested_model(), "synthetic");
        assert!(matches!(
            history(session).await.last().unwrap().payload(),
            StoredEventPayload::RunProviderBound(_)
        ));
        assert_eq!(
            value(&replay),
            value(self.observed.validated.lock().unwrap().as_ref().unwrap())
        );
        if replay.expected_identity().is_some()
            && replay.expected_identity() != self.identity.as_ref()
        {
            return Err(GatewayError::InvalidRequest("scripted identity mismatch"));
        }
        if let Some(pause) = &self.install_pause {
            pause.wait().await;
        }
        if self.install_error {
            return Err(GatewayError::Protocol("synthetic install failure"));
        }
        let mut installed = self.observed.installed.lock().unwrap();
        assert!(installed.is_empty());
        installed.push(replay);
        Ok(())
    }
    async fn generate(&self, input: Vec<InputItem>) -> crate::Result<RequestReceipt> {
        assert_eq!(self.observed.installed.lock().unwrap().len(), 1);
        let number = self.observed.records.inputs.lock().unwrap().len() + 1;
        let request_id = format!("{}-q{number}", self.binding.run_id);
        if number == 1 {
            let run = self
                .binding
                .session
                .run_record(self.binding.run_id.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                value(&input),
                value(&vec![InputItem::user(
                    run.input().prepared_request().prompt.clone()
                )])
            );
        } else {
            for item in &input {
                let InputItem::ToolResult { call_id, output } = item else {
                    panic!("expected actual result")
                };
                let saved = self
                    .binding
                    .session
                    .tool_result(self.binding.run_id.clone(), call_id.clone())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.output(), Some(output.as_str()));
                assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
            }
        }
        self.observed.records.inputs.lock().unwrap().push(input);
        let response = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("extra generation");
        let mut emitted = vec![ProviderEvent::ResponseStarted {
            response_id: response.id.clone(),
        }];
        if self.partial {
            emitted.push(ProviderEvent::OutputItemUpdated {
                response_id: response.id.clone(),
                item_id: "message".into(),
                output_index: 0,
                content_index: Some(0),
                summary_index: None,
                kind: DeltaKind::Text,
                delta: PARTIAL.into(),
            });
        }
        emitted.push(ProviderEvent::ResponseFinished { response });
        for event in emitted {
            let mut events = self.observed.records.events.lock().unwrap();
            let sequence = events.len() as u64 + 1;
            let event = EventEnvelope {
                schema_version: 1,
                sequence,
                event_id: format!("{}-event{sequence}", self.binding.run_id),
                session_id: format!("provider-{}", self.binding.run_id),
                request_id: Some(request_id.clone()),
                provider: ID.into(),
                provider_sequence: Some(sequence),
                event,
            };
            events.push(event.clone());
            self.sender.send(event).unwrap();
        }
        Ok(RequestReceipt { request_id })
    }
    fn close(&self) {
        self.observed.records.closes.fetch_add(1, Ordering::SeqCst);
    }
}
