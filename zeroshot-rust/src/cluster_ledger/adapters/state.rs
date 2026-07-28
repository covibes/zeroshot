use openengine_cluster_protocol::{CompiledGraphIr, Cursor, Generation, GraphSpec, Phase, RunId};
use openengine_cluster_server::admission::{
    AdmissionSnapshot, ControlSnapshot, StoreError as ProtocolStoreError, VerifiedSeed,
};
use openengine_cluster_server::lifecycle::LifecycleSnapshot;

use super::{protocol_cursor, protocol_run_id};

pub(super) struct FoldedProtocolState {
    pub(super) admission: AdmissionSnapshot,
    pub(super) lifecycle: LifecycleSnapshot,
}

impl FoldedProtocolState {
    pub(super) fn from_replay(
        state: &super::super::ReplayState,
    ) -> Result<Self, ProtocolStoreError> {
        let Some(admission) = &state.admission else {
            return Ok(Self {
                admission: AdmissionSnapshot::default(),
                lifecycle: LifecycleSnapshot::default(),
            });
        };
        let generation = Generation::new(admission.generation.get())
            .map_err(|_| ProtocolStoreError::Internal("durable generation is invalid".into()))?;
        let run_id = protocol_run_id(admission.run);
        let cursor = protocol_cursor(state.position);
        let phase = if state.terminal_outcome.is_some() {
            Phase::Finished
        } else {
            Phase::Running
        };
        let control = ControlSnapshot {
            spec: decode_graph(&admission.canonical_graph)?,
            compiled_ir: decode_compiled_ir(&admission.canonical_compiled_ir)?,
            generation: Some(generation),
            run_id: Some(run_id.clone()),
            phase,
            cursor: Some(cursor.clone()),
        };
        Ok(Self {
            admission: AdmissionSnapshot {
                control,
                seed: verified_seed(state, admission.run, run_id)?,
            },
            lifecycle: lifecycle_snapshot(state, cursor)?,
        })
    }
}

fn decode_graph(bytes: &[u8]) -> Result<Option<GraphSpec>, ProtocolStoreError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|_| ProtocolStoreError::Internal("durable graph encoding is invalid".into()))
}

fn decode_compiled_ir(bytes: &[u8]) -> Result<Option<CompiledGraphIr>, ProtocolStoreError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(bytes).map(Some).map_err(|_| {
        ProtocolStoreError::Internal("durable compiled graph encoding is invalid".into())
    })
}

fn verified_seed(
    state: &super::super::ReplayState,
    run: super::super::RunSequence,
    run_id: RunId,
) -> Result<Option<VerifiedSeed>, ProtocolStoreError> {
    state
        .verified_inputs
        .get(&run)
        .map(|verified| {
            Ok(VerifiedSeed {
                run_id,
                input: serde_json::from_slice(&verified.canonical_bytes).map_err(|_| {
                    ProtocolStoreError::Internal(
                        "durable verified input encoding is invalid".into(),
                    )
                })?,
                cursor: protocol_cursor(verified.position),
            })
        })
        .transpose()
}

fn lifecycle_snapshot(
    state: &super::super::ReplayState,
    cursor: Cursor,
) -> Result<LifecycleSnapshot, ProtocolStoreError> {
    let in_flight = u32::try_from(state.active_dispatches.len())
        .map_err(|_| ProtocolStoreError::Internal("dispatch count exceeds u32".into()))?;
    let mut operational = openengine_cluster_protocol::OperationalStatus {
        in_flight,
        ..Default::default()
    };
    if state.terminal_outcome.is_some() {
        operational.dispatch_state = openengine_cluster_protocol::DispatchState::Stopped;
    }
    Ok(LifecycleSnapshot {
        operational: Some(operational),
        latest_cursor: Some(cursor),
        ..Default::default()
    })
}
