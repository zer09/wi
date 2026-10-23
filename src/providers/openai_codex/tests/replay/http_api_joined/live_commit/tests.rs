use super::*;
use crate::{
    DeltaKind, EventEnvelope, ProviderEvent,
    run::{RunEventEnvelope, RunRequest},
    storage::{AppendRunRecord, StoredEventId},
};

fn record(run: &RunId, sequence: u64, event: RunEvent) -> AppendRunRecord {
    let started = matches!(event, RunEvent::RunStarted);
    let no_turn = started || matches!(event, RunEvent::RunFinished { .. });
    let no_request = started || matches!(event, RunEvent::TurnStarted { .. });
    AppendRunRecord::Runtime(RunEventEnvelope {
        schema_version: 2,
        sequence,
        event_id: StoredEventId::new().as_str().into(),
        run_id: run.to_string(),
        session_id: (!started).then(|| "synthetic-session".into()),
        turn_id: (!no_turn).then(|| "54000000-0000-4000-8000-000000000001".into()),
        request_id: (!no_request).then(|| "54000000-0000-4000-8000-000000000002".into()),
        event,
    })
}
fn provider(run: &RunId, sequence: u64, event: ProviderEvent) -> AppendRunRecord {
    record(
        run,
        sequence,
        RunEvent::ProviderEvent {
            event: Box::new(EventEnvelope {
                schema_version: 1,
                sequence,
                event_id: "synthetic-envelope".into(),
                session_id: "synthetic-session".into(),
                request_id: Some("54000000-0000-4000-8000-000000000002".into()),
                provider: "synthetic".into(),
                provider_sequence: None,
                event,
            }),
        },
    )
}
fn update(text: &str) -> ProviderEvent {
    ProviderEvent::OutputItemUpdated {
        response_id: RESPONSE.into(),
        item_id: "answer".into(),
        output_index: 0,
        summary_index: None,
        content_index: Some(0),
        kind: DeltaKind::Text,
        delta: text.into(),
    }
}

#[test]
fn actual_fixture_codec_and_lifecycle_accept_terminal_prefix() {
    use crate::providers::openai_codex::{codec::ResponseDecoder, consistency::Lifecycle};
    for (text, accepted) in [("final 雪🙂", false), (FINAL, true)] {
        let mut decoder = ResponseDecoder::default();
        let mut lifecycle = Lifecycle::default();
        let mut final_item = item();
        final_item["content"][0]["text"] = json!(text);
        let mut frames = first_frames();
        frames.push(delta(DELTA));
        frames.push(json!({"type":"response.output_item.done","response_id":RESPONSE,"output_index":0,"item":final_item}));
        frames.extend(terminal_frames(final_item));
        let mut terminals = 0;
        for frame in frames {
            for event in decoder.apply(frame).unwrap() {
                lifecycle.observe(&event).unwrap();
                if let ProviderEvent::ResponseFinished { response } = event {
                    terminals += 1;
                    assert_eq!(lifecycle.validate(&response).is_ok(), accepted);
                }
            }
        }
        assert_eq!(terminals, 1);
    }
}

#[test]
fn scalar_fixture_lengths_and_protocol_admission() {
    assert_eq!(
        [FIRST.len(), DELTA.len(), APPEND.len(), FINAL.len()],
        [7, 6, 13, 19]
    );
    for bytes in [
        b"{\"command\":\"arm\",\"id\":2,\"extra\":1}\n".as_slice(),
        b"{\"command\":\"unknown\",\"id\":2}\n",
        b"{\"command\":\"arm\",\"id\":2,\"id\":3}\n",
        b"{\"command\":\"a\\rm\",\"id\":2}\n",
    ] {
        assert!(decode::<Control>(bytes).is_none());
    }
    assert!(decode::<Control>(b"{\"command\":\"first\",\"id\":2}\n").is_some());
}
#[test]
fn phases_reject_dom_dependent_release_and_early_final_or_terminal() {
    let mut order = Order {
        last: 1,
        ..Default::default()
    };
    assert!(!order.admit(&Control::Arm { id: 2 }, None));
    assert!(order.admit(&Control::First { id: 2 }, None));
    assert!(!order.admit(&Control::First { id: 3 }, None));
    assert!(!order.admit(&Control::Second { id: 3 }, None));
    assert!(!order.admit(&Control::Page { id: 3, page: 0 }, None));
    assert!(order.admit(&Control::Stop { id: 3 }, None));
    assert!(!order.admit(&Control::First { id: 4 }, None));
}

#[tokio::test]
async fn actual_storage_selected_append_freezes_complete_leaves_and_short_snapshot_before_release()
{
    // This is direct real-storage input, not a model, HTTP request, or joined producer run.
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let store = SessionStore::open(root.join("private-data")).await.unwrap();
    let created = store
        .create_session(CreateSession::new(OperationId::new(), "scalar".into(), None).unwrap())
        .await
        .unwrap();
    let sid = created.session_id().clone();
    let mut keeper = Keeper::default();
    keeper.open(root, &sid).await;
    assert!(keeper.initialized);
    let sql = keeper.connection.as_mut().unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA busy_timeout")
            .fetch_one(&mut *sql)
            .await
            .unwrap(),
        0
    );
    assert!(
        sqlx::query("UPDATE manifest SET head_sequence=head_sequence")
            .execute(&mut *sql)
            .await
            .is_err()
    );
    let handle = store.open_session(sid.clone()).await.unwrap();
    let run = RunId::new();
    let input = RecordedRunInput::new(
        TASK.into(),
        RunRequest {
            provider_id: "synthetic".into(),
            options: SessionOptions::new("synthetic"),
            prompt: "private-test-prompt".into(),
        },
        vec![],
        vec![],
        vec![],
        None,
    )
    .unwrap();
    handle
        .accept_run(OperationId::new(), run.clone(), input)
        .await
        .unwrap();
    for (n, event) in [RunEvent::RunStarted, RunEvent::TurnStarted { number: 1 }]
        .into_iter()
        .enumerate()
    {
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![record(&run, n as u64 + 1, event)],
            )
            .await
            .unwrap();
    }
    let readers = Readers::default();
    let hooks = handle.test_hooks();
    let collector = hooks.enable_latency();
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![provider(&run, 3, update(FIRST))],
        )
        .await
        .unwrap();
    let first = snapshot(root, &sid, FIRST, None, &readers).await;
    let pause = Arc::new(Pause::default());
    hooks.arm_record(
        Record::PartialText,
        Point::AfterCommit,
        Action::Pause(pause.clone()),
    );
    collector.open();
    let operation = OperationId::new();
    let selected = operation.clone();
    let h = handle.clone();
    let r = run.clone();
    let writer = tokio::spawn(async move {
        h.append_run_records(selected, r.clone(), vec![provider(&r, 4, update(DELTA))])
            .await
            .unwrap()
    });
    watch(pause.reached.notified()).await;
    collector.freeze();
    assert_eq!(pause.hits.load(Ordering::SeqCst), 1);
    let second = snapshot(root, &sid, APPEND, Some(&operation), &readers).await;
    assert!(first.valid("first") && second.valid("append"));
    assert_eq!(first.session_id, second.session_id);
    assert_eq!(first.run_id, second.run_id);
    assert_eq!(first.entry_id, second.entry_id);
    assert_eq!(first.field_id, second.field_id);
    assert!(second.head > first.head);
    assert_eq!(second.generation, first.generation);
    assert_eq!(second.content_epoch, first.content_epoch);
    let selected = selected_leaves(&collector);
    assert_eq!(selected.len(), 5);
    let pages = collector.page(0).unwrap().0;
    let rows: Vec<_> = (0..pages)
        .flat_map(|p| collector.page(p).unwrap().1)
        .collect();
    assert_eq!(rows[0][6..8], [0, 0]);
    let ops: Vec<_> = rows
        .iter()
        .filter(|r| r[0] == 3 && r[2] == 1 && r[3] == 2)
        .collect();
    assert_eq!(ops.len(), 1);
    let op = ops[0][1];
    let leaves: Vec<_> = rows
        .iter()
        .filter(|r| r[0] == 2 && r[2] == op && [20, 21, 22].contains(&r[1]))
        .collect();
    assert_eq!(
        leaves.iter().map(|r| r[1]).collect::<Vec<_>>(),
        [20, 21, 21, 21, 22]
    );
    assert!(
        leaves
            .iter()
            .all(|r| r[4] == 2 && r[7] == 0 && r[8] == 0 && r[6] >= r[5])
    );
    assert!(leaves.windows(2).all(|w| w[0][6] <= w[1][5]));
    assert!(
        rows.iter()
            .any(|r| r[0] == 2 && r[2] == op && r[1] == 2 && r[7] == 1)
    );
    assert_eq!(readers.facts()["active"], 0);
    assert_eq!(keeper.facts().active, 1);
    assert_eq!(keeper.totals(&readers).unwrap().active, 1);
    pause.release.notify_one();
    assert!(publish(
        &mut std::io::stdout(),
        &json!({"protocol":1,"event":"captured","id":5,"saved":second,
        "operation_id":operation,"pause_hits":1,"reader_closed":true,"released":true,"pages":pages,
        "readers":readers.facts(),"keeper":keeper.facts(),"totals":keeper.totals(&readers)})
    ));
    let receipt = watch(writer).await.unwrap();
    assert_eq!(receipt.receipt().operation_id(), &operation);
    assert_eq!(receipt.receipt().session_id(), &sid);
    assert_eq!(receipt.receipt().run_id(), Some(&run));
    assert_eq!(receipt.receipt().first_sequence(), second.head);
    assert_eq!(receipt.receipt().last_sequence(), second.head);
    assert_eq!(
        rows,
        (0..pages)
            .flat_map(|p| collector.page(p).unwrap().1)
            .collect::<Vec<_>>()
    );
    let final_item = crate::OutputItem {
        id: Some("answer".into()),
        kind: crate::ItemKind::Message,
        native_type: "message".into(),
        function_call: None,
        native: item(),
    };
    let mut authoritative = None;
    for sequence in [5, 6] {
        handle
            .append_run_records(
                OperationId::new(),
                run.clone(),
                vec![provider(
                    &run,
                    sequence,
                    ProviderEvent::OutputItemFinished {
                        response_id: RESPONSE.into(),
                        output_index: 0,
                        item: final_item.clone(),
                    },
                )],
            )
            .await
            .unwrap();
        let state = snapshot(root, &sid, FINAL, None, &readers).await;
        assert!(state.valid("authoritative"));
        assert_eq!(state.content_epoch, second.content_epoch);
        assert_eq!(state.entry_id, second.entry_id);
        assert_eq!(state.field_id, second.field_id);
        assert!(state.generation > second.generation);
        if let Some(prior) = &authoritative {
            let prior: &Saved = prior;
            assert_eq!(state.generation, prior.generation);
            assert_eq!(state.content_epoch, prior.content_epoch);
        }
        authoritative = Some(state);
    }
    let response = crate::ModelResponse {
        output_provenance: crate::OutputProvenance::NativeTerminal,
        id: RESPONSE.into(),
        model: Some(MODEL.into()),
        outcome: crate::ResponseOutcome::Completed,
        output: vec![final_item],
        text: FINAL.into(),
        usage: None,
        native: json!({}),
    };
    let summary = crate::run::RunSummary {
        turns_started: 1,
        turns_finished: 1,
        model_requests_attempted: 1,
        model_requests_admitted: 1,
        last_request_id: Some("54000000-0000-4000-8000-000000000002".into()),
        last_upstream_outcome: Some(crate::UpstreamOutcome::TerminalReceived),
        ..Default::default()
    };
    for record in [
        provider(
            &run,
            7,
            ProviderEvent::ResponseFinished {
                response: response.clone(),
            },
        ),
        record(
            &run,
            8,
            RunEvent::TurnFinished {
                number: 1,
                response_id: Some(RESPONSE.into()),
                outcome: crate::run::TurnOutcome::ModelCompleted,
                upstream_outcome: Some(crate::UpstreamOutcome::TerminalReceived),
            },
        ),
        record(
            &run,
            9,
            RunEvent::RunFinished {
                outcome: RunOutcome::Completed,
                summary: summary.clone(),
            },
        ),
    ] {
        handle
            .append_run_records(OperationId::new(), run.clone(), vec![record])
            .await
            .unwrap();
    }
    let before_result = snapshot(root, &sid, FINAL, None, &readers).await;
    assert!(!before_result.valid("terminal"));
    handle
        .append_run_records(
            OperationId::new(),
            run.clone(),
            vec![AppendRunRecord::Result(crate::run::RunResult {
                run_id: run.to_string(),
                session_id: Some("synthetic-session".into()),
                outcome: RunOutcome::Completed,
                summary,
                last_response: Some(response),
                events_complete: true,
                sink_error: None,
            })],
        )
        .await
        .unwrap();
    let terminal = snapshot(root, &sid, FINAL, None, &readers).await;
    let authoritative = authoritative.unwrap();
    assert!(terminal.valid("terminal"));
    assert_eq!(terminal.generation, authoritative.generation);
    assert_eq!(terminal.content_epoch, authoritative.content_epoch);
    assert_eq!(terminal.entry_id, authoritative.entry_id);
    assert_eq!(terminal.field_id, authoritative.field_id);
    assert_eq!(readers.facts()["active"], 0);
    store.close().await.unwrap();
    assert!(keeper.close().await);
    assert!(keeper.close().await);
    assert_eq!(keeper.facts().closed, 1);
    assert_eq!(keeper.totals(&readers).unwrap().active, 0);
    temp.close().unwrap();
}

fn saved(kind: &str, head: u64) -> Saved {
    let terminal = kind == "terminal";
    let text = match kind {
        "first" => FIRST,
        "append" => APPEND,
        _ => FINAL,
    };
    Saved {
        session_id: ApplicationSessionId::new(),
        run_id: RunId::new(),
        entry_id: "e:5:0".into(),
        field_id: hash(b"field"),
        head,
        projection_head: head,
        generation: 5,
        content_epoch: 5,
        bytes: text.len(),
        sha256: hash(text.as_bytes()),
        matches: true,
        provisional: !terminal,
        entry_state: if terminal { "completed" } else { "in_progress" }.into(),
        run_state: if terminal { "completed" } else { "running" }.into(),
        result_recorded: terminal,
        response_finished: terminal,
        run_finished: terminal,
        events_complete: terminal.then_some(true),
    }
}

#[test]
fn full_phase_admission_rejects_every_premature_drive_and_wrong_predicate() {
    let first = saved("first", 6);
    let mut second = saved("append", 7);
    second.session_id = first.session_id.clone();
    second.run_id = first.run_id.clone();
    let authoritative = saved("authoritative", 8);
    let terminal = saved("terminal", 12);
    let mut order = Order {
        last: 1,
        ..Default::default()
    };
    assert!(order.admit(&Control::First { id: 2 }, None));
    let mut wrong = first.clone();
    wrong.bytes += 1;
    assert!(!order.admit(
        &Control::ObservedFirst {
            id: 3,
            observed: wrong
        },
        Some(&first)
    ));
    assert!(order.admit(
        &Control::ObservedFirst {
            id: 3,
            observed: first.clone()
        },
        Some(&first)
    ));
    assert!(order.admit(&Control::Arm { id: 4 }, Some(&first)));
    assert!(!order.admit(
        &Control::Authoritative {
            id: 5,
            observed: first.clone()
        },
        Some(&first)
    ));
    assert!(order.admit(&Control::Second { id: 5 }, Some(&first)));
    // Second's independent reader and release finish before the next command can be admitted.
    order.pages = 2;
    assert!(!order.admit(
        &Control::Authoritative {
            id: 6,
            observed: second.clone()
        },
        Some(&second)
    ));
    assert!(!order.admit(&Control::Page { id: 6, page: 1 }, Some(&second)));
    assert!(order.admit(&Control::Page { id: 6, page: 0 }, Some(&second)));
    assert!(order.admit(&Control::Page { id: 7, page: 1 }, Some(&second)));
    assert!(!order.admit(
        &Control::Terminal {
            id: 8,
            observed: second.clone()
        },
        Some(&second)
    ));
    assert!(order.admit(
        &Control::Authoritative {
            id: 8,
            observed: second.clone()
        },
        Some(&second)
    ));
    assert!(!order.admit(
        &Control::Terminal {
            id: 9,
            observed: terminal.clone()
        },
        Some(&authoritative)
    ));
    assert!(order.admit(
        &Control::Terminal {
            id: 9,
            observed: authoritative.clone()
        },
        Some(&authoritative)
    ));
    assert!(!order.admit(
        &Control::ObservedTerminal {
            id: 10,
            observed: authoritative.clone()
        },
        Some(&authoritative)
    ));
    assert!(order.admit(
        &Control::ObservedTerminal {
            id: 10,
            observed: terminal.clone()
        },
        Some(&terminal)
    ));
    assert!(order.admit(&Control::Stop { id: 11 }, Some(&terminal)));
    assert!(!order.admit(&Control::Stop { id: 12 }, Some(&terminal)));
    let mut exhausted = Order {
        last: u32::MAX,
        ..Default::default()
    };
    assert!(!exhausted.admit(&Control::Stop { id: 0 }, None));
    for kind in ["first", "append", "authoritative", "terminal"] {
        let state = saved(kind, 12);
        assert!(state.valid(kind));
        for key in [
            "head",
            "projection_head",
            "generation",
            "content_epoch",
            "bytes",
            "sha256",
            "matches",
            "provisional",
            "entry_state",
            "run_state",
            "result_recorded",
            "response_finished",
            "run_finished",
            "events_complete",
        ] {
            let mut value = serde_json::to_value(&state).unwrap();
            value[key] = match key {
                "head" | "projection_head" | "generation" | "content_epoch" | "bytes" => json!(0),
                "sha256" | "entry_state" | "run_state" => json!("wrong"),
                "events_complete" => {
                    if kind == "terminal" {
                        Value::Null
                    } else {
                        json!(true)
                    }
                }
                _ => json!(!value[key].as_bool().unwrap()),
            };
            assert!(
                !serde_json::from_value::<Saved>(value).unwrap().valid(kind),
                "predicate {key}"
            );
        }
    }
}

#[tokio::test]
async fn independent_reader_closes_after_sql_failure_and_assertion_before_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("private-data"))
        .await
        .unwrap();
    let sid = store
        .create_session(CreateSession::new(OperationId::new(), "reader".into(), None).unwrap())
        .await
        .unwrap()
        .session_id()
        .clone();
    let readers = Readers::default();
    for sql_failure in [true, false] {
        let result = AssertUnwindSafe(read_owned(temp.path(), &sid, &readers, move |sql, _| {
            Box::pin(async move {
                if sql_failure {
                    sqlx::query("SELECT missing_column FROM manifest")
                        .execute(sql)
                        .await
                        .unwrap();
                } else {
                    let _tx = sql.begin().await.unwrap();
                    panic!("synthetic assertion");
                }
            })
        }))
        .catch_unwind()
        .await;
        assert!(result.is_err());
        assert_eq!(
            readers.opened.load(Ordering::SeqCst),
            readers.closed.load(Ordering::SeqCst)
        );
    }
    store.close().await.unwrap();
    temp.close().unwrap();
}

#[tokio::test]
async fn counters_read_actual_auth_and_registered_existing_tool_work() {
    use crate::tools::Tool;
    let counts = Arc::new(Counts::default());
    let auth = CountedAuth::new(TOKEN_A, ACCOUNT);
    let zero = work(&auth, &counts, 0, false);
    assert_eq!(zero.auth_loads, 0);
    assert_eq!(zero.tool_validations, 0);
    assert_eq!(zero.tool_executions, 0);
    auth.prepare_submission().await.unwrap();
    let _ = auth.load().await.unwrap();
    let tool = CountedAdd {
        counts: counts.clone(),
    };
    assert!(tool.validate(&json!({"a":1})).is_err());
    tool.validate(&json!({"a":1,"b":2})).unwrap();
    assert_eq!(
        tool.execute(json!({"a":1,"b":2})).await.unwrap(),
        json!({"sum":3})
    );
    let actual = work(&auth, &counts, 1, true);
    assert_eq!(actual.auth_loads, 1);
    assert_eq!(actual.auth_prepares, 1);
    assert_eq!(actual.tool_validations, 2);
    assert_eq!(actual.tool_executions, 1);
    assert_eq!(actual.completed, 0);
}

#[test]
fn tracker_owns_closed_phase_origin_and_reader_facts_without_panic_payload() {
    let phases = [
        Phase::SetupControl,
        Phase::Setup,
        Phase::ReadyEmit,
        Phase::ControlReceive,
        Phase::ControlAdmission,
        Phase::FirstWireReceive,
        Phase::AcceptanceRead,
        Phase::AcceptanceDecode,
        Phase::TaskMatch,
        Phase::ProviderRequestMatch,
        Phase::FirstWireReply,
        Phase::Settle,
        Phase::Snapshot,
        Phase::SavedValidation,
        Phase::FirstEmit,
        Phase::ObservedFirst,
        Phase::Arm,
        Phase::Second,
        Phase::Page,
        Phase::Authoritative,
        Phase::Terminal,
        Phase::ObservedTerminal,
        Phase::Stop,
        Phase::Cleanup,
        Phase::StoppedEmit,
    ];
    for origin in [Origin::Run, Origin::Cleanup] {
        for phase in phases {
            let readers = Readers::default();
            let mut tracker = Tracker::default();
            tracker.complete();
            tracker.begin(phase);
            tracker.freeze(origin, &readers, &Keeper::default());
            let first = tracker.first.clone().unwrap();
            assert_eq!(first.phase, phase);
            assert_eq!(first.origin, origin);
            assert_eq!(first.last_completed, Some(Phase::SetupControl));
            let bytes = serde_json::to_vec(&first).unwrap();
            assert_eq!(serde_json::from_slice::<Failure>(&bytes).unwrap(), first);
            tracker.begin(Phase::Cleanup);
            tracker.freeze(Origin::Cleanup, &readers, &Keeper::default());
            assert_eq!(tracker.first, Some(first));
        }
    }
    let readers = Readers::default();
    readers.closed.store(1, Ordering::SeqCst);
    assert!(readers.diagnostic().is_none());
    assert!(serde_json::from_str::<Phase>("\"unknown\"").is_err());
    assert!(serde_json::from_str::<Origin>("\"unknown\"").is_err());
}

struct FailureWriter {
    stop: CancellationToken,
    bytes: Vec<u8>,
    first_flushed_before_cleanup: bool,
    fault: u8,
}
impl Write for FailureWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.fault == 1 {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        if self.fault == 2 {
            panic!("unpublished writer payload");
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if !self.stop.is_cancelled() {
            self.first_flushed_before_cleanup = true;
        }
        if self.fault == 3 {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        Ok(())
    }
}
#[tokio::test]
async fn caught_run_failure_flushes_before_cleanup_and_publication_faults_do_not_prevent_close() {
    for fault in 0..=3 {
        let mut resources = Resources::default();
        resources.tracker.begin(Phase::FirstWireReply);
        let mut out = FailureWriter {
            stop: resources.stop.clone(),
            bytes: vec![],
            first_flushed_before_cleanup: false,
            fault,
        };
        let result = std::panic::catch_unwind(|| panic!("unpublished original payload"));
        assert!(!finish(result, &mut resources, &mut out).await);
        assert!(resources.stop.is_cancelled());
        let first = resources.tracker.first.unwrap();
        assert_eq!(first.origin, Origin::Run);
        assert_eq!(first.phase, Phase::FirstWireReply);
        if fault == 0 {
            assert!(out.first_flushed_before_cleanup);
            let frames: Vec<Value> = out
                .bytes
                .split(|b| *b == b'\n')
                .filter(|b| !b.is_empty())
                .map(|b| serde_json::from_slice(b).unwrap())
                .collect();
            assert_eq!(frames.len(), 2);
            assert_eq!(frames[0]["event"], "failed");
            assert_eq!(frames[1]["event"], "failure_cleanup");
            assert_eq!(frames[1]["outcome"], "closed");
            assert!(!String::from_utf8(out.bytes).unwrap().contains("payload"));
        }
    }
}
#[tokio::test]
async fn cleanup_failure_is_separate_and_never_replaces_run_failure_or_unavailable_readers() {
    for run_failed in [false, true] {
        let mut resources = Resources::default();
        resources.tracker.begin(Phase::AcceptanceDecode);
        resources.readers.closed.store(1, Ordering::SeqCst);
        let result = if run_failed {
            Err(Box::new(()) as Box<dyn std::any::Any + Send>)
        } else {
            Ok(2)
        };
        let mut out = vec![];
        assert!(!finish(result, &mut resources, &mut out).await);
        let first = resources.tracker.first.unwrap();
        assert_eq!(
            first.origin,
            if run_failed {
                Origin::Run
            } else {
                Origin::Cleanup
            }
        );
        assert_eq!(
            first.phase,
            if run_failed {
                Phase::AcceptanceDecode
            } else {
                Phase::Cleanup
            }
        );
        assert!(first.readers.is_none());
        let frames: Vec<Value> = out
            .split(|b| *b == b'\n')
            .filter(|b| !b.is_empty())
            .map(|b| serde_json::from_slice(b).unwrap())
            .collect();
        assert_eq!(frames[0]["readers"], Value::Null);
        assert_eq!(frames[1]["outcome"], "failed");
        assert_eq!(frames[1]["readers"], Value::Null);
    }
}

#[tokio::test]
async fn partial_resources_close_store_and_release_pause_without_removing_parent_root() {
    let temp = tempfile::tempdir().unwrap();
    let mut resources = Resources::default();
    resources.close().await;
    resources.store = Some(
        SessionStore::open(temp.path().join("private-data"))
            .await
            .unwrap(),
    );
    let pause = Arc::new(Pause::default());
    resources.pause = Some(pause.clone());
    resources.close().await;
    watch(pause.release.notified()).await;
    assert!(temp.path().join("private-data").is_dir());
    resources.close().await;
    temp.close().unwrap();
}

async fn reader_database(root: &Path, sid: &ApplicationSessionId) -> SqliteConnection {
    let path = db_path(root, sid);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}

#[tokio::test]
async fn reader_connect_and_both_real_settle_query_boundaries_close_before_unwind() {
    for boundary in [
        ReaderStage::Connect,
        ReaderStage::SettleChunks,
        ReaderStage::SettleResults,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let sid = ApplicationSessionId::new();
        if boundary != ReaderStage::Connect {
            let mut sql = reader_database(temp.path(), &sid).await;
            if boundary == ReaderStage::SettleResults {
                sqlx::raw_sql("CREATE TABLE conversation_entries(run_id TEXT,entry_id TEXT,kind TEXT); CREATE TABLE conversation_chunks(run_id TEXT,entry_id TEXT,start_byte INTEGER,bytes BLOB);")
                    .execute(&mut sql).await.unwrap();
            }
            sql.close().await.unwrap();
        }
        let readers = Readers::default();
        *readers.settle.lock().unwrap() = Some((1, tokio::time::Instant::now()));
        let result = AssertUnwindSafe(read_owned(temp.path(), &sid, &readers, |sql, readers| {
            Box::pin(settle_queries(sql, readers))
        }))
        .catch_unwind()
        .await;
        assert!(result.is_err());
        let first = readers.first.lock().unwrap().clone().unwrap();
        assert_eq!(first.first.stage, boundary);
        assert_eq!(first.first.driver, Driver::SqliteOther);
        assert_eq!(
            first.first.sqlite_primary,
            Some(if boundary == ReaderStage::Connect {
                14
            } else {
                1
            })
        );
        assert_eq!(first.first.attempt, Some(1));
        assert!(first.first.elapsed_ms.is_some());
        assert!(first.close.is_none());
        assert_eq!(readers.facts()["active"], 0);
        assert_eq!(
            readers.facts()["opened"],
            usize::from(boundary != ReaderStage::Connect)
        );
        // These counters describe returned connections, not failed-acquisition worker retirement.
        temp.close().unwrap();
    }
}

#[tokio::test]
async fn reader_real_decode_has_no_database_code_and_first_survives_close_error() {
    let temp = tempfile::tempdir().unwrap();
    let sid = ApplicationSessionId::new();
    let mut sql = reader_database(temp.path(), &sid).await;
    sqlx::raw_sql("CREATE TABLE conversation_entries(run_id TEXT,entry_id TEXT,kind TEXT); CREATE TABLE conversation_chunks(run_id TEXT,entry_id TEXT,start_byte INTEGER,bytes INTEGER); INSERT INTO conversation_entries VALUES('r','e','assistant'); INSERT INTO conversation_chunks VALUES('r','e',0,42);")
        .execute(&mut sql).await.unwrap();
    sql.close().await.unwrap();
    let mut resources = Resources::default();
    resources.tracker.begin(Phase::Settle);
    *resources.readers.settle.lock().unwrap() = Some((3, tokio::time::Instant::now()));
    *resources.readers.close_error.lock().unwrap() =
        Some(sqlx::Error::Io(std::io::ErrorKind::BrokenPipe.into()));
    let result = AssertUnwindSafe(read_owned(
        temp.path(),
        &sid,
        &resources.readers,
        |sql, readers| Box::pin(settle_queries(sql, readers)),
    ))
    .catch_unwind()
    .await;
    let payload = result.unwrap_err();
    let original = &payload.downcast_ref::<ReaderPanic>().unwrap().0;
    assert_eq!(original.stage, ReaderStage::SettleChunks);
    assert_eq!(original.driver, Driver::Decode);
    assert_eq!(original.sqlite_primary, None);
    assert_eq!(original.sqlite_extended, None);
    assert_eq!(resources.readers.facts()["active"], 1);
    let mut out = vec![];
    assert!(!finish(Err(payload), &mut resources, &mut out).await);
    let frames: Vec<Value> = out
        .split(|b| *b == b'\n')
        .filter(|b| !b.is_empty())
        .map(|b| serde_json::from_slice(b).unwrap())
        .collect();
    let first = &frames[0]["reader_error"];
    assert_eq!(first["first"]["driver"], "decode");
    assert_eq!(first["close"]["driver"], "io");
    assert_eq!(frames[0]["phase"], "settle");
    assert_eq!(frames[1]["outcome"], "failed");
    assert_eq!(frames[1]["readers"]["active"], 1);
    assert!(!String::from_utf8(out).unwrap().contains("42"));
    temp.close().unwrap();
}

#[tokio::test]
async fn reader_unknown_sync_and_async_panics_are_opaque_and_close_remains_fatal() {
    let temp = tempfile::tempdir().unwrap();
    let sid = ApplicationSessionId::new();
    reader_database(temp.path(), &sid)
        .await
        .close()
        .await
        .unwrap();
    for mode in 0..4 {
        let readers = Readers::default();
        if mode >= 2 {
            *readers.close_error.lock().unwrap() =
                Some(sqlx::Error::Protocol("unpublished close".into()));
        }
        let result = AssertUnwindSafe(read_owned(temp.path(), &sid, &readers, move |_, _| {
            if mode == 0 {
                panic!("unpublished immediate action");
            }
            Box::pin(async move {
                if mode != 2 {
                    panic!("unpublished action payload");
                }
            })
        }))
        .catch_unwind()
        .await;
        assert!(result.is_err());
        let first = readers.first.lock().unwrap().clone().unwrap();
        assert_eq!(
            first.first.stage,
            if mode == 2 {
                ReaderStage::Close
            } else {
                ReaderStage::Action
            }
        );
        assert_eq!(
            first.first.driver,
            if mode == 2 {
                Driver::Protocol
            } else {
                Driver::Panic
            }
        );
        assert_eq!(first.close.is_some(), mode == 3);
        assert_eq!(readers.facts()["active"], usize::from(mode >= 2));
        assert!(first.first.attempt.is_none());
        let bytes = serde_json::to_vec(&first).unwrap();
        assert!(!String::from_utf8(bytes).unwrap().contains("unpublished"));
    }
    temp.close().unwrap();
}

#[tokio::test]
async fn reader_controlled_exclusive_and_shared_cache_locks_classify_busy_and_locked() {
    let temp = tempfile::tempdir().unwrap();
    for shared in [false, true] {
        let options = SqliteConnectOptions::new()
            .filename(temp.path().join(if shared {
                "shared.sqlite3"
            } else {
                "busy.sqlite3"
            }))
            .create_if_missing(true)
            .shared_cache(shared)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging();
        let mut writer = options.connect().await.unwrap();
        sqlx::raw_sql("CREATE TABLE conversation_entries(run_id TEXT,entry_id TEXT,kind TEXT); CREATE TABLE conversation_chunks(run_id TEXT,entry_id TEXT,start_byte INTEGER,bytes BLOB); CREATE TABLE runs(result_sequence INTEGER);")
            .execute(&mut writer).await.unwrap();
        let mut reader = options.read_only(true).connect().await.unwrap();
        sqlx::raw_sql("BEGIN EXCLUSIVE; INSERT INTO conversation_chunks VALUES('r','e',0,X'01');")
            .execute(&mut writer)
            .await
            .unwrap();
        let readers = Readers::default();
        *readers.settle.lock().unwrap() = Some((1, tokio::time::Instant::now()));
        let result = AssertUnwindSafe(settle_queries(&mut reader, &readers))
            .catch_unwind()
            .await;
        let payload = result.unwrap_err();
        let issue = &payload.downcast_ref::<ReaderPanic>().unwrap().0;
        assert_eq!(issue.stage, ReaderStage::SettleChunks);
        assert_eq!(
            issue.driver,
            if shared {
                Driver::SqliteLocked
            } else {
                Driver::SqliteBusy
            }
        );
        assert_eq!(issue.sqlite_primary, Some(if shared { 6 } else { 5 }));
        assert_eq!(issue.sqlite_primary, issue.sqlite_extended.map(|n| n & 255));
        reader.close().await.unwrap();
        sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();
        writer.close().await.unwrap();
    }
    // Controlled locks classify the driver; they do not reproduce the historical WAL race.
    temp.close().unwrap();
}

#[test]
fn reader_numeric_codes_null_availability_and_strict_serialization() {
    for (code, expected) in [
        (Some("5"), Some(5)),
        (Some("6"), Some(6)),
        (Some("261"), Some(261)),
        (Some("517"), Some(517)),
        (Some("1"), Some(1)),
        (None, None),
        (Some(""), None),
        (Some("unknown"), None),
        (Some("-1"), None),
        (Some("0"), None),
        (Some("256"), None),
        (Some("2147483648"), None),
    ] {
        let (primary, extended) = sqlite_codes(code);
        assert_eq!(extended, expected);
        assert_eq!(primary, expected.map(|n| n & 255));
        let driver = match primary {
            Some(5) => Driver::SqliteBusy,
            Some(6) => Driver::SqliteLocked,
            _ => Driver::SqliteOther,
        };
        let mut issue = Readers::default().issue(ReaderStage::Connect, driver);
        issue.sqlite_primary = primary;
        issue.sqlite_extended = extended;
        let value = serde_json::to_value(&issue).unwrap();
        for key in [
            "stage",
            "driver",
            "sqlite_primary",
            "sqlite_extended",
            "attempt",
            "elapsed_ms",
        ] {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(serde_json::from_value::<ReaderIssue>(missing).is_err());
        }
        assert_eq!(
            serde_json::from_value::<ReaderIssue>(value.clone()).unwrap(),
            issue
        );
        for (key, invalid) in [
            ("sqlite_primary", json!(999)),
            ("sqlite_extended", json!(2147483648u64)),
            ("attempt", json!(0)),
            ("stage", json!("unknown")),
            ("driver", json!("unknown")),
            ("payload", json!("unpublished")),
        ] {
            let mut changed = value.clone();
            changed[key] = invalid;
            assert!(serde_json::from_value::<ReaderIssue>(changed).is_err());
        }
        let line = serde_json::to_string(&issue)
            .unwrap()
            .replace("\"stage\":", "\"stage\":\"connect\",\"stage\":");
        assert!(serde_json::from_str::<ReaderIssue>(&line).is_err());
    }
    for error in [
        sqlx::Error::Decode("unpublished".into()),
        sqlx::Error::Io(std::io::ErrorKind::Other.into()),
        sqlx::Error::Protocol("unpublished".into()),
        sqlx::Error::PoolClosed,
        sqlx::Error::RowNotFound,
    ] {
        let issue = Readers::default().sql_error(ReaderStage::Connect, &error);
        assert!(issue.sqlite_primary.is_none() && issue.sqlite_extended.is_none());
        assert!(
            !serde_json::to_string(&issue)
                .unwrap()
                .contains("unpublished")
        );
    }
}

#[tokio::test]
async fn reader_failure_frames_are_safe_and_publication_faults_preserve_first_and_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let sid = ApplicationSessionId::new();
    reader_database(temp.path(), &sid)
        .await
        .close()
        .await
        .unwrap();
    for fault in 0..=3 {
        let mut resources = Resources::default();
        resources.tracker.begin(Phase::Settle);
        *resources.readers.settle.lock().unwrap() = Some((2, tokio::time::Instant::now()));
        *resources.readers.close_error.lock().unwrap() =
            Some(sqlx::Error::Io(std::io::ErrorKind::BrokenPipe.into()));
        let result = AssertUnwindSafe(read_owned(
            temp.path(),
            &sid,
            &resources.readers,
            |sql, readers| Box::pin(settle_queries(sql, readers)),
        ))
        .catch_unwind()
        .await
        .map(|_| 2);
        let mut out = FailureWriter {
            stop: resources.stop.clone(),
            bytes: vec![],
            first_flushed_before_cleanup: false,
            fault,
        };
        assert!(!finish(result, &mut resources, &mut out).await);
        assert!(resources.stop.is_cancelled());
        let first = resources.tracker.first.as_ref().unwrap();
        assert_eq!(first.phase, Phase::Settle);
        assert_eq!(first.origin, Origin::Run);
        let reader = first.reader_error.as_ref().unwrap();
        assert_eq!(reader.first.stage, ReaderStage::SettleChunks);
        assert_eq!(reader.close.as_ref().unwrap().stage, ReaderStage::Close);
        if fault == 0 {
            assert!(out.first_flushed_before_cleanup);
            let frames: Vec<Value> = out
                .bytes
                .split(|b| *b == b'\n')
                .filter(|b| !b.is_empty())
                .map(|b| serde_json::from_slice(b).unwrap())
                .collect();
            assert_eq!(frames.len(), 2);
            assert_eq!(frames[1]["outcome"], "failed");
            assert_eq!(frames[0]["reader_error"]["first"]["sqlite_primary"], 1);
            // This closed synthetic frame feeds the offline Rust-to-Node/B compatibility check.
            assert!(publish(&mut std::io::stdout(), &frames[0]));
        }
        assert!(!String::from_utf8(out.bytes).unwrap().contains("sqlite3"));
    }
    temp.close().unwrap();
}

#[test]
fn reader_watchdog_uses_real_elapsed_without_sleep_and_first_is_immutable() {
    let readers = Readers::default();
    let started = tokio::time::Instant::now() - Duration::from_secs(31);
    *readers.settle.lock().unwrap() = Some((8, started));
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| readers.watchdog(started)));
    assert!(result.is_err());
    let first = readers.first.lock().unwrap().clone().unwrap();
    assert_eq!(first.first.stage, ReaderStage::SettleWatchdog);
    assert_eq!(first.first.driver, Driver::Watchdog);
    assert_eq!(first.first.attempt, Some(8));
    assert!(first.first.elapsed_ms.unwrap() >= 31000);
    readers.freeze(readers.issue(ReaderStage::Action, Driver::Panic));
    assert_eq!(*readers.first.lock().unwrap(), Some(first));
}

#[tokio::test]
async fn keeper_wal_lifecycle_is_a_last_connection_contrast_not_a_race_reproduction() {
    for retained in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let sid = ApplicationSessionId::new();
        let path = db_path(temp.path(), &sid);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(Duration::ZERO)
            .disable_statement_logging();
        let mut writer = options.clone().connect().await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE manifest(head_sequence INTEGER); INSERT INTO manifest VALUES(1);",
        )
        .execute(&mut writer)
        .await
        .unwrap();
        let wal = path.with_file_name("session.sqlite3-wal");
        assert!(std::fs::metadata(&wal).unwrap().len() > 0);
        let mut keeper = Keeper::default();
        if retained {
            keeper.open(temp.path(), &sid).await;
        }
        writer.close().await.unwrap();
        assert_eq!(wal.exists(), retained);
        if retained {
            assert_eq!(keeper.facts().active, 1);
            let sql = keeper.connection.as_mut().unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
                    .fetch_one(&mut *sql)
                    .await
                    .unwrap(),
                "wal"
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("PRAGMA busy_timeout")
                    .fetch_one(&mut *sql)
                    .await
                    .unwrap(),
                0
            );
            assert!(
                sqlx::query("INSERT INTO manifest VALUES(2)")
                    .execute(&mut *sql)
                    .await
                    .is_err()
            );
            // A completed keeper query does not pin the old snapshot or block a new writer.
            let mut writer = options.connect().await.unwrap();
            sqlx::query("BEGIN IMMEDIATE")
                .execute(&mut writer)
                .await
                .unwrap();
            sqlx::query("UPDATE manifest SET head_sequence=2")
                .execute(&mut writer)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT head_sequence FROM manifest LIMIT 1")
                    .fetch_one(&mut *sql)
                    .await
                    .unwrap(),
                1
            );
            sqlx::query("COMMIT").execute(&mut writer).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT head_sequence FROM manifest LIMIT 1")
                    .fetch_one(&mut *sql)
                    .await
                    .unwrap(),
                2
            );
            let readers = Readers::default();
            let head: i64 = read_owned(temp.path(), &sid, &readers, |sql, _| {
                Box::pin(async move {
                    sqlx::query_scalar("SELECT head_sequence FROM manifest LIMIT 1")
                        .fetch_one(sql)
                        .await
                        .unwrap()
                })
            })
            .await;
            assert_eq!(head, 2);
            assert_eq!(readers.facts()["active"], 0);
            assert_eq!(keeper.totals(&readers).unwrap().active, 1);
            // Close the keeper while a writer remains. That writer can now be the last connection.
            assert!(keeper.close().await);
            assert!(wal.exists());
            writer.close().await.unwrap();
            assert!(!wal.exists());
            assert!(keeper.close().await);
            assert_eq!(keeper.facts().closed, 1);
        }
        temp.close().unwrap();
    }
}

#[tokio::test]
async fn keeper_acquisition_and_priming_failures_keep_returned_handles_owned_until_cleanup() {
    for boundary in 0..3 {
        let temp = tempfile::tempdir().unwrap();
        let sid = ApplicationSessionId::new();
        if boundary > 0 {
            let mut writer = reader_database(temp.path(), &sid).await;
            if boundary == 2 {
                sqlx::query("CREATE TABLE manifest(head_sequence INTEGER)")
                    .execute(&mut writer)
                    .await
                    .unwrap();
            }
            writer.close().await.unwrap();
        }
        let mut resources = Resources::default();
        resources.tracker.begin(Phase::Setup);
        let result = AssertUnwindSafe(resources.keeper.open(temp.path(), &sid))
            .catch_unwind()
            .await;
        assert!(result.is_err());
        assert_eq!(resources.keeper.connection.is_some(), boundary > 0);
        assert!(!resources.keeper.initialized);
        let first = resources.keeper.error.clone().unwrap();
        assert_eq!(
            first.first.stage,
            match boundary {
                0 => ReaderStage::KeeperConnect,
                1 => ReaderStage::KeeperPrime,
                _ => ReaderStage::KeeperAction,
            }
        );
        assert_eq!(resources.keeper.opened, usize::from(boundary > 0));
        let mut out = vec![];
        assert!(!finish(result.map(|_| 2), &mut resources, &mut out).await);
        assert!(resources.keeper.connection.is_none());
        assert_eq!(resources.keeper.closed, usize::from(boundary > 0));
        assert!(resources.keeper.close().await);
        assert_eq!(
            resources.tracker.first.as_ref().unwrap().keeper.error,
            Some(first)
        );
        assert!(
            resources
                .tracker
                .first
                .as_ref()
                .unwrap()
                .reader_error
                .is_none()
        );
        // Acquisition counters cover successfully returned handles, never all SQLx worker absence.
        assert!(!String::from_utf8(out).unwrap().contains("sqlite3"));
        temp.close().unwrap();
    }
}

#[tokio::test]
async fn keeper_shutdown_attempts_survive_server_and_storage_errors_panics_and_repeated_cleanup() {
    for fault in 0..5 {
        let temp = tempfile::tempdir().unwrap();
        let mut resources = Resources::default();
        let store = SessionStore::open(temp.path().join("private-data"))
            .await
            .unwrap();
        let sid = store
            .create_session(CreateSession::new(OperationId::new(), "cleanup".into(), None).unwrap())
            .await
            .unwrap()
            .session_id()
            .clone();
        resources.keeper.open(temp.path(), &sid).await;
        let pause = Arc::new(Pause::default());
        resources.pause = Some(pause.clone());
        if fault < 3 {
            // No HTTP or provider is started. This task owns real storage like the server does.
            let stop = resources.stop.clone();
            resources.server = Some(tokio::spawn(async move {
                stop.cancelled().await;
                store.close().await.unwrap();
                assert!(fault != 2, "unpublished server panic");
                ServeOutcome {
                    local_addr: None,
                    http: if fault == 1 {
                        Err(crate::http_api::ServeError::Http)
                    } else {
                        Ok(())
                    },
                    shutdown: Arc::new(ShutdownOutcome::Closed),
                }
            }));
        } else {
            resources.store = Some(store);
            resources.store_close_fault = fault - 2;
        }
        let closed = AssertUnwindSafe(resources.close()).catch_unwind().await;
        assert_eq!(closed.is_ok(), fault == 0);
        watch(pause.release.notified()).await;
        assert!(resources.stop.is_cancelled());
        assert!(resources.server.is_none() && resources.store.is_none());
        assert!(resources.keeper.connection.is_none());
        assert_eq!(resources.keeper.facts().closed, 1);
        let repeated = AssertUnwindSafe(resources.close()).catch_unwind().await;
        assert_eq!(repeated.is_ok(), fault == 0);
        assert_eq!(resources.keeper.closed, 1);
        temp.close().unwrap();
    }
}

#[tokio::test]
async fn keeper_close_error_or_unknown_retirement_is_conservative_and_first_failure_survives() {
    for fault in 1..=2 {
        for primary in 0..3 {
            let temp = tempfile::tempdir().unwrap();
            let store = SessionStore::open(temp.path().join("private-data"))
                .await
                .unwrap();
            let sid = store
                .create_session(
                    CreateSession::new(OperationId::new(), "close".into(), None).unwrap(),
                )
                .await
                .unwrap()
                .session_id()
                .clone();
            let mut resources = Resources {
                store: Some(store),
                ..Default::default()
            };
            resources.keeper.open(temp.path(), &sid).await;
            if fault == 1 {
                resources.keeper.close_error =
                    Some(sqlx::Error::Io(std::io::ErrorKind::BrokenPipe.into()));
            } else {
                resources.keeper.close_panic = true;
            }
            resources.tracker.begin(Phase::Settle);
            if primary == 1 {
                resources
                    .readers
                    .freeze(Readers::default().issue(ReaderStage::Action, Driver::Panic));
            }
            if primary == 2 {
                resources
                    .keeper
                    .freeze(Readers::default().issue(ReaderStage::KeeperAction, Driver::Panic));
            }
            let result = Err(Box::new(()) as Box<dyn std::any::Any + Send>);
            let mut out = vec![];
            assert!(!finish(result, &mut resources, &mut out).await);
            let first = resources.tracker.first.clone().unwrap();
            assert_eq!(first.origin, Origin::Run);
            assert_eq!(first.phase, Phase::Settle);
            assert_eq!(first.reader_error.is_some(), primary == 1);
            assert_eq!(first.keeper.error.is_some(), primary == 2);
            assert_eq!(first.keeper.closed, 0);
            let later = resources.keeper.error.as_ref().unwrap();
            let close = if primary == 2 {
                later.close.as_ref().unwrap()
            } else {
                &later.first
            };
            assert_eq!(close.stage, ReaderStage::KeeperClose);
            assert_eq!(
                close.driver,
                if fault == 1 {
                    Driver::Io
                } else {
                    Driver::Panic
                }
            );
            assert_eq!(resources.keeper.facts().active, 1);
            assert!(resources.keeper.connection.is_none());
            assert!(!resources.keeper.close().await);
            assert!(
                AssertUnwindSafe(resources.close())
                    .catch_unwind()
                    .await
                    .is_err()
            );
            assert_eq!(resources.tracker.first, Some(first));
            let frames: Vec<Value> = out
                .split(|b| *b == b'\n')
                .filter(|b| !b.is_empty())
                .map(|b| serde_json::from_slice(b).unwrap())
                .collect();
            assert_eq!(frames[1]["outcome"], "failed");
            assert_eq!(frames[1]["totals"]["active"], 1);
            if primary == 2 && fault == 1 {
                assert!(publish(&mut std::io::stdout(), &frames[0]));
                assert!(publish(&mut std::io::stdout(), &frames[1]));
            }
            temp.close().unwrap();
        }
    }
}

#[test]
fn keeper_strict_serialization_rejects_missing_unknown_duplicate_and_inconsistent_owned_facts() {
    let keeper = Keeper::default();
    let mut tracker = Tracker::default();
    tracker.freeze(Origin::Run, &Readers::default(), &keeper);
    let value = serde_json::to_value(tracker.first.unwrap()).unwrap();
    assert!(serde_json::from_value::<Failure>(value.clone()).is_ok());
    for key in [
        "acquired",
        "initialized",
        "opened",
        "closed",
        "active",
        "error",
    ] {
        let mut missing = value.clone();
        missing["keeper"].as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<Failure>(missing).is_err());
    }
    for (key, invalid) in [
        ("acquired", json!(true)),
        ("initialized", json!(true)),
        ("opened", json!(2)),
        ("closed", json!(1)),
        ("active", json!(1)),
        ("payload", json!("unpublished")),
    ] {
        let mut changed = value.clone();
        changed["keeper"][key] = invalid;
        assert!(serde_json::from_value::<Failure>(changed).is_err());
    }
    for key in [
        "readers",
        "reader_error",
        "keeper",
        "totals",
        "last_completed",
    ] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<Failure>(missing).is_err());
    }
    let mut changed = value.clone();
    changed["totals"]["opened"] = json!(1);
    changed["totals"]["active"] = json!(1);
    assert!(serde_json::from_value::<Failure>(changed).is_err());
    let mut changed = value.clone();
    changed["totals"] = Value::Null;
    assert!(serde_json::from_value::<Failure>(changed).is_err());
    let mut changed = value.clone();
    changed["reader_error"] = serde_json::to_value(ReaderError {
        first: Readers::default().issue(ReaderStage::KeeperAction, Driver::Panic),
        close: None,
    })
    .unwrap();
    assert!(serde_json::from_value::<Failure>(changed).is_err());
    let mut changed = value.clone();
    changed["keeper"]["error"] = serde_json::to_value(ReaderError {
        first: Readers::default().sql_error(ReaderStage::KeeperConnect, &sqlx::Error::PoolClosed),
        close: Some(
            Readers::default().sql_error(ReaderStage::KeeperClose, &sqlx::Error::PoolClosed),
        ),
    })
    .unwrap();
    assert!(serde_json::from_value::<Failure>(changed).is_err());
    let bytes = serde_json::to_string(&value).unwrap().replace(
        "\"acquired\":false",
        "\"acquired\":false,\"acquired\":false",
    );
    assert!(serde_json::from_str::<Failure>(&bytes).is_err());
}

#[tokio::test]
async fn keeper_remains_owned_while_server_storage_drains_and_duplicate_acquisition_cannot_replace_it()
 {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("private-data"))
        .await
        .unwrap();
    let sid = store
        .create_session(CreateSession::new(OperationId::new(), "drain".into(), None).unwrap())
        .await
        .unwrap()
        .session_id()
        .clone();
    let mut resources = Resources::default();
    resources.keeper.open(temp.path(), &sid).await;
    let repeated = AssertUnwindSafe(resources.keeper.open(temp.path(), &sid))
        .catch_unwind()
        .await;
    assert!(repeated.is_err());
    assert_eq!(resources.keeper.opened, 1);
    assert!(resources.keeper.connection.is_some());
    let wal = db_path(temp.path(), &sid).with_file_name("session.sqlite3-wal");
    let (release, held) = tokio::sync::oneshot::channel();
    let stop = resources.stop.clone();
    resources.server = Some(tokio::spawn(async move {
        stop.cancelled().await;
        held.await.unwrap();
        store.close().await.unwrap();
        ServeOutcome {
            local_addr: None,
            http: Ok(()),
            shutdown: Arc::new(ShutdownOutcome::Closed),
        }
    }));
    let mut closing = Box::pin(resources.close());
    assert!(futures_util::poll!(&mut closing).is_pending());
    assert!(wal.exists());
    release.send(()).unwrap();
    closing.await;
    assert_eq!(resources.keeper.closed, 1);
    assert_eq!(
        resources.keeper.totals(&resources.readers).unwrap().active,
        0
    );
    temp.close().unwrap();
}

#[tokio::test]
async fn keeper_normal_stopped_requires_initialized_retirement_and_truthful_zero_totals() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(temp.path().join("private-data"))
        .await
        .unwrap();
    let sid = store
        .create_session(CreateSession::new(OperationId::new(), "stopped".into(), None).unwrap())
        .await
        .unwrap()
        .session_id()
        .clone();
    let mut resources = Resources {
        store: Some(store),
        ..Default::default()
    };
    resources.keeper.open(temp.path(), &sid).await;
    let mut out = vec![];
    assert!(finish(Ok(2), &mut resources, &mut out).await);
    let frame: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(frame["event"], "stopped");
    assert_eq!(frame["keeper"]["initialized"], true);
    assert_eq!(frame["keeper"]["closed"], 1);
    assert_eq!(frame["totals"]["active"], 0);
    assert!(publish(&mut std::io::stdout(), &frame));
    resources.close().await;
    assert_eq!(resources.keeper.closed, 1);
    let mut empty = Resources::default();
    assert!(!finish(Ok(2), &mut empty, &mut vec![]).await);
    temp.close().unwrap();
}

#[tokio::test]
async fn keeper_closure_and_original_reader_error_survive_every_failed_frame_publication_boundary()
{
    for fault in 0..=3 {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("private-data"))
            .await
            .unwrap();
        let sid = store
            .create_session(
                CreateSession::new(OperationId::new(), "publication".into(), None).unwrap(),
            )
            .await
            .unwrap()
            .session_id()
            .clone();
        let mut resources = Resources {
            store: Some(store),
            ..Default::default()
        };
        resources.keeper.open(temp.path(), &sid).await;
        *resources.readers.settle.lock().unwrap() = Some((1, tokio::time::Instant::now()));
        let result = AssertUnwindSafe(read_owned(
            temp.path(),
            &sid,
            &resources.readers,
            |sql, readers| {
                Box::pin(async move {
                    readers.checked(
                        sqlx::query_scalar::<_, i64>("SELECT missing_column FROM manifest")
                            .fetch_one(sql)
                            .await,
                        ReaderStage::SettleResults,
                    )
                })
            },
        ))
        .catch_unwind()
        .await
        .map(|_| 2);
        let original = result.unwrap_err();
        assert!(original.downcast_ref::<ReaderPanic>().is_some());
        let mut out = FailureWriter {
            stop: resources.stop.clone(),
            bytes: vec![],
            first_flushed_before_cleanup: false,
            fault,
        };
        assert!(!finish(Err(original), &mut resources, &mut out).await);
        assert!(resources.store.is_none());
        assert_eq!(resources.keeper.closed, 1);
        assert_eq!(resources.readers.facts()["active"], 0);
        assert_eq!(
            resources.keeper.totals(&resources.readers).unwrap().active,
            0
        );
        let first = resources.tracker.first.as_ref().unwrap();
        assert!(first.keeper.error.is_none());
        assert_eq!(first.keeper.active, 1);
        assert!(first.reader_error.is_some());
        if fault == 0 {
            assert!(out.first_flushed_before_cleanup);
        }
        assert!(!String::from_utf8(out.bytes).unwrap().contains("sqlite3"));
        temp.close().unwrap();
    }
}
