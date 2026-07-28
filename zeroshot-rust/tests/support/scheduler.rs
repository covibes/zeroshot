use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::Semaphore;
use tokio::time::{Duration, Instant};
use zeroshot_engine::cluster_ledger::{ExecutionId, NodeInstanceId, ResourceId, RunSequence};
use zeroshot_engine::execution::{
    CancelObservation, CatalogDigest, DispatchFence, DispatchObservation, ExecutionCandidate,
    ExecutionCommand, ExecutionCommandSpec, ExecutionControl, ExecutionObservation,
    ExecutionResult, ExecutionRuntime, ExecutionTargetRef, InlineExecutionInput, ProfileDigest,
    ProviderLaneId, RecoveryRef, RegistryDigest, SessionScope, WorkerBindingId, WorkerBindingRef,
    WorkerBindingSpec, WorkspaceAccessMode, WorkspaceAccessRef,
};

pub struct CommandSpec<'a> {
    pub execution: u64,
    pub lane: &'a str,
    pub cluster: &'a str,
    pub workspace: &'a str,
    pub mode: WorkspaceAccessMode,
}

pub fn command(spec: CommandSpec<'_>) -> ExecutionCommand {
    ExecutionCommand::new(ExecutionCommandSpec {
        cluster: ResourceId::new(spec.cluster).unwrap(),
        run: RunSequence::new(1).unwrap(),
        node_instance: NodeInstanceId::new(spec.execution + 100).unwrap(),
        execution: ExecutionId::new(spec.execution).unwrap(),
        dispatch_fence: DispatchFence::new(spec.execution + 1).unwrap(),
        recovery_ref: RecoveryRef::new(format!("recovery-{}", spec.execution)).unwrap(),
        target: ExecutionTargetRef::Agent(
            WorkerBindingRef::new(WorkerBindingSpec {
                binding_id: WorkerBindingId::new(format!("binding-{}", spec.lane)).unwrap(),
                driver_family: zeroshot_engine::execution::DriverFamilyId::new("gateway").unwrap(),
                provider_lane: ProviderLaneId::new(spec.lane).unwrap(),
                version: 1,
                supports_node_instance: true,
            })
            .unwrap(),
        ),
        catalog_digest: CatalogDigest::new(digest('a')).unwrap(),
        profile_digest: ProfileDigest::new(digest('b')).unwrap(),
        registry_digest: RegistryDigest::new(digest('c')).unwrap(),
        workspace: WorkspaceAccessRef::new(ResourceId::new(spec.workspace).unwrap(), spec.mode)
            .unwrap(),
        input: zeroshot_engine::execution::ExecutionInput::Inline(
            InlineExecutionInput::new("{\"ok\":true}").unwrap(),
        ),
        session_scope: SessionScope::Execution,
        execution_deadline_ms: 1_900_000_000_000,
        session_deadline_ms: 1_899_999_999_999,
    })
    .unwrap()
}

#[derive(Clone, Default)]
pub struct BlockingRuntime {
    order: Arc<Mutex<Vec<u64>>>,
    completed: Arc<Mutex<Vec<u64>>>,
    notifiers: Arc<Mutex<BTreeMap<u64, Arc<Semaphore>>>>,
}

#[derive(Clone, Default)]
pub struct RunningRuntime {
    order: Arc<Mutex<Vec<u64>>>,
}

impl RunningRuntime {
    pub async fn wait_for_started(&self, expected: usize) {
        wait_for_started(&self.order, expected).await;
    }

    pub fn order(&self) -> Vec<u64> {
        self.order.lock().unwrap().clone()
    }
}

impl BlockingRuntime {
    pub async fn wait_for_started(&self, expected: usize) {
        wait_for_started(&self.order, expected).await;
    }

    pub fn order(&self) -> Vec<u64> {
        self.order.lock().unwrap().clone()
    }

    pub async fn wait_for_completed(&self, expected: usize) {
        wait_for_started(&self.completed, expected).await;
    }

    pub async fn wait_for_completion(&self, execution: u64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if self.completed.lock().unwrap().contains(&execution) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "execution {execution} did not complete"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub fn release(&self, execution: u64) {
        if let Some(notify) = self.notifiers.lock().unwrap().get(&execution) {
            notify.add_permits(1);
        }
    }
}

#[async_trait]
impl ExecutionRuntime for BlockingRuntime {
    async fn dispatch(&self, command: ExecutionCommand) -> DispatchObservation {
        self.order.lock().unwrap().push(command.execution().get());
        let notify = {
            let mut notifiers = self.notifiers.lock().unwrap();
            notifiers
                .entry(command.execution().get())
                .or_insert_with(|| Arc::new(Semaphore::new(0)))
                .clone()
        };
        notify.acquire().await.unwrap().forget();
        self.completed
            .lock()
            .unwrap()
            .push(command.execution().get());
        DispatchObservation::Completed {
            execution: command.execution(),
            dispatch_fence: command.dispatch_fence(),
            result: ExecutionResult::new(
                ExecutionCandidate::new("done").unwrap(),
                zeroshot_engine::execution::CompletionEvidence::Success,
                None,
            )
            .unwrap(),
        }
    }

    async fn inspect(&self, control: ExecutionControl) -> ExecutionObservation {
        ExecutionObservation::Indeterminate {
            execution: control.execution(),
            dispatch_fence: control.dispatch_fence(),
            fault: None,
        }
    }

    async fn cancel(&self, control: ExecutionControl) -> CancelObservation {
        CancelObservation::Indeterminate {
            execution: control.execution(),
            dispatch_fence: control.dispatch_fence(),
            fault: None,
        }
    }
}

#[async_trait]
impl ExecutionRuntime for RunningRuntime {
    async fn dispatch(&self, command: ExecutionCommand) -> DispatchObservation {
        self.order.lock().unwrap().push(command.execution().get());
        DispatchObservation::Running {
            execution: command.execution(),
            dispatch_fence: command.dispatch_fence(),
        }
    }

    async fn inspect(&self, control: ExecutionControl) -> ExecutionObservation {
        ExecutionObservation::Running {
            execution: control.execution(),
            dispatch_fence: control.dispatch_fence(),
        }
    }

    async fn cancel(&self, control: ExecutionControl) -> CancelObservation {
        CancelObservation::MayHaveStarted {
            execution: control.execution(),
            dispatch_fence: control.dispatch_fence(),
            fault: None,
        }
    }
}

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

async fn wait_for_started(order: &Arc<Mutex<Vec<u64>>>, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if order.lock().unwrap().len() >= expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "dispatch order did not reach {expected}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
