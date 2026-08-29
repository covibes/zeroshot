use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ConnectionKey, EnvironmentVariableName, RunConnectionRequirements, RunConnectionValues,
    RuntimePlan, StaticConnectionValues,
};
use thiserror::Error;

use crate::native_v2_contract::NodeRuntimeBinding;
use crate::native_v2_runner::ResolvedEnvironment;

const MAX_RUN_ENVIRONMENT_BYTES: usize = 256 * 1024;

/// Resolves one node's exact dynamic connection shape at the moment that node starts.
#[async_trait]
pub(crate) trait RunConnectionResolver: Send + Sync {
    async fn resolve(
        &self,
        requirements: RunConnectionRequirements,
    ) -> Result<RunConnectionValues, ConnectionResolutionUnavailable>;
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("dynamic connection resolution is unavailable")]
pub(crate) struct ConnectionResolutionUnavailable;

pub(crate) struct DynamicConnectionPlan {
    pub resolver: Arc<dyn RunConnectionResolver>,
    pub keys: BTreeSet<ConnectionKey>,
    pub source_connection: Option<ConnectionKey>,
}

/// Bounded static values plus run-scoped authority for exactly the dynamic keys in one runtime.
///
/// Static values never enter admission, the ledger, observations, or debug output. Dynamic values
/// are fetched only for the connection keys and fields declared by the node that is starting.
#[derive(Clone)]
pub struct RunEnvironment {
    values: Arc<RunConnectionValues>,
    dynamic_keys: Arc<BTreeSet<ConnectionKey>>,
    source_connection: Option<ConnectionKey>,
    resolver: Option<Arc<dyn RunConnectionResolver>>,
}

impl RunEnvironment {
    pub fn exact(
        runtime: &RuntimePlan,
        values: RunConnectionValues,
    ) -> Result<Self, RunEnvironmentError> {
        validate_bootstrap(runtime, &values, &BTreeSet::new())?;
        Ok(Self {
            values: Arc::new(values),
            dynamic_keys: Arc::new(BTreeSet::new()),
            source_connection: None,
            resolver: None,
        })
    }

    pub(crate) fn with_resolver(
        runtime: &RuntimePlan,
        values: RunConnectionValues,
        dynamic: DynamicConnectionPlan,
    ) -> Result<Self, RunEnvironmentError> {
        if dynamic.keys.is_empty()
            || dynamic
                .source_connection
                .as_ref()
                .is_some_and(|key| !dynamic.keys.contains(key))
        {
            return Err(RunEnvironmentError::InvalidPlan);
        }
        validate_bootstrap(runtime, &values, &dynamic.keys)?;
        Ok(Self {
            values: Arc::new(values),
            dynamic_keys: Arc::new(dynamic.keys),
            source_connection: dynamic.source_connection,
            resolver: Some(dynamic.resolver),
        })
    }

    /// Selects one run's exact keyed snapshots from a trusted host environment inventory.
    pub fn from_available(
        runtime: &RuntimePlan,
        available: &BTreeMap<EnvironmentVariableName, String>,
    ) -> Result<Self, RunEnvironmentError> {
        let mut values = RunConnectionValues::new();
        for (key, fields) in runtime.connection_requirements() {
            let selected = select_environment_values(key.clone(), fields.iter(), available)?;
            values.insert(
                key,
                StaticConnectionValues::new(selected)
                    .map_err(|_| RunEnvironmentError::InvalidPlan)?,
            );
        }
        Self::exact(runtime, values)
    }

    /// Revalidates the static/dynamic partition against an immutable admitted runtime plan.
    pub fn for_runtime(&self, runtime: &RuntimePlan) -> Result<Self, RunEnvironmentError> {
        validate_bootstrap(runtime, self.values.as_ref(), self.dynamic_keys.as_ref())?;
        Ok(self.clone())
    }

    pub(crate) fn bootstrap_values(&self) -> RunConnectionValues {
        self.values.as_ref().clone()
    }

    pub(crate) async fn resolve_source(
        &self,
        fields: BTreeSet<EnvironmentVariableName>,
    ) -> Result<Option<StaticConnectionValues>, RunEnvironmentError> {
        let Some(key) = self.source_connection.clone() else {
            return Ok(None);
        };
        let mut resolved = self
            .resolve_requirements(BTreeMap::from([(key.clone(), fields)]))
            .await?;
        resolved
            .remove(&key)
            .map(Some)
            .ok_or(RunEnvironmentError::MissingConnection(key))
    }

    pub(super) async fn resolve(
        &self,
        binding: &NodeRuntimeBinding,
    ) -> Result<ResolvedEnvironment, RunEnvironmentError> {
        let requirements = binding
            .declared_connections()
            .iter()
            .map(|(key, fields)| (key.clone(), fields.as_set().clone()))
            .collect();
        let resolved = self.resolve_requirements(requirements).await?;
        let mut values = BTreeMap::new();
        for (key, fields) in binding.declared_connections().iter() {
            let source = resolved
                .get(key)
                .ok_or_else(|| RunEnvironmentError::MissingConnection(key.clone()))?;
            for name in fields.iter() {
                let value =
                    source.as_map().get(name).cloned().ok_or_else(|| {
                        RunEnvironmentError::MissingField(key.clone(), name.clone())
                    })?;
                if values.insert(name.clone(), value).is_some() {
                    return Err(RunEnvironmentError::InvalidPlan);
                }
            }
        }
        ResolvedEnvironment::exact(binding, values).map_err(|_| RunEnvironmentError::InvalidPlan)
    }

    async fn resolve_requirements(
        &self,
        requirements: BTreeMap<ConnectionKey, BTreeSet<EnvironmentVariableName>>,
    ) -> Result<RunConnectionValues, RunEnvironmentError> {
        let mut selected = RunConnectionValues::new();
        let mut dynamic = RunConnectionRequirements::new();
        for (key, fields) in requirements {
            if let Some(values) = self.values.get(&key) {
                selected.insert(key.clone(), select_required(&key, &fields, values)?);
            } else if self.dynamic_keys.contains(&key) {
                dynamic.insert(key, fields.into_iter().collect());
            } else {
                return Err(RunEnvironmentError::MissingConnection(key));
            }
        }
        if !dynamic.is_empty() {
            let resolver = self
                .resolver
                .as_ref()
                .ok_or(RunEnvironmentError::InvalidPlan)?;
            let resolved = resolver
                .resolve(dynamic.clone())
                .await
                .map_err(|_| RunEnvironmentError::ResolutionUnavailable)?;
            validate_resolution(&dynamic, &resolved)?;
            selected.extend(resolved);
        }
        validate_size(&selected)?;
        Ok(selected)
    }
}

fn validate_bootstrap(
    runtime: &RuntimePlan,
    values: &RunConnectionValues,
    dynamic_keys: &BTreeSet<ConnectionKey>,
) -> Result<(), RunEnvironmentError> {
    let declared = runtime.connection_requirements();
    if let Some(key) = declared
        .keys()
        .find(|key| !values.contains_key(*key) && !dynamic_keys.contains(*key))
    {
        return Err(RunEnvironmentError::MissingConnection(key.clone()));
    }
    if let Some(key) = values
        .keys()
        .chain(dynamic_keys.iter())
        .find(|key| !declared.contains_key(*key))
    {
        return Err(RunEnvironmentError::UndeclaredConnection(key.clone()));
    }
    if let Some(key) = values.keys().find(|key| dynamic_keys.contains(*key)) {
        return Err(RunEnvironmentError::UndeclaredConnection(key.clone()));
    }
    for (key, supplied) in values {
        let fields = declared
            .get(key)
            .ok_or_else(|| RunEnvironmentError::UndeclaredConnection(key.clone()))?;
        validate_connection_shape(key, fields, supplied)?;
    }
    validate_size(values)
}

fn validate_resolution(
    requirements: &RunConnectionRequirements,
    resolved: &RunConnectionValues,
) -> Result<(), RunEnvironmentError> {
    if let Some(key) = requirements.keys().find(|key| !resolved.contains_key(*key)) {
        return Err(RunEnvironmentError::MissingConnection(key.clone()));
    }
    if let Some(key) = resolved.keys().find(|key| !requirements.contains_key(*key)) {
        return Err(RunEnvironmentError::UndeclaredConnection(key.clone()));
    }
    for (key, fields) in requirements {
        let fields = fields.iter().cloned().collect::<BTreeSet<_>>();
        let values = resolved
            .get(key)
            .ok_or_else(|| RunEnvironmentError::MissingConnection(key.clone()))?;
        validate_connection_shape(key, &fields, values)?;
    }
    Ok(())
}

fn select_required(
    key: &ConnectionKey,
    fields: &BTreeSet<EnvironmentVariableName>,
    values: &StaticConnectionValues,
) -> Result<StaticConnectionValues, RunEnvironmentError> {
    let selected = fields
        .iter()
        .map(|name| {
            values
                .as_map()
                .get(name)
                .cloned()
                .map(|value| (name.clone(), value))
                .ok_or_else(|| RunEnvironmentError::MissingField(key.clone(), name.clone()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    StaticConnectionValues::new(selected).map_err(|_| RunEnvironmentError::InvalidPlan)
}

fn select_environment_values<'a>(
    key: ConnectionKey,
    names: impl IntoIterator<Item = &'a EnvironmentVariableName>,
    available: &BTreeMap<EnvironmentVariableName, String>,
) -> Result<BTreeMap<EnvironmentVariableName, String>, RunEnvironmentError> {
    let mut selected = BTreeMap::new();
    for name in names {
        let value = available
            .get(name)
            .cloned()
            .ok_or_else(|| RunEnvironmentError::MissingField(key.clone(), name.clone()))?;
        selected.insert(name.clone(), value);
    }
    Ok(selected)
}

fn validate_connection_shape(
    key: &ConnectionKey,
    fields: &BTreeSet<EnvironmentVariableName>,
    supplied: &StaticConnectionValues,
) -> Result<(), RunEnvironmentError> {
    if let Some(name) = fields
        .iter()
        .find(|name| !supplied.as_map().contains_key(*name))
    {
        return Err(RunEnvironmentError::MissingField(key.clone(), name.clone()));
    }
    if let Some(name) = supplied
        .as_map()
        .keys()
        .find(|name| !fields.contains(*name))
    {
        return Err(RunEnvironmentError::UndeclaredField(
            key.clone(),
            name.clone(),
        ));
    }
    Ok(())
}

fn validate_size(values: &RunConnectionValues) -> Result<(), RunEnvironmentError> {
    let total = values.iter().try_fold(0_usize, |total, (key, values)| {
        total
            .checked_add(connection_size(key, values)?)
            .ok_or(RunEnvironmentError::TooLarge)
    })?;
    if total > MAX_RUN_ENVIRONMENT_BYTES {
        return Err(RunEnvironmentError::TooLarge);
    }
    Ok(())
}

fn connection_size(
    key: &ConnectionKey,
    values: &StaticConnectionValues,
) -> Result<usize, RunEnvironmentError> {
    values
        .as_map()
        .iter()
        .try_fold(0_usize, |total, (name, value)| {
            total
                .checked_add(key.as_str().len())
                .and_then(|size| size.checked_add(name.as_str().len()))
                .and_then(|size| size.checked_add(value.len()))
                .ok_or(RunEnvironmentError::TooLarge)
        })
}

impl fmt::Debug for RunEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunEnvironment")
            .field(
                "connections",
                &self
                    .values
                    .iter()
                    .map(|(key, values)| (key, values.field_names()))
                    .collect::<BTreeMap<_, _>>(),
            )
            .field("dynamic_keys", &self.dynamic_keys)
            .field("source_connection", &self.source_connection)
            .field("values", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum RunEnvironmentError {
    #[error("declared connection {0} is unavailable")]
    MissingConnection(ConnectionKey),
    #[error("connection {0} field {1} is unavailable")]
    MissingField(ConnectionKey, EnvironmentVariableName),
    #[error("connection {0} was not declared by the run")]
    UndeclaredConnection(ConnectionKey),
    #[error("connection {0} field {1} was not declared by the run")]
    UndeclaredField(ConnectionKey, EnvironmentVariableName),
    #[error("dynamic connection resolution is unavailable")]
    ResolutionUnavailable,
    #[error("run environment exceeds the aggregate bound")]
    TooLarge,
    #[error("run runtime plan is inconsistent")]
    InvalidPlan,
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use openengine_cluster_protocol::{
        CodexProvider, DeclaredConnections, DeclaredEnvironment, ModelId, NodeName, RunSize,
        SessionScope,
    };
    use openengine_cluster_testkit::assertions::AssertValue;

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
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            requirements
                .into_iter()
                .map(|(key, fields)| {
                    let values = fields
                        .into_iter()
                        .map(|field| (field, format!("dynamic-{call}")))
                        .collect();
                    StaticConnectionValues::new(values)
                        .map(|values| (key, values))
                        .map_err(|_| ConnectionResolutionUnavailable)
                })
                .collect()
        }
    }

    fn binding(key: &str, name: &EnvironmentVariableName) -> NodeRuntimeBinding {
        NodeRuntimeBinding::Agent {
            model: ModelId::new("gpt-5.6").assert_value(),
            effort: None,
            session_scope: SessionScope::Execution,
            connections: DeclaredConnections::single(
                key,
                DeclaredEnvironment::new([name.clone()]).assert_value(),
            )
            .assert_value(),
        }
    }

    #[tokio::test]
    async fn same_environment_name_can_resolve_from_different_keys_on_different_nodes() {
        let name = EnvironmentVariableName::new("TOKEN").assert_value();
        let first = binding("first", &name);
        let second = binding("second", &name);
        let runtime = RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Small,
            nodes: BTreeMap::from([
                (NodeName::new("one").assert_value(), first.clone()),
                (NodeName::new("two").assert_value(), second.clone()),
            ]),
        };
        let connection = |value: &str| {
            StaticConnectionValues::new(BTreeMap::from([(name.clone(), value.to_owned())]))
                .assert_value()
        };
        let environment = RunEnvironment::exact(
            &runtime,
            BTreeMap::from([
                (
                    ConnectionKey::new("first").assert_value(),
                    connection("first-secret"),
                ),
                (
                    ConnectionKey::new("second").assert_value(),
                    connection("second-secret"),
                ),
            ]),
        )
        .assert_value();

        assert_eq!(
            environment.resolve(&first).await.assert_value().get(&name),
            Some("first-secret")
        );
        assert_eq!(
            environment.resolve(&second).await.assert_value().get(&name),
            Some("second-secret")
        );
    }

    #[tokio::test]
    async fn dynamic_values_are_refreshed_for_every_node_start() {
        let name = EnvironmentVariableName::new("GH_TOKEN").assert_value();
        let node = binding("github", &name);
        let runtime = RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Small,
            nodes: BTreeMap::from([(NodeName::new("deliver").assert_value(), node.clone())]),
        };
        let key = ConnectionKey::new("github").assert_value();
        let environment = RunEnvironment::with_resolver(
            &runtime,
            BTreeMap::new(),
            DynamicConnectionPlan {
                keys: BTreeSet::from([key.clone()]),
                source_connection: Some(key),
                resolver: Arc::new(RotatingResolver::default()),
            },
        )
        .assert_value();

        assert_eq!(
            environment.resolve(&node).await.assert_value().get(&name),
            Some("dynamic-1")
        );
        assert_eq!(
            environment.resolve(&node).await.assert_value().get(&name),
            Some("dynamic-2")
        );
    }
}
