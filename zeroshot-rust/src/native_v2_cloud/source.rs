use std::collections::BTreeSet;

use openengine_cluster_protocol::EnvironmentVariableName;

use super::RunSecretEnvelope;
use crate::native_v2_delivery::GITHUB_TOKEN_ENV;
use crate::native_v2_supervisor::RunEnvironmentError;

pub(super) async fn source_github_token(
    secrets: &RunSecretEnvelope,
) -> Result<Option<String>, RunEnvironmentError> {
    let field = EnvironmentVariableName::new(GITHUB_TOKEN_ENV)
        .map_err(|_| RunEnvironmentError::InvalidPlan)?;
    let Some(values) = secrets
        .environment
        .resolve_source(BTreeSet::from([field.clone()]))
        .await?
    else {
        return Ok(secrets.github_token.clone());
    };
    values
        .as_map()
        .get(&field)
        .cloned()
        .map(Some)
        .ok_or(RunEnvironmentError::InvalidPlan)
}
