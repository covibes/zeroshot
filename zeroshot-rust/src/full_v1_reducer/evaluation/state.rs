use super::super::*;

pub(super) struct LoopCompletion {
    pub(super) local: Context,
    pub(super) position: HistoryPosition,
    pub(super) label: &'static str,
}

impl LoopCompletion {
    pub(super) fn new(local: Context, position: HistoryPosition, label: &'static str) -> Self {
        Self {
            local,
            position,
            label,
        }
    }
}

pub(super) enum VisitResolution {
    Exhausted,
    Ready(Box<ExecutableVisit>),
}

pub(super) struct LoopFinishRequest<'request, 'traversal> {
    pub(super) group: &'request openengine_cluster_protocol::LoopNode,
    pub(super) context: &'request mut Context,
    pub(super) traversal: Traversal<'traversal>,
    pub(super) completion: LoopCompletion,
}

pub(super) struct ExistingExecutionRequest<'graph, 'context, 'traversal> {
    pub(super) spec: ExecutableSpec<'graph>,
    pub(super) context: &'context mut Context,
    pub(super) traversal: Traversal<'traversal>,
    pub(super) execution: DurableExecution,
    pub(super) input: Value,
}

pub(super) struct MissingDispatchRequest<'graph, 'traversal> {
    pub(super) spec: ExecutableSpec<'graph>,
    pub(super) visit: ExecutableVisit,
    pub(super) input: Value,
    pub(super) traversal: Traversal<'traversal>,
}

pub(super) struct OutcomeApplication<'request, 'graph> {
    pub(super) spec: &'request ExecutableSpec<'graph>,
    pub(super) context: &'request mut Context,
    pub(super) map_indices: &'request [u64],
    pub(super) outcome: &'request WorkerOutcome,
}

pub(super) struct ExecutableVisit {
    pub(super) occurrence: StructuralOccurrence,
    pub(super) matching: Vec<DurableExecution>,
    pub(super) number: u64,
    pub(super) attempt: PositiveInteger,
    pub(super) existing: Option<DurableExecution>,
}

pub(super) fn attempts_exhausted() -> Result<Status, ReducerError> {
    Ok(Status::Terminal {
        position: HistoryPosition::ZERO,
        projection: TerminalProjection::Failed {
            reason: attempts_exhausted_reason()?,
        },
    })
}
