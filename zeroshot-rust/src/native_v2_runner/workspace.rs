use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceAccess {
    ReadOnly,
    Exclusive,
}

/// One run-local gate around its single shared workspace.
#[derive(Clone, Debug, Default)]
pub struct WorkspaceGate {
    inner: Arc<RwLock<()>>,
}

impl WorkspaceGate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub(super) async fn acquire(&self, access: WorkspaceAccess) -> WorkspacePermit {
        match access {
            WorkspaceAccess::ReadOnly => WorkspacePermit::Read {
                _guard: self.inner.clone().read_owned().await,
            },
            WorkspaceAccess::Exclusive => WorkspacePermit::Write {
                _guard: self.inner.clone().write_owned().await,
            },
        }
    }
}

pub(super) enum WorkspacePermit {
    Read { _guard: OwnedRwLockReadGuard<()> },
    Write { _guard: OwnedRwLockWriteGuard<()> },
}

/// Runtime-only environment values. Debug output exposes names, never values.
#[derive(Clone)]
pub struct ResolvedEnvironment {
    values: Arc<BTreeMap<EnvironmentVariableName, String>>,
}

impl ResolvedEnvironment {
    pub fn exact(
        binding: &NodeRuntimeBinding,
        values: BTreeMap<EnvironmentVariableName, String>,
    ) -> Result<Self, EnvironmentResolutionError> {
        let declared = binding.declared_connections();
        if let Some(name) = declared
            .environment_names()
            .find(|name| !values.contains_key(*name))
        {
            return Err(EnvironmentResolutionError::Missing(name.clone()));
        }
        if let Some(name) = values.keys().find(|name| {
            !declared
                .environment_names()
                .any(|declared| declared == *name)
        }) {
            return Err(EnvironmentResolutionError::Undeclared(name.clone()));
        }
        Ok(Self {
            values: Arc::new(values),
        })
    }

    #[must_use]
    pub fn get(&self, name: &EnvironmentVariableName) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&EnvironmentVariableName, &str)> {
        self.values
            .iter()
            .map(|(name, value)| (name, value.as_str()))
    }
}

impl fmt::Debug for ResolvedEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedEnvironment")
            .field("names", &self.values.keys().collect::<Vec<_>>())
            .field("values", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EnvironmentResolutionError {
    #[error("declared environment variable {0} was not resolved")]
    Missing(EnvironmentVariableName),
    #[error("environment variable {0} was not declared by the node")]
    Undeclared(EnvironmentVariableName),
}
