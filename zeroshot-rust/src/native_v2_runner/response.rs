use std::collections::BTreeMap;

use openengine_cluster_protocol::{FieldName, NonEmptyEnumSet, PayloadType, WorkerOutcome};
use serde::Serialize;
use serde_json::Value;

use super::NodeRunnerError;

/// Ephemeral response contract derived from the admitted graph leaf.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeResponseContract {
    Worker {
        output: PayloadType,
    },
    Verifier {
        output: PayloadType,
        signals: BTreeMap<FieldName, NonEmptyEnumSet>,
        diagnostic: PayloadType,
    },
}

impl NodeResponseContract {
    pub(super) fn validate_outcome(&self, outcome: &WorkerOutcome) -> Result<(), NodeRunnerError> {
        outcome.validate().map_err(|_| NodeRunnerError::Driver)?;
        match (self, outcome) {
            (_, WorkerOutcome::Error { .. }) => Ok(()),
            (Self::Worker { output: expected }, WorkerOutcome::Verified { output, .. }) => expected
                .validate_value(output)
                .map_err(|_| NodeRunnerError::Driver),
            (
                Self::Verifier {
                    output: expected_output,
                    signals: expected_signals,
                    diagnostic: expected_diagnostic,
                },
                WorkerOutcome::Verifier {
                    output,
                    signals,
                    diagnostic,
                    ..
                },
            ) => {
                expected_output
                    .validate_value(output)
                    .map_err(|_| NodeRunnerError::Driver)?;
                expected_diagnostic
                    .validate_value(diagnostic)
                    .map_err(|_| NodeRunnerError::Driver)?;
                if signals.len() != expected_signals.len()
                    || signals.iter().any(|(name, label)| {
                        expected_signals.get(name).is_none_or(|labels| {
                            !labels.values().iter().any(|allowed| allowed == label)
                        })
                    })
                {
                    return Err(NodeRunnerError::Driver);
                }
                Ok(())
            }
            _ => Err(NodeRunnerError::Driver),
        }
    }
}

/// Renders the provider-neutral node turn contract used by every agent harness.
pub fn render_agent_prompt(
    input: &Value,
    response: &NodeResponseContract,
) -> Result<String, NodeRunnerError> {
    let input = serde_json::to_string(input).map_err(|_| NodeRunnerError::Driver)?;
    let response = serde_json::to_string(response).map_err(|_| NodeRunnerError::Driver)?;
    Ok(format!(
        "Execute this graph node using the shared workspace.\n\
         Input JSON:\n{input}\n\
         Response contract:\n{response}\n\
         Return only JSON with no Markdown or commentary. For a worker, return the output value \
         itself. For a verifier, return exactly an object with output, signals, and diagnostic; \
         every signal must use one of its declared labels."
    ))
}
