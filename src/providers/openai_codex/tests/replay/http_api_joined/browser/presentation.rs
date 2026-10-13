use super::*;

fn data() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/presentation.json"
    )))
    .unwrap()
}

pub(super) fn text(key: &str) -> String {
    data()[key].as_str().unwrap().to_owned()
}

pub(super) fn setup(workspace: &Path) {
    let path = workspace.join(".agents/skills/presentation");
    skill(&path, "presentation", &text("tool"));
    std::fs::write(path.join("script.sh"), "private-support-script").unwrap();
    std::fs::write(path.join("resource.txt"), "private-support-resource").unwrap();
}

pub(super) fn calls(task: usize) -> Vec<Value> {
    vec![
        json!({"type":"reasoning","id":"reason","summary":[{"type":"summary_text","text":text("summary")}],
            "content":[{"type":"reasoning_text","text":text("reasoning")}],"encrypted_content":"private-native-encrypted"}),
        json!({"type":"message","id":"mixed","role":"assistant","status":"completed","content":[
            {"type":"output_text","text":text("text"),"annotations":[{"private-native":"annotation"}]},
            {"type":"refusal","refusal":text("refusal"),"future":"private-native-refusal"}]}),
        call("add-雪", "add_numbers", ARGUMENTS[task]),
        call("skill", "load_skill", "{\"id\":\"project:presentation\"}"),
        call(
            "overflow",
            "add_numbers",
            "{\"a\":9223372036854775807,\"b\":1}",
        ),
        // This supported replay item has no public text or executable call.
        json!({"type":"reasoning","id":"opaque-reason","encrypted_content":"private-native-encrypted-only"}),
    ]
}

pub(super) fn outputs(task: usize) -> Vec<(&'static str, String, bool)> {
    vec![
        ("add-雪", OUTPUTS[task].into(), false),
        ("skill", json!({"id":"project:presentation","frontmatter":{"name":"presentation","description":"synthetic metadata"},"body":text("tool")}).to_string(), false),
        ("overflow", "{\"error\":{\"code\":\"gateway_error\"}}".into(), true),
    ]
}

pub(super) fn answer_text(task: usize) -> String {
    format!("Final {}\r\n{}{}", task + 1, text("text"), "W".repeat(2048))
}

pub(super) fn answer(task: usize) -> Vec<Value> {
    vec![
        json!({"type":"message","id":"answer","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":answer_text(task),"annotations":[{"private-native":"hidden"}]}]}),
    ]
}

pub(super) fn partial(id: &str, task: usize, turn: usize) -> Vec<Value> {
    let mut frames = vec![];
    if turn == 0 {
        for (index, mut item) in calls(task).into_iter().enumerate() {
            match index {
                0 => {
                    item["summary"] = json!([]);
                    item["content"] = json!([]);
                }
                1 => {
                    item["content"] = json!([]);
                    item["status"] = json!("in_progress");
                }
                2 => {
                    // Partial arguments stay inert until the real completed call replaces them.
                    item["arguments"] = json!("");
                    item["status"] = json!("in_progress");
                }
                _ => {}
            }
            frames.push(json!({"type":"response.output_item.added","response_id":id,"output_index":index,"item":item}));
        }
        for (kind, item, output, content, summary, key) in [
            (
                "reasoning_summary_text",
                "reason",
                0,
                None,
                Some(0),
                "summary",
            ),
            ("reasoning_text", "reason", 0, Some(0), None, "reasoning"),
            ("output_text", "mixed", 1, Some(0), None, "text"),
            ("refusal", "mixed", 1, Some(1), None, "refusal"),
            (
                "function_call_arguments",
                "item-add-雪",
                2,
                None,
                None,
                "arguments",
            ),
        ] {
            let value = text(key);
            let split = value.find('\n').unwrap() + 1;
            for delta in [&value[..split], &value[split..]] {
                frames.push(json!({"type":format!("response.{kind}.delta"),"response_id":id,"item_id":item,
                    "output_index":output,"content_index":content,"summary_index":summary,"delta":delta}));
            }
        }
    } else {
        frames.push(json!({"type":"response.output_item.added","response_id":id,"output_index":0,
            "item":{"type":"message","id":"answer","role":"assistant","status":"in_progress","content":[]}}));
        // Enough real committed deltas to cross several page windows, not a history limit.
        let text = answer_text(task);
        let chars: Vec<_> = text.chars().collect();
        for chunk in chars.chunks(32) {
            frames.push(
                json!({"type":"response.output_text.delta","response_id":id,"item_id":"answer",
                "output_index":0,"content_index":0,"delta":chunk.iter().collect::<String>()}),
            );
        }
    }
    frames
}

pub(super) fn done(id: &str, items: &[Value]) -> Vec<Value> {
    items.iter().enumerate().map(|(index, item)| {
        json!({"type":"response.output_item.done","response_id":id,"output_index":index,"item":item})
    }).collect()
}

// Only C49 opts in. Keep payloads out of this process-local, bounded witness.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    Send,
    Sent,
    Read,
    ReadDone,
    Count,
    Pace,
    Paced,
}

pub(super) struct Trace {
    enabled: bool,
    pub(super) latency: Option<Arc<crate::storage::test_hooks::latency::Collector>>,
    pub(super) polling: Option<FinalPolling>,
    prefix: Mutex<Option<u64>>,
    state: Mutex<Option<TraceState>>,
    // Installed only by deterministic controls, never by a running fixture.
    pub(super) lock_operations: Option<Arc<std::sync::atomic::AtomicUsize>>,
}

struct TraceState {
    origin: std::time::Instant,
    consumed: Option<u64>,
    expected: usize,
    frames: usize,
    counters: [u64; 6],
    counts: [Option<usize>; 4], // first, last, minimum, maximum
    changes: u64,
    gate: [Option<u64>; 3], // set, emission entry, flush completion
    history: std::collections::VecDeque<(u64, Phase, usize, usize, Option<usize>)>,
    truncated: bool,
    failed: bool,
}

impl Trace {
    pub(super) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            latency: None,
            polling: None,
            prefix: Mutex::new(None),
            state: Mutex::new(None),
            lock_operations: None,
        }
    }

    pub(super) fn bind_prefix(&self, records: &[StoredEvent], id: &str) {
        if self.polling.is_none() {
            return;
        }
        assert!(self.enabled && self.latency.is_some() && id == "task-1-final");
        assert_eq!(matching_updates(records, id), 0);
        assert!(
            records
                .iter()
                .enumerate()
                .all(|(i, r)| r.sequence() == i as u64 + 1)
        );
        assert!(
            self.prefix
                .lock()
                .unwrap()
                .replace(records.last().unwrap().sequence())
                .is_none()
        );
    }

    pub(super) fn cursor(&self, id: &str) -> Option<FinalCursor> {
        if self.polling != Some(FinalPolling::Incremental) {
            return None;
        }
        assert!(self.enabled && self.latency.is_some() && id == "task-1-final");
        Some(FinalCursor {
            sequence: self.prefix.lock().unwrap().unwrap(),
            committed: 0,
        })
    }

    fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, Option<TraceState>>> {
        if let Some(counter) = &self.lock_operations {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        self.state.lock()
    }

    pub(super) fn admit(&self) {
        if let Some(collector) = &self.latency {
            collector.open();
        }
        if self.enabled
            && let Ok(mut state) = self.lock()
        {
            *state = Some(TraceState {
                origin: std::time::Instant::now(),
                consumed: None,
                expected: 0,
                frames: 0,
                counters: [0; 6],
                counts: [None; 4],
                changes: 0,
                gate: [None; 3],
                history: Default::default(),
                truncated: false,
                failed: false,
            });
        }
    }

    pub(super) fn consumed(&self) {
        if !self.enabled {
            return;
        }
        if let Ok(mut state) = self.lock()
            && let Some(s) = state.as_mut()
        {
            s.consumed = Some(s.origin.elapsed().as_millis().min(600_000) as u64);
        }
    }

    pub(super) fn expected(&self, frames: usize, deltas: usize) {
        if !self.enabled {
            return;
        }
        if let Ok(mut state) = self.lock()
            && let Some(s) = state.as_mut()
        {
            s.frames = frames;
            s.expected = deltas;
            s.failed |= frames > 130 || deltas > 128;
        }
    }

    fn mark(&self, phase: Phase, frame: usize, delta: usize, count: Option<usize>) {
        if !self.enabled {
            return;
        }
        let ms = self
            .lock()
            .ok()
            .and_then(|s| s.as_ref().map(|s| s.origin.elapsed().as_millis()));
        if let Some(ms) = ms {
            self.mark_at(ms, phase, frame, delta, count);
        }
    }

    pub(super) fn mark_at(
        &self,
        ms: u128,
        phase: Phase,
        frame: usize,
        delta: usize,
        count: Option<usize>,
    ) {
        if !self.enabled {
            return;
        }
        if let Ok(mut state) = self.lock()
            && let Some(s) = state.as_mut()
        {
            if ms > 600_000 || frame > 130 || delta > 128 || count.is_some_and(|n| n > 1_000_000) {
                s.failed = true;
                return;
            }
            let index = match phase {
                Phase::Send => Some(0),
                Phase::Sent => Some(1),
                Phase::Read => Some(2),
                Phase::ReadDone => Some(3),
                Phase::Pace => Some(4),
                Phase::Paced => Some(5),
                Phase::Count => None,
            };
            if let Some(i) = index {
                if s.counters[i] == 1_000_000 {
                    s.failed = true;
                    return;
                }
                s.counters[i] += 1;
            }
            if let Some(n) = count {
                if s.counts[1] != Some(n) {
                    if s.changes == 1_000_000 {
                        s.failed = true;
                        return;
                    }
                    s.changes += 1;
                }
                s.counts[0].get_or_insert(n);
                s.counts[1] = Some(n);
                s.counts[2] = Some(s.counts[2].unwrap_or(n).min(n));
                s.counts[3] = Some(s.counts[3].unwrap_or(n).max(n));
            }
            if s.history.len() == 12 {
                s.history.pop_front();
                s.truncated = true;
            }
            s.history.push_back((ms as u64, phase, frame, delta, count));
        }
    }

    pub(super) async fn during<T>(
        &self,
        phase: Phase,
        frame: usize,
        delta: usize,
        future: impl std::future::Future<Output = T>,
    ) -> T {
        let done = match phase {
            Phase::Send => Phase::Sent,
            Phase::Read => Phase::ReadDone,
            Phase::Pace => Phase::Paced,
            _ => unreachable!(),
        };
        self.mark(phase, frame, delta, None);
        let value = future.await;
        self.mark(done, frame, delta, None);
        value
    }

    pub(super) fn counted(&self, frame: usize, delta: usize, committed: usize) -> bool {
        self.mark(Phase::Count, frame, delta, Some(committed));
        committed == delta
    }

    pub(super) fn gate(&self, index: usize) {
        if !self.enabled {
            return;
        }
        if let Ok(mut state) = self.lock()
            && let Some(s) = state.as_mut()
        {
            let ms = s.origin.elapsed().as_millis();
            s.failed |= ms > 600_000;
            s.gate[index] = Some(ms.min(600_000) as u64);
        }
    }

    pub(super) fn snapshot(&self, id: u32) -> Value {
        // Freeze timing at the original failure snapshot, not at later page exports.
        if let Some(collector) = &self.latency {
            collector.freeze();
        }
        let mut value =
            json!({"id":id,"event":"gate11_diagnostic","state":"disabled","trace":null});
        if !self.enabled {
            return value;
        }
        let Ok(state) = self.lock() else {
            value["state"] = json!("capture_failed");
            return value;
        };
        let Some(s) = state.as_ref() else {
            value["state"] = json!("unavailable");
            return value;
        };
        let ms = s.origin.elapsed().as_millis();
        if s.failed || ms > 600_000 {
            value["state"] = json!("capture_failed");
            return value;
        }
        value["state"] = json!("captured");
        value["trace"] = json!({"admitted_ms":0,"consumed_ms":s.consumed,"snapshot_ms":ms as u64,
            "expected_deltas":s.expected,"expected_frames":s.frames,"await_counts":s.counters,
            "committed_counts":s.counts,"count_changes":s.changes,"gate_ms":s.gate,
            "history":s.history,"truncated":s.truncated});
        value
    }
}

pub(super) fn new_trace(enabled: bool) -> Option<Arc<Trace>> {
    enabled.then(|| Arc::new(Trace::new(true)))
}

pub(super) fn gate_trace(trace: Option<&Trace>, gate: usize) -> Option<&Trace> {
    trace.filter(|t| t.enabled && gate == 10)
}

pub(super) async fn await_phase<T>(
    trace: Option<&Trace>,
    phase: Phase,
    frame: usize,
    delta: usize,
    future: impl std::future::Future<Output = T>,
) -> T {
    if let Some(trace) = trace.filter(|t| t.enabled) {
        trace.during(phase, frame, delta, future).await
    } else {
        // No surrogate Trace or diagnostic hook on the original await path.
        future.await
    }
}

pub(super) fn counted(trace: Option<&Trace>, frame: usize, delta: usize, committed: usize) -> bool {
    if let Some(trace) = trace.filter(|t| t.enabled) {
        trace.counted(frame, delta, committed)
    } else {
        committed == delta
    }
}

pub(super) fn matching_updates(records: &[StoredEvent], id: &str) -> usize {
    records.iter().filter(|record| {
        matches!(record.payload(), StoredEventPayload::RuntimeObserved(event)
            if matches!(&event.event, RunEvent::ProviderEvent { event }
                if matches!(&event.event, ProviderEvent::OutputItemUpdated { response_id, .. } if response_id == id)))
    }).count()
}

pub(super) fn ordinary_cursor(
    gate: usize,
    records: &[StoredEvent],
    trace: Option<&Trace>,
) -> Option<FinalCursor> {
    // Only Task B's final burst uses this cursor; explicit comparisons keep their oracle.
    if gate != 10 || trace.is_some_and(|t| t.polling.is_some()) {
        return None;
    }
    Some(FinalCursor::new(records, "task-1-final"))
}

pub(super) struct FinalCursor {
    pub(super) sequence: u64,
    pub(super) committed: usize,
}
impl FinalCursor {
    pub(super) fn new(records: &[StoredEvent], id: &str) -> Self {
        assert!(!records.is_empty());
        assert!(
            records
                .iter()
                .enumerate()
                .all(|(i, r)| r.sequence() == i as u64 + 1)
        );
        assert_eq!(matching_updates(records, id), 0);
        Self {
            sequence: records.last().unwrap().sequence(),
            committed: 0,
        }
    }

    pub(super) fn observe(&mut self, records: &[StoredEvent], id: &str, sent: usize) -> usize {
        for record in records {
            assert_eq!(record.sequence(), self.sequence.checked_add(1).unwrap());
            // Unrelated immutable rows also advance the cursor, so they are not reread.
            self.sequence = record.sequence();
        }
        self.committed += matching_updates(records, id);
        assert!(self.committed <= sent, "fixture delta overshoot");
        self.committed
    }
}

pub(super) async fn reply(
    wire: &mut Wire,
    db: &Database,
    id: &str,
    frames: Vec<Value>,
    trace: Option<&Trace>,
    cursor: Option<FinalCursor>,
) {
    use crate::storage::test_hooks::latency::{self, Stage};
    let trace = trace.filter(|t| t.enabled);
    let latency = trace.and_then(|t| t.latency.as_ref());
    let mut cursor = cursor.or_else(|| trace.and_then(|t| t.cursor(id)));
    if let Some(trace) = trace {
        trace.expected(
            frames.len(),
            frames.iter().filter(|f| f.get("delta").is_some()).count(),
        );
    }
    let mut deltas = 0;
    for (index, frame) in frames.into_iter().enumerate() {
        let ordinal = index + 1;
        let is_delta = frame.get("delta").is_some();
        let delta = deltas + usize::from(is_delta);
        let timing = latency.map(|c| c.fixture(delta as u64));
        let _observation_time = if is_delta {
            timing
                .as_ref()
                .and_then(|c| c.span(Stage::DeltaObservation))
        } else {
            None
        };
        let _send_time = timing.as_ref().and_then(|c| c.marker(latency::SEND));
        await_phase(
            trace,
            Phase::Send,
            ordinal,
            delta,
            wire.reply(vec![frame], None),
        )
        .await;
        drop(_send_time);
        if is_delta {
            deltas += 1;
            // Pace the synthetic burst against real commits, not Chromium consumption.
            // This preserves the adapter's existing queue and slow-consumer guard.
            watch(async {
                loop {
                    let read = latency.map(|c| c.reader(deltas as u64));
                    let _read_time = read.as_ref().and_then(|c| c.span(Stage::Reader));
                    let records = if let Some(cursor) = &cursor {
                        let poll = await_phase(
                            trace,
                            Phase::Read,
                            ordinal,
                            deltas,
                            db.records_after(cursor.sequence),
                        );
                        if let Some(read) = &read {
                            read.scope(poll).await
                        } else {
                            poll.await
                        }
                    } else if let Some(read) = &read {
                        read.scope(await_phase(
                            trace,
                            Phase::Read,
                            ordinal,
                            deltas,
                            db.records(),
                        ))
                        .await
                    } else {
                        await_phase(trace, Phase::Read, ordinal, deltas, db.records()).await
                    };
                    let _count_time = read.as_ref().and_then(|c| c.marker(latency::COUNT));
                    let committed = if let Some(cursor) = &mut cursor {
                        cursor.observe(&records, id, deltas)
                    } else {
                        matching_updates(&records, id)
                    };
                    if let Some(read) = &read {
                        read.work(latency::COMPLETED_READS, 1);
                    }
                    drop(_count_time);
                    drop(_read_time);
                    if counted(trace, ordinal, deltas, committed) {
                        if let Some(timing) = &timing {
                            timing.work(latency::BARRIERS, 1);
                        }
                        break;
                    }
                    let _pace_time = timing.as_ref().and_then(|c| c.marker(latency::PACE));
                    await_phase(
                        trace,
                        Phase::Pace,
                        ordinal,
                        deltas,
                        tokio::time::sleep(Duration::from_millis(10)),
                    )
                    .await;
                }
            })
            .await;
        }
    }
}

#[test]
fn presentation_canaries_and_real_tool_inputs_are_distinct() {
    let data = data();
    let mut seen = std::collections::HashSet::new();
    for value in data.as_object().unwrap().values() {
        let text = value.as_str().unwrap();
        assert!(seen.insert(text));
        for marker in [
            "<script>",
            "<img",
            "onerror=",
            "javascript:",
            "\u{1b}",
            "雪",
        ] {
            assert!(text.contains(marker));
        }
    }
    for task in 0..2 {
        let calls = calls(task);
        assert_eq!(calls[2]["arguments"], ARGUMENTS[task]);
        assert_eq!(outputs(task)[0].1, OUTPUTS[task]);
        assert!(!outputs(task)[1].2 && outputs(task)[2].2);
        assert!(partial("fixture", task, 1).len() > 32);
    }
}

#[test]
fn presentation_deltas_done_and_terminal_keep_exact_public_and_native_items() {
    use crate::http_api::dto::{ItemView, ResponseView};
    use crate::providers::openai_codex::{codec::ResponseDecoder, consistency::Lifecycle};

    for (task, arguments) in ARGUMENTS.iter().enumerate() {
        let rich = calls(task);
        assert_eq!(rich.len(), 6);
        assert_eq!(rich[0]["summary"][0]["text"], text("summary"));
        assert_eq!(rich[0]["content"][0]["text"], text("reasoning"));
        assert_eq!(rich[1]["content"][0]["text"], text("text"));
        assert_eq!(rich[1]["content"][1]["refusal"], text("refusal"));
        assert_eq!(rich[2], call("add-雪", "add_numbers", arguments));
        assert_eq!(
            rich[3],
            call("skill", "load_skill", "{\"id\":\"project:presentation\"}")
        );
        assert_eq!(
            rich[4],
            call(
                "overflow",
                "add_numbers",
                "{\"a\":9223372036854775807,\"b\":1}"
            )
        );
        assert_eq!(
            rich[5],
            json!({"type":"reasoning","id":"opaque-reason","encrypted_content":"private-native-encrypted-only"})
        );
        assert_eq!(
            outputs(task)
                .iter()
                .map(|(id, _, error)| (*id, *error))
                .collect::<Vec<_>>(),
            [("add-雪", false), ("skill", false), ("overflow", true)]
        );

        let partial = partial("fixture", task, 0);
        assert_eq!(partial.len(), 16);
        for (index, frame) in partial[..6].iter().enumerate() {
            assert_eq!(frame["type"], "response.output_item.added");
            assert_eq!(frame["response_id"], "fixture");
            assert_eq!(frame["output_index"], index);
            assert_eq!(frame["item"]["id"], rich[index]["id"]);
        }
        assert_eq!(partial[0]["item"]["summary"], json!([]));
        assert_eq!(partial[0]["item"]["content"], json!([]));
        assert_eq!(partial[1]["item"]["content"], json!([]));
        assert_eq!(partial[2]["item"]["arguments"], "");
        assert_eq!(partial[2]["item"]["status"], "in_progress");
        for (frames, (kind, item, output, content, summary, key)) in partial[6..].chunks(2).zip([
            (
                "reasoning_summary_text",
                "reason",
                0,
                None,
                Some(0),
                "summary",
            ),
            ("reasoning_text", "reason", 0, Some(0), None, "reasoning"),
            ("output_text", "mixed", 1, Some(0), None, "text"),
            ("refusal", "mixed", 1, Some(1), None, "refusal"),
            (
                "function_call_arguments",
                "item-add-雪",
                2,
                None,
                None,
                "arguments",
            ),
        ]) {
            let value = text(key);
            let split = value.find('\n').unwrap() + 1;
            for (frame, delta) in frames.iter().zip([&value[..split], &value[split..]]) {
                assert_eq!(frame["item_id"], rich[output as usize]["id"]);
                assert_eq!(
                    *frame,
                    json!({"type":format!("response.{kind}.delta"),"response_id":"fixture","item_id":item,
                    "output_index":output,"content_index":content,"summary_index":summary,"delta":delta})
                );
            }
        }
        for (turn, items) in [rich, answer(task)].into_iter().enumerate() {
            let mut terminal = events("fixture", items.clone(), false);
            let mut frames = vec![terminal.remove(0)];
            frames.extend(self::partial("fixture", task, turn));
            let finished = done("fixture", &items);
            assert_eq!(finished.len(), items.len());
            for (index, frame) in finished.iter().enumerate() {
                assert_eq!(
                    *frame,
                    json!({"type":"response.output_item.done","response_id":"fixture","output_index":index,"item":items[index]})
                );
            }
            frames.extend(finished);
            frames.extend(terminal);
            let mut decoder = ResponseDecoder::default();
            let mut lifecycle = Lifecycle::default();
            let mut snapshots = vec![];
            for frame in frames {
                for event in decoder.apply(frame).unwrap() {
                    lifecycle.observe(&event).unwrap();
                    match event {
                        ProviderEvent::OutputItemFinished { item, .. } => {
                            snapshots.push(item.native)
                        }
                        ProviderEvent::ResponseFinished { response } => {
                            lifecycle.validate(&response).unwrap();
                            assert_eq!(snapshots, items);
                            assert_eq!(response.native["output"], json!(items));
                            assert_eq!(
                                response.output_provenance,
                                crate::OutputProvenance::NativeTerminal
                            );
                            assert_eq!(
                                response.text,
                                if turn == 0 {
                                    text("text") + &text("refusal")
                                } else {
                                    answer_text(task)
                                }
                            );
                            assert!(
                                response
                                    .output
                                    .iter()
                                    .all(|item| item.kind != crate::ItemKind::Unknown)
                            );
                            if turn == 0 {
                                let marker = &response.output[5];
                                assert_eq!(marker.kind, crate::ItemKind::Reasoning);
                                assert!(marker.function_call.is_none());
                                assert_eq!(
                                    serde_json::to_value(ItemView::from(marker)).unwrap(),
                                    json!({
                                        "item_id":"opaque-reason","kind":"reasoning","function_call":null,"content":[],"unsupported_content":true
                                    })
                                );
                                assert_eq!(
                                    response
                                        .output
                                        .iter()
                                        .filter(|item| item.function_call.is_some())
                                        .count(),
                                    3
                                );
                            }
                            let public =
                                serde_json::to_string(&ResponseView::from(&response)).unwrap();
                            assert!(
                                !public.contains("private-native")
                                    && !public.contains("encrypted_content")
                                    && !public.contains("opaque_response")
                            );
                        }
                        _ => {}
                    }
                }
            }
            assert!(decoder.finished);
        }
    }
}
