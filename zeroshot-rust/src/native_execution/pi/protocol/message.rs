use serde_json::{Map, Value};

use super::{array_field, integer_field, string_field, validate_bounded_text, MAX_RESPONSE_BYTES};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum MessageRole {
    User,
    Assistant,
}

pub(super) struct PiAssistant {
    pub(super) response: String,
    pub(super) successful: bool,
}

pub(super) fn message_role(message: &Map<String, Value>) -> Result<MessageRole, ()> {
    match string_field(message, "role")? {
        "user" => Ok(MessageRole::User),
        "assistant" => Ok(MessageRole::Assistant),
        _ => Err(()),
    }
}

pub(super) fn validate_user_message(message: &Map<String, Value>) -> Result<(), ()> {
    integer_field(message, "timestamp")?;
    let content = message.get("content").ok_or(())?;
    (content.is_string() || content.is_array())
        .then_some(())
        .ok_or(())
}

pub(super) fn reject_tool_evidence(message: &Value) -> Result<(), ()> {
    let object = message.as_object().ok_or(())?;
    match message_role(object)? {
        MessageRole::User => Ok(()),
        MessageRole::Assistant => assistant_text(array_field(object, "content")?).map(drop),
    }
}

pub(super) fn parse_assistant(
    message: &Value,
    provider: &str,
    model: &str,
) -> Result<PiAssistant, ()> {
    let object = message.as_object().ok_or(())?;
    validate_assistant_metadata(object, provider, model)?;
    let successful = successful_stop(string_field(object, "stopReason")?)?;
    let response = assistant_text(array_field(object, "content")?)?;
    if successful {
        validate_bounded_text(&response, MAX_RESPONSE_BYTES)?;
    }
    Ok(PiAssistant {
        response,
        successful,
    })
}

fn validate_assistant_metadata(
    message: &Map<String, Value>,
    provider: &str,
    model: &str,
) -> Result<(), ()> {
    validate_assistant_identity(message, provider, model)?;
    validate_usage(message.get("usage").and_then(Value::as_object).ok_or(())?)?;
    integer_field(message, "timestamp")?;
    Ok(())
}

fn validate_assistant_identity(
    message: &Map<String, Value>,
    provider: &str,
    model: &str,
) -> Result<(), ()> {
    (string_field(message, "provider")? == provider && string_field(message, "model")? == model)
        .then_some(())
        .ok_or(())
}

fn successful_stop(stop: &str) -> Result<bool, ()> {
    match stop {
        "stop" => Ok(true),
        "pending" | "length" | "toolUse" | "error" | "aborted" | "deferred" => Ok(false),
        _ => Err(()),
    }
}

fn assistant_text(content: &[Value]) -> Result<String, ()> {
    let mut response = String::new();
    for item in content {
        append_content(item.as_object().ok_or(())?, &mut response)?;
        if response.len() > MAX_RESPONSE_BYTES {
            return Err(());
        }
    }
    Ok(response)
}

fn append_content(content: &Map<String, Value>, response: &mut String) -> Result<(), ()> {
    match string_field(content, "type")? {
        "text" => {
            response.push_str(string_field(content, "text")?);
            Ok(())
        }
        "thinking" => {
            string_field(content, "thinking")?;
            Ok(())
        }
        "toolCall" => Err(()),
        _ => Err(()),
    }
}

fn validate_usage(usage: &Map<String, Value>) -> Result<(), ()> {
    for field in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
        integer_field(usage, field)?;
    }
    let cost = usage.get("cost").and_then(Value::as_object).ok_or(())?;
    for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
        number_field(cost, field)?;
    }
    Ok(())
}

fn number_field(object: &Map<String, Value>, name: &str) -> Result<(), ()> {
    object
        .get(name)
        .and_then(Value::as_f64)
        .is_some_and(|value| value.is_finite() && value >= 0.0)
        .then_some(())
        .ok_or(())
}
