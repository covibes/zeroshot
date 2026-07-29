use super::{
    EvidenceClass, FaultCode, FaultConsequence, FaultContext, FaultSeverity, RetryDisposition,
    UserAction,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct EvidenceSemantics {
    pub(super) code: FaultCode,
    pub(super) retry_disposition: RetryDisposition,
    pub(super) user_action: UserAction,
    pub(super) severity: FaultSeverity,
    pub(super) summary: &'static str,
}

const EVIDENCE_SEMANTICS: [EvidenceSemantics; 10] = [
    EvidenceSemantics {
        code: FaultCode::Unavailable,
        retry_disposition: RetryDisposition::RetryAfterBackoff,
        user_action: UserAction::RetryLater,
        severity: FaultSeverity::Error,
        summary: "A required engine resource is unavailable.",
    },
    EvidenceSemantics {
        code: FaultCode::ResourceExhausted,
        retry_disposition: RetryDisposition::RetryAfterBackoff,
        user_action: UserAction::FreeResources,
        severity: FaultSeverity::Error,
        summary: "A required engine resource is exhausted.",
    },
    EvidenceSemantics {
        code: FaultCode::Timeout,
        retry_disposition: RetryDisposition::RetryAfterBackoff,
        user_action: UserAction::RetryLater,
        severity: FaultSeverity::Warning,
        summary: "A native engine operation timed out.",
    },
    EvidenceSemantics {
        code: FaultCode::PermissionDenied,
        retry_disposition: RetryDisposition::RetryAfterUserAction,
        user_action: UserAction::GrantPermission,
        severity: FaultSeverity::Error,
        summary: "A required engine permission was denied.",
    },
    EvidenceSemantics {
        code: FaultCode::AuthenticationRequired,
        retry_disposition: RetryDisposition::RetryAfterUserAction,
        user_action: UserAction::Authenticate,
        severity: FaultSeverity::Error,
        summary: "Authentication is required for a native engine operation.",
    },
    EvidenceSemantics {
        code: FaultCode::MalformedExternalData,
        retry_disposition: RetryDisposition::RetryAfterUserAction,
        user_action: UserAction::RepairExternalData,
        severity: FaultSeverity::Error,
        summary: "External data did not satisfy the native engine contract.",
    },
    EvidenceSemantics {
        code: FaultCode::IntegrityFailure,
        retry_disposition: RetryDisposition::DoNotRetry,
        user_action: UserAction::ContactSupport,
        severity: FaultSeverity::Critical,
        summary: "Native engine integrity verification failed.",
    },
    EvidenceSemantics {
        code: FaultCode::ProcessExited,
        retry_disposition: RetryDisposition::RetryAfterBackoff,
        user_action: UserAction::RestartOperation,
        severity: FaultSeverity::Error,
        summary: "A required native process exited unexpectedly.",
    },
    EvidenceSemantics {
        code: FaultCode::SessionLost,
        retry_disposition: RetryDisposition::DoNotRetry,
        user_action: UserAction::ContactSupport,
        severity: FaultSeverity::Error,
        summary: "A lost native engine session terminated the affected execution.",
    },
    EvidenceSemantics {
        code: FaultCode::InvariantViolation,
        retry_disposition: RetryDisposition::DoNotRetry,
        user_action: UserAction::ContactSupport,
        severity: FaultSeverity::Critical,
        summary: "A native engine invariant was violated.",
    },
];

const CONSEQUENCES: [FaultConsequence; 7] = [
    FaultConsequence::ConfigurationBlocked,
    FaultConsequence::AdmissionBlocked,
    FaultConsequence::ExecutionInterrupted,
    FaultConsequence::SettlementIncomplete,
    FaultConsequence::RecoveryBlocked,
    FaultConsequence::CleanupIncomplete,
    FaultConsequence::ObservationDegraded,
];

pub(super) const fn semantics_for_evidence(class: EvidenceClass) -> EvidenceSemantics {
    EVIDENCE_SEMANTICS[class as usize]
}

pub(super) const fn consequence_for_context(context: FaultContext) -> FaultConsequence {
    CONSEQUENCES[context as usize]
}
