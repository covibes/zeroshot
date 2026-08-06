use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, Generation, GraphDiff, GraphSpec, Phase, RunId,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::BackendError;

use super::backend::HostedState;
use super::backend_support::{internal_error, new_run_id, safe_application_error, second_apply_error};

pub(super) struct RunMetadata {
    pub(super) graph: GraphSpec,
    pub(super) generation: Generation,
    pub(super) run_id: RunId,
    pub(super) result: ApplyResult,
}

pub(super) fn run_metadata(graph: GraphSpec) -> Result<RunMetadata, BackendError> {
    let generation = Generation::new(1).map_err(|_| internal_error("invalid generation"))?;
    let run_id = new_run_id();
    let result = ApplyResult {
        generation: Some(generation),
        run_id: Some(run_id.clone()),
        phase: Phase::Running,
        deduped: false,
        diff: None,
    };
    Ok(RunMetadata {
        graph,
        generation,
        run_id,
        result,
    })
}

pub(super) fn graph_diff(current: Option<&GraphSpec>, requested: &GraphSpec) -> GraphDiff {
    let requested_name = requested.root.name().clone();
    let Some(current) = current else {
        return GraphDiff {
            added: vec![requested_name],
            removed: Vec::new(),
            changed: Vec::new(),
        };
    };
    let current_name = current.root.name().clone();
    if current_name != requested_name {
        GraphDiff {
            added: vec![requested_name],
            removed: vec![current_name],
            changed: Vec::new(),
        }
    } else if current == requested {
        GraphDiff::default()
    } else {
        GraphDiff {
            added: Vec::new(),
            removed: Vec::new(),
            changed: vec![requested_name],
        }
    }
}

pub(super) fn replay_apply(
    state: &HostedState,
    committed: &ApplyParams,
    requested: &ApplyParams,
) -> Result<ApplyResult, BackendError> {
    if committed != requested {
        return Err(second_apply_error(committed, requested));
    }
    let mut result = state
        .apply_result
        .clone()
        .ok_or_else(|| internal_error("missing apply receipt"))?;
    result.deduped = true;
    Ok(result)
}

pub(super) fn reject_cancelled(cancellation: &CancellationSignal) -> Result<(), BackendError> {
    if cancellation.is_cancelled() {
        Err(safe_application_error(
            "CANCELLED",
            "Apply was cancelled before commit",
        ))
    } else {
        Ok(())
    }
}
