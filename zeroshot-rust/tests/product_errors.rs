use std::collections::BTreeSet;

use openengine_cluster_protocol::{
    DomainErrorData, JsonRpcError, APPLICATION_ERROR, CANCELLED, GENERATION_CONFLICT, GONE,
    GRAPH_INVALID, IDEMPOTENCY_REUSE, INTERNAL_ERROR, INTERNAL_ERROR_CODE, INVALID_PARAMS,
    INVALID_PHASE, INVALID_REQUEST, METHOD_NOT_FOUND, NOT_FOUND, NO_RETRYABLE_FRONTIER,
    PARSE_ERROR, RUN_CONFLICT, SCHEMA_VIOLATION, SLOW_CONSUMER, UNSUPPORTED_PROTOCOL_VERSION,
};
use openengine_cluster_server::{BackendError, BackendErrorKind, SERVER_BUSY};
use serde_json::{json, Value};
use zeroshot_engine::fault::{
    EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence, RawDiagnostic,
    RedactionMarker,
};
use zeroshot_engine::observability::NoopObservationSink;
use zeroshot_engine::product_errors::{
    DaemonControlStatus, ProductError, ProductErrorAction, ProductErrorCode,
    ProductErrorProjectionError, MAX_PRODUCT_ERROR_ACTION_BYTES, MAX_PRODUCT_ERROR_JSON_BYTES,
    MAX_PRODUCT_ERROR_MESSAGE_BYTES, MAX_PRODUCT_ERROR_TEXT_BYTES,
};
use openengine_cluster_testkit::assertions::AssertValue;

const ENGINE_CASES: [(EvidenceClass, ProductErrorCode, u8, DaemonControlStatus); 10] = [
    (
        EvidenceClass::Unavailable,
        ProductErrorCode::Unavailable,
        6,
        DaemonControlStatus::Unavailable,
    ),
    (
        EvidenceClass::ResourceExhausted,
        ProductErrorCode::ResourceExhausted,
        6,
        DaemonControlStatus::ResourceExhausted,
    ),
    (
        EvidenceClass::Timeout,
        ProductErrorCode::Timeout,
        6,
        DaemonControlStatus::DeadlineExceeded,
    ),
    (
        EvidenceClass::PermissionDenied,
        ProductErrorCode::PermissionDenied,
        5,
        DaemonControlStatus::PermissionDenied,
    ),
    (
        EvidenceClass::AuthenticationRequired,
        ProductErrorCode::AuthenticationRequired,
        5,
        DaemonControlStatus::Unauthenticated,
    ),
    (
        EvidenceClass::MalformedExternalData,
        ProductErrorCode::MalformedExternalData,
        1,
        DaemonControlStatus::InvalidArgument,
    ),
    (
        EvidenceClass::IntegrityFailure,
        ProductErrorCode::IntegrityFailure,
        1,
        DaemonControlStatus::Internal,
    ),
    (
        EvidenceClass::ProcessExited,
        ProductErrorCode::ProcessExited,
        1,
        DaemonControlStatus::Unavailable,
    ),
    (
        EvidenceClass::SessionLost,
        ProductErrorCode::SessionLost,
        1,
        DaemonControlStatus::Internal,
    ),
    (
        EvidenceClass::InvariantViolation,
        ProductErrorCode::InvariantViolation,
        1,
        DaemonControlStatus::Internal,
    ),
];

const PROTOCOL_CASES: [(&str, ProductErrorCode, u8, DaemonControlStatus); 14] = [
    (
        GRAPH_INVALID,
        ProductErrorCode::InvalidInput,
        2,
        DaemonControlStatus::InvalidArgument,
    ),
    (
        SCHEMA_VIOLATION,
        ProductErrorCode::InvalidInput,
        2,
        DaemonControlStatus::InvalidArgument,
    ),
    (
        GENERATION_CONFLICT,
        ProductErrorCode::GenerationConflict,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        RUN_CONFLICT,
        ProductErrorCode::RunConflict,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        IDEMPOTENCY_REUSE,
        ProductErrorCode::IdempotencyConflict,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        INVALID_PHASE,
        ProductErrorCode::InvalidState,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        NO_RETRYABLE_FRONTIER,
        ProductErrorCode::InvalidState,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        CANCELLED,
        ProductErrorCode::Cancelled,
        6,
        DaemonControlStatus::Cancelled,
    ),
    (
        NOT_FOUND,
        ProductErrorCode::NotFound,
        3,
        DaemonControlStatus::NotFound,
    ),
    (
        GONE,
        ProductErrorCode::Gone,
        3,
        DaemonControlStatus::NotFound,
    ),
    (
        SLOW_CONSUMER,
        ProductErrorCode::SlowConsumer,
        6,
        DaemonControlStatus::ResourceExhausted,
    ),
    (
        SERVER_BUSY,
        ProductErrorCode::ResourceExhausted,
        6,
        DaemonControlStatus::ResourceExhausted,
    ),
    (
        UNSUPPORTED_PROTOCOL_VERSION,
        ProductErrorCode::UnsupportedCapability,
        7,
        DaemonControlStatus::Unsupported,
    ),
    (
        INTERNAL_ERROR_CODE,
        ProductErrorCode::Internal,
        1,
        DaemonControlStatus::Internal,
    ),
];

const EXPECTED_SEMANTICS: [(ProductErrorCode, &str, ProductErrorAction); 21] = [
    (
        ProductErrorCode::Unavailable,
        "A required engine resource is unavailable.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::ResourceExhausted,
        "A required engine resource is exhausted.",
        ProductErrorAction::FreeResources,
    ),
    (
        ProductErrorCode::Timeout,
        "A native engine operation timed out.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::PermissionDenied,
        "A required engine permission was denied.",
        ProductErrorAction::GrantPermission,
    ),
    (
        ProductErrorCode::AuthenticationRequired,
        "Authentication is required for a native engine operation.",
        ProductErrorAction::Authenticate,
    ),
    (
        ProductErrorCode::MalformedExternalData,
        "External data did not satisfy the native engine contract.",
        ProductErrorAction::RepairInput,
    ),
    (
        ProductErrorCode::IntegrityFailure,
        "Native engine integrity verification failed.",
        ProductErrorAction::ContactSupport,
    ),
    (
        ProductErrorCode::ProcessExited,
        "A required native process exited unexpectedly.",
        ProductErrorAction::RestartOperation,
    ),
    (
        ProductErrorCode::SessionLost,
        "A lost native engine session terminated the affected execution.",
        ProductErrorAction::ContactSupport,
    ),
    (
        ProductErrorCode::InvariantViolation,
        "A native engine invariant was violated.",
        ProductErrorAction::ContactSupport,
    ),
    (
        ProductErrorCode::InvalidInput,
        "The request did not satisfy the product contract.",
        ProductErrorAction::RepairInput,
    ),
    (
        ProductErrorCode::UnsupportedCapability,
        "The requested capability is not supported.",
        ProductErrorAction::UseSupportedCapability,
    ),
    (
        ProductErrorCode::GenerationConflict,
        "The cluster generation changed before the request was applied.",
        ProductErrorAction::RefreshState,
    ),
    (
        ProductErrorCode::RunConflict,
        "The active run changed before the request was applied.",
        ProductErrorAction::RefreshState,
    ),
    (
        ProductErrorCode::IdempotencyConflict,
        "The idempotency key was already used for another request.",
        ProductErrorAction::UseNewIdempotencyKey,
    ),
    (
        ProductErrorCode::InvalidState,
        "The requested operation is not valid in the current state.",
        ProductErrorAction::RefreshState,
    ),
    (
        ProductErrorCode::Cancelled,
        "The requested operation was cancelled.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::NotFound,
        "The requested product resource was not found.",
        ProductErrorAction::VerifyReference,
    ),
    (
        ProductErrorCode::Gone,
        "The requested product resource is no longer available.",
        ProductErrorAction::StartNewOperation,
    ),
    (
        ProductErrorCode::SlowConsumer,
        "The control consumer exceeded its bounded delivery capacity.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::Internal,
        "The native product could not complete the operation.",
        ProductErrorAction::ContactSupport,
    ),
];

fn factory() -> FaultFactory<'static> {
    static SINK: NoopObservationSink = NoopObservationSink;
    FaultFactory::new(&SINK)
}

fn protocol_error(domain_code: &str, diagnostic: &str) -> JsonRpcError {
    JsonRpcError {
        code: APPLICATION_ERROR,
        message: diagnostic.to_owned(),
        data: Some(DomainErrorData {
            code: domain_code.to_owned(),
            details: Some(json!({
                "diagnostic": diagnostic,
                "path": "/home/private/project",
                "url": "https://user:credential@example.invalid/control",
                "command": ["provider", "--session", "secret-session"],
                "stderr": "Bearer secret-token"
            })),
        }),
    }
}

fn all_products() -> Vec<ProductError> {
    let mut products = ENGINE_CASES
        .into_iter()
        .map(|(class, _, _, _)| {
            let fault = factory().create(ModuleEvidence::new(
                FaultModule::Provider,
                FaultContext::Execution,
                class,
            ));
            ProductError::from_engine_fault(&fault).assert_value()
        })
        .collect::<Vec<_>>();
    products.extend(PROTOCOL_CASES.into_iter().map(|(domain, _, _, _)| {
        ProductError::from_protocol_error(&protocol_error(domain, "discarded diagnostic"))
            .assert_value()
    }));
    products
}

#[path = "product_errors/cases.rs"]
mod cases;
