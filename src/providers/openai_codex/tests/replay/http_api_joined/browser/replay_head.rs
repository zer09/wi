//! One-shot replay-head pause. The racing rename still comes from real browser HTTP.
use super::*;
use crate::storage::test_hooks::Hooks;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Step {
    Arm,
    Wait,
    Release,
}

#[derive(Default)]
pub(super) struct Gate {
    pause: Option<Arc<Pause>>,
    waited: bool,
    released: bool,
}

impl Gate {
    pub(super) async fn apply(&mut self, step: Step, hooks: &Arc<Hooks>) -> &'static str {
        match step {
            Step::Arm => {
                assert!(
                    self.pause.is_none() && !self.released,
                    "replay-head control rejected"
                );
                let pause = Arc::new(Pause::default());
                hooks.arm(Point::ReplayHeadCaptured, Action::Pause(pause.clone()));
                self.pause = Some(pause);
                "armed"
            }
            Step::Wait => {
                assert!(
                    self.pause.is_some() && !self.waited,
                    "replay-head control rejected"
                );
                watch(self.pause.as_ref().unwrap().reached.notified()).await;
                self.waited = true;
                "paused"
            }
            Step::Release => {
                assert!(
                    self.pause.is_some() && self.waited,
                    "replay-head control rejected"
                );
                self.pause.take().unwrap().release.notify_one();
                self.released = true;
                "released"
            }
        }
    }
}

impl Drop for Gate {
    fn drop(&mut self) {
        // A failed browser assertion must not leave host shutdown waiting on this pause.
        if let Some(pause) = self.pause.take() {
            pause.release.notify_one();
        }
    }
}

#[test]
fn replay_head_control_rejects_malformed_duplicate_and_private_fields() {
    for step in ["arm", "wait", "release"] {
        let raw = format!(r#"{{"command":"replay_head","id":1,"step":"{step}"}}"#);
        assert!(matches!(
            serde_json::from_str::<Control>(&raw),
            Ok(Control::ReplayHead { .. })
        ));
        for field in ["command", "id", "step"] {
            let value: Value = serde_json::from_str(&raw).unwrap();
            let duplicate = format!(r#"{{"{field}":{},{}"#, value[field], &raw[1..]);
            assert!(serde_json::from_str::<Control>(&duplicate).is_err());
        }
        for change in [
            json!({"id":0}),
            json!({"id":-1}),
            json!({"id":4294967296_u64}),
            json!({"id":"1"}),
            json!({"id":1.5}),
            json!({"id":null}),
            json!({"step":"private-canary"}),
            json!({"step":1}),
            json!({"step":null}),
            json!({"text":"private-canary"}),
            json!({"owner":"private-canary"}),
            json!({"session_id":"private-canary"}),
            json!({"point":"BeforeCommit"}),
        ] {
            let mut value: Value = serde_json::from_str(&raw).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(serde_json::from_str::<Control>(&value.to_string()).is_err());
        }
        for field in ["command", "id", "step"] {
            let mut value: Value = serde_json::from_str(&raw).unwrap();
            value.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_str::<Control>(&value.to_string()).is_err());
        }
        assert!(raw.len() < LIMIT as usize);
    }
}

#[tokio::test]
async fn replay_head_gate_is_one_shot_ordered_and_releases_on_drop() {
    let hooks = Arc::new(Hooks::default());
    let mut gate = Gate::default();
    for step in [Step::Wait, Step::Release] {
        assert!(
            AssertUnwindSafe(gate.apply(step, &hooks))
                .catch_unwind()
                .await
                .is_err()
        );
    }
    assert_eq!(gate.apply(Step::Arm, &hooks).await, "armed");
    for step in [Step::Arm, Step::Release] {
        assert!(
            AssertUnwindSafe(gate.apply(step, &hooks))
                .catch_unwind()
                .await
                .is_err()
        );
    }
    let worker_hooks = hooks.clone();
    let worker =
        tokio::spawn(async move { worker_hooks.hit(Point::ReplayHeadCaptured).await.unwrap() });
    assert_eq!(gate.apply(Step::Wait, &hooks).await, "paused");
    assert!(!worker.is_finished());
    assert!(
        AssertUnwindSafe(gate.apply(Step::Wait, &hooks))
            .catch_unwind()
            .await
            .is_err()
    );
    assert_eq!(gate.apply(Step::Release, &hooks).await, "released");
    watch(worker).await.unwrap();
    for step in [Step::Arm, Step::Wait, Step::Release] {
        assert!(
            AssertUnwindSafe(gate.apply(step, &hooks))
                .catch_unwind()
                .await
                .is_err()
        );
    }
    let mut gate = Gate::default();
    gate.apply(Step::Arm, &hooks).await;
    let worker_hooks = hooks.clone();
    let worker =
        tokio::spawn(async move { worker_hooks.hit(Point::ReplayHeadCaptured).await.unwrap() });
    gate.apply(Step::Wait, &hooks).await;
    drop(gate);
    watch(worker).await.unwrap();
}
