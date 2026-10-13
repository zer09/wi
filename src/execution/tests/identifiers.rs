use super::*;

#[tokio::test]
async fn malformed_receipt_failure_and_final_result_persist_through_controller_and_sqlite() {
    for malformed in crate::identifiers::invalid_uuid_spellings() {
        for later in [false, true] {
            let mut steps = Vec::new();
            if later {
                steps.push(Step::Response(response(
                    "prior",
                    vec![call("one", 17, 25)],
                    "prior",
                )));
            }
            steps.push(Step::MalformedReceipt(malformed.clone()));
            let rig = Rig::new(steps, ToolMode::Add).await;
            let (_, final_record, result) =
                executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
            let admitted = u64::from(later);
            assert_eq!(
                result.outcome,
                RunOutcome::Failed {
                    code: "provider_correlation".into()
                }
            );
            assert!(result.events_complete);
            assert!(result.sink_error.is_none());
            assert_eq!(result.summary.model_requests_attempted, admitted + 1);
            assert_eq!(result.summary.model_requests_admitted, admitted);
            assert_eq!(result.summary.turns_started, admitted + 1);
            assert_eq!(result.summary.turns_finished, admitted + 1);
            assert_eq!(
                result.summary.last_upstream_outcome,
                Some(UpstreamOutcome::Unknown)
            );
            assert_eq!(
                result.summary.last_request_id.as_deref(),
                later.then_some("00000000-0000-4000-8000-000000000001")
            );
            assert_eq!(result.summary.new_tool_dispatches, admitted);
            assert_eq!(count(&rig.script.records.calls), admitted as usize);
            assert_eq!(count(&rig.script.records.closes), 1);
            assert!(!final_record.duplicate());
            assert!(final_record.cleanup_warning().is_none());
            assert_eq!(
                rig.session
                    .lookup_receipt(final_record.receipt().operation_id().clone())
                    .await
                    .unwrap()
                    .as_ref(),
                Some(final_record.receipt())
            );
            let saved = rig
                .session
                .run_record(rig.run_id.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(saved.state(), RecordedRunState::Failed);
            assert_eq!(value(saved.result().unwrap()), value(&result));
            assert!(
                rig.session
                    .tool_result(rig.run_id.clone(), "forbidden".into())
                    .await
                    .unwrap()
                    .is_none()
            );
            let records = history(&rig.session).await;
            let final_turn = records
                .iter()
                .rev()
                .find_map(|record| match record.payload() {
                    StoredEventPayload::RuntimeObserved(event)
                        if matches!(event.event, RunEvent::TurnFinished { .. }) =>
                    {
                        Some(event)
                    }
                    _ => None,
                })
                .unwrap();
            assert!(final_turn.request_id.is_none());
            assert!(matches!(&final_turn.event, RunEvent::TurnFinished {
                response_id: None, upstream_outcome: Some(UpstreamOutcome::Unknown),
                outcome: run::TurnOutcome::Stopped { reason }, ..
            } if reason == &result.outcome));
            assert!(
                matches!(records[records.len() - 2].payload(), StoredEventPayload::RuntimeObserved(event)
                if event.request_id.is_none() && matches!(&event.event, RunEvent::RunFinished { outcome, .. } if outcome == &result.outcome))
            );
            assert!(
                matches!(records.last().unwrap().payload(), StoredEventPayload::RunResultRecorded(saved) if value(saved) == value(&result))
            );
            // The producer queued a tool-bearing response, but receipt rejection stopped observation.
            assert!(!records.iter().any(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(event)
                if matches!(&event.event, RunEvent::ProviderEvent { event } if event.request_id.as_deref() == Some(malformed.as_str())))));
            if !malformed.is_empty() {
                assert!(
                    !serde_json::to_string(&records)
                        .unwrap()
                        .contains(&serde_json::to_string(&malformed).unwrap())
                );
            }
            rig.store.close().await.unwrap();
            let reopened = SessionStore::open(rig.temp.path().join("root"))
                .await
                .unwrap();
            let session = reopened
                .open_session(rig.session.session_id().clone())
                .await
                .unwrap();
            assert_eq!(value(&history(&session).await), value(&records));
            let saved = session
                .run_record(rig.run_id.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(saved.state(), RecordedRunState::Failed);
            assert_eq!(value(saved.result().unwrap()), value(&result));
            reopened.close().await.unwrap();
        }
    }
}
