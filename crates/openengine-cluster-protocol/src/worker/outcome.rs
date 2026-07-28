//! Closed, byte-free normalized worker outcomes.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::WorkerContractError;
use crate::wire::impl_validate_gated_wire;
use crate::{ArtifactRef, EnumLabel, FieldName, WorkerErrorCode};

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerFailureReason {
    DeclaredFailure,
    PolicyDenied,
    InteractiveInputRequired,
    AuthenticationRequired,
    MalformedResult,
}

#[derive(Clone, Debug, PartialEq)]
pub enum WorkerOutcome {
    Verified {
        output: Value,
        artifacts: Vec<ArtifactRef>,
    },
    Verifier {
        output: Value,
        signals: BTreeMap<FieldName, EnumLabel>,
        diagnostic: Value,
        artifacts: Vec<ArtifactRef>,
    },
    Error {
        code: WorkerErrorCode,
        reason: WorkerFailureReason,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, tag = "status", rename_all = "snake_case")]
enum WorkerOutcomeWire {
    Verified {
        output: Value,
        artifacts: Vec<ArtifactRef>,
    },
    Verifier {
        output: Value,
        #[schemars(
            schema_with = "crate::value::identifier_keyed_map_schema::<FieldName, EnumLabel>"
        )]
        signals: BTreeMap<FieldName, EnumLabel>,
        diagnostic: Value,
        artifacts: Vec<ArtifactRef>,
    },
    Error {
        code: WorkerErrorCode,
        reason: WorkerFailureReason,
    },
}

#[derive(Serialize)]
#[serde(deny_unknown_fields, tag = "status", rename_all = "snake_case")]
enum WorkerOutcomeRef<'a> {
    Verified {
        output: &'a Value,
        artifacts: &'a [ArtifactRef],
    },
    Verifier {
        output: &'a Value,
        signals: &'a BTreeMap<FieldName, EnumLabel>,
        diagnostic: &'a Value,
        artifacts: &'a [ArtifactRef],
    },
    Error {
        code: WorkerErrorCode,
        reason: WorkerFailureReason,
    },
}

impl WorkerOutcome {
    pub fn validate(&self) -> Result<(), WorkerContractError> {
        match self {
            Self::Error { code, reason } if !valid_failure_pair(*code, *reason) => {
                Err(WorkerContractError::InvalidFailurePair)
            }
            _ => Ok(()),
        }
    }

    #[must_use]
    pub const fn declared_failure(code: WorkerErrorCode) -> Self {
        Self::Error {
            code,
            reason: WorkerFailureReason::DeclaredFailure,
        }
    }

    #[must_use]
    pub const fn policy_refusal() -> Self {
        Self::Error {
            code: WorkerErrorCode::Refusal,
            reason: WorkerFailureReason::PolicyDenied,
        }
    }

    #[must_use]
    pub const fn interactive_refusal() -> Self {
        Self::Error {
            code: WorkerErrorCode::Refusal,
            reason: WorkerFailureReason::InteractiveInputRequired,
        }
    }

    #[must_use]
    pub const fn authentication_refusal() -> Self {
        Self::Error {
            code: WorkerErrorCode::Refusal,
            reason: WorkerFailureReason::AuthenticationRequired,
        }
    }

    #[must_use]
    pub const fn malformed() -> Self {
        Self::Error {
            code: WorkerErrorCode::Malformed,
            reason: WorkerFailureReason::MalformedResult,
        }
    }

    #[must_use]
    pub const fn error_code(&self) -> Option<WorkerErrorCode> {
        match self {
            Self::Error { code, .. } => Some(*code),
            Self::Verified { .. } | Self::Verifier { .. } => None,
        }
    }
}

const fn valid_failure_pair(code: WorkerErrorCode, reason: WorkerFailureReason) -> bool {
    matches!(reason, WorkerFailureReason::DeclaredFailure)
        || matches!(
            (code, reason),
            (
                WorkerErrorCode::Refusal,
                WorkerFailureReason::PolicyDenied
                    | WorkerFailureReason::InteractiveInputRequired
                    | WorkerFailureReason::AuthenticationRequired
            ) | (
                WorkerErrorCode::Malformed,
                WorkerFailureReason::MalformedResult
            )
        )
}

impl From<WorkerOutcomeWire> for WorkerOutcome {
    fn from(wire: WorkerOutcomeWire) -> Self {
        match wire {
            WorkerOutcomeWire::Verified { output, artifacts } => {
                Self::Verified { output, artifacts }
            }
            WorkerOutcomeWire::Verifier {
                output,
                signals,
                diagnostic,
                artifacts,
            } => Self::Verifier {
                output,
                signals,
                diagnostic,
                artifacts,
            },
            WorkerOutcomeWire::Error { code, reason } => Self::Error { code, reason },
        }
    }
}

impl<'a> From<&'a WorkerOutcome> for WorkerOutcomeRef<'a> {
    fn from(outcome: &'a WorkerOutcome) -> Self {
        match outcome {
            WorkerOutcome::Verified { output, artifacts } => Self::Verified { output, artifacts },
            WorkerOutcome::Verifier {
                output,
                signals,
                diagnostic,
                artifacts,
            } => Self::Verifier {
                output,
                signals,
                diagnostic,
                artifacts,
            },
            WorkerOutcome::Error { code, reason } => Self::Error {
                code: *code,
                reason: *reason,
            },
        }
    }
}

impl_validate_gated_wire!(WorkerOutcome, WorkerOutcomeWire, WorkerOutcomeRef);

impl JsonSchema for WorkerOutcome {
    fn schema_name() -> Cow<'static, str> {
        "WorkerOutcome".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let base = generator.subschema_for::<WorkerOutcomeWire>();
        json_schema!({
            "allOf": [
                base,
                {
                    "if": {
                        "required": ["status"],
                        "properties": { "status": { "const": "error" } }
                    },
                    "then": {
                        "oneOf": [
                            {
                                "required": ["reason"],
                                "properties": { "reason": { "const": "declared_failure" } }
                            },
                            {
                                "required": ["code", "reason"],
                                "properties": {
                                    "code": { "const": "refusal" },
                                    "reason": {
                                        "enum": [
                                            "policy_denied",
                                            "interactive_input_required",
                                            "authentication_required"
                                        ]
                                    }
                                }
                            },
                            {
                                "required": ["code", "reason"],
                                "properties": {
                                    "code": { "const": "malformed" },
                                    "reason": { "const": "malformed_result" }
                                }
                            }
                        ]
                    }
                }
            ]
        })
    }
}
