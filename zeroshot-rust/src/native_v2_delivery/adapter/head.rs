use super::*;

impl NativeV2DeliveryAdapter {
    pub(super) async fn advance_review_head(
        &self,
        drive: &mut ReviewDrive<'_>,
    ) -> Result<ReviewStep, DeliveryStop> {
        emit(drive.control, "delivery: updating pull request branch").await?;
        let outcome = self.request_head_update(drive).await?;
        match outcome {
            GitHubHeadUpdateOutcome::Updated(updated) => {
                if !valid_head_update(&drive.review, &updated) {
                    return Err(DeliveryStop::Outcome(WorkerOutcome::malformed()));
                }
                drive.review = updated;
                emit(drive.control, "delivery: adopted updated pull request head").await?;
                Ok(ReviewStep::Continue)
            }
            GitHubHeadUpdateOutcome::Pending => {
                emit(
                    drive.control,
                    "delivery: pull request update is not yet available",
                )
                .await?;
                Ok(ReviewStep::Continue)
            }
            GitHubHeadUpdateOutcome::Conflict => {
                review_completion(
                    drive,
                    DELIVERY_CONFLICT_LABEL,
                    "GitHub authoritatively rejected branch update due to conflict",
                )
                .await
            }
        }
    }

    async fn request_head_update(
        &self,
        drive: &mut ReviewDrive<'_>,
    ) -> Result<GitHubHeadUpdateOutcome, DeliveryStop> {
        let outcome = match self
            .authority
            .update_review_head(
                &self.config.workspace,
                &drive.review,
                drive.credentials.current(),
            )
            .await
        {
            Ok(outcome) => outcome,
            Err(_) => {
                emit(drive.control, "delivery: refreshing GitHub credential").await?;
                drive.credentials.refresh().await?;
                self.authority
                    .update_review_head(
                        &self.config.workspace,
                        &drive.review,
                        drive.credentials.current(),
                    )
                    .await
                    .map_err(|_| crash_outcome())?
            }
        };
        Ok(outcome)
    }
}
