use openengine_cluster_protocol::WorkerOutcome;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::execution::ExecutionInput;

use super::super::worker_process::{decode_inline, validate_bounded_text};
use message::{
    message_role, parse_assistant, reject_tool_evidence, validate_user_message, MessageRole,
    PiAssistant,
};

#[path = "protocol/message.rs"]
mod message;

const MAX_PROMPT_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024;
const MAX_EVENTS: usize = 4096;
const MAX_EVENT_BYTES: usize = 64 * 1024;
const AUXILIARY_EVENTS: [&str; 11] = [
    "queue_update",
    "entry_appended",
    "session_info_changed",
    "thinking_level_changed",
    "auto_retry_start",
    "auto_retry_end",
    "compaction_start",
    "compaction_end",
    "summarization_retry_scheduled",
    "summarization_retry_attempt_start",
    "summarization_retry_finished",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PiUserInput {
    prompt: String,
}

impl PiUserInput {
    pub(super) fn parse(value: &Value) -> Result<Self, ()> {
        let input: Self = serde_json::from_value(value.clone()).map_err(|_| ())?;
        validate_bounded_text(&input.prompt, MAX_PROMPT_BYTES)?;
        Ok(input)
    }

    pub(super) fn from_execution_input(input: ExecutionInput) -> Result<Self, ()> {
        let value: Self = decode_inline(input)?;
        validate_bounded_text(&value.prompt, MAX_PROMPT_BYTES)?;
        Ok(value)
    }

    pub(super) fn into_prompt(self) -> String {
        self.prompt
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PiTerminalOutput {
    response: String,
}

pub(super) fn validate_terminal_output(output: &Value) -> Result<(), ()> {
    let output: PiTerminalOutput = serde_json::from_value(output.clone()).map_err(|_| ())?;
    validate_bounded_text(&output.response, MAX_RESPONSE_BYTES)
}

#[derive(Default)]
struct PiTranscript {
    session_seen: bool,
    agent_seen: bool,
    settled: bool,
    latest_assistant: Option<PiAssistant>,
}

struct PiIdentity<'a> {
    provider: &'a str,
    model: &'a str,
}

impl PiTranscript {
    fn finish(self) -> Result<WorkerOutcome, ()> {
        if !self.session_seen || !self.agent_seen || !self.settled {
            return Err(());
        }
        let assistant = self.latest_assistant.ok_or(())?;
        if !assistant.successful {
            return Err(());
        }
        Ok(WorkerOutcome::Verified {
            output: serde_json::to_value(PiTerminalOutput {
                response: assistant.response,
            })
            .map_err(|_| ())?,
            artifacts: Vec::new(),
        })
    }
}

pub(super) fn parse_pi_output(
    bytes: &[u8],
    provider: &str,
    model: &str,
) -> Result<WorkerOutcome, ()> {
    parse_lines(bytes, &PiIdentity { provider, model })?.finish()
}

fn parse_lines(bytes: &[u8], identity: &PiIdentity<'_>) -> Result<PiTranscript, ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let mut transcript = PiTranscript::default();
    let mut count = 0usize;
    for line in text.lines() {
        count = count.checked_add(1).ok_or(())?;
        validate_line(line, count, transcript.settled)?;
        parse_event(line, &mut transcript, identity)?;
    }
    (count > 0).then_some(transcript).ok_or(())
}

fn validate_line(line: &str, count: usize, settled: bool) -> Result<(), ()> {
    (!line.is_empty() && line.len() <= MAX_EVENT_BYTES && count <= MAX_EVENTS && !settled)
        .then_some(())
        .ok_or(())
}

fn parse_event(
    line: &str,
    transcript: &mut PiTranscript,
    identity: &PiIdentity<'_>,
) -> Result<(), ()> {
    let event: Value = serde_json::from_str(line).map_err(|_| ())?;
    let object = event.as_object().ok_or(())?;
    let event_type = string_field(object, "type")?;
    if !transcript.session_seen && event_type != "session" {
        return Err(());
    }
    if event_type.starts_with("tool_") || event_type == "bash_execution_update" {
        return Err(());
    }
    if AUXILIARY_EVENTS.contains(&event_type) {
        return Ok(());
    }
    if event_type.starts_with("message_") {
        return parse_message_event(event_type, object, transcript, identity);
    }
    parse_lifecycle_event(event_type, object, transcript, identity)
}

fn parse_lifecycle_event(
    event_type: &str,
    event: &Map<String, Value>,
    transcript: &mut PiTranscript,
    identity: &PiIdentity<'_>,
) -> Result<(), ()> {
    match event_type {
        "session" => begin_session(event, transcript),
        "agent_start" => begin_agent(transcript),
        "agent_end" => validate_agent_end(event, transcript),
        "agent_settled" => settle_agent(transcript),
        "turn_start" => require_agent(transcript),
        "turn_end" => validate_turn_end(event, transcript, identity),
        _ => Err(()),
    }
}

fn parse_message_event(
    event_type: &str,
    event: &Map<String, Value>,
    transcript: &mut PiTranscript,
    identity: &PiIdentity<'_>,
) -> Result<(), ()> {
    match event_type {
        "message_start" => validate_message_start(event, transcript),
        "message_update" => validate_message_update(event, transcript),
        "message_end" => validate_message_end(event, transcript, identity),
        _ => Err(()),
    }
}

fn begin_session(event: &Map<String, Value>, transcript: &mut PiTranscript) -> Result<(), ()> {
    if transcript.session_seen {
        return Err(());
    }
    integer_field(event, "version")?;
    string_field(event, "id")?;
    string_field(event, "timestamp")?;
    string_field(event, "cwd")?;
    transcript.session_seen = true;
    Ok(())
}

fn begin_agent(transcript: &mut PiTranscript) -> Result<(), ()> {
    if !transcript.session_seen {
        return Err(());
    }
    transcript.agent_seen = true;
    Ok(())
}

fn require_agent(transcript: &PiTranscript) -> Result<(), ()> {
    transcript.agent_seen.then_some(()).ok_or(())
}

fn validate_agent_end(event: &Map<String, Value>, transcript: &PiTranscript) -> Result<(), ()> {
    require_agent(transcript)?;
    for message in array_field(event, "messages")? {
        reject_tool_evidence(message)?;
    }
    bool_field(event, "willRetry")?;
    Ok(())
}

fn settle_agent(transcript: &mut PiTranscript) -> Result<(), ()> {
    require_agent(transcript)?;
    transcript.settled = true;
    Ok(())
}

fn validate_turn_end(
    event: &Map<String, Value>,
    transcript: &PiTranscript,
    identity: &PiIdentity<'_>,
) -> Result<(), ()> {
    require_agent(transcript)?;
    if !array_field(event, "toolResults")?.is_empty() {
        return Err(());
    }
    validate_message(event.get("message").ok_or(())?, identity).map(drop)
}

fn validate_message_start(event: &Map<String, Value>, transcript: &PiTranscript) -> Result<(), ()> {
    require_agent(transcript)?;
    let message = event.get("message").and_then(Value::as_object).ok_or(())?;
    match message_role(message)? {
        MessageRole::User => validate_user_message(message),
        MessageRole::Assistant => reject_tool_evidence(event.get("message").ok_or(())?),
    }
}

fn validate_message_update(
    event: &Map<String, Value>,
    transcript: &PiTranscript,
) -> Result<(), ()> {
    require_agent(transcript)?;
    let update = event
        .get("assistantMessageEvent")
        .and_then(Value::as_object)
        .ok_or(())?;
    if string_field(update, "type")?
        .to_ascii_lowercase()
        .contains("tool")
    {
        Err(())
    } else {
        Ok(())
    }
}

fn validate_message_end(
    event: &Map<String, Value>,
    transcript: &mut PiTranscript,
    identity: &PiIdentity<'_>,
) -> Result<(), ()> {
    require_agent(transcript)?;
    let message = event.get("message").ok_or(())?;
    if let Some(assistant) = validate_message(message, identity)? {
        transcript.latest_assistant = Some(assistant);
    }
    Ok(())
}

fn validate_message(message: &Value, identity: &PiIdentity<'_>) -> Result<Option<PiAssistant>, ()> {
    let object = message.as_object().ok_or(())?;
    match message_role(object)? {
        MessageRole::User => validate_user_message(object).map(|()| None),
        MessageRole::Assistant => {
            parse_assistant(message, identity.provider, identity.model).map(Some)
        }
    }
}

fn array_field<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a Vec<Value>, ()> {
    object.get(name).and_then(Value::as_array).ok_or(())
}

fn string_field<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a str, ()> {
    object.get(name).and_then(Value::as_str).ok_or(())
}

fn integer_field(object: &Map<String, Value>, name: &str) -> Result<u64, ()> {
    object.get(name).and_then(Value::as_u64).ok_or(())
}

fn bool_field(object: &Map<String, Value>, name: &str) -> Result<bool, ()> {
    object.get(name).and_then(Value::as_bool).ok_or(())
}
