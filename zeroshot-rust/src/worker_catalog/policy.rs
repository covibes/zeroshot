use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::execution::{DriverFamilyId, SessionScope};
use crate::provider_value::{validate_collection_len, validate_serialized};

use crate::worker_catalog as catalog;

type ExecutableArgument = catalog::ExecutableArgument;
type ExecutableName = catalog::ExecutableName;
type ModelId = catalog::ModelId;
type WorkerCatalogError = catalog::WorkerCatalogError;

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

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
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
