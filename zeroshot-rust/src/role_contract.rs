//! Product-private, immutable, versioned role-contract pack. No config, credential, driver, or
//! graph-compiler concerns.

use std::collections::BTreeMap;
use std::fmt;
use std::num::NonZeroU32;
use std::sync::LazyLock;

use serde::Serialize;

use crate::provider_value::{canonicalize, parse_version};
use crate::worker_catalog::{ModelLevel, ReasoningEffort, WorkerCatalog};

pub const ROLE_CONTRACT_PACK_VERSION: u32 = 1;

crate::provider_value::contract_error_type!(RoleContractError);
crate::provider_value::bounded_bytes_type!(
    RoleInstructions,
    12_000,
    RoleContractError,
    "role instructions"
);
crate::provider_value::digest_type!(
    RoleContractDigest,
    RoleContractError,
    "role contract pack digest"
);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoleName {
    Classifier,
    Verifier,
    Worker,
}

impl RoleName {
    pub const ALL: [RoleName; 3] = [Self::Classifier, Self::Verifier, Self::Worker];

    #[must_use]
    pub const fn token(self) -> &'static str {
        match self {
            Self::Classifier => "classifier",
            Self::Verifier => "verifier",
            Self::Worker => "worker",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SchemaId {
    ClassifierInput,
    ClassifierOutput,
    VerifierInput,
    VerifierOutput,
    WorkerInput,
    WorkerOutput,
}

impl SchemaId {
    #[must_use]
    pub const fn token(self) -> &'static str {
        match self {
            Self::ClassifierInput => "classifier-input",
            Self::ClassifierOutput => "classifier-output",
            Self::VerifierInput => "verifier-input",
            Self::VerifierOutput => "verifier-output",
            Self::WorkerInput => "worker-input",
            Self::WorkerOutput => "worker-output",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaRef {
    schema: SchemaId,
    version: NonZeroU32,
}

impl SchemaRef {
    pub fn new(schema: SchemaId, version: u32) -> Result<Self, RoleContractError> {
        let version = parse_version(version)
            .map_err(|error| RoleContractError::new("schema reference", error))?;
        Ok(Self { schema, version })
    }

    #[must_use]
    pub const fn schema(&self) -> SchemaId {
        self.schema
    }

    #[must_use]
    pub fn version(&self) -> u32 {
        self.version.get()
    }
}

impl fmt::Display for SchemaRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}@{}", self.schema.token(), self.version)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleContractSpec {
    pub role: RoleName,
    pub instructions: RoleInstructions,
    pub model_requirement: ModelLevel,
    pub reasoning_requirement: Option<ReasoningEffort>,
    pub input_schema: SchemaRef,
    pub output_schema: SchemaRef,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleContract {
    role: RoleName,
    instructions: RoleInstructions,
    model_requirement: ModelLevel,
    reasoning_requirement: Option<ReasoningEffort>,
    input_schema: SchemaRef,
    output_schema: SchemaRef,
}

fn required_schemas(role: RoleName) -> (SchemaId, SchemaId) {
    match role {
        RoleName::Classifier => (SchemaId::ClassifierInput, SchemaId::ClassifierOutput),
        RoleName::Verifier => (SchemaId::VerifierInput, SchemaId::VerifierOutput),
        RoleName::Worker => (SchemaId::WorkerInput, SchemaId::WorkerOutput),
    }
}

fn catalog_supports(
    catalog: &WorkerCatalog,
    model_requirement: ModelLevel,
    reasoning_requirement: Option<ReasoningEffort>,
) -> bool {
    catalog.providers().iter().any(|provider| {
        provider.models().levels().contains_key(&model_requirement)
            && reasoning_requirement.is_none_or(|effort| provider.reasoning().supports(effort))
    })
}

impl RoleContract {
    pub fn new(spec: RoleContractSpec, catalog: &WorkerCatalog) -> Result<Self, RoleContractError> {
        let (required_input, required_output) = required_schemas(spec.role);
        if spec.input_schema.schema() != required_input
            || spec.output_schema.schema() != required_output
        {
            return Err(RoleContractError::new(
                "schema reference",
                "schema reference does not match its role",
            ));
        }

        if !catalog_supports(catalog, spec.model_requirement, spec.reasoning_requirement) {
            return Err(RoleContractError::new(
                "provider catalog policy",
                "no catalog provider satisfies the role's model or reasoning requirement",
            ));
        }

        let value = Self {
            role: spec.role,
            instructions: spec.instructions,
            model_requirement: spec.model_requirement,
            reasoning_requirement: spec.reasoning_requirement,
            input_schema: spec.input_schema,
            output_schema: spec.output_schema,
        };
        RoleContractError::checked(value)
    }

    #[must_use]
    pub const fn role(&self) -> RoleName {
        self.role
    }

    #[must_use]
    pub fn instructions(&self) -> &RoleInstructions {
        &self.instructions
    }

    #[must_use]
    pub const fn model_requirement(&self) -> ModelLevel {
        self.model_requirement
    }

    #[must_use]
    pub const fn reasoning_requirement(&self) -> Option<ReasoningEffort> {
        self.reasoning_requirement
    }

    #[must_use]
    pub fn input_schema(&self) -> &SchemaRef {
        &self.input_schema
    }

    #[must_use]
    pub fn output_schema(&self) -> &SchemaRef {
        &self.output_schema
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleContractPack {
    version: NonZeroU32,
    contracts: BTreeMap<RoleName, RoleContract>,
    canonical_bytes: Vec<u8>,
    digest: RoleContractDigest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPack<'a> {
    version: u32,
    contracts: &'a BTreeMap<RoleName, RoleContract>,
}

impl RoleContractPack {
    pub fn new(
        version: u32,
        specs: Vec<RoleContractSpec>,
        catalog: &WorkerCatalog,
    ) -> Result<Self, RoleContractError> {
        let version = parse_version(version)
            .map_err(|error| RoleContractError::new("pack version", error))?;
        if specs.len() != RoleName::ALL.len() {
            return Err(RoleContractError::new(
                "role contract pack",
                "pack must define every native role exactly once",
            ));
        }

        let mut contracts = BTreeMap::new();
        for spec in specs {
            let role = spec.role;
            let contract = RoleContract::new(spec, catalog)?;
            if contracts.insert(role, contract).is_some() {
                return Err(RoleContractError::new(
                    "role contract pack",
                    "roles must be unique",
                ));
            }
        }
        if contracts.len() != RoleName::ALL.len() {
            return Err(RoleContractError::new(
                "role contract pack",
                "pack must define every native role exactly once",
            ));
        }

        let (canonical_bytes, digest_hex) = canonicalize(&CanonicalPack {
            version: version.get(),
            contracts: &contracts,
        })
        .map_err(|error| RoleContractError::new("canonical role contract pack", error))?;
        let digest = RoleContractDigest::new(digest_hex)?;

        Ok(Self {
            version,
            contracts,
            canonical_bytes,
            digest,
        })
    }

    #[must_use]
    pub fn version(&self) -> u32 {
        self.version.get()
    }

    #[must_use]
    pub fn contract(&self, role: RoleName) -> Option<&RoleContract> {
        self.contracts.get(&role)
    }

    #[must_use]
    pub fn contracts(&self) -> &BTreeMap<RoleName, RoleContract> {
        &self.contracts
    }

    #[must_use]
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical_bytes
    }

    #[must_use]
    pub fn digest(&self) -> &RoleContractDigest {
        &self.digest
    }
}

static ROLE_CONTRACT_PACK: LazyLock<RoleContractPack> = LazyLock::new(|| {
    RoleContractPack::new(
        ROLE_CONTRACT_PACK_VERSION,
        canonical_role_contract_specs(),
        crate::worker_catalog::worker_catalog(),
    )
    .expect("built-in role contract pack is valid")
});

#[must_use]
pub fn role_contract_pack() -> &'static RoleContractPack {
    &ROLE_CONTRACT_PACK
}

fn canonical_role_contract_specs() -> Vec<RoleContractSpec> {
    vec![
        RoleContractSpec {
            role: RoleName::Classifier,
            instructions: role_instructions(
                "Classify the incoming task by complexity and task type. Emit only the closed \
                 classification labels and a short rationale. Never execute the task, edit \
                 files, or select a provider.",
            ),
            model_requirement: ModelLevel::Level1,
            reasoning_requirement: None,
            input_schema: schema_ref(SchemaId::ClassifierInput, 1),
            output_schema: schema_ref(SchemaId::ClassifierOutput, 1),
        },
        RoleContractSpec {
            role: RoleName::Verifier,
            instructions: role_instructions(
                "Verify a worker's completed output against the task's acceptance criteria by \
                 reading the affected files and running the project's checks directly. Report \
                 each criterion as met or unmet with cited evidence. Never modify files or \
                 accept an unproven claim.",
            ),
            model_requirement: ModelLevel::Level2,
            reasoning_requirement: Some(ReasoningEffort::Medium),
            input_schema: schema_ref(SchemaId::VerifierInput, 1),
            output_schema: schema_ref(SchemaId::VerifierOutput, 1),
        },
        RoleContractSpec {
            role: RoleName::Worker,
            instructions: role_instructions(
                "Implement the assigned task end to end: read the relevant code, make the \
                 required changes, and run the project's own validation commands. Do not stop \
                 at partial progress and do not ask for confirmation.",
            ),
            model_requirement: ModelLevel::Level2,
            reasoning_requirement: Some(ReasoningEffort::Medium),
            input_schema: schema_ref(SchemaId::WorkerInput, 1),
            output_schema: schema_ref(SchemaId::WorkerOutput, 1),
        },
    ]
}

fn role_instructions(value: &str) -> RoleInstructions {
    RoleInstructions::new(value).expect("built-in role instructions are valid")
}

fn schema_ref(schema: SchemaId, version: u32) -> SchemaRef {
    SchemaRef::new(schema, version).expect("built-in schema reference is valid")
}
