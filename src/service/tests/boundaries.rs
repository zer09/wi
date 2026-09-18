use super::b2::*;
use super::fixture::count;
use super::*;
use sqlx::Connection;

#[tokio::test]
async fn cancel_before_pure_admission_leaves_no_receipt_or_execution() {
    let fixture = Fixture::new().await;
    let task = fixture.task("cancel before admission", Plan::default());
    let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
    let ticket = submit(&host, &task);
    assert_eq!(
        host.client().cancel(ticket.session_id(), ticket.run_id()),
        CancelDisposition::Requested
    );
    let completion = watchdog(ticket.accepted()).await.unwrap_err();
    assert!(Arc::ptr_eq(&completion, &ticket.completion().await));
    let failure = failure(&completion);
    assert_eq!(failure.stage(), PersistentRunStage::Preflight);
    assert!(matches!(
        failure.cause(),
        PersistentRunCause::Gateway(GatewayError::InvalidRequest("run pre-cancelled"))
    ));
    assert!(failure.acceptance().is_none());
    assert!(failure.observed_result().is_none());
    assert!(
        fixture
            .session
            .lookup_receipt(task.operation_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    no_work(&task);
    closed(&host).await;
}

#[tokio::test]
async fn cancellation_during_provider_open_model_wait_and_cooperative_tool_is_truthful() {
    for phase in ["opening", "model", "tool"] {
        let fixture = Fixture::new().await;
        let gate = Arc::new(Barrier::default());
        let tool = Arc::new(ToolProbe {
            pause: (phase == "tool").then(|| gate.clone()),
            ..Default::default()
        });
        let task = Task::new(
            &fixture.session,
            tool.registry(),
            phase,
            Plan {
                open_pause: (phase == "opening").then(|| gate.clone()),
                response_pause: (phase == "model").then(|| gate.clone()),
                responses: vec![response("call", vec![call("one", 17, 25)], "")],
                ..Plan::default()
            },
        );
        let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
        let ticket = submit(&host, &task);
        watchdog(gate.reached.notified()).await;
        let receipt = ticket.accepted().await.unwrap();
        assert_eq!(
            host.client().cancel(ticket.session_id(), ticket.run_id()),
            CancelDisposition::Requested
        );
        let completion = watchdog(ticket.completion()).await;
        let (_, _, result) = executed(&completion);
        assert_eq!(result.outcome, RunOutcome::CancelledLocally);
        assert_eq!(
            result.summary.model_requests_attempted,
            u64::from(phase != "opening")
        );
        assert_eq!(
            result.summary.model_requests_admitted,
            u64::from(phase != "opening")
        );
        let upstream = match phase {
            "opening" => None,
            "model" => Some(UpstreamOutcome::Unknown),
            "tool" => Some(UpstreamOutcome::TerminalReceived),
            _ => unreachable!(),
        };
        assert_eq!(result.summary.last_upstream_outcome, upstream);
        assert_eq!(count(&task.observed.records.opens), 1);
        assert_eq!(
            count(&task.observed.records.closes),
            usize::from(phase != "opening")
        );
        assert_eq!(count(&tool.calls), usize::from(phase == "tool"));
        assert_eq!(count(&tool.effects), 0);
        assert_eq!(result.summary.tool_results_prepared, 0);
        let saved = fixture
            .session
            .tool_result(task.run_id.clone(), "one".into())
            .await
            .unwrap();
        if phase == "tool" {
            let saved = saved.unwrap();
            assert!(saved.output().is_none());
            assert!(saved.result_sequence().is_none());
            assert!(saved.finished_sequence().is_none());
        } else {
            assert!(saved.is_none());
        }
        assert!(
            !history(&fixture.session)
                .await
                .iter()
                .any(|event| matches!(event.payload(), StoredEventPayload::ToolResultRecorded(_)))
        );
        assert_eq!(ticket.accepted().await.unwrap(), receipt);
        let saved = fixture
            .session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value(saved.result().unwrap()), value(result));
        fixture
            .session
            .rename(OperationId::new(), "still writable".into())
            .await
            .unwrap();
        closed(&host).await;
    }
}

#[tokio::test]
async fn cancellation_during_sql_awaits_same_future_and_keeps_real_results() {
    for record in [
        Record::Acceptance,
        Record::ProviderBinding,
        Record::ToolIntent,
        Record::ToolResult,
        Record::RunFinished,
        Record::FinalResult,
    ] {
        let fixture = Fixture::new().await;
        let tools = matches!(record, Record::ToolIntent | Record::ToolResult);
        let responses = if tools {
            vec![response(
                "call",
                vec![call("one", 17, 25), call("later", 1, 2)],
                "",
            )]
        } else {
            vec![response(
                "final",
                vec![],
                "completed before late cancellation",
            )]
        };
        let task = fixture.task(
            "SQL cancellation",
            Plan {
                responses,
                ..Plan::default()
            },
        );
        let gate = pause(&fixture.session, record, Point::BeforeCommit);
        let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
        let ticket = submit(&host, &task);
        watchdog(gate.reached.notified()).await;
        let operation = gate.operation_id.lock().unwrap().clone().unwrap();
        let mut reader = connection(
            &fixture.temp.path().join("root"),
            fixture.session.session_id(),
        )
        .await;
        let prefix = rows(&mut reader).await;
        let commands: i64 =
            sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
                .bind(operation.as_str())
                .fetch_one(&mut reader)
                .await
                .unwrap();
        assert_eq!(commands, 0);
        assert_eq!(
            host.client().cancel(ticket.session_id(), ticket.run_id()),
            CancelDisposition::Requested
        );
        assert!(futures_util::poll!(Box::pin(ticket.completion())).is_pending());
        if record == Record::Acceptance {
            assert!(futures_util::poll!(Box::pin(ticket.accepted())).is_pending());
            assert_eq!(count(&task.observed.records.opens), 0);
        }
        assert_eq!(
            count(&fixture.counts.effects),
            usize::from(record == Record::ToolResult)
        );
        gate.release.notify_one();
        let completion = watchdog(ticket.completion()).await;
        let (acceptance, _, result) = executed(&completion);
        let outcome = if matches!(record, Record::RunFinished | Record::FinalResult) {
            RunOutcome::Completed
        } else {
            RunOutcome::CancelledLocally
        };
        assert_eq!(result.outcome, outcome);
        assert_eq!(ticket.accepted().await.unwrap(), *acceptance);
        assert!(
            fixture
                .session
                .lookup_receipt(operation)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(&rows(&mut reader).await[..prefix.len()], prefix);
        if tools {
            let saved = fixture
                .session
                .tool_result(task.run_id.clone(), "one".into())
                .await
                .unwrap()
                .unwrap();
            if record == Record::ToolResult {
                assert_eq!(saved.output(), Some("{\"sum\":42}"));
                assert_eq!(saved.is_error(), Some(false));
                assert!(saved.result_sequence().unwrap() < saved.finished_sequence().unwrap());
                assert_eq!(result.summary.tool_results_prepared, 1);
                assert_eq!(
                    result.summary.last_upstream_outcome,
                    Some(UpstreamOutcome::TerminalReceived)
                );
            } else {
                assert!(saved.output().is_none());
                assert!(saved.finished_sequence().is_none());
                assert_eq!(result.summary.tool_results_prepared, 0);
            }
            assert!(
                fixture
                    .session
                    .tool_result(task.run_id.clone(), "later".into())
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(task.observed.records.inputs.lock().unwrap().len(), 1);
        }
        let saved = fixture
            .session
            .run_record(task.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value(saved.result().unwrap()), value(result));
        reader.close().await.unwrap();
        closed(&host).await;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fault {
    None,
    Unknown,
    Cleanup,
}

#[tokio::test]
async fn shutdown_during_acceptance_result_and_final_sql_preserves_certainty_and_drain() {
    for record in [Record::Acceptance, Record::ToolResult, Record::FinalResult] {
        for fault in [Fault::None, Fault::Unknown, Fault::Cleanup] {
            let fixture = Fixture::new().await;
            let independent = session(&fixture.store).await;
            let responses = if record == Record::ToolResult {
                vec![response("call", vec![call("one", 17, 25)], "")]
            } else {
                vec![response("final", vec![], "actual terminal")]
            };
            let task = fixture.task(
                "shutdown SQL",
                Plan {
                    responses,
                    ..Plan::default()
                },
            );
            let gate = pause(&fixture.session, record, Point::BeforeCommit);
            let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
            let ticket = submit(&host, &task);
            watchdog(gate.reached.notified()).await;
            let operation = gate.operation_id.lock().unwrap().clone().unwrap();
            let mut reader = connection(
                &fixture.temp.path().join("root"),
                fixture.session.session_id(),
            )
            .await;
            let prefix = rows(&mut reader).await;
            let shutdown = host.begin_shutdown();
            let other_waiters = std::thread::scope(|scope| {
                let calls: Vec<_> = (0..4)
                    .map(|_| scope.spawn(|| host.begin_shutdown()))
                    .collect();
                calls
                    .into_iter()
                    .map(|call| call.join().unwrap())
                    .collect::<Vec<_>>()
            });
            assert!(futures_util::poll!(Box::pin(shutdown.wait())).is_pending());
            assert!(futures_util::poll!(Box::pin(ticket.completion())).is_pending());
            assert_eq!(
                host.client()
                    .submit(
                        independent.session_id().clone(),
                        request(),
                        ToolRegistry::new()
                    )
                    .unwrap_err(),
                RunHostError::Closed
            );
            let lease = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(fixture.temp.path().join("root/storage.lock"))
                .unwrap();
            assert!(matches!(
                lease.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
            // A different session proves store admission stays open during tracked SQL drain.
            watchdog(independent.rename(OperationId::new(), "writable while draining".into()))
                .await
                .unwrap();
            match fault {
                Fault::None => {}
                Fault::Unknown => fixture.session.test_hooks().arm_record(
                    record,
                    Point::AfterCommit,
                    Action::Fail(StorageErrorKind::CommitUnknown),
                ),
                Fault::Cleanup => fixture.session.test_hooks().arm_record(
                    record,
                    Point::WriteClosed,
                    Action::Fail(StorageErrorKind::Io),
                ),
            }
            gate.release.notify_one();
            let completion = watchdog(ticket.completion()).await;
            if fault == Fault::None || (record == Record::FinalResult && fault == Fault::Cleanup) {
                let (_, final_record, result) = executed(&completion);
                let expected = if record == Record::FinalResult {
                    RunOutcome::Completed
                } else {
                    RunOutcome::CancelledLocally
                };
                assert_eq!(result.outcome, expected);
                assert_eq!(
                    final_record.cleanup_warning().is_some(),
                    fault == Fault::Cleanup
                );
            } else {
                let failure = failure(&completion);
                let stage = match record {
                    Record::Acceptance => PersistentRunStage::Acceptance,
                    Record::ToolResult => PersistentRunStage::ToolResult,
                    Record::FinalResult => PersistentRunStage::FinalResult,
                    _ => unreachable!(),
                };
                assert_eq!(failure.stage(), stage);
                assert_eq!(failure.operation_id(), Some(&operation));
                if fault == Fault::Unknown {
                    assert!(
                        matches!(failure.cause(), PersistentRunCause::Storage(error) if error.certainty() == CommitCertainty::Unknown && error.kind() == StorageErrorKind::CommitUnknown)
                    );
                } else {
                    assert!(
                        matches!(failure.cause(), PersistentRunCause::Cleanup { commit, .. } if commit.cleanup_warning().is_some())
                    );
                }
                if record == Record::Acceptance {
                    assert_eq!(failure.acceptance().is_some(), fault == Fault::Cleanup);
                    assert!(failure.observed_result().is_none());
                    assert!(Arc::ptr_eq(
                        &completion,
                        &ticket.accepted().await.unwrap_err()
                    ));
                } else {
                    assert_eq!(
                        failure.acceptance(),
                        Some(ticket.accepted().await.unwrap().receipt())
                    );
                    let observed = failure.observed_result().unwrap();
                    if record == Record::ToolResult {
                        assert!(!observed.events_complete);
                        assert_eq!(observed.sink_error, Some(RunSinkError::Failed));
                        assert_eq!(
                            observed.outcome,
                            RunOutcome::Failed {
                                code: "event_sink".into()
                            }
                        );
                    } else {
                        assert_eq!(observed.outcome, RunOutcome::Completed);
                    }
                }
            }
            let shutdown_outcome = watchdog(shutdown.wait()).await;
            assert!(matches!(&*shutdown_outcome, ShutdownOutcome::Closed));
            for waiter in other_waiters {
                assert!(Arc::ptr_eq(
                    &shutdown_outcome,
                    &watchdog(waiter.wait()).await
                ));
            }
            assert!(host.inner.gate().entries.is_empty());
            assert!(host.inner.tracker.is_empty());
            assert_eq!(&rows(&mut reader).await[..prefix.len()], prefix);
            let stored: i64 =
                sqlx::query_scalar("SELECT count(*) FROM commands WHERE operation_id=?")
                    .bind(operation.as_str())
                    .fetch_one(&mut reader)
                    .await
                    .unwrap();
            assert_eq!(stored, 1, "postcommit uncertainty is not rollback");
            reader.close().await.unwrap();
            let reopened = SessionStore::open(fixture.temp.path().join("root"))
                .await
                .unwrap();
            let session = reopened
                .open_session(task.session.session_id().clone())
                .await
                .unwrap();
            assert!(session.lookup_receipt(operation).await.unwrap().is_some());
            if record == Record::ToolResult {
                let saved = session
                    .tool_result(task.run_id.clone(), "one".into())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.output(), Some("{\"sum\":42}"));
                assert_eq!(saved.is_error(), Some(false));
                assert_eq!(count(&fixture.counts.effects), 1);
            }
            if record == Record::FinalResult {
                assert_eq!(
                    session
                        .run_record(task.run_id.clone())
                        .await
                        .unwrap()
                        .unwrap()
                        .result()
                        .unwrap()
                        .outcome,
                    RunOutcome::Completed
                );
            }
            reopened.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn lookup_preflight_binding_and_event_failures_are_not_worker_loss() {
    for stage in [
        PersistentRunStage::Lookup,
        PersistentRunStage::Preflight,
        PersistentRunStage::ProviderBinding,
        PersistentRunStage::RuntimeEvent,
    ] {
        let fixture = Fixture::new().await;
        let task = fixture.task(
            "failure fidelity",
            Plan {
                unsupported: stage == PersistentRunStage::Preflight,
                ..Plan::default()
            },
        );
        match stage {
            PersistentRunStage::Lookup => fixture.session.test_hooks().arm(
                Point::ReceiptLookupComplete,
                Action::Fail(StorageErrorKind::Io),
            ),
            PersistentRunStage::ProviderBinding => fixture.session.test_hooks().arm_record(
                Record::ProviderBinding,
                Point::BeforeCommit,
                Action::Fail(StorageErrorKind::Io),
            ),
            PersistentRunStage::RuntimeEvent => fixture.session.test_hooks().arm_record(
                Record::ResponseFinished,
                Point::BeforeCommit,
                Action::Fail(StorageErrorKind::Io),
            ),
            _ => {}
        }
        let host = RunHost::new(fixture.store, task.gateway.clone()).unwrap();
        let ticket = submit(&host, &task);
        let completion = watchdog(ticket.completion()).await;
        let failure = failure(&completion);
        assert_eq!(failure.stage(), stage);
        if matches!(
            stage,
            PersistentRunStage::Lookup | PersistentRunStage::Preflight
        ) {
            assert!(Arc::ptr_eq(
                &completion,
                &ticket.accepted().await.unwrap_err()
            ));
            assert!(failure.acceptance().is_none());
        } else {
            assert_eq!(
                failure.acceptance(),
                Some(ticket.accepted().await.unwrap().receipt())
            );
            assert!(!failure.observed_result().unwrap().events_complete);
            assert!(
                matches!(failure.cause(), PersistentRunCause::Storage(error) if error.certainty() == CommitCertainty::NotCommitted)
            );
        }
        assert!(!host.inner.gate().closing);
        closed(&host).await;
    }
}
