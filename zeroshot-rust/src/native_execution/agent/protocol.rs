use openengine_cluster_protocol::{canonical_value_bytes, ArtifactRef, Generation, RedactionClass};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::execution::ExecutionInput;
use super::super::program::CODEX_AGENT_WORKER_REF;
use super::super::worker_process::{decode_inline, validate_bounded_text};
use super::validator::MAX_EXPECTED_GREETING_BYTES;

pub(super) const VALIDATION_TYPE_ID: &str = "native.agent.validation@1";
const MAX_PROMPT_BYTES: usize = 16 * 1024;
const MAX_SUMMARY_BYTES: usize = 4 * 1024;
const MAX_CODEX_EVENTS: usize = 4096;
const MAX_CODEX_EVENT_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentUserInput {
    prompt: String,
    expected_greeting: String,
}

impl AgentUserInput {
    pub(super) fn parse(value: &Value) -> Result<Self, ()> {
        let input: Self = serde_json::from_value(value.clone()).map_err(|_| ())?;
        validate_bounded_text(&input.prompt, MAX_PROMPT_BYTES)?;
        validate_bounded_text(&input.expected_greeting, MAX_EXPECTED_GREETING_BYTES)?;
        Ok(input)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentDispatchInput {
    pub(super) generation: u64,
    prompt: String,
    pub(super) expected_greeting: String,
}

impl AgentDispatchInput {
    pub(crate) fn new(generation: u64, input: Value) -> Result<Self, ()> {
        let input = AgentUserInput::parse(&input)?;
        Generation::new(generation).map_err(|_| ())?;
        Ok(Self {
            generation,
            prompt: input.prompt,
            expected_greeting: input.expected_greeting,
        })
    }

    pub(super) fn from_execution_input(input: ExecutionInput) -> Result<Self, ()> {
        let value: Self = decode_inline(input)?;
        validate_bounded_text(&value.prompt, MAX_PROMPT_BYTES)?;
        validate_bounded_text(&value.expected_greeting, MAX_EXPECTED_GREETING_BYTES)?;
        Generation::new(value.generation).map_err(|_| ())?;
        Ok(value)
    }

    pub(super) fn provider_prompt(&self) -> String {
        let greeting = serde_json::to_string(&self.expected_greeting)
            .expect("bounded greeting must serialize");
        format!(
            concat!(
                "{}\n\nModify only this workspace. Write the JSON string value {greeting} ",
                "as the exact UTF-8 contents of greeting.txt. Finish with exactly one JSON ",
                "object {{\"summary\":\"a short bounded summary\"}} and no Markdown."
            ),
            self.prompt,
            greeting = greeting
        )
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTerminalOutput {
    pub(crate) summary: String,
    pub(crate) validation_artifact: ArtifactRef,
}

impl AgentTerminalOutput {
    pub(crate) fn validate(&self) -> Result<(), ()> {
        validate_bounded_text(&self.summary, MAX_SUMMARY_BYTES)?;
        if self.validation_artifact.type_id.as_str() != VALIDATION_TYPE_ID
            || self.validation_artifact.media_type.as_str() != "application/json"
            || self.validation_artifact.redaction != RedactionClass::Internal
            || self.validation_artifact.producer.worker.as_str() != CODEX_AGENT_WORKER_REF
        {
            return Err(());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentFinalMessage {
    summary: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ValidationOutput {
    path: String,
    sha256: String,
    status: String,
}

#[derive(Default)]
struct CodexTranscript {
    final_message: Option<String>,
    turn_completed: bool,
}

pub(super) fn parse_codex_output(bytes: &[u8]) -> Result<String, ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let mut transcript = CodexTranscript::default();
    for (index, line) in text.lines().filter(|line| !line.is_empty()).enumerate() {
        if index >= MAX_CODEX_EVENTS || line.len() > MAX_CODEX_EVENT_BYTES {
            return Err(());
        }
        parse_codex_event(line, &mut transcript)?;
    }
    if !transcript.turn_completed {
        return Err(());
    }
    let final_message = transcript.final_message.ok_or(())?;
    let parsed: AgentFinalMessage = serde_json::from_str(&final_message).map_err(|_| ())?;
    validate_bounded_text(&parsed.summary, MAX_SUMMARY_BYTES)?;
    Ok(parsed.summary)
}

fn parse_codex_event(line: &str, transcript: &mut CodexTranscript) -> Result<(), ()> {
    let event: Value = serde_json::from_str(line).map_err(|_| ())?;
    let object = event.as_object().ok_or(())?;
    match object.get("type").and_then(Value::as_str).ok_or(())? {
        "thread.started" | "turn.started" => Ok(()),
        "turn.completed" => {
            transcript.turn_completed = true;
            Ok(())
        }
        "turn.failed" | "error" => Err(()),
        "item.started" | "item.created" | "item.completed" => parse_codex_item(object, transcript),
        _ => Err(()),
    }
}

fn parse_codex_item(
    event: &serde_json::Map<String, Value>,
    transcript: &mut CodexTranscript,
) -> Result<(), ()> {
    let item = event.get("item").and_then(Value::as_object).ok_or(())?;
    match item.get("type").and_then(Value::as_str).ok_or(())? {
        "agent_message" => {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                transcript.final_message = Some(text.to_owned());
            }
            Ok(())
        }
        "message" if item.get("role").and_then(Value::as_str) == Some("assistant") => {
            transcript.final_message = assistant_message_text(item)?;
            Ok(())
        }
        "reasoning" | "command_execution" | "function_call" | "function_call_output" => Ok(()),
        _ => Err(()),
    }
}

fn assistant_message_text(item: &serde_json::Map<String, Value>) -> Result<Option<String>, ()> {
    let content = item.get("content").and_then(Value::as_array).ok_or(())?;
    let mut output = String::new();
    for entry in content {
        let entry = entry.as_object().ok_or(())?;
        if entry.get("type").and_then(Value::as_str) == Some("text") {
            output.push_str(entry.get("text").and_then(Value::as_str).ok_or(())?);
        }
    }
    Ok((!output.is_empty()).then_some(output))
}

pub(super) fn validate_validation_output(bytes: &[u8]) -> Result<(), ()> {
    let output: ValidationOutput = serde_json::from_slice(bytes).map_err(|_| ())?;
    if output.path != "greeting.txt"
        || output.status != "passed"
        || output.sha256.len() != 64
        || !output
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    let canonical =
        canonical_value_bytes(&serde_json::to_value(output).map_err(|_| ())?).map_err(|_| ())?;
    if canonical != bytes {
        return Err(());
    }
    Ok(())
}
