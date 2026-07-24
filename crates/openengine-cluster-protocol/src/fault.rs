//! Closed, bounded, backend-neutral fault projection. `BackendFault` is the generic backend-port
//! mapping contract: any backend builds one from its own bounded/closed data and gets a
//! runtime-validated, byte-free wire type with no field capable of carrying a raw message, path,
//! URL, header, command, provider code, credential, or session ID. Native `EngineFault` mapping is
//! out of scope here (tracked separately); this module never imports engine-internal types.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use crate::value::BoundedString256;
use crate::wire::impl_validate_gated_wire;

/// The maximum number of safe source frames a `BackendFault` may carry.
pub const MAX_FAULT_SOURCE_FRAMES: usize = 8;

/// The maximum byte length of a `BackendFault`'s final JSON encoding. Deliberately below the
/// worst-case sum of every field's own maximum, so this is a real binding constraint rather than
/// dead code: a fault packing `MAX_FAULT_SOURCE_FRAMES` frames each near their own 256-character
/// maximum, alongside maximal `eventId`/`executionRef`/`summary` values, exceeds this bound and
/// must be rejected even though every individual field is independently within its own limit.
pub const MAX_FAULT_ENCODED_BYTES: usize = 2048;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultCode {
    Unavailable,
    ResourceExhausted,
    DeadlineExceeded,
    PermissionDenied,
    FailedPrecondition,
    NotFound,
    Aborted,
    Internal,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultConsequence {
    TurnFailed,
    RunFailed,
    RunDegraded,
    NoObservableEffect,
}

/// Descriptive only: no `BackendFault` and no `fault` event ever performs or authorizes a retry.
/// Event ordering and emission never themselves change terminal semantics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultRetryDisposition {
    Retryable,
    RetryableAfterBackoff,
    NotRetryable,
    Indeterminate,
}

/// Descriptive only, like [`FaultRetryDisposition`]: naming `Retry` never itself retries or
/// authorizes a retry.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultAction {
    None,
    Retry,
    Wait,
    Escalate,
    Abort,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultSeverity {
    Info,
    Warning,
    Error,
    Critical,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FaultSourceFrame {
    pub component: BoundedString256,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum FaultProjectionError {
    #[error("fault source must contain at most {MAX_FAULT_SOURCE_FRAMES} frames")]
    TooManySourceFrames,
    #[error("fault action=retry is inconsistent with retry=not_retryable")]
    InconsistentRetryAction,
    #[error("fault encoded JSON exceeds {MAX_FAULT_ENCODED_BYTES} bytes")]
    EncodedTooLarge,
}

/// A closed, bounded, backend-neutral projection of a unary backend fault. Correlates to a run via
/// the enclosing `EventNotification.run_id` and, optionally, to a single execution via the opaque
/// `execution_ref` -- never a raw ledger ID. Every string/collection field and the final encoded
/// JSON are bounded; both `Serialize` and `Deserialize` run [`BackendFault::validate`], so an
/// invalid value can never be produced or accepted on the wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendFault {
    pub event_id: BoundedString256,
    pub execution_ref: Option<BoundedString256>,
    pub code: FaultCode,
    pub consequence: FaultConsequence,
    pub retry: FaultRetryDisposition,
    pub action: FaultAction,
    pub severity: FaultSeverity,
    pub summary: BoundedString256,
    pub source: Vec<FaultSourceFrame>,
}

impl BackendFault {
    pub fn validate(&self) -> Result<(), FaultProjectionError> {
        if self.source.len() > MAX_FAULT_SOURCE_FRAMES {
            return Err(FaultProjectionError::TooManySourceFrames);
        }
        if self.action == FaultAction::Retry && self.retry == FaultRetryDisposition::NotRetryable {
            return Err(FaultProjectionError::InconsistentRetryAction);
        }
        let encoded_len = serde_json::to_vec(&BackendFaultRef::from(self))
            .expect("BackendFaultRef fields serialize infallibly")
            .len();
        if encoded_len > MAX_FAULT_ENCODED_BYTES {
            return Err(FaultProjectionError::EncodedTooLarge);
        }
        Ok(())
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BackendFaultWire {
    event_id: BoundedString256,
    #[serde(default)]
    execution_ref: Option<BoundedString256>,
    code: FaultCode,
    consequence: FaultConsequence,
    retry: FaultRetryDisposition,
    action: FaultAction,
    severity: FaultSeverity,
    summary: BoundedString256,
    #[schemars(length(max = 8))]
    source: Vec<FaultSourceFrame>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendFaultRef<'a> {
    event_id: &'a BoundedString256,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_ref: Option<&'a BoundedString256>,
    code: FaultCode,
    consequence: FaultConsequence,
    retry: FaultRetryDisposition,
    action: FaultAction,
    severity: FaultSeverity,
    summary: &'a BoundedString256,
    source: &'a [FaultSourceFrame],
}

impl From<BackendFaultWire> for BackendFault {
    fn from(wire: BackendFaultWire) -> Self {
        Self {
            event_id: wire.event_id,
            execution_ref: wire.execution_ref,
            code: wire.code,
            consequence: wire.consequence,
            retry: wire.retry,
            action: wire.action,
            severity: wire.severity,
            summary: wire.summary,
            source: wire.source,
        }
    }
}

impl<'a> From<&'a BackendFault> for BackendFaultRef<'a> {
    fn from(fault: &'a BackendFault) -> Self {
        Self {
            event_id: &fault.event_id,
            execution_ref: fault.execution_ref.as_ref(),
            code: fault.code,
            consequence: fault.consequence,
            retry: fault.retry,
            action: fault.action,
            severity: fault.severity,
            summary: &fault.summary,
            source: &fault.source,
        }
    }
}

impl_validate_gated_wire!(BackendFault, BackendFaultWire, BackendFaultRef);

impl JsonSchema for BackendFault {
    fn schema_name() -> Cow<'static, str> {
        "BackendFault".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        generator.subschema_for::<BackendFaultWire>()
    }
}
