use openengine_cluster_protocol::{IDEMPOTENCY_REUSE, NOT_FOUND, RUN_CONFLICT};
use openengine_cluster_client::ClientError;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::NativeV2CliError;
use crate::native_v2_admission::NativeV2AdmissionError;
use crate::native_v2_supervisor::RunEnvironmentError;

pub const ERROR_FORMAT_ENV: &str = "ZEROSHOT_RUST_ERROR_FORMAT";
pub const JSON_ERROR_FORMAT: &str = "json";
const ERROR_SCHEMA: &str = "zeroshot.error/v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DiagnosticKind {
    InvalidRequest,
    Protocol,
    RunNotFound,
    SubmissionConflict,
    Target,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeV2CliDiagnostic {
    schema: &'static str,
    kind: DiagnosticKind,
    code: String,
    message: String,
    path: Option<Vec<Value>>,
    node: Option<String>,
    details: Value,
}

impl NativeV2CliDiagnostic {
    pub fn target(message: impl Into<String>) -> Self {
        Self::new(DiagnosticKind::Target, "target.unavailable", message)
    }

    fn new(kind: DiagnosticKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            schema: ERROR_SCHEMA,
            kind,
            code: code.into(),
            message: message.into(),
            path: None,
            node: None,
            details: json!({}),
        }
    }

    fn with_context(mut self, node: Option<String>, details: Value) -> Self {
        self.node = node;
        self.details = object_details(details);
        self
    }

    fn with_details(self, details: Value) -> Self {
        self.with_context(None, details)
    }
}

impl NativeV2CliError {
    #[must_use]
    pub fn diagnostic(&self) -> NativeV2CliDiagnostic {
        request_diagnostic(self)
            .or_else(|| run_diagnostic(self))
            .or_else(|| protocol_diagnostic(self))
            .unwrap_or_else(|| NativeV2CliDiagnostic::target(self.to_string()))
    }
}

fn request_diagnostic(error: &NativeV2CliError) -> Option<NativeV2CliDiagnostic> {
    let diagnostic = match error {
        NativeV2CliError::Usage(message) => request(usage_code(message), message, None, json!({})),
        NativeV2CliError::Json { kind, path, source } => request(
            json_code(source),
            error.to_string(),
            None,
            json!({
                "fileKind": kind,
                "filePath": path,
                "line": source.line(),
                "column": source.column(),
            }),
        ),
        NativeV2CliError::InitialInput(message) => request(
            "input.type_mismatch",
            error.to_string(),
            None,
            json!({"reason": message}),
        ),
        NativeV2CliError::InvalidRun(source) => request(
            admission_code(source),
            error.to_string(),
            admission_node(source),
            admission_details(source),
        ),
        NativeV2CliError::Environment(name) => request(
            "runtime.missing_environment",
            error.to_string(),
            None,
            json!({"environment": name.as_str()}),
        ),
        NativeV2CliError::RunEnvironment(source) => {
            request(environment_code(source), error.to_string(), None, json!({}))
        }
        NativeV2CliError::GitHubToken => request(
            "runtime.invalid_environment",
            error.to_string(),
            None,
            json!({}),
        ),
        _ => return None,
    };
    Some(diagnostic)
}

fn request(
    code: &str,
    message: impl Into<String>,
    node: Option<String>,
    details: Value,
) -> NativeV2CliDiagnostic {
    NativeV2CliDiagnostic::new(DiagnosticKind::InvalidRequest, code, message)
        .with_context(node, details)
}

fn usage_code(message: &str) -> &'static str {
    if message.contains("invalid value")
        && (message.contains("--template") || message.contains("<TEMPLATE>"))
    {
        "template.unknown"
    } else if message.contains("template delivery mode")
        || message.contains("valid only with --template software-change")
    {
        "template.unsupported_delivery"
    } else if message.contains("model") && message.contains("unrecognized") {
        "runtime.unsupported_model"
    } else {
        "request.invalid"
    }
}

fn json_code(source: &serde_json::Error) -> &'static str {
    if source.to_string().contains("unknown field") {
        "json.unknown_field"
    } else {
        "json.invalid"
    }
}

fn environment_code(source: &RunEnvironmentError) -> &'static str {
    match source {
        RunEnvironmentError::Missing(_) => "runtime.missing_environment",
        _ => "runtime.invalid_environment",
    }
}

fn admission_code(source: &NativeV2AdmissionError) -> &'static str {
    match source {
        NativeV2AdmissionError::InitialInput(_) => "input.type_mismatch",
        NativeV2AdmissionError::MissingRuntimeBinding { .. } => "runtime.missing_binding",
        NativeV2AdmissionError::UnexpectedRuntimeBinding { .. } => "runtime.unexpected_binding",
        NativeV2AdmissionError::UnsupportedModel { .. } => "runtime.unsupported_model",
        NativeV2AdmissionError::UnsupportedEffort { .. } => "runtime.unsupported_effort",
        NativeV2AdmissionError::UnsupportedGraphProfile => "graph.unsupported_profile",
        _ => "request.invalid",
    }
}

fn admission_node(source: &NativeV2AdmissionError) -> Option<String> {
    match source {
        NativeV2AdmissionError::Attempts { node, .. }
        | NativeV2AdmissionError::MissingRuntimeBinding { node }
        | NativeV2AdmissionError::UnexpectedRuntimeBinding { node }
        | NativeV2AdmissionError::MissingAgentInstructions { node }
        | NativeV2AdmissionError::DeliveryInstructionsForbidden { node }
        | NativeV2AdmissionError::DeliveryMustBeVerifier { node }
        | NativeV2AdmissionError::UnsupportedDeliveryWorker { node, .. }
        | NativeV2AdmissionError::DeliveryWorkerRequiresBinding { node, .. }
        | NativeV2AdmissionError::InvalidDeliveryContract { node, .. }
        | NativeV2AdmissionError::UnsupportedModel { node, .. }
        | NativeV2AdmissionError::UnsupportedEffort { node, .. } => Some(node.to_string()),
        _ => None,
    }
}

fn admission_details(source: &NativeV2AdmissionError) -> Value {
    match source {
        NativeV2AdmissionError::UnsupportedModel { model, .. } => json!({"model": model}),
        NativeV2AdmissionError::UnsupportedEffort { model, effort, .. } => {
            json!({"model": model, "effort": format!("{effort:?}").to_lowercase()})
        }
        NativeV2AdmissionError::DeliveryNodeCount { found, .. } => json!({"found": found}),
        NativeV2AdmissionError::DeclaredEnvironmentTooLarge { found } => json!({"found": found}),
        _ => json!({}),
    }
}

fn run_diagnostic(error: &NativeV2CliError) -> Option<NativeV2CliDiagnostic> {
    match error {
        NativeV2CliError::RunNotFound { run_id } => Some(
            NativeV2CliDiagnostic::new(
                DiagnosticKind::RunNotFound,
                "run.not_found",
                error.to_string(),
            )
            .with_details(json!({"runId": run_id})),
        ),
        NativeV2CliError::SubmissionConflict { existing_run_id } => Some(
            NativeV2CliDiagnostic::new(
                DiagnosticKind::SubmissionConflict,
                "submission.conflict",
                error.to_string(),
            )
            .with_details(json!({"existingRunId": existing_run_id})),
        ),
        NativeV2CliError::Remote {
            code,
            message,
            details,
        } => Some(remote_diagnostic(code, message, details.clone())),
        _ => None,
    }
}

fn remote_diagnostic(code: &str, message: &str, details: Option<Value>) -> NativeV2CliDiagnostic {
    let details = object_details(details.unwrap_or_else(|| json!({})));
    match code {
        NOT_FOUND => {
            NativeV2CliDiagnostic::new(DiagnosticKind::RunNotFound, "run.not_found", message)
                .with_details(details)
        }
        RUN_CONFLICT | IDEMPOTENCY_REUSE => NativeV2CliDiagnostic::new(
            DiagnosticKind::SubmissionConflict,
            "submission.conflict",
            message,
        )
        .with_details(details),
        _ => NativeV2CliDiagnostic::new(DiagnosticKind::Target, code.to_lowercase(), message)
            .with_details(details),
    }
}

fn protocol_diagnostic(error: &NativeV2CliError) -> Option<NativeV2CliDiagnostic> {
    match error {
        NativeV2CliError::Protocol(_) | NativeV2CliError::OutputJson(_) => {
            Some(NativeV2CliDiagnostic::new(
                DiagnosticKind::Protocol,
                "protocol.invalid",
                error.to_string(),
            ))
        }
        _ => None,
    }
}

fn object_details(details: Value) -> Value {
    match details {
        Value::Object(_) => details,
        value => Value::Object(Map::from_iter([("nativeDetails".to_owned(), value)])),
    }
}

pub(super) fn client_error(error: ClientError) -> NativeV2CliError {
    match error {
        ClientError::Backend(error) => NativeV2CliError::Remote {
            code: error.code,
            message: error.message,
            details: error.details,
        },
        ClientError::Rpc(error) => match error.data {
            Some(data) => NativeV2CliError::Remote {
                code: data.code,
                message: error.message,
                details: data.details,
            },
            None => NativeV2CliError::Protocol(error.message),
        },
        ClientError::Transport(_) => NativeV2CliError::Disconnected,
        error => NativeV2CliError::Protocol(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use openengine_cluster_protocol::{ModelId, NodeName, ReasoningEffort};
    use openengine_cluster_testkit::assertions::{AssertValue, JsonAt};
    use serde_json::json;

    use super::*;

    #[test]
    fn admission_diagnostic_preserves_stable_code_node_and_details() {
        let error = NativeV2CliError::InvalidRun(NativeV2AdmissionError::UnsupportedEffort {
            node: NodeName::new("worker").assert_value(),
            model: ModelId::new("gpt-5.6-luna")
                .assert_value()
                .as_str()
                .to_owned(),
            effort: ReasoningEffort::Max,
        });
        let value = serde_json::to_value(error.diagnostic()).assert_value();
        assert_eq!(value.assert_key("schema"), ERROR_SCHEMA);
        assert_eq!(value.assert_key("kind"), "invalid_request");
        assert_eq!(value.assert_key("code"), "runtime.unsupported_effort");
        assert_eq!(value.assert_key("node"), "worker");
        assert_eq!(
            value.assert_key("details"),
            &json!({"model": "gpt-5.6-luna", "effort": "max"})
        );
    }

    #[test]
    fn conflict_diagnostic_retains_existing_run_identity() {
        let run_id = "01900000-0000-7000-8000-000000000001".to_owned();
        let error = NativeV2CliError::SubmissionConflict {
            existing_run_id: run_id.clone(),
        };
        let value = serde_json::to_value(error.diagnostic()).assert_value();
        assert_eq!(value.assert_key("kind"), "submission_conflict");
        assert_eq!(
            value.assert_key("details").assert_key("existingRunId"),
            &run_id
        );
    }
}
