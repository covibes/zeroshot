//! Pure `apply` plan preparation: decides whether an admission proposal is unchanged or changed,
//! and stages the changed-path payloads/receipt, without touching the durable ledger itself.

use openengine_cluster_protocol::{canonical_value_bytes, ApplyResult, Generation, Phase};
use openengine_cluster_server::admission::{CommitProposal, StoreError as ProtocolStoreError};
use serde::Serialize;

use super::super::record::{CanonicalDigest, RecordPayload};
use super::super::ReplayState;
use super::protocol::protocol_run_id;
use super::AdmissionRecordContext;

pub(super) enum ApplyPlan {
    Unchanged {
        proposal: CommitProposal,
        generation: Option<Generation>,
    },
    Changed {
        proposal: CommitProposal,
        canonical_compiled_ir: Vec<u8>,
    },
}

pub(super) struct ChangedApply {
    pub(super) result: ApplyResult,
    pub(super) payloads: Vec<RecordPayload>,
}

pub(super) fn prepare_unchanged_apply(
    state: &ReplayState,
    proposal: CommitProposal,
    generation: Option<Generation>,
) -> Result<ChangedApply, ProtocolStoreError> {
    if proposal.input.is_some() {
        return Err(ProtocolStoreError::SchemaViolation(
            "unchanged admission cannot replace verified input".into(),
        ));
    }
    let current = state
        .admission
        .as_ref()
        .expect("unchanged admission requires current state");
    Ok(ChangedApply {
        result: ApplyResult {
            generation,
            run_id: Some(protocol_run_id(current.run)),
            phase: Phase::Running,
            deduped: false,
            diff: None,
        },
        payloads: Vec::new(),
    })
}

pub(super) fn ensure_change_is_safe(state: &ReplayState) -> Result<(), ProtocolStoreError> {
    if !state.active_dispatches.is_empty()
        || state
            .effects
            .values()
            .any(|effect| effect.receipt_digest.is_none())
    {
        return Err(ProtocolStoreError::InvalidPhase {
            current: Phase::Running,
        });
    }
    Ok(())
}

fn canonical_internal<T: Serialize>(
    value: &T,
    encoding_error: &'static str,
    canonical_error: &'static str,
) -> Result<Vec<u8>, ProtocolStoreError> {
    let value = serde_json::to_value(value)
        .map_err(|_| ProtocolStoreError::Internal(encoding_error.into()))?;
    canonical_value_bytes(&value).map_err(|_| ProtocolStoreError::Internal(canonical_error.into()))
}

fn canonical_input(proposal: &CommitProposal) -> Result<Vec<u8>, ProtocolStoreError> {
    let input = proposal.input.as_ref().ok_or_else(|| {
        ProtocolStoreError::SchemaViolation("changed admission requires verified input".into())
    })?;
    canonical_value_bytes(input)
        .map_err(|_| ProtocolStoreError::SchemaViolation("input is not canonical".into()))
}

pub(super) fn prepare_changed_apply(
    state: &mut ReplayState,
    proposal: CommitProposal,
    canonical_compiled_ir: Vec<u8>,
    admission: &AdmissionRecordContext,
) -> Result<ChangedApply, ProtocolStoreError> {
    let generation = state
        .identities
        .allocate_generation()
        .map_err(|_| ProtocolStoreError::Internal("generation allocation failed".into()))?;
    let run = state
        .identities
        .allocate_run()
        .map_err(|_| ProtocolStoreError::Internal("run allocation failed".into()))?;
    let canonical_graph = canonical_internal(
        &proposal.graph,
        "graph encoding failed",
        "graph canonicalization failed",
    )?;
    let canonical_policy = canonical_internal(
        &proposal.graph.policy,
        "graph policy encoding failed",
        "graph policy is not canonical",
    )?;
    let canonical_input = canonical_input(&proposal)?;
    let input_digest = CanonicalDigest::of(&canonical_input);
    let payloads = changed_apply_payloads(ChangedPayloads {
        generation,
        run,
        canonical_graph,
        canonical_input,
        input_digest,
        canonical_compiled_ir,
        policy_digest: CanonicalDigest::of(&canonical_policy),
        catalog_digest: *admission.catalog_digest(),
        profile_digest: *admission.profile_digest(),
        absolute_deadline_ms: admission.absolute_deadline_ms()?,
    });
    Ok(ChangedApply {
        result: ApplyResult {
            generation: Some(Generation::new(generation.get()).map_err(|_| {
                ProtocolStoreError::Internal("generation exceeds protocol range".into())
            })?),
            run_id: Some(protocol_run_id(run)),
            phase: Phase::Running,
            deduped: false,
            diff: None,
        },
        payloads,
    })
}

struct ChangedPayloads {
    generation: super::super::GenerationId,
    run: super::super::RunSequence,
    canonical_graph: Vec<u8>,
    canonical_input: Vec<u8>,
    input_digest: CanonicalDigest,
    canonical_compiled_ir: Vec<u8>,
    policy_digest: CanonicalDigest,
    catalog_digest: CanonicalDigest,
    profile_digest: CanonicalDigest,
    absolute_deadline_ms: u64,
}

fn changed_apply_payloads(changed: ChangedPayloads) -> Vec<RecordPayload> {
    let ChangedPayloads {
        generation,
        run,
        canonical_graph,
        canonical_input,
        input_digest,
        canonical_compiled_ir,
        policy_digest,
        catalog_digest,
        profile_digest,
        absolute_deadline_ms,
    } = changed;
    vec![
        RecordPayload::Admission {
            generation,
            run,
            graph_digest: CanonicalDigest::of(&canonical_graph),
            input_digest,
            policy_digest,
            catalog_digest,
            profile_digest,
            absolute_deadline_ms,
            canonical_graph,
            canonical_compiled_ir,
        },
        RecordPayload::VerifiedInput {
            run,
            digest: input_digest,
            canonical_bytes: canonical_input,
        },
    ]
}

pub(super) fn current_protocol_generation(
    state: &ReplayState,
) -> Result<Option<Generation>, ProtocolStoreError> {
    state
        .admission
        .as_ref()
        .map(|admission| {
            Generation::new(admission.generation.get())
                .map_err(|_| ProtocolStoreError::Internal("durable generation is invalid".into()))
        })
        .transpose()
}

fn validate_protocol_generation(
    expected: Option<Generation>,
    current: Option<Generation>,
) -> Result<(), ProtocolStoreError> {
    let matches = match expected {
        None => true,
        Some(expected) if expected.get() == 0 => current.is_none(),
        Some(expected) => current == Some(expected),
    };
    if matches {
        Ok(())
    } else {
        Err(ProtocolStoreError::GenerationConflict { current })
    }
}

fn ensure_apply_phase(state: &ReplayState) -> Result<(), ProtocolStoreError> {
    if state.terminal_outcome.is_some() {
        Err(ProtocolStoreError::InvalidPhase {
            current: Phase::Finished,
        })
    } else {
        Ok(())
    }
}

pub(super) fn prepare_apply_plan(
    state: &ReplayState,
    proposal: CommitProposal,
) -> Result<ApplyPlan, ProtocolStoreError> {
    ensure_apply_phase(state)?;
    let current_generation = current_protocol_generation(state)?;
    validate_protocol_generation(proposal.if_generation, current_generation)?;
    let canonical_compiled_ir = proposal
        .compiled_ir
        .canonical_bytes()
        .map_err(|_| ProtocolStoreError::Internal("compiled graph encoding failed".into()))?;
    let unchanged = state
        .admission
        .as_ref()
        .is_some_and(|admission| admission.canonical_compiled_ir == canonical_compiled_ir);
    Ok(if unchanged {
        ApplyPlan::Unchanged {
            proposal,
            generation: current_generation,
        }
    } else {
        ApplyPlan::Changed {
            proposal,
            canonical_compiled_ir,
        }
    })
}
