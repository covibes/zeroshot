use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;

use openengine_cluster_protocol::{
    ConnectionKey, EnvironmentVariableName, RunConnectionValues, RuntimePlan,
    StaticConnectionValues,
};
use thiserror::Error;

use crate::native_v2_contract::NodeRuntimeBinding;
use crate::native_v2_runner::ResolvedEnvironment;

const MAX_RUN_ENVIRONMENT_BYTES: usize = 256 * 1024;

/// Bounded, runtime-only values for exactly the keyed fields declared by one run's runtime plan.
///
/// Values never enter admission, the ledger, observations, or debug output. The exact keyed-shape
/// check happens once at trusted bootstrap. Node dispatch then selects and flattens only that
/// node's declared connections without consulting a user, store, or pluggable resolver.
#[derive(Clone)]
pub struct RunEnvironment {
    values: Arc<RunConnectionValues>,
}

impl RunEnvironment {
    pub fn exact(
        runtime: &RuntimePlan,
        values: RunConnectionValues,
    ) -> Result<Self, RunEnvironmentError> {
        let declared = runtime.connection_requirements();
        if let Some(key) = declared.keys().find(|key| !values.contains_key(*key)) {
            return Err(RunEnvironmentError::MissingConnection(key.clone()));
        }
        if let Some(key) = values.keys().find(|key| !declared.contains_key(*key)) {
            return Err(RunEnvironmentError::UndeclaredConnection(key.clone()));
        }
        let mut total = 0_usize;
        for (key, fields) in &declared {
            let supplied = values
                .get(key)
                .ok_or_else(|| RunEnvironmentError::MissingConnection(key.clone()))?;
            validate_connection_shape(key, fields, supplied)?;
            total = total
                .checked_add(connection_size(key, supplied)?)
                .ok_or(RunEnvironmentError::TooLarge)?;
        }
        if total > MAX_RUN_ENVIRONMENT_BYTES {
            return Err(RunEnvironmentError::TooLarge);
        }
        Ok(Self {
            values: Arc::new(values),
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

    /// Revalidates this exact map against an immutable admitted runtime plan.
    pub fn for_runtime(&self, runtime: &RuntimePlan) -> Result<Self, RunEnvironmentError> {
        Self::exact(runtime, self.values.as_ref().clone())
    }

    pub(crate) fn bootstrap_values(&self) -> RunConnectionValues {
        self.values.as_ref().clone()
    }

    pub(super) fn resolve(
        &self,
        binding: &NodeRuntimeBinding,
    ) -> Result<ResolvedEnvironment, RunEnvironmentError> {
        let mut values = BTreeMap::new();
        for (key, fields) in binding.declared_connections().iter() {
            let source = self
                .values
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
    #[error("run environment exceeds the aggregate bound")]
    TooLarge,
    #[error("run runtime plan is inconsistent")]
    InvalidPlan,
}

#[cfg(test)]
mod tests {
    use super::*;
    use openengine_cluster_protocol::{
        CodexProvider, DeclaredConnections, DeclaredEnvironment, ModelId, NodeName, RunSize,
        SessionScope,
    };

    #[test]
    fn same_environment_name_can_resolve_from_different_keys_on_different_nodes() {
        let name = EnvironmentVariableName::new("TOKEN").expect("valid environment name");
        let binding = |key: &str| NodeRuntimeBinding::Agent {
            model: ModelId::new("gpt-5.6").expect("valid model"),
            effort: None,
            session_scope: SessionScope::Execution,
            connections: DeclaredConnections::single(
                key,
                DeclaredEnvironment::new([name.clone()]).expect("valid environment"),
            )
            .expect("valid connection"),
        };
        let first = binding("first");
        let second = binding("second");
        let runtime = RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Small,
            nodes: BTreeMap::from([
                (NodeName::new("one").expect("valid node"), first.clone()),
                (NodeName::new("two").expect("valid node"), second.clone()),
            ]),
        };
        let connection = |value: &str| {
            StaticConnectionValues::new(BTreeMap::from([(name.clone(), value.to_owned())]))
                .expect("valid values")
        };
        let environment = RunEnvironment::exact(
            &runtime,
            BTreeMap::from([
                (
                    ConnectionKey::new("first").expect("valid key"),
                    connection("first-secret"),
                ),
                (
                    ConnectionKey::new("second").expect("valid key"),
                    connection("second-secret"),
                ),
            ]),
        )
        .expect("valid run connections");

        assert_eq!(
            environment
                .resolve(&first)
                .expect("first environment")
                .get(&name),
            Some("first-secret")
        );
        assert_eq!(
            environment
                .resolve(&second)
                .expect("second environment")
                .get(&name),
            Some("second-secret")
        );
    }
}
