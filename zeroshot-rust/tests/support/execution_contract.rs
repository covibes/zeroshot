use zeroshot_engine::cluster_ledger::{ExecutionId, NodeInstanceId, ResourceId, RunSequence};
use zeroshot_engine::execution::{
    BuiltinWorkerId, BuiltinWorkerRef, CatalogDigest, DispatchFence, DriverFamilyId,
    ExecutionCommand, ExecutionCommandSpec, ExecutionInput, ExecutionTargetRef, ProfileDigest,
    ProviderLaneId, RecoveryRef, RegistryDigest, SessionScope, WorkerBindingId, WorkerBindingRef,
    WorkerBindingSpec, WorkspaceAccessMode, WorkspaceAccessRef,
};

pub struct CommandSpec<'a> {
    pub execution: u64,
    pub fence: u64,
    pub recovery: &'a str,
    pub target: ExecutionTargetRef,
    pub scope: SessionScope,
}

pub fn agent_target(node_instance: bool) -> ExecutionTargetRef {
    ExecutionTargetRef::Agent(
        WorkerBindingRef::new(WorkerBindingSpec {
            binding_id: WorkerBindingId::new("worker.binding").unwrap(),
            driver_family: DriverFamilyId::new("gateway").unwrap(),
            provider_lane: ProviderLaneId::new("lane.alpha").unwrap(),
            version: 1,
            supports_node_instance: node_instance,
        })
        .unwrap(),
    )
}

pub fn builtin_target() -> ExecutionTargetRef {
    ExecutionTargetRef::Builtin(
        BuiltinWorkerRef::new(BuiltinWorkerId::new("builtin.proof").unwrap(), 1).unwrap(),
    )
}

pub fn command_with_input(spec: CommandSpec<'_>, input: ExecutionInput) -> ExecutionCommand {
    ExecutionCommand::new(ExecutionCommandSpec {
        cluster: ResourceId::new("cluster/alpha").unwrap(),
        run: RunSequence::new(9).unwrap(),
        node_instance: NodeInstanceId::new(7).unwrap(),
        execution: ExecutionId::new(spec.execution).unwrap(),
        dispatch_fence: DispatchFence::new(spec.fence).unwrap(),
        recovery_ref: RecoveryRef::new(spec.recovery).unwrap(),
        target: spec.target,
        catalog_digest: CatalogDigest::new(digest('a')).unwrap(),
        profile_digest: ProfileDigest::new(digest('b')).unwrap(),
        registry_digest: RegistryDigest::new(digest('c')).unwrap(),
        workspace: WorkspaceAccessRef::new(
            ResourceId::new("cluster/workspace").unwrap(),
            WorkspaceAccessMode::Exclusive,
        )
        .unwrap(),
        input,
        session_scope: spec.scope,
        execution_deadline_ms: 1_900_000_000_000,
        session_deadline_ms: 1_899_999_999_999,
    })
    .unwrap()
}

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}
