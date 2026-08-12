use openengine_cluster_protocol::{
    canonical_value_bytes, ArtifactRef, TerminalResult, WorkerDescriptor, WorkerOutcome, WorkerRef,
};
use serde_json::json;

use crate::cluster_ledger::DispatchAllocation;
use crate::execution::{CompletionEvidence, DispatchFence, DispatchObservation};

use super::program::{AGENT_WORKER_REF, NativeExecutionRegistry};
use super::NativeExecutionError;
use crate::native_admission::native_worker_protocol::OUTPUT_VALUE;
use super::agent::AgentTerminalOutput;

pub(super) fn canonical_terminal_bytes(
    value: &TerminalResult,
) -> Result<Vec<u8>, NativeExecutionError> {
    canonical_value_bytes(
        &serde_json::to_value(value).map_err(|_| NativeExecutionError::InvalidState)?,
    )
    .map_err(|_| NativeExecutionError::InvalidState)
}

pub(super) fn validate_observation(
    registry: &NativeExecutionRegistry,
    worker: &WorkerRef,
    allocation: &DispatchAllocation,
    observation: DispatchObservation,
) -> Result<Vec<u8>, NativeExecutionError> {
    let DispatchObservation::Completed {
        execution,
        dispatch_fence,
        result,
    } = observation
    else {
        return Err(NativeExecutionError::InvalidState);
    };
    let expected_fence = DispatchFence::new(allocation.execution.get())
        .map_err(|_| NativeExecutionError::Contract)?;
    let identity_matches = execution == allocation.execution && dispatch_fence == expected_fence;
    if !identity_matches || !matches!(result.evidence(), CompletionEvidence::Success) {
        return Err(NativeExecutionError::InvalidState);
    }
    validate_candidate(registry, worker, result.candidate().as_str().as_bytes())
}

fn validate_candidate(
    registry: &NativeExecutionRegistry,
    worker: &WorkerRef,
    candidate: &[u8],
) -> Result<Vec<u8>, NativeExecutionError> {
    let outcome: WorkerOutcome =
        serde_json::from_slice(candidate).map_err(|_| NativeExecutionError::InvalidState)?;
    validate_outcome(registry, worker, &outcome)?;
    let value = serde_json::to_value(&outcome).map_err(|_| NativeExecutionError::InvalidState)?;
    let canonical =
        canonical_value_bytes(&value).map_err(|_| NativeExecutionError::InvalidState)?;
    if canonical != candidate {
        return Err(NativeExecutionError::InvalidState);
    }
    Ok(canonical)
}

pub(super) fn canonical_outcome(
    registry: &NativeExecutionRegistry,
    worker: &WorkerRef,
    outcome: WorkerOutcome,
) -> Result<Vec<u8>, NativeExecutionError> {
    let value = serde_json::to_value(outcome).map_err(|_| NativeExecutionError::InvalidState)?;
    let candidate =
        canonical_value_bytes(&value).map_err(|_| NativeExecutionError::InvalidState)?;
    validate_candidate(registry, worker, &candidate)
}

fn validate_outcome(
    registry: &NativeExecutionRegistry,
    worker: &WorkerRef,
    outcome: &WorkerOutcome,
) -> Result<(), NativeExecutionError> {
    let descriptor = registry
        .descriptor(worker.as_str())
        .ok_or(NativeExecutionError::InvalidState)?;
    match outcome {
        WorkerOutcome::Error { code, .. } => descriptor
            .contract
            .errors
            .contains(code)
            .then_some(())
            .ok_or(NativeExecutionError::InvalidState),
        WorkerOutcome::Verified { output, artifacts } => {
            validate_verified(descriptor, worker, output, artifacts)
        }
        _ => Err(NativeExecutionError::InvalidState),
    }
}

fn validate_verified(
    descriptor: &WorkerDescriptor,
    worker: &WorkerRef,
    output: &serde_json::Value,
    artifacts: &[ArtifactRef],
) -> Result<(), NativeExecutionError> {
    descriptor
        .contract
        .output
        .validate_value(output)
        .map_err(|_| NativeExecutionError::InvalidState)?;
    match worker.as_str() {
        crate::native_admission::native_worker_protocol::WORKER_REF => {
            validate_deterministic(output, artifacts)
        }
        AGENT_WORKER_REF => validate_agent(output, artifacts),
        _ => Err(NativeExecutionError::InvalidState),
    }
}

fn validate_deterministic(
    output: &serde_json::Value,
    artifacts: &[ArtifactRef],
) -> Result<(), NativeExecutionError> {
    (artifacts.is_empty() && output == &json!({ "value": OUTPUT_VALUE }))
        .then_some(())
        .ok_or(NativeExecutionError::InvalidState)
}

fn validate_agent(
    output: &serde_json::Value,
    artifacts: &[ArtifactRef],
) -> Result<(), NativeExecutionError> {
    let terminal: AgentTerminalOutput =
        serde_json::from_value(output.clone()).map_err(|_| NativeExecutionError::InvalidState)?;
    terminal
        .validate()
        .map_err(|()| NativeExecutionError::InvalidState)?;
    (artifacts == [terminal.validation_artifact])
        .then_some(())
        .ok_or(NativeExecutionError::InvalidState)
}

#[cfg(test)]
mod tests {
    use openengine_cluster_protocol::{canonical_value_bytes, WorkerOutcome};

    use super::*;
    use crate::cluster_ledger::{ExecutionId, NodeInstanceId, RunSequence};
    use crate::execution::{ExecutionCandidate, ExecutionResult};
    use crate::fault::{EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence};
    use crate::observability::NoopObservationSink;

    fn candidate(value: serde_json::Value) -> Vec<u8> {
        canonical_value_bytes(&value).unwrap()
    }

    fn worker() -> WorkerRef {
        WorkerRef::new(crate::native_admission::native_worker_protocol::WORKER_REF).unwrap()
    }

    fn allocation() -> DispatchAllocation {
        DispatchAllocation {
            run: RunSequence::new(1).unwrap(),
            node_instance: NodeInstanceId::new(1).unwrap(),
            execution: ExecutionId::new(1).unwrap(),
        }
    }

    fn result(evidence: CompletionEvidence) -> crate::execution::ExecutionResult {
        let value = serde_json::to_value(WorkerOutcome::Verified {
            output: json!({ "value": 42 }),
            artifacts: Vec::new(),
        })
        .unwrap();
        let candidate =
            ExecutionCandidate::new(String::from_utf8(candidate(value)).unwrap()).unwrap();
        ExecutionResult::new(candidate, evidence, None).unwrap()
    }

    fn fault() -> crate::fault::EngineFault {
        static SINK: NoopObservationSink = NoopObservationSink;
        FaultFactory::new(&SINK).create(ModuleEvidence::new(
            FaultModule::Worker,
            FaultContext::Execution,
            EvidenceClass::InvariantViolation,
        ))
    }

    #[test]
    fn candidate_validation_is_closed_canonical_and_artifact_free() {
        let registry = NativeExecutionRegistry::production();
        let valid = serde_json::to_value(WorkerOutcome::Verified {
            output: json!({ "value": 42 }),
            artifacts: Vec::new(),
        })
        .unwrap();
        assert!(validate_candidate(&registry, &worker(), &candidate(valid)).is_ok());
        assert!(validate_candidate(&registry, &worker(), b"not-json").is_err());
        assert!(
            validate_candidate(
                &registry,
                &worker(),
                br#"{ "status":"verified","output":{"value":42},"artifacts":[] }"#,
            )
            .is_err()
        );
        assert!(
            validate_candidate(
                &registry,
                &worker(),
                &candidate(json!({
                    "status": "verifier",
                    "output": { "value": 42 },
                    "signals": {},
                    "diagnostic": null,
                    "artifacts": []
                })),
            )
            .is_err()
        );
        assert!(
            validate_candidate(
                &registry,
                &worker(),
                &candidate(json!({
                    "status": "verified",
                    "output": { "value": 42 },
                    "artifacts": [{
                        "artifactId": "artifact-1",
                        "sha256": "a".repeat(64),
                        "byteLength": 1,
                        "mediaType": "application/json",
                        "typeId": "native.deterministic.output@1",
                        "producer": {
                            "node": "deterministic",
                            "worker": "native.deterministic@1"
                        },
                        "lineage": { "generation": 1, "runId": "run:1", "attempt": 1 },
                        "redaction": "internal"
                    }]
                })),
            )
            .is_err()
        );
    }

    #[test]
    fn observation_must_be_successful_completed_and_allocation_bound() {
        let registry = NativeExecutionRegistry::production();
        let allocation = allocation();
        let fence = DispatchFence::new(allocation.execution.get()).unwrap();
        assert!(
            validate_observation(
                &registry,
                &worker(),
                &allocation,
                DispatchObservation::Running {
                    execution: allocation.execution,
                    dispatch_fence: fence,
                },
            )
            .is_err()
        );
        assert!(
            validate_observation(
                &registry,
                &worker(),
                &allocation,
                DispatchObservation::Completed {
                    execution: ExecutionId::new(2).unwrap(),
                    dispatch_fence: fence,
                    result: result(CompletionEvidence::Success),
                },
            )
            .is_err()
        );
        assert!(
            validate_observation(
                &registry,
                &worker(),
                &allocation,
                DispatchObservation::Completed {
                    execution: allocation.execution,
                    dispatch_fence: fence,
                    result: result(CompletionEvidence::Fault(fault())),
                },
            )
            .is_err()
        );
    }
}
