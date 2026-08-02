use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use crate::provider_value::BoundedText;

use super::material::SecretMaterial;

/// See the comment on [`super::AdmissionManifestDigest`]: `type` aliases (not `use`) for
/// macro-declared cross-module types keep source-level import checks able to resolve them.
type CredentialError = super::CredentialError;

const SOURCE_LOCATOR_MAX: usize = 256;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum CredentialSourceKind {
    Environment,
    HelperCommand,
    File,
}

/// A declared credential source location. The locator never appears in its `Debug` form.
#[derive(Clone, Eq, PartialEq)]
pub struct CredentialSourceRef {
    kind: CredentialSourceKind,
    locator: BoundedText<SOURCE_LOCATOR_MAX>,
}

impl CredentialSourceRef {
    pub fn new(
        kind: CredentialSourceKind,
        locator: impl Into<String>,
    ) -> Result<Self, CredentialError> {
        Ok(Self {
            kind,
            locator: BoundedText::new(locator)
                .map_err(|error| CredentialError::new("credential source locator", error))?,
        })
    }

    #[must_use]
    pub fn kind(&self) -> CredentialSourceKind {
        self.kind
    }

    pub(crate) fn locator(&self) -> &str {
        self.locator.as_str()
    }
}

impl fmt::Debug for CredentialSourceRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialSourceRef")
            .field("kind", &self.kind)
            .field("locator", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialSourceFault {
    PermissionDenied,
    AuthenticationRequired,
    Malformed,
    Unavailable,
}

/// A native credential source. `Ok(None)` means absent (fall through); `Err` fails closed.
pub trait CredentialSourcePort: Send + Sync {
    fn kind(&self) -> CredentialSourceKind;

    fn load(
        &self,
        source: &CredentialSourceRef,
    ) -> Result<Option<SecretMaterial>, CredentialSourceFault>;
}

/// Reads only the injected snapshot. Never consults `std::env`, native settings, or an OS
/// credential store.
pub struct EnvSnapshotCredentialSource {
    snapshot: BTreeMap<String, String>,
}

impl EnvSnapshotCredentialSource {
    #[must_use]
    pub fn new(snapshot: BTreeMap<String, String>) -> Self {
        Self { snapshot }
    }
}

impl CredentialSourcePort for EnvSnapshotCredentialSource {
    fn kind(&self) -> CredentialSourceKind {
        CredentialSourceKind::Environment
    }

    fn load(
        &self,
        source: &CredentialSourceRef,
    ) -> Result<Option<SecretMaterial>, CredentialSourceFault> {
        match self.snapshot.get(source.locator()) {
            Some(value) => SecretMaterial::new(value.clone().into_bytes())
                .map(Some)
                .map_err(|_| CredentialSourceFault::Malformed),
            None => Ok(None),
        }
    }
}

/// Maps a source kind to its port. A declared kind with no registered port fails closed.
#[derive(Default)]
pub struct CredentialSourceRegistry {
    ports: BTreeMap<CredentialSourceKind, Arc<dyn CredentialSourcePort>>,
}

impl CredentialSourceRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        mut self,
        port: Arc<dyn CredentialSourcePort>,
    ) -> Result<Self, CredentialError> {
        let kind = port.kind();
        if self.ports.insert(kind, port).is_some() {
            return Err(CredentialError::new(
                "credential source registry",
                "duplicate credential source kind",
            ));
        }
        Ok(self)
    }

    pub(crate) fn port(
        &self,
        kind: CredentialSourceKind,
    ) -> Option<&Arc<dyn CredentialSourcePort>> {
        self.ports.get(&kind)
    }
}
