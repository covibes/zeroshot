//! Immutable portable conformance catalog and factory contract.

use std::error::Error;

use async_trait::async_trait;
use openengine_cluster_protocol::{GraphProfile, SCHEMA_VIOLATION};
use openengine_cluster_server::ClusterBackend;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConformanceModule {
    Initialize,
    Dispatch,
    Get,
    Admission,
    Lifecycle,
    Watch,
    Logs,
    AgentAttach,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OptionalCapability {
    Logs,
    AgentAttach,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConformanceRequirement {
    Required,
    Optional(OptionalCapability),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransportApplicability {
    pub dispatcher: bool,
    pub ndjson: bool,
    pub websocket: bool,
    pub typed_in_process: bool,
}

const WIRE_ONLY: TransportApplicability = TransportApplicability {
    dispatcher: true,
    ndjson: true,
    websocket: true,
    typed_in_process: false,
};
const TYPED_DISPATCHED: TransportApplicability = TransportApplicability {
    dispatcher: true,
    ndjson: true,
    websocket: true,
    typed_in_process: true,
};
const INTERCEPTED: TransportApplicability = TransportApplicability {
    dispatcher: false,
    ndjson: true,
    websocket: true,
    typed_in_process: true,
};

#[derive(Clone, Copy)]
pub(crate) enum Expected {
    Initialize,
    EmptyGet,
    Error {
        code: i64,
        domain: Option<&'static str>,
        id: Option<i64>,
    },
    WatchEstablished,
    LogsEstablished,
    AgentAttachNotFound,
}

#[derive(Clone, Copy)]
pub(crate) struct CaseDefinition {
    pub(crate) id: &'static str,
    pub(crate) module: ConformanceModule,
    pub(crate) requirement: ConformanceRequirement,
    pub(crate) applicability: TransportApplicability,
    pub(crate) input: &'static str,
    pub(crate) expected: Expected,
}

impl CaseDefinition {
    const fn dispatched(
        id: &'static str,
        module: ConformanceModule,
        input: &'static str,
        expected: Expected,
    ) -> Self {
        Self {
            id,
            module,
            requirement: ConformanceRequirement::Required,
            applicability: match expected {
                Expected::Initialize | Expected::EmptyGet => TYPED_DISPATCHED,
                _ => WIRE_ONLY,
            },
            input,
            expected,
        }
    }

    const fn direct(
        id: &'static str,
        module: ConformanceModule,
        requirement: ConformanceRequirement,
        expected: Expected,
    ) -> Self {
        Self {
            id,
            module,
            requirement,
            applicability: INTERCEPTED,
            input: match expected {
                Expected::WatchEstablished => {
                    r#"{"jsonrpc":"2.0","id":1,"method":"watch","params":{}}"#
                }
                Expected::LogsEstablished => {
                    r#"{"jsonrpc":"2.0","id":1,"method":"logs","params":{}}"#
                }
                Expected::AgentAttachNotFound => {
                    r#"{"jsonrpc":"2.0","id":1,"method":"agent/attach","params":{"execution":"portable-conformance-unknown"}}"#
                }
                _ => "",
            },
            expected,
        }
    }
}

const PARSE_ERROR: Expected = Expected::Error {
    code: -32700,
    domain: None,
    id: None,
};
const INVALID_REQUEST: Expected = Expected::Error {
    code: -32600,
    domain: None,
    id: None,
};
const INVALID_PARAMS: Expected = Expected::Error {
    code: -32602,
    domain: None,
    id: Some(1),
};
const SCHEMA_INVALID: Expected = Expected::Error {
    code: -32602,
    domain: Some(SCHEMA_VIOLATION),
    id: Some(1),
};
const METHOD_NOT_FOUND: Expected = Expected::Error {
    code: -32601,
    domain: None,
    id: Some(1),
};
const UNSUPPORTED_VERSION: Expected = Expected::Error {
    code: -32000,
    domain: Some("UNSUPPORTED_PROTOCOL_VERSION"),
    id: Some(1),
};

pub(crate) static CATALOG: [CaseDefinition; 18] = [
    CaseDefinition::dispatched(
        "portable.initialize.registration",
        ConformanceModule::Initialize,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"openengine.cluster/v1"}}"#,
        Expected::Initialize,
    ),
    CaseDefinition::dispatched(
        "portable.dispatch.parse-error",
        ConformanceModule::Dispatch,
        "{",
        PARSE_ERROR,
    ),
    CaseDefinition::dispatched(
        "portable.dispatch.batch-invalid",
        ConformanceModule::Dispatch,
        "[]",
        INVALID_REQUEST,
    ),
    CaseDefinition::dispatched(
        "portable.dispatch.invalid-jsonrpc",
        ConformanceModule::Dispatch,
        r#"{"jsonrpc":"1.0","id":1,"method":"get","params":{}}"#,
        INVALID_REQUEST,
    ),
    CaseDefinition::dispatched(
        "portable.dispatch.invalid-params",
        ConformanceModule::Dispatch,
        r#"{"jsonrpc":"2.0","id":1,"method":"get","params":[]}"#,
        INVALID_PARAMS,
    ),
    CaseDefinition::dispatched(
        "portable.dispatch.unknown-method",
        ConformanceModule::Dispatch,
        r#"{"jsonrpc":"2.0","id":1,"method":"portable/missing","params":{}}"#,
        METHOD_NOT_FOUND,
    ),
    CaseDefinition::dispatched(
        "portable.dispatch.unsupported-version",
        ConformanceModule::Dispatch,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"openengine.cluster/v0"}}"#,
        UNSUPPORTED_VERSION,
    ),
    CaseDefinition::dispatched(
        "portable.get.empty",
        ConformanceModule::Get,
        r#"{"jsonrpc":"2.0","id":1,"method":"get","params":{}}"#,
        Expected::EmptyGet,
    ),
    CaseDefinition::dispatched(
        "portable.plan.schema-invalid",
        ConformanceModule::Admission,
        r#"{"jsonrpc":"2.0","id":1,"method":"plan","params":{}}"#,
        SCHEMA_INVALID,
    ),
    CaseDefinition::dispatched(
        "portable.apply.schema-invalid",
        ConformanceModule::Admission,
        r#"{"jsonrpc":"2.0","id":1,"method":"apply","params":{}}"#,
        SCHEMA_INVALID,
    ),
    CaseDefinition::dispatched(
        "portable.update.schema-invalid",
        ConformanceModule::Lifecycle,
        r#"{"jsonrpc":"2.0","id":1,"method":"update","params":{}}"#,
        SCHEMA_INVALID,
    ),
    CaseDefinition::dispatched(
        "portable.stop.schema-invalid",
        ConformanceModule::Lifecycle,
        r#"{"jsonrpc":"2.0","id":1,"method":"stop","params":{}}"#,
        SCHEMA_INVALID,
    ),
    CaseDefinition::dispatched(
        "portable.retry.schema-invalid",
        ConformanceModule::Lifecycle,
        r#"{"jsonrpc":"2.0","id":1,"method":"retry","params":{}}"#,
        SCHEMA_INVALID,
    ),
    CaseDefinition::dispatched(
        "portable.resubmit.schema-invalid",
        ConformanceModule::Lifecycle,
        r#"{"jsonrpc":"2.0","id":1,"method":"resubmit","params":{}}"#,
        SCHEMA_INVALID,
    ),
    CaseDefinition::dispatched(
        "portable.delete.schema-invalid",
        ConformanceModule::Lifecycle,
        r#"{"jsonrpc":"2.0","id":1,"method":"delete","params":{}}"#,
        SCHEMA_INVALID,
    ),
    CaseDefinition::direct(
        "portable.watch.establish-empty",
        ConformanceModule::Watch,
        ConformanceRequirement::Required,
        Expected::WatchEstablished,
    ),
    CaseDefinition::direct(
        "portable.logs.establish",
        ConformanceModule::Logs,
        ConformanceRequirement::Optional(OptionalCapability::Logs),
        Expected::LogsEstablished,
    ),
    CaseDefinition::direct(
        "portable.agent-attach.unknown",
        ConformanceModule::AgentAttach,
        ConformanceRequirement::Optional(OptionalCapability::AgentAttach),
        Expected::AgentAttachNotFound,
    ),
];

pub struct ConformanceCase {
    definition: &'static CaseDefinition,
}

impl ConformanceCase {
    #[must_use]
    pub const fn id(&self) -> &'static str {
        self.definition.id
    }

    #[must_use]
    pub const fn module(&self) -> ConformanceModule {
        self.definition.module
    }

    #[must_use]
    pub const fn requirement(&self) -> ConformanceRequirement {
        self.definition.requirement
    }

    #[must_use]
    pub const fn transport_applicability(&self) -> TransportApplicability {
        self.definition.applicability
    }

    #[must_use]
    pub const fn input(&self) -> &'static str {
        self.definition.input
    }
}

static PUBLIC_CATALOG: [ConformanceCase; 18] = [
    ConformanceCase {
        definition: &CATALOG[0],
    },
    ConformanceCase {
        definition: &CATALOG[1],
    },
    ConformanceCase {
        definition: &CATALOG[2],
    },
    ConformanceCase {
        definition: &CATALOG[3],
    },
    ConformanceCase {
        definition: &CATALOG[4],
    },
    ConformanceCase {
        definition: &CATALOG[5],
    },
    ConformanceCase {
        definition: &CATALOG[6],
    },
    ConformanceCase {
        definition: &CATALOG[7],
    },
    ConformanceCase {
        definition: &CATALOG[8],
    },
    ConformanceCase {
        definition: &CATALOG[9],
    },
    ConformanceCase {
        definition: &CATALOG[10],
    },
    ConformanceCase {
        definition: &CATALOG[11],
    },
    ConformanceCase {
        definition: &CATALOG[12],
    },
    ConformanceCase {
        definition: &CATALOG[13],
    },
    ConformanceCase {
        definition: &CATALOG[14],
    },
    ConformanceCase {
        definition: &CATALOG[15],
    },
    ConformanceCase {
        definition: &CATALOG[16],
    },
    ConformanceCase {
        definition: &CATALOG[17],
    },
];

#[must_use]
pub fn conformance_catalog() -> &'static [ConformanceCase] {
    &PUBLIC_CATALOG
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RegisteredOptionalCapabilities {
    pub logs: bool,
    pub agent_attach: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct BackendRegistration<'a> {
    pub graph_profiles: &'a [GraphProfile],
    pub optional: RegisteredOptionalCapabilities,
}

#[async_trait]
pub trait BackendFactory: Send + Sync {
    type Backend: ClusterBackend;
    type Error: Error + Send + Sync + 'static;

    fn registration(&self) -> BackendRegistration<'_>;
    async fn create(&self) -> Result<Self::Backend, Self::Error>;
    async fn reset(&self, backend: &Self::Backend) -> Result<(), Self::Error>;
    async fn cleanup(&self, backend: Self::Backend) -> Result<(), Self::Error>;
}
