use std::collections::BTreeMap;
use std::fmt;

use openengine_cluster_protocol::{EnumLabel, FieldName, NonEmptyEnumSet, PayloadType, WorkerOutcome};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::NodeRunnerError;

const MAX_RESPONSE_ERROR_BYTES: usize = 8 * 1024;

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
    pub(crate) fn parse_agent_response(
        &self,
        response: &str,
    ) -> Result<WorkerOutcome, NodeResponseError> {
        let value = serde_json::from_str(response).map_err(|error| {
            NodeResponseError::new(format!("final response is not valid JSON: {error}"))
        })?;
        let outcome = match self {
            Self::Worker { .. } => WorkerOutcome::Verified {
                output: value,
                artifacts: Vec::new(),
            },
            Self::Verifier { .. } => {
                let verifier: VerifierResponse = serde_json::from_value(value).map_err(|error| {
                    NodeResponseError::new(format!(
                        "verifier response must contain exactly output, signals, and diagnostic: {error}"
                    ))
                })?;
                WorkerOutcome::Verifier {
                    output: verifier.output,
                    signals: verifier.signals,
                    diagnostic: verifier.diagnostic,
                    artifacts: Vec::new(),
                }
            }
        };
        self.validate_agent_outcome(&outcome)?;
        Ok(outcome)
    }

    pub(super) fn validate_outcome(&self, outcome: &WorkerOutcome) -> Result<(), NodeRunnerError> {
        validate_native_v2_outcome(outcome)?;
        if matches!(outcome, WorkerOutcome::Error { .. }) {
            return Ok(());
        }
        self.validate_agent_outcome(outcome)
            .map_err(|_| NodeRunnerError::Driver)
    }

    fn validate_agent_outcome(&self, outcome: &WorkerOutcome) -> Result<(), NodeResponseError> {
        match (self, outcome) {
            (Self::Worker { output: expected }, WorkerOutcome::Verified { output, .. }) => expected
                .validate_value(output)
                .map_err(|error| NodeResponseError::new(format!("output {error}"))),
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
                    .map_err(|error| NodeResponseError::new(format!("output {error}")))?;
                expected_diagnostic
                    .validate_value(diagnostic)
                    .map_err(|error| NodeResponseError::new(format!("diagnostic {error}")))?;
                validate_signals(expected_signals, signals)
            }
            _ => Err(NodeResponseError::new(
                "final response does not match the node role".to_owned(),
            )),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NodeResponseError(Box<str>);

impl NodeResponseError {
    fn new(mut message: String) -> Self {
        if message.len() > MAX_RESPONSE_ERROR_BYTES {
            let mut end = MAX_RESPONSE_ERROR_BYTES.saturating_sub(3);
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
            message.push_str("...");
        }
        Self(message.into_boxed_str())
    }
}

pub(crate) enum AgentResponse {
    Complete(WorkerOutcome),
    Correction(String),
}

pub(crate) fn resolve_agent_response(
    contract: &NodeResponseContract,
    response: &str,
) -> Result<AgentResponse, NodeRunnerError> {
    Ok(match contract.parse_agent_response(response) {
        Ok(outcome) => AgentResponse::Complete(outcome),
        Err(error) => AgentResponse::Correction(render_agent_correction(contract, &error)?),
    })
}

impl fmt::Display for NodeResponseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifierResponse {
    output: Value,
    signals: BTreeMap<FieldName, EnumLabel>,
    diagnostic: Value,
}

fn validate_signals(
    expected: &BTreeMap<FieldName, NonEmptyEnumSet>,
    actual: &BTreeMap<FieldName, EnumLabel>,
) -> Result<(), NodeResponseError> {
    for name in expected.keys() {
        if !actual.contains_key(name) {
            return Err(NodeResponseError::new(format!(
                "signals is missing required field {}",
                name.as_str()
            )));
        }
    }
    for (name, label) in actual {
        let Some(labels) = expected.get(name) else {
            return Err(NodeResponseError::new(format!(
                "signals contains undeclared field {}",
                name.as_str()
            )));
        };
        if !labels.values().iter().any(|allowed| allowed == label) {
            return Err(NodeResponseError::new(format!(
                "signals.{} contains undeclared label {}",
                name.as_str(),
                label.as_str()
            )));
        }
    }
    Ok(())
}

fn validate_native_v2_outcome(outcome: &WorkerOutcome) -> Result<(), NodeRunnerError> {
    outcome.validate().map_err(|_| NodeRunnerError::Driver)?;
    match outcome {
        WorkerOutcome::Verified { artifacts, .. } | WorkerOutcome::Verifier { artifacts, .. }
            if !artifacts.is_empty() =>
        {
            Err(NodeRunnerError::Driver)
        }
        WorkerOutcome::Verified { .. }
        | WorkerOutcome::Verifier { .. }
        | WorkerOutcome::Error { .. } => Ok(()),
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
         The response contract describes the required type; never return the contract itself. \
         Return only JSON with no Markdown or commentary. For a worker, return the output value \
         itself; an output contract of {{\"kind\":\"null\"}} requires the literal null. For a \
         verifier, return exactly an object with output, signals, and diagnostic; every signal \
         must use one of its declared labels."
    ))
}

/// Renders one mechanical correction turn in the already-open provider session.
pub(crate) fn render_agent_correction(
    response: &NodeResponseContract,
    error: &NodeResponseError,
) -> Result<String, NodeRunnerError> {
    let response = serde_json::to_string(response).map_err(|_| NodeRunnerError::Driver)?;
    Ok(format!(
        "Your previous final response was rejected mechanically and was not passed to the graph.\n\
         Validation error:\n{error}\n\
         Response contract:\n{response}\n\
         Return a corrected final response only. It must be valid JSON with no Markdown or commentary."
    ))
}

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::assertions::AssertValue;
    use serde_json::json;

    use super::*;

    fn worker_contract() -> NodeResponseContract {
        NodeResponseContract::Worker {
            output: serde_json::from_value(json!({
                "kind": "record",
                "fields": {
                    "answer": { "type": { "kind": "integer" }, "required": true }
                }
            }))
            .assert_value(),
        }
    }

    #[test]
    fn agent_response_reports_mechanical_json_and_payload_errors() {
        let contract = worker_contract();
        let malformed = contract
            .parse_agent_response("not json")
            .err()
            .assert_value();
        assert!(
            malformed
                .to_string()
                .starts_with("final response is not valid JSON:")
        );

        assert_eq!(
            contract.parse_agent_response(r#"{"answer":"wrong"}"#),
            Err(NodeResponseError::new(
                "output $.answer must be a integer".to_owned()
            ))
        );
        assert!(matches!(
            contract.parse_agent_response(r#"{"answer":42}"#).assert_value(),
            WorkerOutcome::Verified { output, .. } if output == json!({"answer": 42})
        ));
    }
}
