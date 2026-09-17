use super::*;
use crate::run::RunOutcome;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

async fn mutate(rig: &Rig, sequence: u64, payload: Value) {
    let id = rig.session.session_id().as_str();
    let path = rig
        .temp
        .path()
        .join("store/sessions")
        .join(&id[..2])
        .join(id)
        .join("session.sqlite3");
    let mut sql = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER events_no_update")
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("UPDATE events SET payload_json=? WHERE sequence=?")
        .bind(payload.to_string())
        .bind(sequence as i64)
        .execute(&mut sql)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable history'); END").execute(&mut sql).await.unwrap();
    sql.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_07_preparation_checks_raw_unknown_fields_in_prior_prefix_checkpoint() {
    let rig = Rig::new().await;
    rig.record(Plan::new(rig.input("first"), vec![response("one", vec![])]))
        .await;
    rig.record(Plan::new(
        rig.input("second"),
        vec![response("two", vec![])],
    ))
    .await;
    let records = history(&rig.session).await;
    let started = records
        .iter()
        .find(|event| {
            matches!(
                event.payload(),
                StoredEventPayload::RuntimeObserved(crate::run::RunEventEnvelope {
                    event: crate::run::RunEvent::RunStarted,
                    ..
                })
            )
        })
        .unwrap();
    let mut payload = value(started)["payload"].clone();
    payload["unknown_outer"] = json!({"z":1,"a":{"雪":"{ \"b\":1,\"a\":2 }\r\n"}});
    mutate(&rig, started.sequence(), payload).await;
    // Typed history remains decodable, but the second run selected different raw bytes.
    assert_eq!(history(&rig.session).await.len(), records.len());
    let error = prepare_session_replay(&rig.session, ID, MODEL)
        .await
        .unwrap_err();
    assert!(
        matches!(error.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.integrity")
    );
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_07_selection_checkpoint_and_expected_identity_are_not_assumed() {
    for field in ["digest", "identity"] {
        let rig = Rig::new().await;
        rig.record(Plan::new(rig.input("task"), vec![response("one", vec![])]))
            .await;
        let records = history(&rig.session).await;
        let selected = records
            .iter()
            .find(|event| matches!(event.payload(), StoredEventPayload::RunHistorySelected(_)))
            .unwrap();
        let mut payload = value(selected)["payload"].clone();
        if field == "digest" {
            payload["selection"]["history_digest"] = json!("0".repeat(64));
        } else {
            payload["selection"]["expected_identity"] = value(&identity('a'));
        }
        mutate(&rig, selected.sequence(), payload).await;
        let error = prepare_session_replay(&rig.session, ID, MODEL)
            .await
            .unwrap_err();
        if field == "digest" {
            assert!(
                matches!(error.cause(), PersistentRunCause::Storage(error) if error.code() == "storage.integrity")
            );
        } else {
            assert!(matches!(
                error.cause(),
                PersistentRunCause::Gateway(GatewayError::InvalidRequest(
                    "stored history replay metadata is inconsistent"
                ))
            ));
        }
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_12_13_result_request_call_and_actual_error_flag_conflicts_reject() {
    for field in ["request_id", "call_id", "is_error"] {
        let rig = Rig::new().await;
        rig.record(Plan::new(
            rig.input("task"),
            vec![
                response("call", vec![call("x", json!({"mode":"failed"}))]),
                response("done", vec![]),
            ],
        ))
        .await;
        let records = history(&rig.session).await;
        let result = records
            .iter()
            .find(|event| matches!(event.payload(), StoredEventPayload::ToolResultRecorded(_)))
            .unwrap();
        let mut payload = value(result)["payload"].clone();
        payload[field] = if field == "is_error" {
            json!(false)
        } else {
            json!("wrong identity")
        };
        mutate(&rig, result.sequence(), payload).await;
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_13_reuse_needs_its_actual_event_and_identical_original_arguments() {
    for change in ["arguments", "reuse_event"] {
        let rig = Rig::new().await;
        rig.record(Plan::new(
            rig.input("task"),
            vec![
                response("first", vec![call("x", json!({"a":1,"b":2}))]),
                response("reused", vec![call("x", json!({"a":1,"b":2}))]),
                response("done", vec![]),
            ],
        ))
        .await;
        let records = history(&rig.session).await;
        let event = if change == "arguments" {
            records.iter().find(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(crate::run::RunEventEnvelope { event: crate::run::RunEvent::ProviderEvent { event }, .. }) if matches!(&event.event, ProviderEvent::ResponseFinished { response } if response.id == "reused"))).unwrap()
        } else {
            records
                .iter()
                .find(|record| {
                    matches!(
                        record.payload(),
                        StoredEventPayload::RuntimeObserved(crate::run::RunEventEnvelope {
                            event: crate::run::RunEvent::ToolEvent {
                                event: crate::tools::ToolExecutionEvent::ToolResultReused { .. }
                            },
                            ..
                        })
                    )
                })
                .unwrap()
        };
        let mut payload = value(event)["payload"].clone();
        if change == "arguments" {
            payload["event"]["response"]["output"][0]["function_call"]["arguments"] =
                json!("{\"a\":2,\"b\":1}");
        } else {
            payload["event"]["type"] = json!("tool_execution_started");
        }
        mutate(&rig, event.sequence(), payload).await;
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_20_authoritative_response_must_be_unique_and_agree_with_actual_result() {
    for change in ["duplicate", "last_response", "attempts"] {
        let rig = Rig::new().await;
        let original = response(
            "one",
            vec![OutputItem {
                id: Some("r".into()),
                kind: crate::ItemKind::Reasoning,
                native_type: "reasoning".into(),
                function_call: None,
                native: json!({"id":"r","type":"reasoning","summary":[]}),
            }],
        );
        rig.record(Plan::new(rig.input("task"), vec![original.clone()]))
            .await;
        let records = history(&rig.session).await;
        let event = if change == "duplicate" {
            records.iter().find(|record| matches!(record.payload(), StoredEventPayload::RuntimeObserved(crate::run::RunEventEnvelope { event: crate::run::RunEvent::ProviderEvent { event }, .. }) if matches!(event.event, ProviderEvent::OutputItemFinished { .. }))).unwrap()
        } else {
            records.last().unwrap()
        };
        let mut payload = value(event)["payload"].clone();
        match change {
            "duplicate" => {
                payload["event"]["type"] = json!("response_finished");
                payload["event"]["response"] = value(&original);
            }
            "last_response" => {
                payload["last_response"]["text"] = json!("not the recorded response")
            }
            _ => payload["summary"]["model_requests_attempted"] = json!(2),
        }
        mutate(&rig, event.sequence(), payload).await;
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
        rig.store.close().await.unwrap();
    }
}

#[tokio::test]
async fn p1b2_20_terminal_summary_matches_canonical_exchanges_with_or_without_final_result() {
    use crate::run::RunEvent;

    for final_result in [false, true] {
        for field in [
            "turns_started",
            "turns_finished",
            "model_requests_attempted",
            "model_requests_admitted",
            "new_tool_dispatches",
            "tool_results_prepared",
            "reused_results",
            "last_request_id",
            "last_upstream_outcome",
            "outcome",
        ] {
            let rig = Rig::new().await;
            let mut plan = Plan::new(
                rig.input("terminal summary"),
                vec![
                    response("first", vec![call("x", json!({"a":17,"b":25}))]),
                    response("reused", vec![call("x", json!({"a":17,"b":25}))]),
                    response("done", vec![]),
                ],
            );
            plan.final_result = final_result;
            rig.record(plan).await;
            assert_eq!(rig.prepare().await.included_exchange_count(), 3);
            let records = history(&rig.session).await;
            let terminal = records
                .iter()
                .find(|record| {
                    matches!(
                        record.payload(),
                        StoredEventPayload::RuntimeObserved(crate::run::RunEventEnvelope {
                            event: RunEvent::RunFinished { .. },
                            ..
                        })
                    )
                })
                .unwrap();
            let mut payload = value(terminal)["payload"].clone();
            match field {
                "outcome" => payload[field] = json!({"type":"failed", "code":"event_sink"}),
                "last_request_id" => payload["summary"][field] = json!("wrong request"),
                "last_upstream_outcome" => payload["summary"][field] = json!("not_submitted"),
                _ => {
                    payload["summary"][field] =
                        json!(payload["summary"][field].as_u64().unwrap() + 1)
                }
            }
            mutate(&rig, terminal.sequence(), payload.clone()).await;
            if final_result {
                // Matching corruption in both terminal records must not hide the bad summary.
                let result = records.last().unwrap();
                assert!(matches!(
                    result.payload(),
                    StoredEventPayload::RunResultRecorded(_)
                ));
                let mut result_payload = value(result)["payload"].clone();
                result_payload["summary"] = payload["summary"].clone();
                result_payload["outcome"] = payload["outcome"].clone();
                mutate(&rig, result.sequence(), result_payload).await;
            }
            assert_incomplete(
                prepare_session_replay(&rig.session, ID, MODEL)
                    .await
                    .unwrap_err(),
            );
            rig.store.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn p1b2_20_terminal_outcome_must_agree_with_stopped_turn_without_final_result() {
    let rig = Rig::new().await;
    let mut plan = Plan::new(
        rig.input("cancelled terminal"),
        vec![response("closed", vec![call("x", json!({"a":17,"b":25}))])],
    );
    plan.stop = Stop::Finish;
    plan.final_result = false;
    rig.record(plan).await;
    assert_eq!(rig.prepare().await.included_exchange_count(), 1);
    let records = history(&rig.session).await;
    let terminal = records.last().unwrap();
    for outcome in [
        json!({"type":"completed"}),
        json!({"type":"failed", "code":"event_sink"}),
    ] {
        let mut payload = value(terminal)["payload"].clone();
        payload["outcome"] = outcome;
        mutate(&rig, terminal.sequence(), payload).await;
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
    }
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_20_tools_prepared_terminal_rejects_unrelated_outcomes_without_final_result() {
    use crate::run::{RunEvent, TurnOutcome};

    let rig = Rig::new().await;
    let original = response("closed", vec![call("x", json!({"a":17,"b":25}))]);
    let mut plan = Plan::new(rig.input("tools prepared terminal"), vec![original.clone()]);
    plan.stop = Stop::ToolsPrepared;
    plan.final_result = false;
    let (run, result) = rig.record(plan).await;
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    assert!(result.events_complete);
    assert!(result.sink_error.is_none());
    assert_eq!(result.summary.turns_started, 1);
    assert_eq!(result.summary.turns_finished, 1);
    assert!(
        rig.session
            .run_record(run.clone())
            .await
            .unwrap()
            .unwrap()
            .result()
            .is_none()
    );
    let records = history(&rig.session).await;
    assert!(
        matches!(records[records.len() - 2].payload(), StoredEventPayload::RuntimeObserved(event)
        if matches!(event.event, RunEvent::TurnFinished { number: 1, outcome: TurnOutcome::ToolsPrepared, .. }))
    );
    let terminal = records.last().unwrap();
    assert!(
        matches!(terminal.payload(), StoredEventPayload::RuntimeObserved(event)
        if matches!(&event.event, RunEvent::RunFinished { outcome: RunOutcome::CancelledLocally, summary }
            if value(summary) == value(&result.summary)))
    );
    let prepared = rig.prepare().await;
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(prepared.included_exchange_count(), 1);
    assert!(prepared.excluded_runs().is_empty());
    let replay = prepared.replay();
    assert_eq!(replay.runs()[0].source_run_id(), run.as_str());
    assert_eq!(
        value(replay.runs()[0].exchanges()[0].response()),
        value(&original)
    );
    assert_eq!(
        value(&replay.runs()[0].exchanges()[0].tool_results()),
        json!([{"kind":"tool_result", "call_id":"x", "output":"{\"sum\":42}"}])
    );
    assert_eq!(value(&records), value(&history(&rig.session).await));

    for outcome in [
        json!({"type":"failed", "code":"event_sink"}),
        json!({"type":"failed", "code":"history_restore"}),
        json!({"type":"failed", "code":"model_failed"}),
        json!({"type":"failed", "code":"counter_overflow_extra"}),
        json!({"type":"completed"}),
    ] {
        let mut payload = value(terminal)["payload"].clone();
        payload["outcome"] = outcome;
        mutate(&rig, terminal.sequence(), payload).await;
        let before = history(&rig.session).await;
        let work = rig.counters.work();
        assert_incomplete(
            prepare_session_replay(&rig.session, ID, MODEL)
                .await
                .unwrap_err(),
        );
        assert_eq!(value(&before), value(&history(&rig.session).await));
        assert_eq!(rig.counters.work(), work);
    }
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn p1b2_20_tools_prepared_terminal_counter_overflow_allowlist_without_final_result() {
    let rig = Rig::new().await;
    let mut plan = Plan::new(
        rig.input("tools prepared failure code"),
        vec![response("closed", vec![call("x", json!({"a":17,"b":25}))])],
    );
    plan.stop = Stop::ToolsPrepared;
    plan.final_result = false;
    let (_, result) = rig.record(plan).await;
    assert_eq!(result.outcome, RunOutcome::CancelledLocally);
    assert!(result.events_complete);
    let records = history(&rig.session).await;
    let terminal = records.last().unwrap();
    let mut payload = value(terminal)["payload"].clone();
    // This mutation checks the allowed failure code, not an actual producer overflow.
    payload["outcome"] = json!({"type":"failed", "code":"counter_overflow"});
    mutate(&rig, terminal.sequence(), payload).await;
    let before = history(&rig.session).await;
    let prepared = rig.prepare().await;
    assert_eq!(prepared.included_run_count(), 1);
    assert_eq!(prepared.included_exchange_count(), 1);
    assert!(prepared.excluded_runs().is_empty());
    assert_eq!(value(&before), value(&history(&rig.session).await));
    rig.store.close().await.unwrap();
}

#[test]
fn p1b2_01_owned_dtos_validate_deserialization_and_redact_all_content() {
    let response = response(
        "private-response",
        vec![call("private-call", json!({"a":17,"b":25}))],
    );
    let output = vec![InputItem::ToolResult {
        call_id: "private-call".into(),
        output: "private exact output\r\n雪".into(),
    }];
    let exchange = crate::ReplayExchange::new(response.clone(), output.clone()).unwrap();
    let run = ReplayRun::new(
        "private-run".into(),
        "private prepared prompt".into(),
        vec![exchange.clone()],
    )
    .unwrap();
    let replay = ConversationReplay::new(
        ID.into(),
        MODEL.into(),
        Some(identity('a')),
        vec![run.clone()],
    )
    .unwrap();
    assert_eq!(replay.version(), 1);
    assert_eq!(
        format!("{replay:?} {run:?} {exchange:?}"),
        "ConversationReplay([redacted]) ReplayRun([redacted]) ReplayExchange([redacted])"
    );
    assert_eq!(
        value(&serde_json::from_value::<ConversationReplay>(value(&replay)).unwrap()),
        value(&replay)
    );
    for field in [
        "version",
        "provider_id",
        "requested_model",
        "expected_identity",
        "duplicate_run",
        "prompt",
        "empty_exchanges",
        "user_result",
        "wrong_call",
        "incomplete_call",
        "extra_result",
        "after_no_call",
    ] {
        let mut bad = value(&replay);
        match field {
            "version" => bad[field] = json!(2),
            "provider_id" | "requested_model" => bad[field] = json!(" "),
            "expected_identity" => bad[field]["provider_id"] = json!("different"),
            "duplicate_run" => bad["runs"].as_array_mut().unwrap().push(value(&run)),
            "prompt" => bad["runs"][0]["prepared_prompt"] = json!(""),
            "empty_exchanges" => bad["runs"][0]["exchanges"] = json!([]),
            "user_result" => {
                bad["runs"][0]["exchanges"][0]["tool_results"][0] =
                    json!({"kind":"user","text":"injected"})
            }
            "wrong_call" => {
                bad["runs"][0]["exchanges"][0]["tool_results"][0]["call_id"] = json!("wrong")
            }
            "incomplete_call" => {
                bad["runs"][0]["exchanges"][0]["response"]["output"][0]["function_call"]["complete"] =
                    json!(false)
            }
            "extra_result" => bad["runs"][0]["exchanges"][0]["tool_results"]
                .as_array_mut()
                .unwrap()
                .push(value(&output[0])),
            _ => {
                let no_call =
                    crate::ReplayExchange::new(fixture::response("no-call", vec![]), vec![])
                        .unwrap();
                bad["runs"][0]["exchanges"]
                    .as_array_mut()
                    .unwrap()
                    .insert(0, value(&no_call));
            }
        }
        assert!(
            serde_json::from_value::<ConversationReplay>(bad).is_err(),
            "{field}"
        );
    }
    assert!(crate::ReplayExchange::new(response, vec![]).is_err());
    assert!(ReplayRun::new(" ".into(), "prompt".into(), vec![exchange]).is_err());
}
