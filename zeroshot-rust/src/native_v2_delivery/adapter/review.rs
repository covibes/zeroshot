use super::*;

pub(super) enum ReviewProgress {
    Merged,
    CiFailed(String),
    Mergeable,
    Pending,
    Conflict,
    Closed,
}

pub(super) enum ReviewStep {
    Continue,
    Complete(WorkerOutcome),
}

impl ReviewProgress {
    pub(super) fn from_state(state: GitHubReviewState) -> Result<Self, DeliveryStop> {
        match state {
            GitHubReviewState::Merged { merge_revision } if valid_revision(&merge_revision) => {
                Ok(Self::Merged)
            }
            GitHubReviewState::Merged { .. } => {
                Err(DeliveryStop::Outcome(WorkerOutcome::malformed()))
            }
            GitHubReviewState::Open {
                checks: GitHubChecks::Failed { diagnostic },
            } => Ok(Self::CiFailed(diagnostic)),
            GitHubReviewState::Open {
                checks: GitHubChecks::Pending,
            } => Ok(Self::Pending),
            GitHubReviewState::Open {
                checks: GitHubChecks::NotRequired | GitHubChecks::Passed,
            } => Ok(Self::Mergeable),
            GitHubReviewState::Conflict => Ok(Self::Conflict),
            GitHubReviewState::Closed => Ok(Self::Closed),
        }
    }
}

pub(super) fn crash_outcome() -> DeliveryStop {
    DeliveryStop::Outcome(WorkerOutcome::declared_failure(WorkerErrorCode::Crash))
}

pub(super) async fn review_completion(
    drive: &ReviewDrive<'_>,
    label: &'static str,
    diagnostic: &str,
) -> Result<ReviewStep, DeliveryStop> {
    emit(drive.control, diagnostic).await?;
    validate_delivery_contract(drive.mode, drive.response).map_err(DeliveryStop::Runner)?;
    delivery_outcome(drive.mode, label, &drive.review, diagnostic)
        .map(ReviewStep::Complete)
        .map_err(DeliveryStop::Runner)
}
