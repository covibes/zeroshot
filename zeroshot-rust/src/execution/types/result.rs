use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize};

use super::common::{contract_error, decode_fault_value, validate_serialized_with_limit};
use super::{ExecutionCandidate, ExecutionContractError, MAX_EXECUTION_SERIALIZED_BYTES};
use crate::fault::EngineFault;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageObservation {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub vendor_cost_usd: Option<Decimal>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageObservationSpec {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub vendor_cost_usd: Option<Decimal>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedUsageObservation {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_creation_tokens: Option<u64>,
    vendor_cost_usd: Option<Decimal>,
}

impl UsageObservation {
    pub fn new(spec: UsageObservationSpec) -> Result<Self, ExecutionContractError> {
        if spec
            .vendor_cost_usd
            .is_some_and(|value| value.is_sign_negative())
        {
            return Err(contract_error(
                "vendor cost usd",
                "must be greater than or equal to zero",
            ));
        }
        let value = Self {
            input_tokens: spec.input_tokens,
            output_tokens: spec.output_tokens,
            cache_read_tokens: spec.cache_read_tokens,
            cache_creation_tokens: spec.cache_creation_tokens,
            vendor_cost_usd: spec.vendor_cost_usd,
        };
        validate_serialized_with_limit(&value, 4096, "usage observation")?;
        Ok(value)
    }
}

impl<'de> Deserialize<'de> for UsageObservation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = EncodedUsageObservation::deserialize(deserializer)?;
        Self::new(encoded.into()).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CompletionEvidence {
    Success,
    Fault(EngineFault),
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum EncodedCompletionEvidence {
    Success,
    Fault(serde_json::Value),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionResult {
    candidate: ExecutionCandidate,
    evidence: CompletionEvidence,
    usage: Option<UsageObservation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedExecutionResult {
    candidate: ExecutionCandidate,
    evidence: CompletionEvidence,
    usage: Option<UsageObservation>,
}

impl ExecutionResult {
    pub fn new(
        candidate: ExecutionCandidate,
        evidence: CompletionEvidence,
        usage: Option<UsageObservation>,
    ) -> Result<Self, ExecutionContractError> {
        let value = Self {
            candidate,
            evidence,
            usage,
        };
        validate_serialized_with_limit(&value, MAX_EXECUTION_SERIALIZED_BYTES, "execution result")?;
        Ok(value)
    }

    #[must_use]
    pub fn candidate(&self) -> &ExecutionCandidate {
        &self.candidate
    }

    #[must_use]
    pub fn evidence(&self) -> &CompletionEvidence {
        &self.evidence
    }

    #[must_use]
    pub fn usage(&self) -> Option<&UsageObservation> {
        self.usage.as_ref()
    }
}

impl<'de> Deserialize<'de> for ExecutionResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = EncodedExecutionResult::deserialize(deserializer)?;
        Self::new(encoded.candidate, encoded.evidence, encoded.usage)
            .map_err(serde::de::Error::custom)
    }
}

impl<'de> Deserialize<'de> for CompletionEvidence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match EncodedCompletionEvidence::deserialize(deserializer)? {
            EncodedCompletionEvidence::Success => Ok(Self::Success),
            EncodedCompletionEvidence::Fault(value) => {
                decode_fault_value(value, "completion evidence fault")
                    .map(Self::Fault)
                    .map_err(serde::de::Error::custom)
            }
        }
    }
}

impl From<EncodedUsageObservation> for UsageObservationSpec {
    fn from(value: EncodedUsageObservation) -> Self {
        Self {
            input_tokens: value.input_tokens,
            output_tokens: value.output_tokens,
            cache_read_tokens: value.cache_read_tokens,
            cache_creation_tokens: value.cache_creation_tokens,
            vendor_cost_usd: value.vendor_cost_usd,
        }
    }
}
