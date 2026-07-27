use std::fmt;
use std::num::NonZeroU64;

use serde::{Deserialize, Deserializer, Serialize};

use crate::fault::EngineFault;

pub const MAX_EXECUTION_INLINE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_EXECUTION_CANDIDATE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_EXECUTION_SERIALIZED_BYTES: usize = MAX_EXECUTION_INLINE_BYTES + 65_536;
pub const MAX_DRIVER_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

crate::provider_value::contract_error_type!(ExecutionContractError);
crate::provider_value::bounded_text_type!(
    RecoveryRef,
    256,
    ExecutionContractError,
    "recovery reference"
);
crate::provider_value::bounded_text_type!(
    WorkerBindingId,
    128,
    ExecutionContractError,
    "worker binding id"
);
crate::provider_value::bounded_text_type!(
    DriverFamilyId,
    64,
    ExecutionContractError,
    "driver family id"
);
crate::provider_value::bounded_text_type!(
    ProviderLaneId,
    64,
    ExecutionContractError,
    "provider lane id"
);
crate::provider_value::bounded_text_type!(
    BuiltinWorkerId,
    128,
    ExecutionContractError,
    "builtin worker id"
);
crate::provider_value::bounded_bytes_type!(
    InlineExecutionInput,
    MAX_EXECUTION_INLINE_BYTES,
    ExecutionContractError,
    "inline execution input"
);
crate::provider_value::bounded_bytes_type!(
    ExecutionCandidate,
    MAX_EXECUTION_CANDIDATE_BYTES,
    ExecutionContractError,
    "execution candidate"
);
crate::provider_value::digest_type!(CatalogDigest, ExecutionContractError, "catalog digest");
crate::provider_value::digest_type!(ProfileDigest, ExecutionContractError, "profile digest");
crate::provider_value::digest_type!(RegistryDigest, ExecutionContractError, "registry digest");

pub(crate) fn contract_error(
    field: &'static str,
    error: impl std::fmt::Display,
) -> ExecutionContractError {
    ExecutionContractError::new(field, error)
}

pub(crate) fn checked_value<T: serde::Serialize>(value: T) -> Result<T, ExecutionContractError> {
    ExecutionContractError::checked(value)
}

pub(crate) fn validate_serialized_with_limit<T: Serialize + ?Sized>(
    value: &T,
    max: usize,
    field: &'static str,
) -> Result<(), ExecutionContractError> {
    let actual = serde_json::to_vec(value)
        .map_err(|error| contract_error(field, error))?
        .len();
    if actual > max {
        return Err(contract_error(
            field,
            format!("serialized value is {actual} bytes; maximum is {max}"),
        ));
    }
    Ok(())
}

pub(crate) fn decode_fault_value(
    value: serde_json::Value,
    field: &'static str,
) -> Result<EngineFault, ExecutionContractError> {
    let encoded = serde_json::to_vec(&value).map_err(|error| contract_error(field, error))?;
    EngineFault::decode_json(&encoded).map_err(|error| contract_error(field, error))
}

pub(crate) fn decode_optional_fault_value(
    value: Option<serde_json::Value>,
    field: &'static str,
) -> Result<Option<EngineFault>, ExecutionContractError> {
    value
        .map(|fault| decode_fault_value(fault, field))
        .transpose()
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct DispatchFence(NonZeroU64);

impl DispatchFence {
    pub fn new(value: u64) -> Result<Self, ExecutionContractError> {
        let value = NonZeroU64::new(value)
            .ok_or_else(|| contract_error("dispatch fence", "must be greater than zero"))?;
        if value.get() > i64::MAX as u64 {
            return Err(contract_error(
                "dispatch fence",
                "must be less than or equal to i64::MAX",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

impl<'de> Deserialize<'de> for DispatchFence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for DispatchFence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.get())
    }
}
