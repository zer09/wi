//! Fixture observation stimuli, not browser rename acceptance coverage.
use super::*;
use crate::http_api::event_test_hooks::{FaultHook, FaultMode, FaultPlan, Phase, Target};
use crate::service::RunClient;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Step {
    Pending,
    Arm,
    Commit,
    Hit,
    Release,
    Reconnected,
    Finish,
}

fn data() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/test-support/read-reconnect.json"
    )))
    .unwrap()
}
fn text(key: &str) -> String {
    data()[key].as_str().unwrap().into()
}
fn checked<T, E>(result: std::result::Result<T, E>) -> T {
    result.unwrap_or_else(|_| panic!("read reconnect evidence rejected"))
}

pub(super) async fn provider(
    mut wire: Wire,
    db: Database,
    proof: Arc<Mutex<Proof>>,
    mut drive: mpsc::Receiver<usize>,
) {
    let body = wire.receive().await;
    let records = db.records().await;
    assert!(records.len() == 6, "read reconnect prefix rejected");
    let StoredEventPayload::RunAccepted(a) = records[1].payload() else {
        panic!("read reconnect acceptance missing")
    };
    let input = a.input();
    let prompt: Value = checked(serde_json::from_str(&input.prepared_request().prompt));
    assert!(input.user_text() == text("task") && prompt["task"] == text("task"));
    assert_request(
        &body,
        &[user(&input.prepared_request().prompt)],
        None,
        input,
    );
    assert!(body.get("previous_response_id").is_none() && wire.requests == 1);
    {
        let mut p = proof.lock().unwrap();
        p.connections = 1;
        p.requests = 1;
        p.prepared_exact = 1;
        p.fresh_empty = true;
    }
    let mut socket = wire.websocket.take().unwrap();
    // Keep both monitors active during every browser pause and observation loss.
    loop {
        tokio::select! {
            _ = wire.listener.accept() => {
                proof.lock().unwrap().connections += 1;
                panic!("read reconnect unexpected connection");
            }
            frame = socket.next() => match frame {
                Some(Ok(Message::Ping(_))) => checked(socket.flush().await),
                Some(Ok(Message::Pong(_))) => (),
                _ => { proof.lock().unwrap().requests += 1; panic!("read reconnect unexpected request"); }
            },
            gate = drive.recv() => { assert!(gate == Some(1), "read reconnect provider control rejected"); break; }
        }
    }
    wire.websocket = Some(socket);
    let item = json!({"type":"message","id":"read-reconnect-answer","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text("answer"),"annotations":[]}]});
    wire.reply(events("read-reconnect-terminal", vec![item], false), None)
        .await;
    wire.closed().await;
    proof.lock().unwrap().completed = 1;
    let _ = wire.listener.accept().await;
    proof.lock().unwrap().connections += 1;
    panic!("read reconnect unexpected connection");
}

#[derive(Default)]
pub(super) struct Audit {
    pub faults: Arc<FaultHook>,
    selected: Option<ApplicationSessionId>,
    identity: Option<(RunId, OperationId)>,
    next: usize,
    plan: Option<Arc<FaultPlan>>,
    prefix: Vec<StoredEvent>,
    renames: Vec<Value>,
}
impl Audit {
    pub(super) fn check_control(&mut self, c: &Control) {
        match c {
            Control::Select { session_id, .. } if self.selected.is_none() => {
                self.selected = Some(checked(session_id.parse()))
            }
            Control::ReadReconnect {
                session_id,
                run_id,
                operation_id,
                ..
            } => {
                assert!(
                    self.selected.as_ref() == Some(session_id),
                    "read reconnect identity rejected"
                );
                assert!(
                    session_id.as_str() != run_id.as_str()
                        && session_id.as_str() != operation_id.as_str()
                        && run_id.as_str() != operation_id.as_str(),
                    "read reconnect identity rejected"
                );
                if let Some((run, op)) = &self.identity {
                    assert!(
                        run == run_id && op == operation_id,
                        "read reconnect identity rejected"
                    );
                } else {
                    self.identity = Some((run_id.clone(), operation_id.clone()));
                }
            }
            Control::Stop { .. } => (),
            _ => panic!("read reconnect control rejected"),
        }
    }
    pub(super) async fn apply(
        &mut self,
        c: &Control,
        db: &Database,
        client: &RunClient,
        proof: &Mutex<Proof>,
        drive: &mpsc::Sender<usize>,
    ) -> Value {
        let Control::ReadReconnect {
            id,
            step,
            window,
            subscription,
            session_id,
            run_id,
            operation_id,
        } = c
        else {
            unreachable!()
        };
        let steps = [
            Step::Pending,
            Step::Arm,
            Step::Commit,
            Step::Hit,
            Step::Release,
            Step::Reconnected,
            Step::Arm,
            Step::Commit,
            Step::Hit,
            Step::Release,
            Step::Reconnected,
            Step::Arm,
            Step::Commit,
            Step::Hit,
            Step::Release,
            Step::Reconnected,
            Step::Finish,
        ];
        assert!(
            steps.get(self.next) == Some(step),
            "read reconnect order rejected"
        );
        let expected_window = if self.next == 0 {
            0
        } else {
            ((self.next - 1) / 5 + 1).min(3)
        };
        assert!(
            *window as usize == expected_window,
            "read reconnect window rejected"
        );
        let ordinal = if *step == Step::Pending {
            1
        } else if matches!(step, Step::Reconnected | Step::Finish) {
            *window as u64 + 1
        } else {
            *window as u64
        };
        assert!(
            *subscription == ordinal,
            "read reconnect subscription rejected"
        );
        if *step == Step::Pending {
            watch(async {
                while proof.lock().unwrap().requests == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await;
        }
        {
            let p = proof.lock().unwrap();
            assert!(
                p.connections == 1
                    && p.requests == 1
                    && p.prepared_exact == 1
                    && p.fresh_empty
                    && p.completed == 0
                    && p.continuations == 0
                    && !p.provider_failed,
                "read reconnect provider rejected"
            );
        }
        assert!(
            client.has_other_active_operation(session_id, &OperationId::new()),
            "read reconnect run inactive"
        );
        if matches!(
            step,
            Step::Pending | Step::Arm | Step::Reconnected | Step::Finish
        ) {
            watch(self.faults.wait_subscriptions(1)).await;
            let subscriptions = self.faults.subscriptions();
            assert!(
                subscriptions.len() == 1
                    && subscriptions[0].session_id == *session_id
                    && subscriptions[0].ordinal == ordinal,
                "read reconnect subscription rejected"
            );
        }
        let mut frame_bytes = 0;
        let mut yielded_bytes = 0;
        match step {
            Step::Arm => {
                let sequence = 6 + *window as u64;
                assert!(
                    self.faults.subscriptions()[0].last_sequence == sequence - 1,
                    "read reconnect subscription cursor rejected"
                );
                let mode = if *window == 1 {
                    FaultMode::PrefixThenError
                } else {
                    FaultMode::WholeThenError
                };
                self.plan = Some(checked(self.faults.arm(
                    Target {
                        session_id: session_id.clone(),
                        subscription: ordinal,
                        sequence,
                    },
                    mode,
                )));
            }
            Step::Commit => {
                assert!(self.plan.as_ref().unwrap().phase() == Phase::Armed);
                let title = data()["titles"][*window as usize - 1]
                    .as_str()
                    .unwrap()
                    .to_owned();
                let session = client.test_open_session(session_id.clone()).await;
                let result = checked(session.rename(OperationId::new(), title).await);
                assert!(
                    !result.duplicate() && result.cleanup_warning().is_none(),
                    "read reconnect rename rejected"
                );
                self.renames.push(
                    serde_json::to_value(crate::http_api::dto::ReceiptView::from(result.receipt()))
                        .unwrap(),
                );
            }
            Step::Hit | Step::Release => {
                let plan = self.plan.as_ref().unwrap();
                let hit = watch(plan.reached())
                    .await
                    .expect("read reconnect fault absent");
                assert!(
                    plan.phase() == Phase::Reached
                        && hit.target.session_id == *session_id
                        && hit.target.sequence == 6 + *window as u64
                        && hit.target.subscription == ordinal
                        && hit.mode
                            == if *window == 1 {
                                FaultMode::PrefixThenError
                            } else {
                                FaultMode::WholeThenError
                            }
                );
                frame_bytes = hit.frame_bytes;
                yielded_bytes = hit.yielded_bytes;
                if *step == Step::Release {
                    checked(self.faults.release(plan));
                    assert!(
                        watch(plan.retired()).await == Phase::Completed,
                        "read reconnect fault retirement rejected"
                    );
                    self.plan = None;
                }
            }
            Step::Finish => {
                checked(drive.send(1).await);
            }
            _ => (),
        }
        let records = db.records().await;
        if *step != Step::Finish {
            self.audit(&records, db, session_id, run_id, operation_id)
                .await;
        }
        let head = records.len();
        let rename = self.renames.last();
        let event_id = records
            .get(5 + self.renames.len())
            .filter(|_| !self.renames.is_empty())
            .map(|r| r.event_id().as_str());
        let response = json!({"id":id,"event":"read_reconnect","step":match step {
            Step::Pending=>"pending",Step::Arm=>"arm",Step::Commit=>"commit",Step::Hit=>"hit",Step::Release=>"release",Step::Reconnected=>"reconnected",Step::Finish=>"finish"},
            "window":window,"subscription":subscription,"session_id":session_id,"run_id":run_id,"operation_id":operation_id,
            "head":head,"rename_count":self.renames.len(),"rename_operation":rename.map(|r| r["operation_id"].clone()),"rename_event":event_id,
            "frame_bytes":frame_bytes,"yielded_bytes":yielded_bytes,"connections":1,"requests":1,"exact":true});
        self.next += 1;
        response
    }
    async fn audit(
        &mut self,
        records: &[StoredEvent],
        db: &Database,
        sid: &ApplicationSessionId,
        run: &RunId,
        op: &OperationId,
    ) {
        assert!(
            records.len() == 6 + self.renames.len(),
            "read reconnect head rejected"
        );
        let kinds = [
            "session.created",
            "run.accepted",
            "checkpoint",
            "run.started",
            "checkpoint",
            "turn.started",
        ];
        let mut ids = std::collections::HashSet::new();
        for (i, record) in records.iter().enumerate() {
            let v = serde_json::to_value(crate::http_api::dto::EventView::from(record)).unwrap();
            assert!(
                record.application_session_id() == sid
                    && record.sequence() == i as u64 + 1
                    && ids.insert(record.event_id().clone())
            );
            assert!(v["kind"] == if i < 6 { kinds[i] } else { "session.renamed" });
            assert!(record.run_id() == if i == 0 || i >= 6 { None } else { Some(run) });
            if i == 0 {
                assert!(v["data"]["title"] == data()["title"]);
            }
            if i == 1 {
                assert!(v["data"]["user_text"] == data()["task"]);
            }
            if i >= 6 {
                assert!(v["data"] == json!({"title":data()["titles"][i-6]}));
                let receipt = &self.renames[i - 6];
                let sequence = (i + 1).to_string();
                assert!(
                    receipt["session_id"] == json!(sid)
                        && receipt["run_id"].is_null()
                        && receipt["first_sequence"].as_str() == Some(sequence.as_str())
                        && receipt["last_sequence"].as_str() == Some(sequence.as_str())
                );
            }
        }
        assert!(
            serde_json::to_value(&self.prefix).unwrap()
                == serde_json::to_value(&records[..self.prefix.len()]).unwrap(),
            "read reconnect prefix changed"
        );
        let receipts = db.receipts().await;
        assert!(
            receipts
                == vec![
                    json!({"operation_id":op,"run_id":run,"session_id":sid,"first_sequence":"2","last_sequence":"3"})
                ]
        );
        let mut reader = db.reader.lock().await;
        let sql = reader.as_mut().unwrap();
        let rows: Vec<String> = checked(
            sqlx::query_scalar(
                "SELECT receipt_json FROM commands WHERE method='rename' ORDER BY first_sequence",
            )
            .fetch_all(&mut *sql)
            .await,
        );
        assert!(
            rows.len() == self.renames.len(),
            "read reconnect rename commands rejected"
        );
        for (row, expected) in rows.iter().zip(&self.renames) {
            let receipt: crate::storage::CommitReceipt = checked(serde_json::from_str(row));
            assert!(
                serde_json::to_value(crate::http_api::dto::ReceiptView::from(&receipt)).unwrap()
                    == *expected
            );
        }
        let heads: Vec<i64> = checked(
            sqlx::query_scalar("SELECT head_sequence FROM manifest")
                .fetch_all(&mut *sql)
                .await,
        );
        let states: Vec<String> = checked(
            sqlx::query_scalar("SELECT state FROM runs")
                .fetch_all(&mut *sql)
                .await,
        );
        assert!(
            heads == vec![records.len() as i64] && states == vec!["running"],
            "read reconnect stored run rejected"
        );
        self.prefix = records.to_vec();
    }
}
