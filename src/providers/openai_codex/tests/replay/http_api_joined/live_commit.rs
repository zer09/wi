//! C54's separate private producer. The parent, never this child, owns the root.
use super::*;
use crate::{Provider, ProviderCapabilities, ProviderSession, RequestReceipt, SessionControl};
use ring::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};
use std::{io::Write, os::unix::fs::PermissionsExt, panic::AssertUnwindSafe, path::PathBuf};
use tokio::io::AsyncBufReadExt;

#[path = "live_commit/tests.rs"]
mod tests;
const RESPONSE: &str = "task-1-final";
const FIRST: &str = "one 雪";
const DELTA: &str = " +🙂";
const APPEND: &str = "one 雪 +🙂";
const FINAL: &str = "one 雪 +🙂 final";
const TASK: &str = "Give one short answer.";
const LIMIT: usize = 16384;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    SetupControl,
    Setup,
    ReadyEmit,
    ControlReceive,
    ControlAdmission,
    FirstWireReceive,
    AcceptanceRead,
    AcceptanceDecode,
    TaskMatch,
    ProviderRequestMatch,
    FirstWireReply,
    Settle,
    Snapshot,
    SavedValidation,
    FirstEmit,
    ObservedFirst,
    Arm,
    Second,
    Page,
    Authoritative,
    Terminal,
    ObservedTerminal,
    Stop,
    Cleanup,
    StoppedEmit,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Origin {
    Run,
    Cleanup,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReaderFacts {
    opened: usize,
    closed: usize,
    active: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Failure {
    origin: Origin,
    phase: Phase,
    last_completed: Option<Phase>,
    readers: Option<ReaderFacts>,
}
#[derive(Default)]
struct Tracker {
    phase: Phase,
    last_completed: Option<Phase>,
    first: Option<Failure>,
}
impl Tracker {
    fn begin(&mut self, phase: Phase) {
        self.phase = phase;
    }
    fn complete(&mut self) {
        self.last_completed = Some(self.phase);
    }
    fn freeze(&mut self, origin: Origin, readers: &Readers) {
        if self.first.is_none() {
            self.first = Some(Failure {
                origin,
                phase: self.phase,
                last_completed: self.last_completed,
                readers: readers.diagnostic(),
            });
        }
    }
    fn publish(&self, out: &mut impl Write) {
        if let Some(first) = &self.first {
            let mut frame = serde_json::to_value(first).unwrap();
            frame["protocol"] = json!(1);
            frame["event"] = json!("failed");
            frame["category"] = json!("native_failure");
            publish(out, &frame);
        }
    }
}
fn publish(out: &mut impl Write, frame: &Value) -> bool {
    // A broken observer must not stop resource cleanup or replace the first failure.
    std::panic::catch_unwind(AssertUnwindSafe(|| {
        serde_json::to_writer(&mut *out, frame)?;
        out.write_all(b"\n")?;
        out.flush()
    }))
    .is_ok_and(|result| result.is_ok())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    id: u32,
    root: PathBuf,
    owner: String,
}
impl Start {
    fn valid(&self, cwd: &Path) -> bool {
        self.id == 1
            && self.owner.len() == 64
            && self
                .owner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && self.root.is_absolute()
            && self
                .root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("wi-live-commit-"))
            && std::fs::canonicalize(&self.root).is_ok_and(|p| p == self.root)
            && cwd == self.root.join("child")
            && [
                self.root.clone(),
                cwd.to_owned(),
                self.root.join("workspace"),
                self.root.join("private-skills"),
            ]
            .iter()
            .all(|p| {
                std::fs::symlink_metadata(p)
                    .is_ok_and(|s| s.is_dir() && s.permissions().mode() & 0o7777 == 0o700)
            })
            && ["home", "xdg", "codex", "tmp"].iter().all(|n| {
                std::fs::symlink_metadata(cwd.join(n))
                    .is_ok_and(|s| s.is_dir() && s.permissions().mode() & 0o7777 == 0o700)
            })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Saved {
    session_id: ApplicationSessionId,
    run_id: RunId,
    entry_id: String,
    field_id: String,
    head: u64,
    projection_head: u64,
    generation: u64,
    content_epoch: u64,
    bytes: usize,
    sha256: String,
    matches: bool,
    provisional: bool,
    entry_state: String,
    run_state: String,
    result_recorded: bool,
    response_finished: bool,
    run_finished: bool,
    events_complete: Option<bool>,
}
impl Saved {
    fn valid(&self, kind: &str) -> bool {
        // An item snapshot replaces text, but only ResponseFinished finalizes the entry.
        let terminal = kind == "terminal";
        let provisional = !terminal;
        let expected = match kind {
            "first" => FIRST,
            "append" => APPEND,
            "authoritative" | "terminal" => FINAL,
            _ => return false,
        };
        self.entry_id
            .parse::<crate::conversation::EntryId>()
            .is_ok()
            && self.field_id.len() == 64
            && self
                .field_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && self.head == self.projection_head
            && self.head > 0
            && self.generation > 0
            && self.generation <= self.head
            && self.content_epoch > 0
            && self.content_epoch <= self.head
            && self.bytes == expected.len()
            && self.sha256 == hash(expected.as_bytes())
            && self.matches
            && self.provisional == provisional
            && self.entry_state
                == if provisional {
                    "in_progress"
                } else {
                    "completed"
                }
            && self.run_state == if terminal { "completed" } else { "running" }
            && self.result_recorded == terminal
            && self.response_finished == terminal
            && self.run_finished == terminal
            && self.events_complete == terminal.then_some(true)
    }
}
#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    First { id: u32 },
    ObservedFirst { id: u32, observed: Saved },
    Arm { id: u32 },
    Second { id: u32 },
    Page { id: u32, page: usize },
    Authoritative { id: u32, observed: Saved },
    Terminal { id: u32, observed: Saved },
    ObservedTerminal { id: u32, observed: Saved },
    Stop { id: u32 },
}
impl Control {
    fn id(&self) -> u32 {
        match self {
            Self::First { id }
            | Self::ObservedFirst { id, .. }
            | Self::Arm { id }
            | Self::Second { id }
            | Self::Page { id, .. }
            | Self::Authoritative { id, .. }
            | Self::Terminal { id, .. }
            | Self::ObservedTerminal { id, .. }
            | Self::Stop { id } => *id,
        }
    }
}
#[derive(Default)]
struct Order {
    last: u32,
    phase: u8,
    page: usize,
    pages: usize,
}
impl Order {
    fn admit(&mut self, command: &Control, saved: Option<&Saved>) -> bool {
        if self.last.checked_add(1) != Some(command.id()) || command.id() == 0 {
            return false;
        }
        let next = match command {
            Control::First { .. } if self.phase == 0 => 1,
            Control::ObservedFirst { observed, .. }
                if self.phase == 1 && observed.valid("first") && Some(observed) == saved =>
            {
                2
            }
            Control::Arm { .. } if self.phase == 2 => 3,
            Control::Second { .. } if self.phase == 3 => 4,
            Control::Page { page, .. }
                if self.phase == 4 && *page == self.page && *page < self.pages =>
            {
                self.page += 1;
                4
            }
            Control::Authoritative { observed, .. }
                if self.phase == 4
                    && self.pages > 0
                    && self.page == self.pages
                    && observed.valid("append")
                    && Some(observed) == saved =>
            {
                5
            }
            Control::Terminal { observed, .. }
                if self.phase == 5
                    && observed.valid("authoritative")
                    && Some(observed) == saved =>
            {
                6
            }
            Control::ObservedTerminal { observed, .. }
                if self.phase == 6 && observed.valid("terminal") && Some(observed) == saved =>
            {
                7
            }
            Control::Stop { .. } if self.phase < 8 => 8,
            _ => return false,
        };
        self.last = command.id();
        self.phase = next;
        true
    }
}
fn hash(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn emit(value: Value) {
    let mut value = value;
    value["protocol"] = json!(1);
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(bytes.len() <= LIMIT);
    let mut out = std::io::stdout().lock();
    out.write_all(&bytes).unwrap();
    out.write_all(b"\n").unwrap();
    out.flush().unwrap();
}
async fn control<T: serde::de::DeserializeOwned>(
    reader: &mut tokio::io::BufReader<tokio::io::Stdin>,
) -> T {
    let mut bytes = vec![];
    let length = watch(
        reader
            .take((LIMIT + 1) as u64)
            .read_until(b'\n', &mut bytes),
    )
    .await
    .unwrap();
    assert!(
        length > 0 && length <= LIMIT && bytes.last() == Some(&b'\n'),
        "live control rejected"
    );
    decode(&bytes).unwrap_or_else(|| panic!("live control rejected"))
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    if bytes.len() > LIMIT || bytes.last() != Some(&b'\n') || bytes.contains(&b'\\') {
        return None;
    }
    serde_json::from_slice(bytes).ok()
}

#[derive(Default)]
struct Counts {
    opens: AtomicUsize,
    models: AtomicUsize,
    connections: AtomicUsize,
    validates: AtomicUsize,
    executes: AtomicUsize,
    completions: AtomicUsize,
}
struct CountedAdd {
    counts: Arc<Counts>,
}
#[async_trait]
impl crate::tools::Tool for CountedAdd {
    fn definition(&self) -> crate::ToolDefinition {
        crate::tools::AddNumbers.definition()
    }
    fn validate(&self, arguments: &Value) -> Result<()> {
        self.counts.validates.fetch_add(1, Ordering::SeqCst);
        crate::tools::AddNumbers.validate(arguments)
    }
    async fn execute(&self, arguments: Value) -> Result<Value> {
        self.counts.executes.fetch_add(1, Ordering::SeqCst);
        crate::tools::AddNumbers.execute(arguments).await
    }
}
struct CountedProvider {
    adapter: OpenAiCodexProvider,
    counts: Arc<Counts>,
}
#[async_trait]
impl Provider for CountedProvider {
    fn id(&self) -> &'static str {
        self.adapter.id()
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.adapter.capabilities()
    }
    fn validate_replay(
        &self,
        options: &SessionOptions,
        replay: &ConversationReplay,
        input: &[InputItem],
    ) -> Result<()> {
        self.adapter.validate_replay(options, replay, input)
    }
    async fn open_session(&self, options: SessionOptions) -> Result<ProviderSession> {
        self.counts.opens.fetch_add(1, Ordering::SeqCst);
        let mut session = self.adapter.open_session(options).await?;
        let counts = self.counts.clone();
        session.events = Box::pin(session.events.inspect(move |event| {
            if matches!(event.event, crate::ProviderEvent::ResponseFinished { .. }) {
                counts.completions.fetch_add(1, Ordering::SeqCst);
            }
        }));
        session.control = Arc::new(CountedControl {
            inner: session.control,
            counts: self.counts.clone(),
        });
        Ok(session)
    }
}
struct CountedControl {
    inner: Arc<dyn SessionControl>,
    counts: Arc<Counts>,
}
#[async_trait]
impl SessionControl for CountedControl {
    fn replay_identity(&self) -> Option<ReplayIdentity> {
        self.inner.replay_identity()
    }
    async fn install_replay(&self, replay: ConversationReplay) -> Result<()> {
        self.inner.install_replay(replay).await
    }
    async fn generate(&self, input: Vec<InputItem>) -> Result<RequestReceipt> {
        self.counts.models.fetch_add(1, Ordering::SeqCst);
        self.inner.generate(input).await
    }
    fn close(&self) {
        self.inner.close();
    }
    async fn steer(&self, text: String) -> Result<()> {
        self.inner.steer(text).await
    }
}
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Work {
    auth_loads: usize,
    auth_prepares: usize,
    provider_opens: usize,
    model_requests: usize,
    connections: usize,
    wire_requests: usize,
    prepared_exact: usize,
    completed: usize,
    tool_validations: usize,
    tool_executions: usize,
}
fn work(auth: &CountedAuth, counts: &Counts, requests: usize, prepared: bool) -> Work {
    Work {
        auth_loads: auth.loads.load(Ordering::SeqCst),
        auth_prepares: auth.prepares.load(Ordering::SeqCst),
        provider_opens: counts.opens.load(Ordering::SeqCst),
        model_requests: counts.models.load(Ordering::SeqCst),
        connections: counts.connections.load(Ordering::SeqCst),
        wire_requests: requests,
        prepared_exact: usize::from(prepared),
        completed: counts.completions.load(Ordering::SeqCst),
        tool_validations: counts.validates.load(Ordering::SeqCst),
        tool_executions: counts.executes.load(Ordering::SeqCst),
    }
}
fn delta(text: &str) -> Value {
    json!({"type":"response.output_text.delta","response_id":RESPONSE,"item_id":"answer","output_index":0,"content_index":0,"delta":text})
}
fn item() -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":FINAL}]})
}
fn first_frames() -> Vec<Value> {
    vec![
        json!({"type":"response.created","response":{"id":RESPONSE}}),
        json!({"type":"response.output_item.added","response_id":RESPONSE,"output_index":0,"item":{"type":"message","id":"answer","role":"assistant","status":"in_progress","content":[]}}),
        delta(FIRST),
    ]
}
fn terminal_frames(item: Value) -> Vec<Value> {
    let mut terminal = events(RESPONSE, vec![item], false);
    terminal.remove(0);
    terminal
}
fn db_path(root: &Path, sid: &ApplicationSessionId) -> PathBuf {
    root.join("private-data/sessions")
        .join(&sid.as_str()[..2])
        .join(sid.as_str())
        .join("session.sqlite3")
}
#[derive(Default)]
struct Readers {
    opened: AtomicUsize,
    closed: AtomicUsize,
}
impl Readers {
    fn diagnostic(&self) -> Option<ReaderFacts> {
        let opened = self.opened.load(Ordering::SeqCst);
        let closed = self.closed.load(Ordering::SeqCst);
        opened.checked_sub(closed).map(|active| ReaderFacts {
            opened,
            closed,
            active,
        })
    }
    fn facts(&self) -> Value {
        let opened = self.opened.load(Ordering::SeqCst);
        let closed = self.closed.load(Ordering::SeqCst);
        json!({"opened":opened,"closed":closed,"active":opened-closed})
    }
}
async fn read_owned<T>(
    root: &Path,
    sid: &ApplicationSessionId,
    readers: &Readers,
    action: impl for<'a> FnOnce(&'a mut SqliteConnection) -> futures_util::future::BoxFuture<'a, T>,
) -> T {
    let mut sql = SqliteConnectOptions::new()
        .filename(db_path(root, sid))
        .read_only(true)
        .busy_timeout(Duration::ZERO)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    readers.opened.fetch_add(1, Ordering::SeqCst);
    let result = AssertUnwindSafe(action(&mut sql)).catch_unwind().await;
    sql.close().await.unwrap();
    readers.closed.fetch_add(1, Ordering::SeqCst);
    result.unwrap_or_else(|_| panic!("live reader rejected"))
}
// Every snapshot owns a short independent reader. Even a failed assertion closes it before unwinding.
async fn snapshot(
    root: &Path,
    sid: &ApplicationSessionId,
    expected: &str,
    operation: Option<&OperationId>,
    readers: &Readers,
) -> Saved {
    let saved_sid = sid.clone();
    let expected = expected.to_owned();
    let operation = operation.cloned();
    read_owned(root, sid, readers, move |sql| Box::pin(async move {
        let sid = saved_sid;
        let mut tx = sql.begin().await.unwrap();
        let version: i64 = sqlx::query_scalar("PRAGMA user_version").fetch_one(&mut *tx).await.unwrap(); assert_eq!(version, 3);
        let (head, projection): (i64,i64) = sqlx::query_as("SELECT head_sequence,applied_sequence FROM manifest,conversation_projection").fetch_one(&mut *tx).await.unwrap(); assert_eq!(head,projection);
        let rows = sqlx::query("SELECT e.run_id,e.entry_id,e.content_epoch,e.metadata_json,f.field_id,f.generation,f.byte_length,r.state,r.result_sequence FROM conversation_entries e JOIN conversation_fields f USING(run_id,entry_id) JOIN runs r USING(run_id) WHERE e.kind='assistant'").fetch_all(&mut *tx).await.unwrap(); assert_eq!(rows.len(),1);
        let row = &rows[0]; let run: String = row.get("run_id"); let entry: String = row.get("entry_id"); let field: String = row.get("field_id");
        let chunks = sqlx::query("SELECT start_byte,bytes FROM conversation_chunks WHERE run_id=? AND entry_id=? AND field_id=? ORDER BY start_byte").bind(&run).bind(&entry).bind(&field).fetch_all(&mut *tx).await.unwrap();
        let mut bytes = vec![];
        for chunk in chunks { assert_eq!(chunk.get::<i64,_>("start_byte"),bytes.len() as i64); bytes.extend(chunk.get::<Vec<u8>,_>("bytes")); }
        assert!(bytes == expected.as_bytes()); assert_eq!(row.get::<i64,_>("byte_length"),bytes.len() as i64);
        if let Some(op) = &operation {
            let receipt: String = sqlx::query_scalar("SELECT receipt_json FROM commands WHERE operation_id=? AND method='append_run_records'").bind(op.as_str()).fetch_one(&mut *tx).await.unwrap();
            let receipt: crate::storage::CommitReceipt = serde_json::from_str(&receipt).unwrap();
            assert_eq!(receipt.operation_id(), op); assert_eq!(receipt.session_id(), &sid);
            assert_eq!(receipt.first_sequence(), head as u64); assert_eq!(receipt.last_sequence(), head as u64); assert_eq!(receipt.run_id().unwrap().as_str(),run);
            let payload: String = sqlx::query_scalar("SELECT payload_json FROM events WHERE sequence=? AND run_id=? AND event_type='runtime.observed'").bind(head).bind(&run).fetch_one(&mut *tx).await.unwrap();
            let event: crate::run::RunEventEnvelope = serde_json::from_str(&payload).unwrap();
            assert_eq!(event.run_id, run);
            assert!(matches!(event.event, RunEvent::ProviderEvent { event } if matches!(&event.event, crate::ProviderEvent::OutputItemUpdated { response_id, item_id, output_index:0, content_index:Some(0), summary_index:None, kind: crate::DeltaKind::Text, delta } if response_id == RESPONSE && item_id == "answer" && delta == DELTA)));
            let changed: i64 = sqlx::query_scalar("SELECT changed_sequence FROM conversation_entries WHERE run_id=? AND entry_id=?").bind(&run).bind(&entry).fetch_one(&mut *tx).await.unwrap(); assert_eq!(changed,head);
        }
        let response_finished: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE run_id=? AND event_type='runtime.observed' AND json_extract(payload_json,'$.type')='provider_event' AND json_extract(payload_json,'$.event.type')='response_finished'").bind(&run).fetch_one(&mut *tx).await.unwrap();
        let header: String = sqlx::query_scalar("SELECT header_json FROM conversation_blocks WHERE run_id=?").bind(&run).fetch_one(&mut *tx).await.unwrap();
        let header: Value = serde_json::from_str(&header).unwrap();
        let terminal_sequence: Option<i64> = sqlx::query_scalar("SELECT terminal_sequence FROM runs WHERE run_id=?").bind(&run).fetch_one(&mut *tx).await.unwrap();
        assert!(response_finished <= 1);
        let meta: Value = serde_json::from_str(row.get("metadata_json")).unwrap();
        let saved = Saved { session_id:sid.clone(),run_id:run.parse().unwrap(),entry_id:entry,field_id:field,head:head as u64,projection_head:projection as u64,
            generation:row.get::<i64,_>("generation") as u64,content_epoch:row.get::<i64,_>("content_epoch") as u64,bytes:bytes.len(),sha256:hash(&bytes),matches:true,
            provisional:meta["provisional"].as_bool().unwrap(),entry_state:meta["state"].as_str().unwrap().into(),run_state:row.get("state"),result_recorded:row.get::<Option<i64>,_>("result_sequence").is_some(), response_finished:response_finished==1, run_finished:terminal_sequence.is_some(), events_complete:header["events_complete"].as_bool() };
        tx.commit().await.unwrap(); saved
    })).await
}
async fn settled(
    root: &Path,
    sid: &ApplicationSessionId,
    expected: &str,
    terminal: bool,
    readers: &Readers,
    tracker: &mut Tracker,
) -> Saved {
    tracker.begin(Phase::Settle);
    // Poll only a tiny scalar until the writer has finished. No session mutex is acquired.
    let started = tokio::time::Instant::now();
    loop {
        let (rows, results) = read_owned(root, sid, readers, |sql| Box::pin(async move {
                let rows: Vec<Vec<u8>> = sqlx::query_scalar("SELECT c.bytes FROM conversation_chunks c JOIN conversation_entries e USING(run_id,entry_id) WHERE e.kind='assistant' ORDER BY c.start_byte").fetch_all(&mut *sql).await.unwrap();
                let results: i64 = sqlx::query_scalar("SELECT count(*) FROM runs WHERE result_sequence IS NOT NULL").fetch_one(&mut *sql).await.unwrap();
                (rows, results)
            })).await;
        if rows.concat() == expected.as_bytes() && (!terminal || results == 1) {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "live state watchdog"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tracker.complete();
    tracker.begin(Phase::Snapshot);
    let saved = snapshot(root, sid, expected, None, readers).await;
    tracker.complete();
    saved
}

fn selected_leaves(collector: &crate::storage::test_hooks::latency::Collector) -> Vec<Vec<u64>> {
    let pages = collector.page(0).unwrap().0;
    let rows: Vec<_> = (0..pages)
        .flat_map(|p| collector.page(p).unwrap().1)
        .collect();
    assert_eq!(rows[0][6..8], [0, 0]);
    let operations: Vec<_> = rows
        .iter()
        .filter(|r| r[0] == 3 && r[2] == 1 && r[3] == 2)
        .collect();
    assert_eq!(operations.len(), 1);
    let op = operations[0][1];
    let leaves: Vec<_> = rows
        .iter()
        .filter(|r| r[0] == 2 && r[2] == op && [20, 21, 22].contains(&r[1]))
        .cloned()
        .collect();
    assert_eq!(
        leaves.iter().map(|r| r[1]).collect::<Vec<_>>(),
        [20, 21, 21, 21, 22]
    );
    assert!(leaves.iter().all(|r| r[3] == 0
        && r[4] == 2
        && r[7] == 0
        && r[8] == 0
        && r[6] >= r[5]));
    assert!(leaves.windows(2).all(|w| w[0][6] <= w[1][5]));
    for stage in [20, 21, 22] {
        let total = rows.iter().find(|r| r[0] == 1 && r[1] == stage).unwrap();
        let items: Vec<_> = leaves.iter().filter(|r| r[1] == stage).collect();
        assert_eq!(total[2], items.len() as u64);
        assert_eq!(total[3], items.iter().map(|r| r[6] - r[5]).sum::<u64>());
        assert_eq!(total[5], 0);
    }
    leaves
}

#[derive(Default)]
struct Resources {
    store: Option<SessionStore>,
    server: Option<tokio::task::JoinHandle<ServeOutcome>>,
    stop: CancellationToken,
    pause: Option<Arc<Pause>>,
    wire: Option<Wire>,
    readers: Readers,
    tracker: Tracker,
}
impl Resources {
    async fn close(&mut self) {
        if let Some(pause) = self.pause.take() {
            pause.release.notify_one();
        }
        // Stop drains the existing host before its storage closes. Do not delete the parent's root.
        self.stop.cancel();
        let drained = if let Some(server) = self.server.take() {
            match AssertUnwindSafe(watch(server)).catch_unwind().await {
                Ok(Ok(outcome)) => {
                    outcome.http.is_ok() && matches!(&*outcome.shutdown, ShutdownOutcome::Closed)
                }
                _ => false,
            }
        } else {
            true
        };
        let closed = if let Some(store) = self.store.take() {
            store.close().await.is_ok()
        } else {
            true
        };
        self.wire.take();
        assert!(drained && closed);
        assert_eq!(
            self.readers.opened.load(Ordering::SeqCst),
            self.readers.closed.load(Ordering::SeqCst)
        );
    }
}
async fn run(input: &mut tokio::io::BufReader<tokio::io::Stdin>, resources: &mut Resources) -> u32 {
    resources.tracker.begin(Phase::SetupControl);
    let start: Start = control(input).await;
    resources.tracker.complete();
    resources.tracker.begin(Phase::Setup);
    let cwd = std::env::current_dir().unwrap();
    assert!(start.valid(&cwd), "live root rejected");
    for (key, name) in [
        ("HOME", "home"),
        ("XDG_CONFIG_HOME", "xdg"),
        ("CODEX_HOME", "codex"),
        ("TMPDIR", "tmp"),
        ("TMP", "tmp"),
        ("TEMP", "tmp"),
    ] {
        assert!(
            std::env::var_os(key) == Some(cwd.join(name).into_os_string()),
            "live isolation rejected"
        );
    }
    let token = start.root.join("owner");
    let metadata = std::fs::symlink_metadata(&token).unwrap();
    assert!(metadata.is_file() && metadata.permissions().mode() & 0o7777 == 0o600);
    assert!(std::fs::read_to_string(&token).unwrap() == start.owner);
    assert!(
        !start.root.join("private-data").exists(),
        "live adoption rejected"
    );
    let store = SessionStore::open(start.root.join("private-data"))
        .await
        .unwrap();
    resources.store = Some(store);
    let store = resources.store.as_ref().unwrap();
    let created = store
        .create_session(
            CreateSession::new(
                OperationId::new(),
                "Live measurement".into(),
                Some(start.root.join("workspace").to_str().unwrap().into()),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let sid = created.session_id().clone();
    let handle = store.open_session(sid.clone()).await.unwrap();
    let hooks = handle.test_hooks();
    let collector = hooks.enable_latency();
    drop(handle);
    resources.wire = Some(Wire::new(Transport::WebSocket).await);
    let address = resources
        .wire
        .as_ref()
        .unwrap()
        .listener
        .local_addr()
        .unwrap();
    let auth = Arc::new(CountedAuth::new(TOKEN_A, ACCOUNT));
    let counts = Arc::new(Counts::default());
    let mut adapter = OpenAiCodexProvider::loopback(auth.clone(), Transport::WebSocket, address);
    adapter.websocket_endpoint = format!("ws://{address}/codex/responses");
    adapter.sse_endpoint = format!("http://{address}/codex/responses");
    let mut gateway = Gateway::new();
    gateway
        .register(Arc::new(CountedProvider {
            adapter,
            counts: counts.clone(),
        }))
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut options = SessionOptions::new(MODEL);
    options.transport = Transport::WebSocket;
    options.instructions = INSTRUCTIONS.into();
    let mut settings = ApiSettings::new(
        &origin,
        vec![start.root.join("workspace")],
        start.root.join("private-skills"),
        PROVIDER_ID.into(),
        options,
        false,
    )
    .unwrap();
    settings.set_test_tool(Arc::new(CountedAdd {
        counts: counts.clone(),
    }));
    let config = ApiConfig::new(settings, OwnerToken::load(&token).unwrap());
    let host = RunHost::new(resources.store.take().unwrap(), Arc::new(gateway)).unwrap();
    resources.server = Some(tokio::spawn(serve(
        listener,
        host,
        config,
        resources.stop.clone(),
    )));
    let mut order = Order {
        last: 1,
        ..Default::default()
    };
    let mut saved = None;
    let mut prepared = false;
    let mut completed = false;
    let mut observed_terminal = false;
    resources.tracker.complete();
    resources.tracker.begin(Phase::ReadyEmit);
    emit(
        json!({"event":"ready","id":1,"pid":std::process::id(),"origin":origin,"session_id":sid,"head":1,"work":work(&auth,&counts,0,false)}),
    );
    resources.tracker.complete();
    loop {
        resources.tracker.begin(Phase::ControlReceive);
        let command: Control = control(input).await;
        resources.tracker.complete();
        resources.tracker.begin(Phase::ControlAdmission);
        assert!(order.admit(&command, saved.as_ref()), "live phase rejected");
        resources.tracker.complete();
        let id = command.id();
        match command {
            Control::First { .. } => {
                let wire = resources.wire.as_mut().unwrap();
                let connecting = wire.websocket.is_none();
                resources.tracker.begin(Phase::FirstWireReceive);
                let body = wire.receive().await;
                resources.tracker.complete();
                if connecting {
                    counts.connections.fetch_add(1, Ordering::SeqCst);
                }
                resources.tracker.begin(Phase::AcceptanceRead);
                let input: String = read_owned(&start.root, &sid, &resources.readers, |sql| {
                    Box::pin(async move {
                        sqlx::query_scalar(
                            "SELECT payload_json FROM events WHERE event_type='run.accepted'",
                        )
                        .fetch_one(sql)
                        .await
                        .unwrap()
                    })
                })
                .await;
                resources.tracker.complete();
                resources.tracker.begin(Phase::AcceptanceDecode);
                let input: Value = serde_json::from_str(&input).unwrap();
                let input: RecordedRunInput =
                    serde_json::from_value(input["input"].clone()).unwrap();
                resources.tracker.complete();
                resources.tracker.begin(Phase::TaskMatch);
                assert!(input.user_text() == TASK);
                resources.tracker.complete();
                resources.tracker.begin(Phase::ProviderRequestMatch);
                assert_request(
                    &body,
                    &[user(&input.prepared_request().prompt)],
                    None,
                    &input,
                );
                assert!(body.get("previous_response_id").is_none());
                prepared = true;
                resources.tracker.complete();
                resources.tracker.begin(Phase::FirstWireReply);
                wire.reply(first_frames(), None).await;
                resources.tracker.complete();
                let first = settled(
                    &start.root,
                    &sid,
                    FIRST,
                    false,
                    &resources.readers,
                    &mut resources.tracker,
                )
                .await;
                resources.tracker.begin(Phase::SavedValidation);
                assert!(first.valid("first"));
                saved = Some(first);
                resources.tracker.complete();
                resources.tracker.begin(Phase::FirstEmit);
                emit(
                    json!({"event":"first","id":id,"saved":saved,"work":work(&auth,&counts,wire.requests,prepared)}),
                );
            }
            Control::ObservedFirst { .. } => {
                resources.tracker.begin(Phase::ObservedFirst);
                emit(json!({"event":"first_observed","id":id}));
            }
            Control::Arm { .. } => {
                resources.tracker.begin(Phase::Arm);
                let pause = Arc::new(Pause::default());
                hooks.arm_record(
                    Record::PartialText,
                    Point::AfterCommit,
                    Action::Pause(pause.clone()),
                );
                resources.pause = Some(pause);
                collector.open();
                emit(json!({"event":"armed","id":id}));
            }
            Control::Second { .. } => {
                resources.tracker.begin(Phase::Second);
                resources
                    .wire
                    .as_mut()
                    .unwrap()
                    .reply(vec![delta(DELTA)], None)
                    .await;
                let pause = resources.pause.as_ref().unwrap();
                watch(pause.reached.notified()).await;
                assert_eq!(pause.hits.load(Ordering::SeqCst), 1);
                collector.freeze();
                assert_eq!(collector.capture_state(), "captured");
                selected_leaves(&collector);
                let operation = pause.operation_id.lock().unwrap().clone().unwrap();
                let second = snapshot(
                    &start.root,
                    &sid,
                    APPEND,
                    Some(&operation),
                    &resources.readers,
                )
                .await;
                let first = saved.as_ref().unwrap();
                assert!(second.valid("append"));
                assert_eq!(first.generation, second.generation);
                assert_eq!(first.content_epoch, second.content_epoch);
                assert_eq!(first.entry_id, second.entry_id);
                assert_eq!(first.field_id, second.field_id);
                // SSE cannot acquire SessionMutex until this release. Never wait for DOM here.
                resources.pause.take().unwrap().release.notify_one();
                order.pages = collector.page(0).unwrap().0;
                saved = Some(second);
                emit(
                    json!({"event":"captured","id":id,"saved":saved,"operation_id":operation,"pause_hits":1,"reader_closed":true,"readers":resources.readers.facts(),"released":true,"pages":order.pages}),
                );
            }
            Control::Page { page, .. } => {
                resources.tracker.begin(Phase::Page);
                let (pages, rows) = collector.page(page).unwrap();
                emit(json!({"event":"page","id":id,"page":page,"pages":pages,"rows":rows}));
            }
            Control::Authoritative { .. } => {
                resources.tracker.begin(Phase::Authoritative);
                let prior = saved.as_ref().unwrap().clone();
                resources.wire.as_mut().unwrap().reply(vec![json!({"type":"response.output_item.done","response_id":RESPONSE,"output_index":0,"item":item()})],None).await;
                let final_state = settled(
                    &start.root,
                    &sid,
                    FINAL,
                    false,
                    &resources.readers,
                    &mut resources.tracker,
                )
                .await;
                resources.tracker.begin(Phase::Authoritative);
                assert!(final_state.valid("authoritative"));
                assert!(final_state.generation > prior.generation);
                assert_eq!(final_state.content_epoch, prior.content_epoch);
                assert_eq!(final_state.field_id, prior.field_id);
                saved = Some(final_state);
                emit(json!({"event":"authoritative","id":id,"saved":saved}));
            }
            Control::Terminal { .. } => {
                resources.tracker.begin(Phase::Terminal);
                let prior = saved.as_ref().unwrap().clone();
                let wire = resources.wire.as_mut().unwrap();
                wire.reply(terminal_frames(item()), None).await;
                wire.closed().await;
                wire.no_request();
                let final_state = settled(
                    &start.root,
                    &sid,
                    FINAL,
                    true,
                    &resources.readers,
                    &mut resources.tracker,
                )
                .await;
                resources.tracker.begin(Phase::Terminal);
                assert!(final_state.valid("terminal"));
                assert_eq!(prior.generation, final_state.generation);
                assert_eq!(prior.content_epoch, final_state.content_epoch);
                let (payload, tools): (String, i64) = read_owned(&start.root, &sid, &resources.readers, |sql| Box::pin(async move {
                    let payload = sqlx::query_scalar("SELECT payload_json FROM events WHERE event_type='run.result.recorded'").fetch_one(&mut *sql).await.unwrap();
                    let tools = sqlx::query_scalar("SELECT count(*) FROM tool_results").fetch_one(&mut *sql).await.unwrap();
                    (payload, tools)
                })).await;
                let result: crate::run::RunResult = serde_json::from_str(&payload).unwrap();
                assert!(
                    matches!(result.outcome, RunOutcome::Completed)
                        && result.events_complete
                        && result.sink_error.is_none()
                );
                assert_eq!(counts.completions.load(Ordering::SeqCst), 1);
                assert_eq!(result.summary.model_requests_attempted, 1);
                assert_eq!(result.summary.model_requests_admitted, 1);
                assert_eq!(result.summary.new_tool_dispatches, 0);
                assert_eq!(result.summary.tool_results_prepared, 0);
                assert_eq!(result.summary.reused_results, 0);
                assert_eq!(tools, 0);
                completed = true;
                saved = Some(final_state);
                emit(
                    json!({"event":"terminal","id":id,"saved":saved,"work":work(&auth,&counts,wire.requests,prepared)}),
                );
            }
            Control::ObservedTerminal { .. } => {
                resources.tracker.begin(Phase::ObservedTerminal);
                observed_terminal = true;
                emit(json!({"event":"complete","id":id}));
            }
            Control::Stop { .. } => {
                resources.tracker.begin(Phase::Stop);
                resources.wire.as_ref().unwrap().no_request();
                emit(
                    json!({"event":"stopping","id":id,"complete":completed && observed_terminal,"work":work(&auth,&counts,resources.wire.as_ref().unwrap().requests,prepared)}),
                );
                resources.tracker.complete();
                return id;
            }
        }
        resources.tracker.complete();
    }
}
async fn finish(
    result: std::thread::Result<u32>,
    resources: &mut Resources,
    out: &mut impl Write,
) -> bool {
    if result.is_err() {
        resources.tracker.freeze(Origin::Run, &resources.readers);
        // Flush the owned failure before shutdown can close the browser's SSE.
        resources.tracker.publish(out);
    }
    resources.tracker.begin(Phase::Cleanup);
    let cleanup = AssertUnwindSafe(resources.close()).catch_unwind().await;
    if cleanup.is_ok() {
        resources.tracker.complete();
    } else if resources.tracker.first.is_none() {
        resources
            .tracker
            .freeze(Origin::Cleanup, &resources.readers);
        resources.tracker.publish(out);
    }
    if resources.tracker.first.is_some() {
        publish(
            out,
            &json!({"protocol":1,"event":"failure_cleanup","outcome":if cleanup.is_ok() { "closed" } else { "failed" },"readers":resources.readers.diagnostic()}),
        );
        return false;
    }
    resources.tracker.begin(Phase::StoppedEmit);
    publish(
        out,
        &json!({"protocol":1,"event":"stopped","id":result.unwrap(),"drained":true,"readers":resources.readers.facts()}),
    )
}
#[tokio::test]
#[ignore = "private C54 live producer; only the separately authorized browser harness may select it"]
async fn child() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut resources = Resources::default();
    let mut input = tokio::io::BufReader::new(tokio::io::stdin());
    let result = AssertUnwindSafe(run(&mut input, &mut resources))
        .catch_unwind()
        .await;
    if !finish(result, &mut resources, &mut std::io::stdout()).await {
        std::process::exit(1);
    }
}
