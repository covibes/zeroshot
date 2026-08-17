use super::*;

pub(super) struct ParallelProbeSummary<'a> {
    pub(super) probes: &'a [(Status, Context)],
    pub(super) completed: usize,
    pub(super) required: usize,
}

pub(super) struct ParallelJoinResult {
    pub(super) branch_count: usize,
    pub(super) required: usize,
    pub(super) joined: Context,
    pub(super) position: HistoryPosition,
    pub(super) winners: BTreeSet<usize>,
}

pub(super) struct TerminalMapSelection<'a> {
    pub(super) items: &'a [Value],
    pub(super) probes: &'a [MapItemResult],
    pub(super) index: usize,
    pub(super) terminal: Status,
}

pub(super) struct MapItemResult {
    pub(super) status: Status,
    pub(super) context: Context,
    pub(super) scope: Vec<u64>,
}

pub(super) fn earliest_terminal(results: &[MapItemResult]) -> Option<(usize, Status)> {
    results
        .iter()
        .enumerate()
        .filter_map(|(index, result)| match &result.status {
            Status::Terminal { position, .. } => Some((index, *position, result.status.clone())),
            Status::Pending | Status::Continue { .. } => None,
        })
        .min_by_key(|(index, position, _)| (*position, *index))
        .map(|(index, _, status)| (index, status))
}
