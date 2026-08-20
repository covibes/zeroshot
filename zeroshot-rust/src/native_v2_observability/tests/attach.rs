use super::*;

#[tokio::test]
async fn durable_logs_resume_exclusively_without_gaps_or_duplicates() {
    let (_ledger, run_id, left, _right, service) = cursor_fixture().await;
    let public_left = public_reference(&left);
    let (_, mut logs) = service
        .logs(RunLogsParams {
            run_id: run_id.clone(),
            from_cursor: Some(Cursor::new("v2:3")),
            execution: Some(public_left.clone()),
        })
        .await
        .assert_value();
    let records = logs.read_available().await.assert_value();
    assert_eq!(
        records
            .iter()
            .map(|event| event.cursor.as_str())
            .collect::<Vec<_>>(),
        ["v2:4", "v2:6"]
    );
    assert_eq!(records.assert_at(0).record.message.as_str(), "first");
    let saved_log_cursor = records.assert_at(0).cursor.clone();
    drop(logs);
    let (_, mut resumed_logs) = service
        .logs(RunLogsParams {
            run_id: run_id.clone(),
            from_cursor: Some(saved_log_cursor),
            execution: Some(public_left),
        })
        .await
        .assert_value();
    let resumed = resumed_logs.read_available().await.assert_value();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed.assert_at(0).cursor.as_str(), "v2:6");
}

#[derive(Default)]
struct FakeSession;

#[async_trait]
impl NodeSession for FakeSession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        true
    }

    async fn close(&self) {}
}

#[derive(Default)]
pub(super) struct FakeSessions;

#[async_trait]
impl SessionFactory for FakeSessions {
    async fn open(
        &self,
        _invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        Ok(Arc::new(FakeSession))
    }
}

pub(super) struct ControlledDriver {
    pub(super) first_emitted: Arc<Notify>,
    pub(super) release: Arc<Notify>,
}

pub(super) struct ParallelVerifierDriver {
    pub(super) release: Arc<Barrier>,
}

#[async_trait]
impl NodeDriver for ParallelVerifierDriver {
    async fn run(
        &self,
        invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        self.release.wait().await;
        control.emit(LiveOutput::new(
            LiveOutputStream::Output,
            invocation.node.reference.node.as_str(),
        )?)?;
        Ok(WorkerOutcome::Verifier {
            output: Value::Null,
            signals: BTreeMap::new(),
            diagnostic: Value::Null,
            artifacts: Vec::new(),
        })
    }
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};

#[async_trait]
impl NodeDriver for ControlledDriver {
    async fn run(
        &self,
        _invocation: DriverInvocation,
        control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        control.emit(LiveOutput::new(LiveOutputStream::Output, "before attach")?)?;
        self.first_emitted.notify_one();
        self.release.notified().await;
        control.emit(LiveOutput::new(LiveOutputStream::Output, "after attach")?)?;
        Ok(WorkerOutcome::Verified {
            output: Value::Null,
            artifacts: Vec::new(),
        })
    }
}
