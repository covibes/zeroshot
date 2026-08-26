use openengine_cluster_protocol::{RunStatus, TerminalResult};

use super::super::{CliOutcome, CliRunStatus};

pub(super) fn outcome_for_status(status: &CliRunStatus) -> CliOutcome {
    match status {
        CliRunStatus::Target(RunStatus::Finished {
            terminal_result: TerminalResult::Succeeded { .. },
            ..
        }) => CliOutcome::Finished,
        CliRunStatus::Target(RunStatus::Finished {
            terminal_result: TerminalResult::Failed { .. },
            ..
        }) => CliOutcome::Failed,
        _ => CliOutcome::Completed,
    }
}
