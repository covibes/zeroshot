use serde_json::Value;

use crate::native_v2_contract::{TokenUsageDelta, parse_token_usage_delta};
use crate::native_v2_runner::{DriverControl, LiveOutput, LiveOutputStream, NodeRunnerError};

const MAX_EVENTS: usize = 4096;
const MAX_EVENT_BYTES: usize = 64 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSION_ID_BYTES: usize = 512;
const LIVE_CHUNK_BYTES: usize = 8 * 1024;

pub(super) struct ClaudeResult {
    pub(super) session_id: Option<String>,
    pub(super) message: String,
}

pub(super) struct ClaudeFailure {
    pub(super) session_id: Option<String>,
    pub(super) retryable: bool,
    pub(super) diagnostic: String,
}

pub(super) enum ClaudeAttempt {
    Complete(ClaudeResult),
    Failed(ClaudeFailure),
}

pub(super) struct ClaudeTranscript {
    pending: Vec<u8>,
    bytes: usize,
    events: usize,
    session_id: Option<String>,
    result: Option<Value>,
    failure: Option<String>,
    retryable_failure_seen: bool,
    settled: bool,
    visible_text_emitted: bool,
    token_usage: Option<TokenUsageDelta>,
    redactions: Vec<String>,
}

impl ClaudeTranscript {
    pub(super) fn new(mut redactions: Vec<String>) -> Self {
        redactions.retain(|value| !value.is_empty());
        redactions
            .sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        redactions.dedup();
        Self {
            pending: Vec::new(),
            bytes: 0,
            events: 0,
            session_id: None,
            result: None,
            failure: None,
            retryable_failure_seen: false,
            settled: false,
            visible_text_emitted: false,
            token_usage: None,
            redactions,
        }
    }

    pub(super) fn push(
        &mut self,
        chunk: &[u8],
        control: &DriverControl,
    ) -> Result<(), NodeRunnerError> {
        self.bytes = self
            .bytes
            .checked_add(chunk.len())
            .filter(|bytes| *bytes <= MAX_TRANSCRIPT_BYTES)
            .ok_or(NodeRunnerError::Driver)?;
        self.pending.extend_from_slice(chunk);
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let remaining = self.pending.split_off(newline + 1);
            let line = std::mem::replace(&mut self.pending, remaining);
            self.parse_line(line.get(..newline).ok_or(NodeRunnerError::Driver)?, control)?;
        }
        if self.pending.len() > MAX_EVENT_BYTES {
            return Err(NodeRunnerError::Driver);
        }
        Ok(())
    }

    pub(super) fn finish_stream(&mut self) -> Result<(), NodeRunnerError> {
        self.pending
            .is_empty()
            .then_some(())
            .ok_or(NodeRunnerError::Driver)
    }

    pub(super) fn token_usage(&self) -> Option<TokenUsageDelta> {
        self.token_usage
    }

    pub(super) fn finish(self) -> Result<ClaudeAttempt, NodeRunnerError> {
        if !self.settled {
            if self.retryable_failure_seen {
                return Ok(ClaudeAttempt::Failed(ClaudeFailure {
                    session_id: self.session_id,
                    retryable: true,
                    diagnostic: "Claude execution ended after a retryable API error".to_owned(),
                }));
            }
            return Err(NodeRunnerError::Driver);
        }
        if let Some(diagnostic) = self.failure {
            return Ok(ClaudeAttempt::Failed(ClaudeFailure {
                session_id: self.session_id,
                retryable: self.retryable_failure_seen,
                diagnostic,
            }));
        }
        let result = self.result.ok_or(NodeRunnerError::Driver)?;
        let message = match result {
            Value::String(message) => message,
            structured => {
                serde_json::to_string(&structured).map_err(|_| NodeRunnerError::Driver)?
            }
        };
        Ok(ClaudeAttempt::Complete(ClaudeResult {
            session_id: self.session_id,
            message,
        }))
    }

    fn parse_line(&mut self, line: &[u8], control: &DriverControl) -> Result<(), NodeRunnerError> {
        if line.is_empty() || line.len() > MAX_EVENT_BYTES || self.settled {
            return Err(NodeRunnerError::Driver);
        }
        self.events = self
            .events
            .checked_add(1)
            .filter(|events| *events <= MAX_EVENTS)
            .ok_or(NodeRunnerError::Driver)?;
        let event: Value = serde_json::from_slice(line).map_err(|_| NodeRunnerError::Driver)?;
        let object = event.as_object().ok_or(NodeRunnerError::Driver)?;
        record_session_id(object.get("session_id"), &mut self.session_id)?;
        self.dispatch_event(object, control)
    }

    fn dispatch_event(
        &mut self,
        object: &serde_json::Map<String, Value>,
        control: &DriverControl,
    ) -> Result<(), NodeRunnerError> {
        match object.get("type").and_then(Value::as_str) {
            Some("system") => self.parse_system(object, control),
            Some("stream_event") => self.parse_stream_event(object, control),
            Some("assistant") => self.parse_assistant(object, control),
            Some("result") => self.parse_result(object, control),
            Some(_) => Ok(()),
            None => Err(NodeRunnerError::Driver),
        }
    }

    fn parse_system(
        &mut self,
        event: &serde_json::Map<String, Value>,
        control: &DriverControl,
    ) -> Result<(), NodeRunnerError> {
        if event.get("subtype").and_then(Value::as_str) != Some("api_retry") {
            return Ok(());
        }
        self.retryable_failure_seen = true;
        let attempt = event.get("attempt").and_then(Value::as_u64).unwrap_or(0);
        let maximum = event
            .get("max_retries")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let error = event
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        self.emit(
            control,
            LiveOutputStream::System,
            &format!("Claude API retry {attempt}/{maximum}: {error}"),
        )
    }

    fn parse_stream_event(
        &mut self,
        event: &serde_json::Map<String, Value>,
        control: &DriverControl,
    ) -> Result<(), NodeRunnerError> {
        let Some(inner) = event.get("event").and_then(Value::as_object) else {
            return Ok(());
        };
        if inner.get("type").and_then(Value::as_str) != Some("content_block_delta") {
            return Ok(());
        }
        let Some(delta) = inner.get("delta").and_then(Value::as_object) else {
            return Ok(());
        };
        let (field, stream) = match delta.get("type").and_then(Value::as_str) {
            Some("text_delta") => ("text", LiveOutputStream::Output),
            Some("thinking_delta") => ("thinking", LiveOutputStream::System),
            _ => return Ok(()),
        };
        if let Some(text) = delta.get(field).and_then(Value::as_str) {
            if field == "text" {
                self.visible_text_emitted = true;
            }
            self.emit(control, stream, text)?;
        }
        Ok(())
    }

    fn parse_assistant(
        &mut self,
        event: &serde_json::Map<String, Value>,
        control: &DriverControl,
    ) -> Result<(), NodeRunnerError> {
        if self.visible_text_emitted {
            return Ok(());
        }
        let Some(content) = event
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
        else {
            return Ok(());
        };
        for block in content {
            let Some(block) = block.as_object() else {
                continue;
            };
            if block.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    self.emit(control, LiveOutputStream::Output, text)?;
                    self.visible_text_emitted = true;
                }
            }
        }
        Ok(())
    }

    fn parse_result(
        &mut self,
        event: &serde_json::Map<String, Value>,
        _control: &DriverControl,
    ) -> Result<(), NodeRunnerError> {
        self.token_usage = parse_token_usage_delta(
            event.get("usage"),
            Some("cache_read_input_tokens"),
            Some("cache_creation_input_tokens"),
        );
        let unsuccessful = event.get("subtype").and_then(Value::as_str) != Some("success")
            || event.get("is_error").and_then(Value::as_bool) == Some(true);
        if unsuccessful {
            let diagnostic = event
                .get("result")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| error_list(event.get("errors")))
                .unwrap_or_else(|| {
                    format!(
                        "Claude result {}",
                        event
                            .get("subtype")
                            .and_then(Value::as_str)
                            .unwrap_or("failed")
                    )
                });
            self.failure = Some(diagnostic);
            self.settled = true;
            return Ok(());
        }
        if self.result.is_some() {
            return Err(NodeRunnerError::Driver);
        }
        self.result = Some(
            event
                .get("structured_output")
                .filter(|value| !value.is_null())
                .or_else(|| event.get("result"))
                .cloned()
                .unwrap_or(Value::Null),
        );
        self.settled = true;
        Ok(())
    }

    fn emit(
        &self,
        control: &DriverControl,
        stream: LiveOutputStream,
        text: &str,
    ) -> Result<(), NodeRunnerError> {
        let mut safe = text.to_owned();
        for value in &self.redactions {
            safe = safe.replace(value, "[REDACTED]");
        }
        if safe.contains('\0') {
            return Err(NodeRunnerError::UnsafeOutput);
        }
        for chunk in utf8_chunks(&safe, LIVE_CHUNK_BYTES) {
            control.emit(LiveOutput::new(stream, chunk)?)?;
        }
        Ok(())
    }
}

fn error_list(value: Option<&Value>) -> Option<String> {
    let errors = value?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|error| !error.trim().is_empty())
        .collect::<Vec<_>>();
    (!errors.is_empty()).then(|| errors.join("; "))
}

fn record_session_id(
    value: Option<&Value>,
    retained: &mut Option<String>,
) -> Result<(), NodeRunnerError> {
    let Some(value) = value else {
        return Ok(());
    };
    let session_id = value.as_str().ok_or(NodeRunnerError::Driver)?.trim();
    if session_id.is_empty() || session_id.len() > MAX_SESSION_ID_BYTES {
        return Err(NodeRunnerError::Driver);
    }
    match retained.as_deref() {
        Some(existing) if existing != session_id => Err(NodeRunnerError::Driver),
        Some(_) => Ok(()),
        None => {
            *retained = Some(session_id.to_owned());
            Ok(())
        }
    }
}

fn utf8_chunks(value: &str, max: usize) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = value.len().min(start + max);
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(value[start..end].to_owned());
        start = end;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::ClaudeTranscript;

    #[test]
    fn redactions_are_deduplicated_and_longest_first() {
        let transcript = ClaudeTranscript::new(vec![
            "secret".to_owned(),
            "secret-tail".to_owned(),
            "secret".to_owned(),
            String::new(),
        ]);
        assert_eq!(transcript.redactions, vec!["secret-tail", "secret"]);
        let safe = transcript
            .redactions
            .iter()
            .fold("value=secret-tail".to_owned(), |safe, value| {
                safe.replace(value, "[REDACTED]")
            });
        assert_eq!(safe, "value=[REDACTED]");
    }
}
