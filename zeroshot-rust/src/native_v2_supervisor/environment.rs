use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;

use openengine_cluster_protocol::{
    EnvironmentVariableName, RuntimePlan, MAX_DECLARED_ENVIRONMENT_NAMES,
};
use thiserror::Error;

use crate::native_v2_contract::NodeRuntimeBinding;
use crate::native_v2_runner::ResolvedEnvironment;

const MAX_RUN_ENVIRONMENT_VALUE_BYTES: usize = 64 * 1024;
const MAX_RUN_ENVIRONMENT_BYTES: usize = 256 * 1024;

/// Bounded, runtime-only values for exactly the names declared by one run's runtime plan.
///
/// Values never enter admission, the ledger, observations, or debug output. The exact-name check
/// happens once at trusted bootstrap, so node dispatch does not consult a connection, user, or
/// pluggable resolver.
#[derive(Clone)]
pub struct RunEnvironment {
    values: Arc<BTreeMap<EnvironmentVariableName, String>>,
}

impl RunEnvironment {
    pub fn exact(
        runtime: &RuntimePlan,
        values: BTreeMap<EnvironmentVariableName, String>,
    ) -> Result<Self, RunEnvironmentError> {
        let declared = runtime
            .nodes()
            .values()
            .flat_map(|binding| binding.declared_environment().iter().cloned())
            .collect::<BTreeSet<_>>();
        if declared.len() > MAX_DECLARED_ENVIRONMENT_NAMES {
            return Err(RunEnvironmentError::TooManyNames);
        }
        if let Some(name) = declared.iter().find(|name| !values.contains_key(*name)) {
            return Err(RunEnvironmentError::Missing(name.clone()));
        }
        if let Some(name) = values.keys().find(|name| !declared.contains(*name)) {
            return Err(RunEnvironmentError::Undeclared(name.clone()));
        }
        let mut total = 0_usize;
        for (name, value) in &values {
            if value.contains('\0') {
                return Err(RunEnvironmentError::InvalidValue(name.clone()));
            }
            if value.len() > MAX_RUN_ENVIRONMENT_VALUE_BYTES {
                return Err(RunEnvironmentError::ValueTooLarge(name.clone()));
            }
            total = total
                .checked_add(name.as_str().len())
                .and_then(|size| size.checked_add(value.len()))
                .ok_or(RunEnvironmentError::TooLarge)?;
        }
        if total > MAX_RUN_ENVIRONMENT_BYTES {
            return Err(RunEnvironmentError::TooLarge);
        }
        Ok(Self {
            values: Arc::new(values),
        })
    }

    /// Selects one run's exact declared-name map from a trusted host inventory.
    pub fn from_available(
        runtime: &RuntimePlan,
        available: &BTreeMap<EnvironmentVariableName, String>,
    ) -> Result<Self, RunEnvironmentError> {
        let names = runtime
            .nodes()
            .values()
            .flat_map(|binding| binding.declared_environment().iter());
        let values = select_environment_values(names, available)?;
        Self::exact(runtime, values)
    }

    /// Revalidates this exact map against an immutable admitted runtime plan.
    pub fn for_runtime(&self, runtime: &RuntimePlan) -> Result<Self, RunEnvironmentError> {
        Self::exact(runtime, self.values.as_ref().clone())
    }

    pub(crate) fn bootstrap_values(&self) -> BTreeMap<EnvironmentVariableName, String> {
        self.values.as_ref().clone()
    }

    pub(crate) fn get(&self, name: &EnvironmentVariableName) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub(super) fn resolve(
        &self,
        binding: &NodeRuntimeBinding,
    ) -> Result<ResolvedEnvironment, RunEnvironmentError> {
        let values =
            select_environment_values(binding.declared_environment().iter(), self.values.as_ref())?;
        ResolvedEnvironment::exact(binding, values).map_err(|_| RunEnvironmentError::InvalidPlan)
    }
}

fn select_environment_values<'a>(
    names: impl IntoIterator<Item = &'a EnvironmentVariableName>,
    available: &BTreeMap<EnvironmentVariableName, String>,
) -> Result<BTreeMap<EnvironmentVariableName, String>, RunEnvironmentError> {
    let mut selected = BTreeMap::new();
    for name in names {
        let value = available
            .get(name)
            .cloned()
            .ok_or_else(|| RunEnvironmentError::Missing(name.clone()))?;
        selected.insert(name.clone(), value);
    }
    Ok(selected)
}

impl fmt::Debug for RunEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunEnvironment")
            .field("names", &self.values.keys().collect::<Vec<_>>())
            .field("values", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum RunEnvironmentError {
    #[error("run declares more than 64 distinct environment names")]
    TooManyNames,
    #[error("declared environment variable {0} is unavailable")]
    Missing(EnvironmentVariableName),
    #[error("environment variable {0} was not declared by the run")]
    Undeclared(EnvironmentVariableName),
    #[error("environment variable {0} contains an invalid NUL byte")]
    InvalidValue(EnvironmentVariableName),
    #[error("environment variable {0} exceeds the per-value bound")]
    ValueTooLarge(EnvironmentVariableName),
    #[error("run environment exceeds the aggregate bound")]
    TooLarge,
    #[error("run runtime plan is inconsistent")]
    InvalidPlan,
}
