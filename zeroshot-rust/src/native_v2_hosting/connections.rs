use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ConnectionResolveRequest, ConnectionResolveResult, ConnectionKey, RunConnectionRequirements,
    RunConnectionValues, RunId, TargetConnectionResolver,
};
use reqwest::{redirect::Policy, Client, Url};

use crate::native_v2_supervisor::{
    ConnectionResolutionUnavailable, DynamicConnectionPlan, RunConnectionResolver,
};
use crate::native_v2_target_authority::TargetAuthorityError;

const MAX_RESOLUTION_RESPONSE_BYTES: usize = 300 * 1024;
const MAX_RESOLVER_TOKEN_BYTES: usize = 16 * 1024;
const RESOLUTION_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn build_connection_resolver(
    run_id: RunId,
    wire: TargetConnectionResolver,
) -> Result<DynamicConnectionPlan, TargetAuthorityError> {
    let endpoint = validated_endpoint(&wire.endpoint)?;
    validate_bearer_token(&wire.bearer_token)?;
    let dynamic_keys = validated_dynamic_keys(&wire.keys, wire.source_connection.as_ref())?;
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(RESOLUTION_TIMEOUT)
        .build()
        .map_err(|_| invalid("connection resolver client is unavailable"))?;
    Ok(DynamicConnectionPlan {
        resolver: Arc::new(HttpRunConnectionResolver {
            client,
            endpoint,
            bearer_token: Arc::from(wire.bearer_token),
            run_id,
        }),
        keys: dynamic_keys,
        source_connection: wire.source_connection,
    })
}

fn validated_endpoint(value: &str) -> Result<Url, TargetAuthorityError> {
    let endpoint =
        Url::parse(value).map_err(|_| invalid("connection resolver endpoint is invalid"))?;
    let valid = endpoint.scheme() == "https"
        && endpoint.host_str().is_some()
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.query().is_none()
        && endpoint.fragment().is_none();
    valid
        .then_some(endpoint)
        .ok_or_else(|| invalid("connection resolver endpoint is invalid"))
}

fn validate_bearer_token(value: &str) -> Result<(), TargetAuthorityError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_RESOLVER_TOKEN_BYTES
        && !value.chars().any(char::is_control);
    valid
        .then_some(())
        .ok_or_else(|| invalid("connection resolver bearer token is invalid"))
}

fn validated_dynamic_keys(
    keys: &[ConnectionKey],
    source_connection: Option<&ConnectionKey>,
) -> Result<BTreeSet<ConnectionKey>, TargetAuthorityError> {
    let dynamic_keys = keys.iter().cloned().collect::<BTreeSet<_>>();
    let valid = !dynamic_keys.is_empty()
        && dynamic_keys.len() == keys.len()
        && source_connection.is_none_or(|key| dynamic_keys.contains(key));
    valid
        .then_some(dynamic_keys)
        .ok_or_else(|| invalid("connection resolver keys are invalid"))
}

struct HttpRunConnectionResolver {
    client: Client,
    endpoint: Url,
    bearer_token: Arc<str>,
    run_id: RunId,
}

#[async_trait]
impl RunConnectionResolver for HttpRunConnectionResolver {
    async fn resolve(
        &self,
        requirements: RunConnectionRequirements,
    ) -> Result<RunConnectionValues, ConnectionResolutionUnavailable> {
        let mut response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.bearer_token.as_ref())
            .json(&ConnectionResolveRequest {
                run_id: self.run_id.clone(),
                connections: requirements,
            })
            .send()
            .await
            .map_err(|_| ConnectionResolutionUnavailable)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > MAX_RESOLUTION_RESPONSE_BYTES as u64)
        {
            return Err(ConnectionResolutionUnavailable);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ConnectionResolutionUnavailable)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_RESOLUTION_RESPONSE_BYTES {
                return Err(ConnectionResolutionUnavailable);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<ConnectionResolveResult>(&body)
            .map(|result| result.connections)
            .map_err(|_| ConnectionResolutionUnavailable)
    }
}

fn invalid(message: &str) -> TargetAuthorityError {
    TargetAuthorityError::invalid(message.to_owned())
}
