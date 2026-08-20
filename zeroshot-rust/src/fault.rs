use std::error::Error;
use std::fmt;

use openengine_cluster_protocol::INTERNAL_ERROR_CODE;
use openengine_cluster_server::BackendError;
use serde::{Deserialize, Serialize};

use crate::observability::{
    FaultObservation, ObservationModule, ObservationOperation, ObservationOutcome, ObservationSink,
};

mod redaction;
mod taxonomy;
mod validation;

pub use redaction::{EphemeralDiagnostic, RawDiagnostic, RedactionMarker};
use taxonomy::{consequence_for_context, semantics_for_evidence, EvidenceSemantics};
use validation::validate_fault;

pub const MAX_FAULT_SUMMARY_BYTES: usize = 512;
pub const MAX_FAULT_SOURCES: usize = 8;
pub const MAX_ENGINE_FAULT_BYTES: usize = 4096;
pub const MAX_EPHEMERAL_DIAGNOSTIC_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultModule {
    Engine,
    Storage,
    Worker,
    Provider,
    Workspace,
    Source,
    Credential,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
#[repr(usize)]
pub enum FaultContext {
    Configuration,
    Admission,
    Execution,
    Settlement,
    Recovery,
    Cleanup,
    Observation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
#[repr(usize)]
pub enum EvidenceClass {
    Unavailable,
    ResourceExhausted,
    Timeout,
    PermissionDenied,
    AuthenticationRequired,
    MalformedExternalData,
    IntegrityFailure,
    ProcessExited,
    SessionLost,
    InvariantViolation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultCode {
    Unavailable,
    ResourceExhausted,
    Timeout,
    PermissionDenied,
    AuthenticationRequired,
    MalformedExternalData,
    IntegrityFailure,
    ProcessExited,
    SessionLost,
    InvariantViolation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultConsequence {
    ConfigurationBlocked,
    AdmissionBlocked,
    ExecutionInterrupted,
    SettlementIncomplete,
    RecoveryBlocked,
    CleanupIncomplete,
    ObservationDegraded,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryDisposition {
    DoNotRetry,
    RetryAfterBackoff,
    RetryAfterUserAction,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UserAction {
    RetryLater,
    FreeResources,
    GrantPermission,
    Authenticate,
    RepairExternalData,
    RestartOperation,
    ContactSupport,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultSeverity {
    Warning,
    Error,
    Critical,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleEvidence {
    module: FaultModule,
    context: FaultContext,
    class: EvidenceClass,
    diagnostic: Option<RawDiagnostic>,
}

impl ModuleEvidence {
    #[must_use]
    pub const fn new(module: FaultModule, context: FaultContext, class: EvidenceClass) -> Self {
        Self {
            module,
            context,
            class,
            diagnostic: None,
        }
    }

    #[must_use]
    pub fn with_diagnostic(mut self, diagnostic: RawDiagnostic) -> Self {
        self.diagnostic = Some(diagnostic);
        self
    }

    #[must_use]
    pub const fn module(&self) -> FaultModule {
        self.module
    }

    #[must_use]
    pub const fn context(&self) -> FaultContext {
        self.context
    }

    #[must_use]
    pub const fn class(&self) -> EvidenceClass {
        self.class
    }

    #[must_use]
    pub const fn diagnostic(&self) -> Option<&RawDiagnostic> {
        self.diagnostic.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeSourceFrame {
    module: FaultModule,
    context: FaultContext,
    evidence_class: EvidenceClass,
}

impl SafeSourceFrame {
    #[must_use]
    pub const fn new(
        module: FaultModule,
        context: FaultContext,
        evidence_class: EvidenceClass,
    ) -> Self {
        Self {
            module,
            context,
            evidence_class,
        }
    }

    #[must_use]
    pub const fn module(&self) -> FaultModule {
        self.module
    }

    #[must_use]
    pub const fn context(&self) -> FaultContext {
        self.context
    }

    #[must_use]
    pub const fn evidence_class(&self) -> EvidenceClass {
        self.evidence_class
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BoundedFaultSummary(&'static str);

impl BoundedFaultSummary {
    pub fn from_engine_owned(summary: &'static str) -> Result<Self, FaultError> {
        if summary.len() > MAX_FAULT_SUMMARY_BYTES {
            return Err(FaultError::SummaryTooLong);
        }
        Ok(Self(summary))
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineFault {
    code: FaultCode,
    consequence: FaultConsequence,
    retry_disposition: RetryDisposition,
    user_action: UserAction,
    severity: FaultSeverity,
    summary: &'static str,
    sources: Vec<SafeSourceFrame>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedEngineFault {
    code: FaultCode,
    consequence: FaultConsequence,
    retry_disposition: RetryDisposition,
    user_action: UserAction,
    severity: FaultSeverity,
    summary: String,
    sources: Vec<SafeSourceFrame>,
}

impl EngineFault {
    fn from_sources(sources: Vec<SafeSourceFrame>) -> Result<Self, FaultError> {
        if sources.len() > MAX_FAULT_SOURCES {
            return Err(FaultError::TooManySources);
        }
        let primary = sources
            .first()
            .copied()
            .ok_or(FaultError::MissingPrimarySource)?;
        let semantics = semantics_for_evidence(primary.evidence_class);
        Ok(Self::from_semantics(
            semantics,
            consequence_for_context(primary.context),
            sources,
        ))
    }

    fn from_semantics(
        semantics: EvidenceSemantics,
        consequence: FaultConsequence,
        sources: Vec<SafeSourceFrame>,
    ) -> Self {
        Self {
            code: semantics.code,
            consequence,
            retry_disposition: semantics.retry_disposition,
            user_action: semantics.user_action,
            severity: semantics.severity,
            summary: semantics.summary,
            sources,
        }
    }

    fn has_same_semantics(&self, other: &Self) -> bool {
        self.code == other.code
            && self.consequence == other.consequence
            && self.retry_disposition == other.retry_disposition
            && self.user_action == other.user_action
            && self.severity == other.severity
            && self.summary == other.summary
    }

    #[must_use]
    pub const fn code(&self) -> FaultCode {
        self.code
    }

    #[must_use]
    pub const fn consequence(&self) -> FaultConsequence {
        self.consequence
    }

    #[must_use]
    pub const fn retry_disposition(&self) -> RetryDisposition {
        self.retry_disposition
    }

    #[must_use]
    pub const fn user_action(&self) -> UserAction {
        self.user_action
    }

    #[must_use]
    pub const fn severity(&self) -> FaultSeverity {
        self.severity
    }

    #[must_use]
    pub const fn summary(&self) -> &'static str {
        self.summary
    }

    #[must_use]
    pub fn sources(&self) -> &[SafeSourceFrame] {
        &self.sources
    }

    pub fn encode_json(&self) -> Result<Vec<u8>, FaultError> {
        validate_fault(self)?;
        let encoded = serde_json::to_vec(self).map_err(|_| FaultError::EncodingFailed)?;
        if encoded.len() > MAX_ENGINE_FAULT_BYTES {
            return Err(FaultError::EncodedFaultTooLong);
        }
        Ok(encoded)
    }

    pub fn decode_json(encoded: &[u8]) -> Result<Self, FaultError> {
        if encoded.len() > MAX_ENGINE_FAULT_BYTES {
            return Err(FaultError::EncodedFaultTooLong);
        }
        let decoded: EncodedEngineFault =
            serde_json::from_slice(encoded).map_err(|_| FaultError::InvalidEncoding)?;
        if decoded.summary.len() > MAX_FAULT_SUMMARY_BYTES {
            return Err(FaultError::SummaryTooLong);
        }
        if decoded.sources.len() > MAX_FAULT_SOURCES {
            return Err(FaultError::TooManySources);
        }
        let fault = Self::from_sources(decoded.sources)?;
        if decoded.summary != fault.summary {
            return Err(FaultError::InvalidSafeSummary);
        }
        let supplied = Self {
            code: decoded.code,
            consequence: decoded.consequence,
            retry_disposition: decoded.retry_disposition,
            user_action: decoded.user_action,
            severity: decoded.severity,
            summary: fault.summary,
            sources: Vec::new(),
        };
        if !supplied.has_same_semantics(&fault) {
            return Err(FaultError::InvalidFaultSemantics);
        }
        Ok(fault)
    }
}

impl From<&EngineFault> for BackendError {
    fn from(_fault: &EngineFault) -> Self {
        BackendError::new(INTERNAL_ERROR_CODE, "Internal error")
    }
}

impl From<EngineFault> for BackendError {
    fn from(fault: EngineFault) -> Self {
        Self::from(&fault)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(usize)]
pub enum FaultError {
    SummaryTooLong,
    DiagnosticTooLong,
    TooManySources,
    MissingPrimarySource,
    EncodedFaultTooLong,
    InvalidSafeSummary,
    InvalidFaultSemantics,
    InvalidEncoding,
    EncodingFailed,
}

const FAULT_ERROR_MESSAGES: [&str; 9] = [
    "fault summary exceeds 512 UTF-8 bytes",
    "ephemeral diagnostic exceeds 1024 UTF-8 bytes",
    "fault source chain exceeds eight frames",
    "fault source chain requires a canonical primary frame",
    "encoded engine fault exceeds 4096 bytes",
    "fault summary is not the engine-owned summary for its evidence class",
    "fault semantics do not match the canonical primary source frame",
    "engine fault encoding is invalid",
    "engine fault encoding failed",
];

impl fmt::Display for FaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [
            summary,
            diagnostic,
            sources,
            primary,
            encoded,
            safe_summary,
            semantics,
            invalid,
            failed,
        ] = FAULT_ERROR_MESSAGES;
        formatter.write_str(match self {
            Self::SummaryTooLong => summary,
            Self::DiagnosticTooLong => diagnostic,
            Self::TooManySources => sources,
            Self::MissingPrimarySource => primary,
            Self::EncodedFaultTooLong => encoded,
            Self::InvalidSafeSummary => safe_summary,
            Self::InvalidFaultSemantics => semantics,
            Self::InvalidEncoding => invalid,
            Self::EncodingFailed => failed,
        })
    }
}

impl Error for FaultError {}

pub struct FaultFactory<'a> {
    observations: &'a dyn ObservationSink,
}

impl<'a> FaultFactory<'a> {
    #[must_use]
    pub const fn new(observations: &'a dyn ObservationSink) -> Self {
        Self { observations }
    }

    #[must_use]
    pub fn create(&self, evidence: ModuleEvidence) -> EngineFault {
        let semantics = semantics_for_evidence(evidence.class);
        let fault = EngineFault::from_semantics(
            semantics,
            consequence_for_context(evidence.context),
            vec![SafeSourceFrame::new(
                evidence.module,
                evidence.context,
                evidence.class,
            )],
        );
        let fault_size_bytes = fault
            .encode_json()
            .ok()
            .and_then(|encoded| u16::try_from(encoded.len()).ok())
            .unwrap_or_default();
        self.observations.record_fault(FaultObservation {
            module: evidence.module.into(),
            operation: evidence.context.into(),
            outcome: ObservationOutcome::Faulted,
            fault_code: fault.code,
            consequence: fault.consequence,
            severity: fault.severity,
            fault_size_bytes,
            diagnostic_redacted: evidence.diagnostic.is_some(),
        });
        fault
    }
}

impl From<FaultModule> for ObservationModule {
    fn from(module: FaultModule) -> Self {
        match module {
            FaultModule::Engine => Self::Engine,
            FaultModule::Storage => Self::Storage,
            FaultModule::Worker => Self::Worker,
            FaultModule::Provider => Self::Provider,
            FaultModule::Workspace => Self::Workspace,
            FaultModule::Source => Self::Source,
            FaultModule::Credential => Self::Credential,
        }
    }
}

impl From<FaultContext> for ObservationOperation {
    fn from(context: FaultContext) -> Self {
        match context {
            FaultContext::Configuration => Self::Configuration,
            FaultContext::Admission => Self::Admission,
            FaultContext::Execution => Self::Execution,
            FaultContext::Settlement => Self::Settlement,
            FaultContext::Recovery => Self::Recovery,
            FaultContext::Cleanup => Self::Cleanup,
            FaultContext::Observation => Self::Observation,
        }
    }
}
