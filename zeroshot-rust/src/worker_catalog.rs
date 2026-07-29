use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::num::NonZeroU32;
use std::sync::LazyLock;

use serde::Serialize;
use sha2::{Digest as _, Sha256};

use crate::execution::{CatalogDigest, DriverFamilyId, SessionScope};
use crate::provider_value::{validate_collection_len, validate_serialized};

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

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DriverFamily {
    CliProcess,
    AcpStdio,
    GatewayHttp,
}

impl DriverFamily {
    #[must_use]
    pub const fn token(self) -> &'static str {
        match self {
            Self::CliProcess => "cli-process",
            Self::AcpStdio => "acp-stdio",
            Self::GatewayHttp => "gateway-http",
        }
    }

    #[must_use]
    pub fn driver_family_id(self) -> DriverFamilyId {
        DriverFamilyId::new(self.token()).expect("closed driver-family token is valid")
    }
}

impl TryFrom<DriverFamily> for DriverFamilyId {
    type Error = crate::execution::ExecutionContractError;

    fn try_from(family: DriverFamily) -> Result<Self, Self::Error> {
        Self::new(family.token())
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelLevel {
    Level1,
    Level2,
    Level3,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerCapability {
    ToolUse,
    WorkspaceIsolation,
    McpServers,
    JsonSchema,
    StreamEvents,
    Thinking,
    ReasoningEffort,
    SessionResume,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySupport {
    Experimental,
    Stable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CapabilityPolicy(BTreeMap<WorkerCapability, CapabilitySupport>);

impl CapabilityPolicy {
    pub fn new(
        entries: impl IntoIterator<Item = (WorkerCapability, CapabilitySupport)>,
    ) -> Result<Self, WorkerCatalogError> {
        let mut values = BTreeMap::new();
        for (capability, support) in entries {
            if values.insert(capability, support).is_some() {
                return Err(WorkerCatalogError::new(
                    "capability policy",
                    "capabilities must be unique",
                ));
            }
        }
        validate_collection_len(values.len())
            .map_err(|error| WorkerCatalogError::new("capability policy", error))?;
        Ok(Self(values))
    }

    #[must_use]
    pub fn support(&self, capability: WorkerCapability) -> Option<CapabilitySupport> {
        self.0.get(&capability).copied()
    }

    #[must_use]
    pub fn supports(&self, capability: WorkerCapability) -> bool {
        self.0.contains_key(&capability)
    }

    #[must_use]
    pub fn entries(&self) -> &BTreeMap<WorkerCapability, CapabilitySupport> {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    level: ModelLevel,
    model: Option<ModelId>,
    default_reasoning_effort: Option<ReasoningEffort>,
}

impl ModelSelection {
    #[must_use]
    pub const fn new(
        level: ModelLevel,
        model: Option<ModelId>,
        default_reasoning_effort: Option<ReasoningEffort>,
    ) -> Self {
        Self {
            level,
            model,
            default_reasoning_effort,
        }
    }

    #[must_use]
    pub const fn level(&self) -> ModelLevel {
        self.level
    }

    #[must_use]
    pub fn model(&self) -> Option<&ModelId> {
        self.model.as_ref()
    }

    #[must_use]
    pub const fn default_reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.default_reasoning_effort
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPolicy {
    default_level: ModelLevel,
    levels: BTreeMap<ModelLevel, ModelSelection>,
}

impl ModelPolicy {
    pub fn new(
        default_level: ModelLevel,
        selections: impl IntoIterator<Item = ModelSelection>,
    ) -> Result<Self, WorkerCatalogError> {
        let mut levels = BTreeMap::new();
        for selection in selections {
            if levels.insert(selection.level(), selection).is_some() {
                return Err(WorkerCatalogError::new(
                    "model policy",
                    "model levels must be unique",
                ));
            }
        }
        validate_collection_len(levels.len())
            .map_err(|error| WorkerCatalogError::new("model policy", error))?;
        if !levels.contains_key(&default_level) {
            return Err(WorkerCatalogError::new(
                "default model level",
                "default level must be present in the model policy",
            ));
        }
        validate_serialized(&levels)
            .map_err(|error| WorkerCatalogError::new("model policy", error))?;
        Ok(Self {
            default_level,
            levels,
        })
    }

    #[must_use]
    pub const fn default_level(&self) -> ModelLevel {
        self.default_level
    }

    #[must_use]
    pub fn default_selection(&self) -> &ModelSelection {
        self.levels
            .get(&self.default_level)
            .expect("validated model policy contains its default")
    }

    #[must_use]
    pub fn selection(&self, level: ModelLevel) -> Option<&ModelSelection> {
        self.levels.get(&level)
    }

    #[must_use]
    pub fn levels(&self) -> &BTreeMap<ModelLevel, ModelSelection> {
        &self.levels
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ReasoningPolicy(BTreeSet<ReasoningEffort>);

impl ReasoningPolicy {
    pub fn new(
        efforts: impl IntoIterator<Item = ReasoningEffort>,
    ) -> Result<Self, WorkerCatalogError> {
        let mut unique = BTreeSet::new();
        for effort in efforts {
            if !unique.insert(effort) {
                return Err(WorkerCatalogError::new(
                    "reasoning policy",
                    "reasoning efforts must be unique",
                ));
            }
        }
        let efforts = unique;
        validate_collection_len(efforts.len())
            .map_err(|error| WorkerCatalogError::new("reasoning policy", error))?;
        Ok(Self(efforts))
    }

    #[must_use]
    pub fn supports(&self, effort: ReasoningEffort) -> bool {
        self.0.contains(&effort)
    }

    #[must_use]
    pub fn efforts(&self) -> &BTreeSet<ReasoningEffort> {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SessionPolicy(BTreeSet<SessionScope>);

impl SessionPolicy {
    pub fn new(scopes: impl IntoIterator<Item = SessionScope>) -> Result<Self, WorkerCatalogError> {
        let mut unique = BTreeSet::new();
        for scope in scopes {
            if !unique.insert(scope) {
                return Err(WorkerCatalogError::new(
                    "session policy",
                    "session scopes must be unique",
                ));
            }
        }
        let scopes = unique;
        if scopes.is_empty() {
            return Err(WorkerCatalogError::new(
                "session policy",
                "at least one session scope is required",
            ));
        }
        validate_collection_len(scopes.len())
            .map_err(|error| WorkerCatalogError::new("session policy", error))?;
        Ok(Self(scopes))
    }

    #[must_use]
    pub fn supports(&self, scope: SessionScope) -> bool {
        self.0.contains(&scope)
    }

    #[must_use]
    pub fn scopes(&self) -> &BTreeSet<SessionScope> {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeStrategy {
    Version,
    HelpOrVersion,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableMetadata {
    name: ExecutableName,
    arguments: Vec<ExecutableArgument>,
    probe: ProbeStrategy,
}

impl ExecutableMetadata {
    pub fn new(
        name: ExecutableName,
        arguments: Vec<ExecutableArgument>,
        probe: ProbeStrategy,
    ) -> Result<Self, WorkerCatalogError> {
        validate_collection_len(arguments.len())
            .map_err(|error| WorkerCatalogError::new("executable arguments", error))?;
        let value = Self {
            name,
            arguments,
            probe,
        };
        validate_serialized(&value)
            .map_err(|error| WorkerCatalogError::new("executable metadata", error))?;
        Ok(value)
    }

    #[must_use]
    pub fn name(&self) -> &ExecutableName {
        &self.name
    }

    #[must_use]
    pub fn arguments(&self) -> &[ExecutableArgument] {
        &self.arguments
    }

    #[must_use]
    pub const fn probe(&self) -> ProbeStrategy {
        self.probe
    }
}

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
        let version = NonZeroU32::new(spec.version).ok_or_else(|| {
            WorkerCatalogError::new("catalog version", "version must be greater than zero")
        })?;
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

        let canonical_bytes = serde_json::to_vec(&CanonicalCatalog {
            version: version.get(),
            default_provider: &spec.default_provider,
            providers: &spec.providers,
        })
        .map_err(|error| WorkerCatalogError::new("canonical catalog", error))?;
        if canonical_bytes.len() > crate::provider_value::MAX_SERIALIZED_BYTES {
            return Err(WorkerCatalogError::new(
                "canonical catalog",
                "canonical catalog exceeds the serialized-value bound",
            ));
        }
        let mut digest_hex = String::with_capacity(64);
        for byte in Sha256::digest(&canonical_bytes) {
            write!(&mut digest_hex, "{byte:02x}").expect("writing to a string cannot fail");
        }
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
    WorkerCatalog::new(canonical_catalog_spec()).expect("built-in worker catalog is valid")
});

#[must_use]
pub fn worker_catalog() -> &'static WorkerCatalog {
    &WORKER_CATALOG
}

fn canonical_catalog_spec() -> WorkerCatalogSpec {
    WorkerCatalogSpec {
        version: WORKER_CATALOG_VERSION,
        default_provider: provider_id(DEFAULT_WORKER_PROVIDER),
        providers: vec![
            provider(ProviderSource {
                id: "claude",
                aliases: &["anthropic"],
                display_name: "Claude",
                family: DriverFamily::CliProcess,
                executable: Some(("claude", &[], ProbeStrategy::Version)),
                level_models: [Some("haiku"), Some("sonnet"), Some("opus")],
                level_reasoning: [None, None, None],
                reasoning: &[
                    ReasoningEffort::Low,
                    ReasoningEffort::Medium,
                    ReasoningEffort::High,
                    ReasoningEffort::Xhigh,
                    ReasoningEffort::Max,
                ],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::McpServers),
                    stable(WorkerCapability::JsonSchema),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                    stable(WorkerCapability::ReasoningEffort),
                    stable(WorkerCapability::SessionResume),
                ],
                credential_requirement: "claude-auth",
            }),
            provider(ProviderSource {
                id: "codex",
                aliases: &["openai"],
                display_name: "Codex",
                family: DriverFamily::CliProcess,
                executable: Some(("codex", &["exec"], ProbeStrategy::Version)),
                level_models: [Some("gpt-5.4"), Some("gpt-5.4"), Some("gpt-5.4")],
                level_reasoning: [
                    Some(ReasoningEffort::Medium),
                    Some(ReasoningEffort::High),
                    Some(ReasoningEffort::Xhigh),
                ],
                reasoning: &[
                    ReasoningEffort::Low,
                    ReasoningEffort::Medium,
                    ReasoningEffort::High,
                    ReasoningEffort::Xhigh,
                    ReasoningEffort::Max,
                ],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::McpServers),
                    stable(WorkerCapability::JsonSchema),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                    stable(WorkerCapability::ReasoningEffort),
                    stable(WorkerCapability::SessionResume),
                ],
                credential_requirement: "codex-auth",
            }),
            provider(ProviderSource {
                id: "gateway",
                aliases: &[],
                display_name: "Gateway",
                family: DriverFamily::GatewayHttp,
                executable: None,
                level_models: [None, None, None],
                level_reasoning: [None, None, None],
                reasoning: &[],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                ],
                credential_requirement: "gateway-auth",
            }),
            provider(ProviderSource {
                id: "gemini",
                aliases: &["google"],
                display_name: "Gemini",
                family: DriverFamily::CliProcess,
                executable: Some(("gemini", &[], ProbeStrategy::Version)),
                level_models: [None, None, None],
                level_reasoning: [None, None, None],
                reasoning: &[],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::McpServers),
                    (
                        WorkerCapability::JsonSchema,
                        CapabilitySupport::Experimental,
                    ),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                ],
                credential_requirement: "gemini-auth",
            }),
            provider(ProviderSource {
                id: "opencode",
                aliases: &[],
                display_name: "Opencode",
                family: DriverFamily::CliProcess,
                executable: Some(("opencode", &["run"], ProbeStrategy::Version)),
                level_models: [None, None, None],
                level_reasoning: [
                    Some(ReasoningEffort::Low),
                    Some(ReasoningEffort::Medium),
                    Some(ReasoningEffort::High),
                ],
                reasoning: &[
                    ReasoningEffort::Low,
                    ReasoningEffort::Medium,
                    ReasoningEffort::High,
                    ReasoningEffort::Xhigh,
                    ReasoningEffort::Max,
                ],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::McpServers),
                    (
                        WorkerCapability::JsonSchema,
                        CapabilitySupport::Experimental,
                    ),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                    stable(WorkerCapability::ReasoningEffort),
                ],
                credential_requirement: "opencode-auth",
            }),
            provider(ProviderSource {
                id: "pi",
                aliases: &[],
                display_name: "Pi",
                family: DriverFamily::CliProcess,
                executable: Some(("pi", &[], ProbeStrategy::HelpOrVersion)),
                level_models: [None, None, None],
                level_reasoning: [None, None, None],
                reasoning: &[],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                ],
                credential_requirement: "pi-auth",
            }),
            provider(ProviderSource {
                id: "kiro",
                aliases: &[],
                display_name: "Kiro",
                family: DriverFamily::AcpStdio,
                executable: Some(("kiro-cli", &["acp"], ProbeStrategy::Version)),
                level_models: [None, None, None],
                level_reasoning: [None, None, None],
                reasoning: &[],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                ],
                credential_requirement: "kiro-auth",
            }),
            provider(ProviderSource {
                id: "copilot",
                aliases: &[],
                display_name: "Copilot",
                family: DriverFamily::CliProcess,
                executable: Some(("copilot", &[], ProbeStrategy::HelpOrVersion)),
                level_models: [None, None, None],
                level_reasoning: [None, None, None],
                reasoning: &[],
                capabilities: vec![
                    stable(WorkerCapability::ToolUse),
                    stable(WorkerCapability::WorkspaceIsolation),
                    stable(WorkerCapability::McpServers),
                    stable(WorkerCapability::StreamEvents),
                    stable(WorkerCapability::Thinking),
                ],
                credential_requirement: "copilot-auth",
            }),
        ],
    }
}

type ExecutableSource = (&'static str, &'static [&'static str], ProbeStrategy);

struct ProviderSource {
    id: &'static str,
    aliases: &'static [&'static str],
    display_name: &'static str,
    family: DriverFamily,
    executable: Option<ExecutableSource>,
    level_models: [Option<&'static str>; 3],
    level_reasoning: [Option<ReasoningEffort>; 3],
    reasoning: &'static [ReasoningEffort],
    capabilities: Vec<(WorkerCapability, CapabilitySupport)>,
    credential_requirement: &'static str,
}

fn provider(source: ProviderSource) -> ProviderDescriptor {
    let levels = [ModelLevel::Level1, ModelLevel::Level2, ModelLevel::Level3]
        .into_iter()
        .zip(source.level_models)
        .zip(source.level_reasoning)
        .map(|((level, model), effort)| ModelSelection::new(level, model.map(model_id), effort));
    ProviderDescriptor::new(ProviderDescriptorSpec {
        id: provider_id(source.id),
        aliases: source.aliases.iter().copied().map(provider_alias).collect(),
        display_name: ProviderDisplayName::new(source.display_name)
            .expect("built-in display name is valid"),
        driver_family: source.family,
        models: ModelPolicy::new(ModelLevel::Level2, levels)
            .expect("built-in model policy is valid"),
        reasoning: ReasoningPolicy::new(source.reasoning.iter().copied())
            .expect("built-in reasoning policy is valid"),
        sessions: SessionPolicy::new([SessionScope::Execution])
            .expect("built-in session policy is valid"),
        capabilities: CapabilityPolicy::new(source.capabilities.iter().copied())
            .expect("built-in capability policy is valid"),
        executable: source.executable.map(|(name, arguments, probe)| {
            ExecutableMetadata::new(
                ExecutableName::new(name).expect("built-in executable name is valid"),
                arguments
                    .iter()
                    .map(|argument| {
                        ExecutableArgument::new(*argument).expect("built-in argument is valid")
                    })
                    .collect(),
                probe,
            )
            .expect("built-in executable metadata is valid")
        }),
        credential_requirements: vec![
            CredentialRequirementName::new(source.credential_requirement)
                .expect("built-in credential requirement is valid"),
        ],
    })
    .expect("built-in provider descriptor is valid")
}

const fn stable(capability: WorkerCapability) -> (WorkerCapability, CapabilitySupport) {
    (capability, CapabilitySupport::Stable)
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).expect("built-in provider id is valid")
}

fn provider_alias(value: &str) -> ProviderAlias {
    ProviderAlias::new(value).expect("built-in provider alias is valid")
}

fn model_id(value: &str) -> ModelId {
    ModelId::new(value).expect("built-in model id is valid")
}
