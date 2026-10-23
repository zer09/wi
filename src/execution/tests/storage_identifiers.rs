use super::*;

#[tokio::test]
async fn id2a_untrusted_observed_call_ids_keep_recordable_terminal_tool_preflight_truth() {
    for call_id in [String::new(), "x".repeat(513)] {
        let observed = response("opaque-terminal", vec![call(&call_id, 17, 25)], "observed");
        let rig = Rig::new(vec![Step::Response(observed.clone())], ToolMode::Add).await;
        let (_, final_record, result) =
            executed(rig.start(CancellationToken::new()).await.unwrap().unwrap());
        assert_eq!(
            result.outcome,
            RunOutcome::Failed {
                code: "tool_preflight".into()
            }
        );
        assert!(result.events_complete);
        assert_eq!(result.sink_error, None);
        assert_eq!(result.summary.model_requests_attempted, 1);
        assert_eq!(result.summary.model_requests_admitted, 1);
        assert_eq!(
            result.summary.last_upstream_outcome,
            Some(UpstreamOutcome::TerminalReceived)
        );
        assert_eq!(result.summary.new_tool_dispatches, 0);
        assert_eq!(result.summary.tool_results_prepared, 0);
        assert_eq!(
            value(result.last_response.as_ref().unwrap()),
            value(&observed)
        );
        assert_eq!(count(&rig.script.records.calls), 0);
        assert_eq!(count(&rig.script.records.closes), 1);
        assert!(final_record.cleanup_warning().is_none());
        assert_eq!(
            rig.session
                .lookup_receipt(final_record.receipt().operation_id().clone())
                .await
                .unwrap()
                .as_ref(),
            Some(final_record.receipt())
        );
        let records = history(&rig.session).await;
        assert!(records.iter().any(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(event)
            if matches!(&event.event, RunEvent::ProviderEvent { event } if matches!(&event.event, ProviderEvent::ResponseFinished { response } if value(response) == value(&observed))))));
        assert!(!records.iter().any(|record| matches!(record.payload(), StoredEventPayload::ToolResultRecorded(_))
            || matches!(record.payload(), StoredEventPayload::RuntimeObserved(event) if matches!(event.event, RunEvent::ToolEvent { .. }))));
        let saved = rig
            .session
            .run_record(rig.run_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.state(), RecordedRunState::Failed);
        assert_eq!(value(saved.result().unwrap()), value(&result));
        rig.store.close().await.unwrap();
        let reopened = SessionStore::open(rig.temp.path().join("root"))
            .await
            .unwrap();
        let session = reopened
            .open_session(rig.session.session_id().clone())
            .await
            .unwrap();
        assert_eq!(value(&history(&session).await), value(&records));
        reopened.close().await.unwrap();
    }
}
