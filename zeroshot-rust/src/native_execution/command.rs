use openengine_cluster_protocol::{canonical_value_bytes, WorkerRef};
use serde_json::Value;

use crate::cluster_ledger::store::IdempotencyId;
use crate::cluster_ledger::{DispatchAllocation, ExecutionId, ReplayState, RunSequence};
use crate::execution::{
    BuiltinWorkerId, BuiltinWorkerRef, CatalogDigest, DispatchFence, ExecutionCommand,
    ExecutionCommandSpec, ExecutionInput, ExecutionTargetRef, ProfileDigest, RecoveryRef,
    RegistryDigest, SessionScope, WorkspaceAccessMode, WorkspaceAccessRef,
};
use crate::native_admission::native_worker_protocol::{digest_hex, WORKER_REF};

use super::agent::AgentDispatchInput;
use super::program::{NativeExecutionRegistry, AGENT_WORKER_REF};
use super::{admission, NativeExecutionError};

pub(super) fn dispatch_key(
    run: RunSequence,
    execution: ExecutionId,
) -> Result<IdempotencyId, NativeExecutionError> {
    IdempotencyId::new(format!("native-dispatch-{}-{}", run.get(), execution.get()))
        .map_err(|_| NativeExecutionError::Contract)
}

pub(super) fn settlement_key(
    run: RunSequence,
    execution: ExecutionId,
) -> Result<IdempotencyId, NativeExecutionError> {
    IdempotencyId::new(format!(
        "native-settlement-{}-{}",
        run.get(),
        execution.get()
    ))
    .map_err(|_| NativeExecutionError::Contract)
}

pub(super) fn terminal_key(run: RunSequence) -> Result<IdempotencyId, NativeExecutionError> {
    IdempotencyId::new(format!("native-terminal-{}", run.get()))
        .map_err(|_| NativeExecutionError::Contract)
}

pub(super) struct CommandRequest<'a> {
    pub(super) state: &'a ReplayState,
    pub(super) allocation: DispatchAllocation,
    pub(super) input: Value,
    pub(super) worker: &'a WorkerRef,
}

pub(super) fn build(
    request: CommandRequest<'_>,
    registry: &NativeExecutionRegistry,
) -> Result<ExecutionCommand, NativeExecutionError> {
    let CommandRequest {
        state,
        allocation,
        input,
        worker,
    } = request;
    let admission = admission(state)?;
    let (dispatch_fence, recovery_ref) = control_refs(&allocation)?;
    let (catalog_digest, profile_digest, registry_digest) = digests(admission, registry)?;
    ExecutionCommand::new(ExecutionCommandSpec {
        cluster: state.resource.clone(),
        run: allocation.run,
        node_instance: allocation.node_instance,
        execution: allocation.execution,
        dispatch_fence,
        recovery_ref,
        target: target(worker)?,
        catalog_digest,
        profile_digest,
        registry_digest,
        workspace: WorkspaceAccessRef::new(state.resource.clone(), WorkspaceAccessMode::Exclusive)
            .map_err(|_| NativeExecutionError::Contract)?,
        input: execution_input(input, admission.generation.get(), worker)?,
        session_scope: SessionScope::Execution,
        execution_deadline_ms: admission.absolute_deadline_ms,
        session_deadline_ms: admission.absolute_deadline_ms,
    })
    .map_err(|_| NativeExecutionError::Contract)
}

fn control_refs(
    allocation: &DispatchAllocation,
) -> Result<(DispatchFence, RecoveryRef), NativeExecutionError> {
    let fence = DispatchFence::new(allocation.execution.get())
        .map_err(|_| NativeExecutionError::Contract)?;
    let recovery = RecoveryRef::new(format!(
        "native-run-{}-execution-{}",
        allocation.run.get(),
        allocation.execution.get()
    ))
    .map_err(|_| NativeExecutionError::Contract)?;
    Ok((fence, recovery))
}

fn target(worker: &WorkerRef) -> Result<ExecutionTargetRef, NativeExecutionError> {
    let worker = match worker.as_str() {
        WORKER_REF => "native.deterministic",
        AGENT_WORKER_REF => "native.agent.codex",
        _ => return Err(NativeExecutionError::InvalidState),
    };
    let worker = BuiltinWorkerId::new(worker).map_err(|_| NativeExecutionError::Contract)?;
    let target = BuiltinWorkerRef::new(worker, 1).map_err(|_| NativeExecutionError::Contract)?;
    Ok(ExecutionTargetRef::Builtin(target))
}

fn digests(
    admission: &crate::cluster_ledger::replay::AdmissionState,
    registry: &NativeExecutionRegistry,
) -> Result<(CatalogDigest, ProfileDigest, RegistryDigest), NativeExecutionError> {
    let catalog = CatalogDigest::new(digest_hex(admission.catalog_digest))
        .map_err(|_| NativeExecutionError::Contract)?;
    let profile = ProfileDigest::new(digest_hex(admission.profile_digest))
        .map_err(|_| NativeExecutionError::Contract)?;
    let registry = RegistryDigest::new(digest_hex(registry.catalog_digest()))
        .map_err(|_| NativeExecutionError::Contract)?;
    Ok((catalog, profile, registry))
}

fn execution_input(
    input: Value,
    generation: u64,
    worker: &WorkerRef,
) -> Result<ExecutionInput, NativeExecutionError> {
    let value = if worker.as_str() == AGENT_WORKER_REF {
        serde_json::to_value(
            AgentDispatchInput::new(generation, input)
                .map_err(|()| NativeExecutionError::InvalidState)?,
        )
        .map_err(|_| NativeExecutionError::InvalidState)?
    } else {
        input
    };
    let canonical =
        canonical_value_bytes(&value).map_err(|_| NativeExecutionError::InvalidState)?;
    let inline = String::from_utf8(canonical).map_err(|_| NativeExecutionError::InvalidState)?;
    ExecutionInput::inline(inline).map_err(|_| NativeExecutionError::Contract)
}
