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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use openengine_cluster_protocol::{
        CodexProvider, ConnectionKey, DeclaredConnections, DeclaredEnvironment, ModelId, NodeName,
        RunConnectionRequirements, RunConnectionValues, RunSize, RuntimePlan, SessionScope,
        StaticConnectionValues,
    };
    use openengine_cluster_testkit::assertions::AssertValue;

    use super::*;
    use crate::native_v2_contract::NodeRuntimeBinding;
    use crate::native_v2_supervisor::{
        ConnectionResolutionUnavailable, DynamicConnectionPlan, RunConnectionResolver,
        RunEnvironment,
    };

    #[derive(Default)]
    struct RotatingResolver {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl RunConnectionResolver for RotatingResolver {
        async fn resolve(
            &self,
            requirements: RunConnectionRequirements,
        ) -> Result<RunConnectionValues, ConnectionResolutionUnavailable> {
            let token = format!("source-{}", self.calls.fetch_add(1, Ordering::SeqCst) + 1);
            Ok(requirements
                .into_iter()
                .map(|(key, fields)| {
                    let values = fields
                        .into_iter()
                        .map(|field| (field, token.clone()))
                        .collect();
                    (key, StaticConnectionValues::new(values).assert_value())
                })
                .collect())
        }
    }

    #[tokio::test]
    async fn source_checkout_resolves_again_instead_of_reusing_an_earlier_token() {
        let key = ConnectionKey::new("github").assert_value();
        let field = EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value();
        let node = NodeRuntimeBinding::Agent {
            model: ModelId::new("gpt-5.6").assert_value(),
            effort: None,
            session_scope: SessionScope::Execution,
            connections: DeclaredConnections::single(
                key.as_str(),
                DeclaredEnvironment::new([field]).assert_value(),
            )
            .assert_value(),
        };
        let runtime = RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Small,
            nodes: BTreeMap::from([(NodeName::new("deliver").assert_value(), node)]),
        };
        let environment = RunEnvironment::with_resolver(
            &runtime,
            BTreeMap::new(),
            DynamicConnectionPlan {
                resolver: Arc::new(RotatingResolver::default()),
                keys: BTreeSet::from([key.clone()]),
                source_connection: Some(key),
            },
        )
        .assert_value();
        let secrets = RunSecretEnvelope {
            environment: Arc::new(environment),
            github_token: None,
        };

        assert_eq!(
            source_github_token(&secrets)
                .await
                .assert_value()
                .as_deref(),
            Some("source-1")
        );
        assert_eq!(
            source_github_token(&secrets)
                .await
                .assert_value()
                .as_deref(),
            Some("source-2")
        );
    }
}
