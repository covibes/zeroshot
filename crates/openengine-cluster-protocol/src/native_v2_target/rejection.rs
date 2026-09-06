use serde::{Deserialize, Serialize};

use crate::NativeV2RunValueError;

pub const MAX_TARGET_RUN_REJECTION_MESSAGE_BYTES: usize = 1_024;

/// Public, secret-free reason that a target rejected a submitted run before admission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TargetRunRejection {
    message: String,
}

impl TargetRunRejection {
    pub fn new(message: impl Into<String>) -> Result<Self, NativeV2RunValueError> {
        let message = message.into();
        if message.is_empty()
            || message.len() > MAX_TARGET_RUN_REJECTION_MESSAGE_BYTES
            || message.chars().any(char::is_control)
        {
            return Err(NativeV2RunValueError(
                "target run rejection message must be 1..=1024 non-control UTF-8 bytes",
            ));
        }
        Ok(Self { message })
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl<'de> Deserialize<'de> for TargetRunRejection {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Wire {
            message: String,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.message).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::assertions::AssertValue;

    use super::*;

    #[test]
    fn target_run_rejection_is_bounded_and_closed() {
        let rejection = TargetRunRejection::new("required input binding is missing").assert_value();
        let encoded = serde_json::to_value(&rejection).assert_value();
        assert_eq!(
            encoded,
            serde_json::json!({"message": "required input binding is missing"})
        );
        assert!(TargetRunRejection::new("x".repeat(1_025)).is_err());
        assert!(
            serde_json::from_value::<TargetRunRejection>(
                serde_json::json!({"message": "rejected", "extra": true})
            )
            .is_err()
        );
    }
}
