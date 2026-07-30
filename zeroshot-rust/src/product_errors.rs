use std::fmt::Write as _;

use openengine_cluster_protocol::{
    JsonRpcError, APPLICATION_ERROR, CANCELLED, GENERATION_CONFLICT, GONE, GRAPH_INVALID,
    IDEMPOTENCY_REUSE, INTERNAL_ERROR, INTERNAL_ERROR_CODE, INVALID_PARAMS, INVALID_PHASE,
    INVALID_REQUEST, METHOD_NOT_FOUND, NOT_FOUND, NO_RETRYABLE_FRONTIER, PARSE_ERROR,
    RUN_CONFLICT, SCHEMA_VIOLATION, SLOW_CONSUMER, UNSUPPORTED_PROTOCOL_VERSION,
};
use openengine_cluster_server::{BackendError, BackendErrorKind};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::fault::{EngineFault, FaultCode, UserAction};

pub const MAX_PRODUCT_ERROR_MESSAGE_BYTES: usize = 128;
pub const MAX_PRODUCT_ERROR_ACTION_BYTES: usize = 32;
pub const MAX_PRODUCT_ERROR_JSON_BYTES: usize = 512;
pub const MAX_PRODUCT_ERROR_TEXT_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductErrorCode {
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
    InvalidInput,
    UnsupportedCapability,
    GenerationConflict,
    RunConflict,
    IdempotencyConflict,
    InvalidState,
    Cancelled,
    NotFound,
    Gone,
    SlowConsumer,
    Internal,
}

impl ProductErrorCode {
    pub const ALL: [Self; 21] = [
        Self::Unavailable,
        Self::ResourceExhausted,
        Self::Timeout,
        Self::PermissionDenied,
        Self::AuthenticationRequired,
        Self::MalformedExternalData,
        Self::IntegrityFailure,
        Self::ProcessExited,
        Self::SessionLost,
        Self::InvariantViolation,
        Self::InvalidInput,
        Self::UnsupportedCapability,
        Self::GenerationConflict,
        Self::RunConflict,
        Self::IdempotencyConflict,
        Self::InvalidState,
        Self::Cancelled,
        Self::NotFound,
        Self::Gone,
        Self::SlowConsumer,
        Self::Internal,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::ResourceExhausted => "resource_exhausted",
            Self::Timeout => "timeout",
            Self::PermissionDenied => "permission_denied",
            Self::AuthenticationRequired => "authentication_required",
            Self::MalformedExternalData => "malformed_external_data",
            Self::IntegrityFailure => "integrity_failure",
            Self::ProcessExited => "process_exited",
            Self::SessionLost => "session_lost",
            Self::InvariantViolation => "invariant_violation",
            Self::InvalidInput => "invalid_input",
            Self::UnsupportedCapability => "unsupported_capability",
            Self::GenerationConflict => "generation_conflict",
            Self::RunConflict => "run_conflict",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::InvalidState => "invalid_state",
            Self::Cancelled => "cancelled",
            Self::NotFound => "not_found",
            Self::Gone => "gone",
            Self::SlowConsumer => "slow_consumer",
            Self::Internal => "internal",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == value)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductErrorAction {
    RetryLater,
    FreeResources,
    GrantPermission,
    Authenticate,
    RepairInput,
    RestartOperation,
    ContactSupport,
    RefreshState,
    UseNewIdempotencyKey,
    UseSupportedCapability,
    VerifyReference,
    StartNewOperation,
}

impl ProductErrorAction {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RetryLater => "retry_later",
            Self::FreeResources => "free_resources",
            Self::GrantPermission => "grant_permission",
            Self::Authenticate => "authenticate",
            Self::RepairInput => "repair_input",
            Self::RestartOperation => "restart_operation",
            Self::ContactSupport => "contact_support",
            Self::RefreshState => "refresh_state",
            Self::UseNewIdempotencyKey => "use_new_idempotency_key",
            Self::UseSupportedCapability => "use_supported_capability",
            Self::VerifyReference => "verify_reference",
            Self::StartNewOperation => "start_new_operation",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonControlStatus {
    InvalidArgument,
    Unsupported,
    Conflict,
    Cancelled,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ResourceExhausted,
    Unavailable,
    DeadlineExceeded,
    Internal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductError {
    code: ProductErrorCode,
    message: &'static str,
    action: ProductErrorAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedProductError {
    code: ProductErrorCode,
    message: String,
    action: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonControlError {
    status: DaemonControlStatus,
    code: ProductErrorCode,
    message: &'static str,
    action: ProductErrorAction,
}

impl DaemonControlError {
    #[must_use]
    pub const fn status(self) -> DaemonControlStatus {
        self.status
    }

    #[must_use]
    pub const fn code(self) -> ProductErrorCode {
        self.code
    }

    #[must_use]
    pub const fn message(self) -> &'static str {
        self.message
    }

    #[must_use]
    pub const fn action(self) -> ProductErrorAction {
        self.action
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ProductErrorProjectionError {
    #[error("product error message exceeds its safe bound")]
    MessageTooLong,
    #[error("product error action exceeds its safe bound")]
    ActionTooLong,
    #[error("product error JSON exceeds its safe bound")]
    JsonTooLong,
    #[error("product error text exceeds its safe bound")]
    TextTooLong,
    #[error("product error encoding is invalid")]
    InvalidEncoding,
    #[error("product error fields do not match the closed code")]
    InvalidSemantics,
    #[error("protocol error category is not safe for product projection")]
    UnknownProtocolError,
    #[error("product error encoding failed")]
    EncodingFailed,
}

impl ProductError {
    #[must_use]
    pub fn from_engine_fault(fault: &EngineFault) -> Result<Self, ProductErrorProjectionError> {
        let code = match fault.code() {
            FaultCode::Unavailable => ProductErrorCode::Unavailable,
            FaultCode::ResourceExhausted => ProductErrorCode::ResourceExhausted,
            FaultCode::Timeout => ProductErrorCode::Timeout,
            FaultCode::PermissionDenied => ProductErrorCode::PermissionDenied,
            FaultCode::AuthenticationRequired => ProductErrorCode::AuthenticationRequired,
            FaultCode::MalformedExternalData => ProductErrorCode::MalformedExternalData,
            FaultCode::IntegrityFailure => ProductErrorCode::IntegrityFailure,
            FaultCode::ProcessExited => ProductErrorCode::ProcessExited,
            FaultCode::SessionLost => ProductErrorCode::SessionLost,
            FaultCode::InvariantViolation => ProductErrorCode::InvariantViolation,
        };
        let projected = Self::from_code(code);
        let action = match fault.user_action() {
            UserAction::RetryLater => ProductErrorAction::RetryLater,
            UserAction::FreeResources => ProductErrorAction::FreeResources,
            UserAction::GrantPermission => ProductErrorAction::GrantPermission,
            UserAction::Authenticate => ProductErrorAction::Authenticate,
            UserAction::RepairExternalData => ProductErrorAction::RepairInput,
            UserAction::RestartOperation => ProductErrorAction::RestartOperation,
            UserAction::ContactSupport => ProductErrorAction::ContactSupport,
        };
        if fault.summary() != projected.message || action != projected.action {
            return Err(ProductErrorProjectionError::InvalidSemantics);
        }
        Ok(projected)
    }

    pub fn from_protocol_error(
        error: &JsonRpcError,
    ) -> Result<Self, ProductErrorProjectionError> {
        let code = match error.code {
            PARSE_ERROR | INVALID_REQUEST | INVALID_PARAMS => ProductErrorCode::InvalidInput,
            METHOD_NOT_FOUND => ProductErrorCode::UnsupportedCapability,
            INTERNAL_ERROR => ProductErrorCode::Internal,
            APPLICATION_ERROR => {
                let domain = error
                    .data
                    .as_ref()
                    .ok_or(ProductErrorProjectionError::UnknownProtocolError)?;
                protocol_domain_code(&domain.code)?
            }
            _ => return Err(ProductErrorProjectionError::UnknownProtocolError),
        };
        Ok(Self::from_code(code))
    }

    pub fn from_backend_error(
        error: &BackendError,
    ) -> Result<Self, ProductErrorProjectionError> {
        let code = match error.kind {
            BackendErrorKind::Internal => ProductErrorCode::Internal,
            BackendErrorKind::InvalidParams => ProductErrorCode::InvalidInput,
            BackendErrorKind::Application => protocol_domain_code(&error.code)?,
        };
        Ok(Self::from_code(code))
    }

    #[must_use]
    pub const fn code(self) -> ProductErrorCode {
        self.code
    }

    #[must_use]
    pub const fn message(self) -> &'static str {
        self.message
    }

    #[must_use]
    pub const fn action(self) -> ProductErrorAction {
        self.action
    }

    #[must_use]
    pub const fn exit_status(self) -> u8 {
        match self.code {
            ProductErrorCode::InvalidInput => 2,
            ProductErrorCode::NotFound | ProductErrorCode::Gone => 3,
            ProductErrorCode::GenerationConflict
            | ProductErrorCode::RunConflict
            | ProductErrorCode::IdempotencyConflict
            | ProductErrorCode::InvalidState => 4,
            ProductErrorCode::PermissionDenied | ProductErrorCode::AuthenticationRequired => 5,
            ProductErrorCode::Unavailable
            | ProductErrorCode::ResourceExhausted
            | ProductErrorCode::Timeout
            | ProductErrorCode::Cancelled
            | ProductErrorCode::SlowConsumer => 6,
            ProductErrorCode::UnsupportedCapability => 7,
            ProductErrorCode::MalformedExternalData
            | ProductErrorCode::IntegrityFailure
            | ProductErrorCode::ProcessExited
            | ProductErrorCode::SessionLost
            | ProductErrorCode::InvariantViolation
            | ProductErrorCode::Internal => 1,
        }
    }

    #[must_use]
    pub const fn daemon_status(self) -> DaemonControlStatus {
        match self.code {
            ProductErrorCode::InvalidInput | ProductErrorCode::MalformedExternalData => {
                DaemonControlStatus::InvalidArgument
            }
            ProductErrorCode::UnsupportedCapability => DaemonControlStatus::Unsupported,
            ProductErrorCode::GenerationConflict
            | ProductErrorCode::RunConflict
            | ProductErrorCode::IdempotencyConflict
            | ProductErrorCode::InvalidState => DaemonControlStatus::Conflict,
            ProductErrorCode::Cancelled => DaemonControlStatus::Cancelled,
            ProductErrorCode::NotFound | ProductErrorCode::Gone => DaemonControlStatus::NotFound,
            ProductErrorCode::PermissionDenied => DaemonControlStatus::PermissionDenied,
            ProductErrorCode::AuthenticationRequired => DaemonControlStatus::Unauthenticated,
            ProductErrorCode::ResourceExhausted | ProductErrorCode::SlowConsumer => {
                DaemonControlStatus::ResourceExhausted
            }
            ProductErrorCode::Unavailable | ProductErrorCode::ProcessExited => {
                DaemonControlStatus::Unavailable
            }
            ProductErrorCode::Timeout => DaemonControlStatus::DeadlineExceeded,
            ProductErrorCode::IntegrityFailure
            | ProductErrorCode::SessionLost
            | ProductErrorCode::InvariantViolation
            | ProductErrorCode::Internal => DaemonControlStatus::Internal,
        }
    }

    #[must_use]
    pub const fn daemon_control(self) -> DaemonControlError {
        DaemonControlError {
            status: self.daemon_status(),
            code: self.code,
            message: self.message,
            action: self.action,
        }
    }

    pub fn render_json(self) -> Result<Vec<u8>, ProductErrorProjectionError> {
        validate_fields(self.message, self.action)?;
        let encoded = serde_json::to_vec(&self)
            .map_err(|_| ProductErrorProjectionError::EncodingFailed)?;
        if encoded.len() > MAX_PRODUCT_ERROR_JSON_BYTES {
            return Err(ProductErrorProjectionError::JsonTooLong);
        }
        Ok(encoded)
    }

    pub fn decode_json(encoded: &[u8]) -> Result<Self, ProductErrorProjectionError> {
        if encoded.len() > MAX_PRODUCT_ERROR_JSON_BYTES {
            return Err(ProductErrorProjectionError::JsonTooLong);
        }
        let decoded: EncodedProductError = serde_json::from_slice(encoded)
            .map_err(|_| ProductErrorProjectionError::InvalidEncoding)?;
        if decoded.message.len() > MAX_PRODUCT_ERROR_MESSAGE_BYTES {
            return Err(ProductErrorProjectionError::MessageTooLong);
        }
        if decoded.action.len() > MAX_PRODUCT_ERROR_ACTION_BYTES {
            return Err(ProductErrorProjectionError::ActionTooLong);
        }
        let canonical = Self::from_code(decoded.code);
        if decoded.message != canonical.message || decoded.action != canonical.action.as_str() {
            return Err(ProductErrorProjectionError::InvalidSemantics);
        }
        Ok(canonical)
    }

    pub fn render_text(self) -> Result<String, ProductErrorProjectionError> {
        validate_fields(self.message, self.action)?;
        let mut rendered = String::with_capacity(
            self.code.as_str().len() + self.message.len() + self.action.as_str().len() + 19,
        );
        write!(
            rendered,
            "error[{}]: {}\naction: {}\n",
            self.code.as_str(),
            self.message,
            self.action.as_str()
        )
        .map_err(|_| ProductErrorProjectionError::EncodingFailed)?;
        if rendered.len() > MAX_PRODUCT_ERROR_TEXT_BYTES {
            return Err(ProductErrorProjectionError::TextTooLong);
        }
        Ok(rendered)
    }

    pub fn decode_text(encoded: &str) -> Result<Self, ProductErrorProjectionError> {
        if encoded.len() > MAX_PRODUCT_ERROR_TEXT_BYTES {
            return Err(ProductErrorProjectionError::TextTooLong);
        }
        let body = encoded
            .strip_suffix('\n')
            .ok_or(ProductErrorProjectionError::InvalidEncoding)?;
        let (first, second) = body
            .split_once('\n')
            .ok_or(ProductErrorProjectionError::InvalidEncoding)?;
        if second.contains('\n') {
            return Err(ProductErrorProjectionError::InvalidEncoding);
        }
        let (code, message) = first
            .strip_prefix("error[")
            .and_then(|line| line.split_once("]: "))
            .ok_or(ProductErrorProjectionError::InvalidEncoding)?;
        let action = second
            .strip_prefix("action: ")
            .ok_or(ProductErrorProjectionError::InvalidEncoding)?;
        if message.len() > MAX_PRODUCT_ERROR_MESSAGE_BYTES {
            return Err(ProductErrorProjectionError::MessageTooLong);
        }
        if action.len() > MAX_PRODUCT_ERROR_ACTION_BYTES {
            return Err(ProductErrorProjectionError::ActionTooLong);
        }
        let code = ProductErrorCode::from_str(code)
            .ok_or(ProductErrorProjectionError::InvalidEncoding)?;
        let canonical = Self::from_code(code);
        if message != canonical.message || action != canonical.action.as_str() {
            return Err(ProductErrorProjectionError::InvalidSemantics);
        }
        Ok(canonical)
    }

    const fn from_code(code: ProductErrorCode) -> Self {
        let (message, action) = product_semantics(code);
        Self {
            code,
            message,
            action,
        }
    }
}

fn protocol_domain_code(code: &str) -> Result<ProductErrorCode, ProductErrorProjectionError> {
    match code {
        GRAPH_INVALID | SCHEMA_VIOLATION => Ok(ProductErrorCode::InvalidInput),
        GENERATION_CONFLICT => Ok(ProductErrorCode::GenerationConflict),
        RUN_CONFLICT => Ok(ProductErrorCode::RunConflict),
        IDEMPOTENCY_REUSE => Ok(ProductErrorCode::IdempotencyConflict),
        INVALID_PHASE | NO_RETRYABLE_FRONTIER => Ok(ProductErrorCode::InvalidState),
        CANCELLED => Ok(ProductErrorCode::Cancelled),
        NOT_FOUND => Ok(ProductErrorCode::NotFound),
        GONE => Ok(ProductErrorCode::Gone),
        SLOW_CONSUMER => Ok(ProductErrorCode::SlowConsumer),
        UNSUPPORTED_PROTOCOL_VERSION => Ok(ProductErrorCode::UnsupportedCapability),
        INTERNAL_ERROR_CODE => Ok(ProductErrorCode::Internal),
        _ => Err(ProductErrorProjectionError::UnknownProtocolError),
    }
}

fn validate_fields(
    message: &str,
    action: ProductErrorAction,
) -> Result<(), ProductErrorProjectionError> {
    if message.len() > MAX_PRODUCT_ERROR_MESSAGE_BYTES {
        return Err(ProductErrorProjectionError::MessageTooLong);
    }
    if action.as_str().len() > MAX_PRODUCT_ERROR_ACTION_BYTES {
        return Err(ProductErrorProjectionError::ActionTooLong);
    }
    Ok(())
}

const fn product_semantics(code: ProductErrorCode) -> (&'static str, ProductErrorAction) {
    match code {
        ProductErrorCode::Unavailable => (
            "A required engine resource is unavailable.",
            ProductErrorAction::RetryLater,
        ),
        ProductErrorCode::ResourceExhausted => (
            "A required engine resource is exhausted.",
            ProductErrorAction::FreeResources,
        ),
        ProductErrorCode::Timeout => (
            "A native engine operation timed out.",
            ProductErrorAction::RetryLater,
        ),
        ProductErrorCode::PermissionDenied => (
            "A required engine permission was denied.",
            ProductErrorAction::GrantPermission,
        ),
        ProductErrorCode::AuthenticationRequired => (
            "Authentication is required for a native engine operation.",
            ProductErrorAction::Authenticate,
        ),
        ProductErrorCode::MalformedExternalData => (
            "External data did not satisfy the native engine contract.",
            ProductErrorAction::RepairInput,
        ),
        ProductErrorCode::IntegrityFailure => (
            "Native engine integrity verification failed.",
            ProductErrorAction::ContactSupport,
        ),
        ProductErrorCode::ProcessExited => (
            "A required native process exited unexpectedly.",
            ProductErrorAction::RestartOperation,
        ),
        ProductErrorCode::SessionLost => (
            "A lost native engine session terminated the affected execution.",
            ProductErrorAction::ContactSupport,
        ),
        ProductErrorCode::InvariantViolation => (
            "A native engine invariant was violated.",
            ProductErrorAction::ContactSupport,
        ),
        ProductErrorCode::InvalidInput => (
            "The request did not satisfy the product contract.",
            ProductErrorAction::RepairInput,
        ),
        ProductErrorCode::UnsupportedCapability => (
            "The requested capability is not supported.",
            ProductErrorAction::UseSupportedCapability,
        ),
        ProductErrorCode::GenerationConflict => (
            "The cluster generation changed before the request was applied.",
            ProductErrorAction::RefreshState,
        ),
        ProductErrorCode::RunConflict => (
            "The active run changed before the request was applied.",
            ProductErrorAction::RefreshState,
        ),
        ProductErrorCode::IdempotencyConflict => (
            "The idempotency key was already used for another request.",
            ProductErrorAction::UseNewIdempotencyKey,
        ),
        ProductErrorCode::InvalidState => (
            "The requested operation is not valid in the current state.",
            ProductErrorAction::RefreshState,
        ),
        ProductErrorCode::Cancelled => (
            "The requested operation was cancelled.",
            ProductErrorAction::RetryLater,
        ),
        ProductErrorCode::NotFound => (
            "The requested product resource was not found.",
            ProductErrorAction::VerifyReference,
        ),
        ProductErrorCode::Gone => (
            "The requested product resource is no longer available.",
            ProductErrorAction::StartNewOperation,
        ),
        ProductErrorCode::SlowConsumer => (
            "The control consumer exceeded its bounded delivery capacity.",
            ProductErrorAction::RetryLater,
        ),
        ProductErrorCode::Internal => (
            "The native product could not complete the operation.",
            ProductErrorAction::ContactSupport,
        ),
    }
}
