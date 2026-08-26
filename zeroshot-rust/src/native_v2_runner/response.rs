use std::collections::BTreeMap;
use std::fmt;

use openengine_cluster_protocol::{
    EnumLabel, FieldName, NodeInstructions, NonEmptyEnumSet, PayloadType, WorkerOutcome,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{DriverControl, LiveOutput, LiveOutputStream, NodeRunnerError};

const MAX_RESPONSE_ERROR_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_CORRECTIONS: usize = 2;

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderSchemaDialect {
    Standard,
    OpenAiStrict,
}

impl NodeResponseContract {
    pub(crate) fn provider_schema(&self, dialect: ProviderSchemaDialect) -> Value {
        closed_object_schema(
            BTreeMap::from([("response".to_owned(), self.response_schema(dialect))]),
            vec!["response".to_owned()],
        )
    }

    fn response_schema(&self, dialect: ProviderSchemaDialect) -> Value {
        match self {
            Self::Worker { output } => payload_schema(output, dialect),
            Self::Verifier {
                output,
                signals,
                diagnostic,
            } => {
                let signal_properties = signals
                    .iter()
                    .map(|(name, labels)| {
                        (
                            name.as_str().to_owned(),
                            enum_schema(labels.values().iter().map(EnumLabel::as_str)),
                        )
                    })
                    .collect::<BTreeMap<_, _>>();
                closed_object_schema(
                    BTreeMap::from([
                        ("diagnostic".to_owned(), payload_schema(diagnostic, dialect)),
                        ("output".to_owned(), payload_schema(output, dialect)),
                        (
                            "signals".to_owned(),
                            closed_object_schema(
                                signal_properties,
                                signals
                                    .keys()
                                    .map(|name| name.as_str().to_owned())
                                    .collect(),
                            ),
                        ),
                    ]),
                    vec![
                        "diagnostic".to_owned(),
                        "output".to_owned(),
                        "signals".to_owned(),
                    ],
                )
            }
        }
    }

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

pub(crate) struct AgentResponseState {
    prompt: String,
    corrections: usize,
}

impl AgentResponseState {
    pub(crate) fn new(prompt: String) -> Self {
        Self {
            prompt,
            corrections: 0,
        }
    }

    pub(crate) fn prompt(&self) -> &str {
        &self.prompt
    }

    pub(crate) fn replace_prompt(&mut self, prompt: String) {
        self.prompt = prompt;
    }

    pub(crate) fn accept(
        &mut self,
        provider: &str,
        control: &DriverControl,
        response: AgentResponse,
    ) -> Result<Option<WorkerOutcome>, NodeRunnerError> {
        match response {
            AgentResponse::Complete(outcome) => Ok(Some(outcome)),
            AgentResponse::Correction(_) if self.corrections == MAX_OUTPUT_CORRECTIONS => {
                control.emit(LiveOutput::new(
                    LiveOutputStream::System,
                    format!("{provider} final output remained malformed after two corrections"),
                )?)?;
                Ok(Some(WorkerOutcome::malformed()))
            }
            AgentResponse::Correction(correction) => {
                self.corrections += 1;
                self.prompt = correction;
                Ok(None)
            }
        }
    }
}

pub(crate) fn resolve_agent_response(
    contract: &NodeResponseContract,
    response: &str,
) -> Result<AgentResponse, NodeRunnerError> {
    let semantic_response = parse_provider_envelope(response);
    let parsed = match semantic_response {
        Ok(response) => contract.parse_agent_response(&response),
        Err(error) => Err(error),
    };
    Ok(match parsed {
        Ok(outcome) => AgentResponse::Complete(outcome),
        Err(error) => AgentResponse::Correction(render_agent_correction(contract, &error)?),
    })
}

fn parse_provider_envelope(response: &str) -> Result<String, NodeResponseError> {
    let envelope: ProviderResponseEnvelope = serde_json::from_str(response).map_err(|error| {
        NodeResponseError::new(format!(
            "provider response must be exactly an object containing response: {error}"
        ))
    })?;
    serde_json::to_string(&envelope.response)
        .map_err(|_| NodeResponseError::new("provider response could not be encoded".to_owned()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderResponseEnvelope {
    response: Value,
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

fn payload_schema(payload: &PayloadType, dialect: ProviderSchemaDialect) -> Value {
    match payload {
        PayloadType::Null => json!({ "type": "null" }),
        PayloadType::Boolean => json!({ "type": "boolean" }),
        PayloadType::Integer => json!({ "type": "integer" }),
        PayloadType::Number => json!({ "type": "number" }),
        PayloadType::String => json!({ "type": "string" }),
        PayloadType::Record { fields } => {
            let properties = fields
                .iter()
                .map(|(name, field)| {
                    (
                        name.as_str().to_owned(),
                        payload_schema(&field.value_type, dialect),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            let required = fields
                .iter()
                .filter(|(_, field)| {
                    field.required || dialect == ProviderSchemaDialect::OpenAiStrict
                })
                .map(|(name, _)| name.as_str().to_owned())
                .collect();
            closed_object_schema(properties, required)
        }
        PayloadType::Array { items } => {
            json!({ "type": "array", "items": payload_schema(items, dialect) })
        }
        PayloadType::Enum { values } => enum_schema(values.values().iter().map(EnumLabel::as_str)),
    }
}

fn enum_schema<'a>(values: impl Iterator<Item = &'a str>) -> Value {
    json!({ "type": "string", "enum": values.collect::<Vec<_>>() })
}

fn closed_object_schema(properties: BTreeMap<String, Value>, required: Vec<String>) -> Value {
    let properties = properties.into_iter().collect::<Map<_, _>>();
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

/// Renders the provider-neutral node turn contract used by every agent harness.
pub fn render_agent_prompt(
    instructions: &NodeInstructions,
    input: &Value,
    response: &NodeResponseContract,
) -> Result<String, NodeRunnerError> {
    let instructions = instructions.as_str();
    let input = serde_json::to_string(input).map_err(|_| NodeRunnerError::Driver)?;
    let response = serde_json::to_string(response).map_err(|_| NodeRunnerError::Driver)?;
    Ok(format!(
        "Execute this graph node using the shared workspace.\n\
         Authored instructions:\n{instructions}\n\
         Input JSON:\n{input}\n\
         Runtime-owned response contract:\n{response}\n\
         The response contract describes the required type; never return the contract itself. \
         Return only JSON with no Markdown or commentary. The provider response must be exactly \
         an object with one field named response. For a worker, response contains the output \
         value; an output contract of {{\"kind\":\"null\"}} requires the literal null inside \
         {{\"response\":null}}. For a verifier, response contains exactly an object with output, \
         signals, and diagnostic; every signal must use one of its declared labels."
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
         Return a corrected provider response only: exactly an object with one field named \
         response. It must be valid JSON with no Markdown or commentary."
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

    #[test]
    fn provider_schema_closes_the_transport_and_preserves_optional_fields() {
        let contract = NodeResponseContract::Worker {
            output: serde_json::from_value(json!({
                "kind": "record",
                "fields": {
                    "answer": { "type": { "kind": "integer" }, "required": true },
                    "notes": {
                        "type": {
                            "kind": "array",
                            "items": { "kind": "enum", "values": ["ripe", "fresh"] }
                        },
                        "required": false
                    }
                }
            }))
            .assert_value(),
        };

        assert_eq!(
            contract.provider_schema(ProviderSchemaDialect::Standard),
            json!({
                "type": "object",
                "properties": {
                    "response": {
                        "type": "object",
                        "properties": {
                            "answer": { "type": "integer" },
                            "notes": {
                                "type": "array",
                                "items": {
                                    "type": "string",
                                    "enum": ["fresh", "ripe"]
                                }
                            }
                        },
                        "required": ["answer"],
                        "additionalProperties": false
                    }
                },
                "required": ["response"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn provider_schema_covers_every_payload_kind_and_the_verifier_shape() {
        for (payload, expected) in [
            (PayloadType::Null, json!({"type":"null"})),
            (PayloadType::Boolean, json!({"type":"boolean"})),
            (PayloadType::Integer, json!({"type":"integer"})),
            (PayloadType::Number, json!({"type":"number"})),
            (PayloadType::String, json!({"type":"string"})),
        ] {
            let contract = NodeResponseContract::Worker { output: payload };
            assert_eq!(
                contract.provider_schema(ProviderSchemaDialect::Standard)["properties"]["response"],
                expected
            );
        }

        let verifier = NodeResponseContract::Verifier {
            output: PayloadType::Null,
            signals: BTreeMap::from([(
                FieldName::new("verdict").assert_value(),
                NonEmptyEnumSet::new(vec![
                    EnumLabel::new("rejected").assert_value(),
                    EnumLabel::new("accepted").assert_value(),
                ])
                .assert_value(),
            )]),
            diagnostic: PayloadType::Boolean,
        };
        let response =
            &verifier.provider_schema(ProviderSchemaDialect::Standard)["properties"]["response"];
        assert_eq!(
            response["required"],
            json!(["diagnostic", "output", "signals"])
        );
        assert_eq!(response["properties"]["output"], json!({"type":"null"}));
        assert_eq!(
            response["properties"]["signals"]["properties"]["verdict"],
            json!({"type":"string", "enum":["accepted", "rejected"]})
        );
        assert_eq!(
            response["properties"]["diagnostic"],
            json!({"type":"boolean"})
        );
    }

    #[test]
    fn openai_schema_requires_every_declared_object_field() {
        let contract = NodeResponseContract::Worker {
            output: serde_json::from_value(json!({
                "kind": "record",
                "fields": {
                    "required": { "type": { "kind": "boolean" }, "required": true },
                    "optional": { "type": { "kind": "string" }, "required": false }
                }
            }))
            .assert_value(),
        };

        let schema = contract.provider_schema(ProviderSchemaDialect::OpenAiStrict);
        assert_eq!(
            schema["properties"]["response"]["required"],
            json!(["optional", "required"])
        );
    }

    #[test]
    fn provider_envelope_is_unwrapped_before_authoritative_validation() {
        let contract = worker_contract();
        assert!(matches!(
            resolve_agent_response(&contract, r#"{"response":{"answer":42}}"#).assert_value(),
            AgentResponse::Complete(WorkerOutcome::Verified { output, .. })
                if output == json!({"answer": 42})
        ));
        assert!(matches!(
            resolve_agent_response(&contract, r#"{"answer":42}"#).assert_value(),
            AgentResponse::Correction(_)
        ));
        assert!(matches!(
            resolve_agent_response(&contract, r#"{"response":{"answer":42},"extra":true}"#)
                .assert_value(),
            AgentResponse::Correction(_)
        ));
    }
}
