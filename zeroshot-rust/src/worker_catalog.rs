use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU32;
use std::sync::LazyLock;

use serde::Serialize;

use crate::execution::{CatalogDigest, DriverFamilyId, SessionScope};
use crate::provider_value::{canonicalize, parse_version, validate_collection_len};

mod builtins;
mod policy;

pub use policy::{
    CapabilityPolicy, CapabilitySupport, DriverFamily, ExecutableMetadata, ModelLevel, ModelPolicy,
    ModelSelection, ProbeStrategy, ReasoningEffort, ReasoningPolicy, SessionPolicy,
    WorkerCapability,
};

pub const WORKER_CATALOG_VERSION: u32 = 1;
pub const WORKER_PROVIDER_COUNT: usize = 8;
pub const DEFAULT_WORKER_PROVIDER: &str = "claude";

crate::provider_value::contract_error_type!(WorkerCatalogError);
crate::provider_value::provider_id_type!(ProviderId, WorkerCatalogError, "provider id");
crate::provider_value::provider_id_type!(ProviderAlias, WorkerCatalogError, "provider alias");
crate::provider_value::bounded_text_type!(
    ProviderDisplayName,
    64,
    WorkerCatalogError,
    "provider display name"
);
crate::provider_value::bounded_bytes_type!(ModelId, 128, WorkerCatalogError, "model id");
crate::provider_value::bounded_bytes_type!(
    ExecutableName,
    128,
    WorkerCatalogError,
    "executable name"
);
crate::provider_value::bounded_bytes_type!(
    ExecutableArgument,
    256,
    WorkerCatalogError,
    "executable argument"
);
crate::provider_value::provider_id_type!(
    CredentialRequirementName,
    WorkerCatalogError,
    "credential requirement name"
);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDescriptorSpec {
    pub id: ProviderId,
    pub aliases: Vec<ProviderAlias>,
    pub display_name: ProviderDisplayName,
    pub driver_family: DriverFamily,
    pub models: ModelPolicy,
    pub reasoning: ReasoningPolicy,
    pub sessions: SessionPolicy,
    pub capabilities: CapabilityPolicy,
    pub executable: Option<ExecutableMetadata>,
    pub credential_requirements: Vec<CredentialRequirementName>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    id: ProviderId,
    aliases: Vec<ProviderAlias>,
    display_name: ProviderDisplayName,
    driver_family: DriverFamily,
    models: ModelPolicy,
    reasoning: ReasoningPolicy,
    sessions: SessionPolicy,
    capabilities: CapabilityPolicy,
    executable: Option<ExecutableMetadata>,
    credential_requirements: Vec<CredentialRequirementName>,
}

impl ProviderDescriptor {
    pub fn new(mut spec: ProviderDescriptorSpec) -> Result<Self, WorkerCatalogError> {
        spec.aliases.sort();
        if spec.aliases.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(WorkerCatalogError::new(
                "provider aliases",
                "aliases must be unique",
            ));
        }
        if spec
            .aliases
            .iter()
            .any(|alias| alias.as_str() == spec.id.as_str())
        {
            return Err(WorkerCatalogError::new(
                "provider aliases",
                "an alias must not equal its canonical provider id",
            ));
        }
        validate_collection_len(spec.aliases.len())
            .map_err(|error| WorkerCatalogError::new("provider aliases", error))?;

        spec.credential_requirements.sort();
        if spec
            .credential_requirements
            .windows(2)
            .any(|pair| pair[0] == pair[1])
        {
            return Err(WorkerCatalogError::new(
                "credential requirements",
                "requirement names must be unique",
            ));
        }
        validate_collection_len(spec.credential_requirements.len())
            .map_err(|error| WorkerCatalogError::new("credential requirements", error))?;

        match (spec.driver_family, spec.executable.is_some()) {
            (DriverFamily::GatewayHttp, true) => {
                return Err(WorkerCatalogError::new(
                    "driver family policy",
                    "gateway-http providers must not declare process executable metadata",
                ));
            }
            (DriverFamily::CliProcess | DriverFamily::AcpStdio, false) => {
                return Err(WorkerCatalogError::new(
                    "driver family policy",
                    "process-backed providers must declare executable metadata",
                ));
            }
            _ => {}
        }

        if spec.sessions.supports(SessionScope::NodeInstance) {
            return Err(WorkerCatalogError::new(
                "session policy",
                "worker catalog v1 has no pinned evidence for node-instance sessions",
            ));
        }
        if !spec.sessions.supports(SessionScope::Execution) {
            return Err(WorkerCatalogError::new(
                "session policy",
                "worker catalog v1 providers must support execution scope",
            ));
        }

        let supports_reasoning = spec
            .capabilities
            .supports(WorkerCapability::ReasoningEffort);
        if supports_reasoning != !spec.reasoning.efforts().is_empty() {
            return Err(WorkerCatalogError::new(
                "reasoning policy",
                "reasoning efforts and the reasoning capability must be declared together",
            ));
        }
        for selection in spec.models.levels().values() {
            if let Some(effort) = selection.default_reasoning_effort() {
                if !spec.reasoning.supports(effort) {
                    return Err(WorkerCatalogError::new(
                        "model policy",
                        "a model default uses an unsupported reasoning effort",
                    ));
                }
            }
        }

        let value = Self {
            id: spec.id,
            aliases: spec.aliases,
            display_name: spec.display_name,
            driver_family: spec.driver_family,
            models: spec.models,
            reasoning: spec.reasoning,
            sessions: spec.sessions,
            capabilities: spec.capabilities,
            executable: spec.executable,
            credential_requirements: spec.credential_requirements,
        };
        WorkerCatalogError::checked(value)
    }

    #[must_use]
    pub fn id(&self) -> &ProviderId {
        &self.id
    }

    #[must_use]
    pub fn aliases(&self) -> &[ProviderAlias] {
        &self.aliases
    }

    #[must_use]
    pub fn display_name(&self) -> &ProviderDisplayName {
        &self.display_name
    }

    #[must_use]
    pub const fn driver_family(&self) -> DriverFamily {
        self.driver_family
    }

    #[must_use]
    pub fn driver_family_id(&self) -> DriverFamilyId {
        self.driver_family.driver_family_id()
    }

    #[must_use]
    pub fn models(&self) -> &ModelPolicy {
        &self.models
    }

    #[must_use]
    pub fn reasoning(&self) -> &ReasoningPolicy {
        &self.reasoning
    }

    #[must_use]
    pub fn sessions(&self) -> &SessionPolicy {
        &self.sessions
    }

    #[must_use]
    pub fn capabilities(&self) -> &CapabilityPolicy {
        &self.capabilities
    }

    #[must_use]
    pub fn executable(&self) -> Option<&ExecutableMetadata> {
        self.executable.as_ref()
    }

    #[must_use]
    pub fn credential_requirements(&self) -> &[CredentialRequirementName] {
        &self.credential_requirements
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerCatalogSpec {
    pub version: u32,
    pub default_provider: ProviderId,
    pub providers: Vec<ProviderDescriptor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerCatalog {
    version: NonZeroU32,
    default_provider: ProviderId,
    providers: Vec<ProviderDescriptor>,
    canonical_bytes: Vec<u8>,
    digest: CatalogDigest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalCatalog<'a> {
    version: u32,
    default_provider: &'a ProviderId,
    providers: &'a [ProviderDescriptor],
}

impl WorkerCatalog {
    pub fn new(mut spec: WorkerCatalogSpec) -> Result<Self, WorkerCatalogError> {
        let version = parse_version(spec.version)
            .map_err(|error| WorkerCatalogError::new("catalog version", error))?;
        if spec.providers.is_empty() {
            return Err(WorkerCatalogError::new(
                "catalog providers",
                "at least one provider is required",
            ));
        }
        validate_collection_len(spec.providers.len())
            .map_err(|error| WorkerCatalogError::new("catalog providers", error))?;
        spec.providers.sort_by(|left, right| left.id.cmp(&right.id));
        if spec
            .providers
            .windows(2)
            .any(|pair| pair[0].id == pair[1].id)
        {
            return Err(WorkerCatalogError::new(
                "catalog providers",
                "canonical provider ids must be unique",
            ));
        }

        let canonical_ids = spec
            .providers
            .iter()
            .map(|provider| provider.id.as_str())
            .collect::<BTreeSet<_>>();
        if !canonical_ids.contains(spec.default_provider.as_str()) {
            return Err(WorkerCatalogError::new(
                "default provider",
                "default provider must name a canonical provider",
            ));
        }

        let mut names = BTreeMap::<&str, &str>::new();
        for provider in &spec.providers {
            if let Some(owner) = names.insert(provider.id.as_str(), provider.id.as_str()) {
                return Err(WorkerCatalogError::new(
                    "provider identity",
                    format!("provider identity collides with {owner}"),
                ));
            }
            for alias in &provider.aliases {
                if let Some(owner) = names.insert(alias.as_str(), provider.id.as_str()) {
                    return Err(WorkerCatalogError::new(
                        "provider identity",
                        format!("provider identity collides with {owner}"),
                    ));
                }
            }
        }

        let mut display_names = BTreeSet::new();
        for provider in &spec.providers {
            let folded = provider.display_name.as_str().to_ascii_lowercase();
            if !display_names.insert(folded) {
                return Err(WorkerCatalogError::new(
                    "provider display names",
                    "display names must be unique ignoring ASCII case",
                ));
            }
        }

        let (canonical_bytes, digest_hex) = canonicalize(&CanonicalCatalog {
            version: version.get(),
            default_provider: &spec.default_provider,
            providers: &spec.providers,
        })
        .map_err(|error| WorkerCatalogError::new("canonical catalog", error))?;
        let digest = CatalogDigest::new(digest_hex)
            .map_err(|error| WorkerCatalogError::new("catalog digest", error))?;

        Ok(Self {
            version,
            default_provider: spec.default_provider,
            providers: spec.providers,
            canonical_bytes,
            digest,
        })
    }

    #[must_use]
    pub fn version(&self) -> u32 {
        self.version.get()
    }

    #[must_use]
    pub fn default_provider_id(&self) -> &ProviderId {
        &self.default_provider
    }

    #[must_use]
    pub fn default_provider(&self) -> &ProviderDescriptor {
        self.resolve(self.default_provider.as_str())
            .expect("validated catalog contains its default provider")
    }

    #[must_use]
    pub fn providers(&self) -> &[ProviderDescriptor] {
        &self.providers
    }

    #[must_use]
    pub fn resolve(&self, identity: &str) -> Option<&ProviderDescriptor> {
        self.providers
            .binary_search_by(|provider| provider.id.as_str().cmp(identity))
            .ok()
            .map(|index| &self.providers[index])
            .or_else(|| {
                self.providers.iter().find(|provider| {
                    provider
                        .aliases
                        .iter()
                        .any(|alias| alias.as_str() == identity)
                })
            })
    }

    #[must_use]
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical_bytes
    }

    #[must_use]
    pub fn digest(&self) -> &CatalogDigest {
        &self.digest
    }
}

static WORKER_CATALOG: LazyLock<WorkerCatalog> = LazyLock::new(|| {
    WorkerCatalog::new(builtins::canonical_catalog_spec())
        .expect("built-in worker catalog is valid")
});

#[must_use]
pub fn worker_catalog() -> &'static WorkerCatalog {
    &WORKER_CATALOG
}
