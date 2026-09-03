use serde_json::Value;

use crate::native_v2_capsule::provider_json_lines::{ProviderJsonLine, ProviderJsonLines};
use crate::native_v2_capsule::provider_process::safe_provider_text;
use crate::native_v2_contract::TokenUsageDelta;
use crate::native_v2_runner::{LiveOutputStream, NodeRunnerError};

#[path = "transcript/diagnostic.rs"]
mod diagnostic;
#[path = "transcript/session_id.rs"]
mod session_id;
#[path = "transcript/usage.rs"]
mod usage;

use diagnostic::{combine_failure_detail, error_list, record_count};
use session_id::record_session_id;
use usage::{
    ProvisionalUsage, TerminalUsage, UsageKeys, message_identity, parse_terminal_usage,
    parse_usage_snapshot,
};

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

impl ClaudeAttempt {
    pub(super) fn process_failure(diagnostic: impl Into<String>) -> Self {
        Self::Failed(ClaudeFailure {
            session_id: None,
            retryable: false,
            diagnostic: diagnostic.into(),
        })
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct ClaudeEmission {
    pub(super) stream: LiveOutputStream,
    pub(super) text: String,
}

enum ClaudeTerminal {
    Complete(Value),
    Failed(String),
}

pub(super) struct ClaudeTranscript {
    lines: ProviderJsonLines,
    session_id: Option<String>,
    session_failure: Option<String>,
    terminal: Option<ClaudeTerminal>,
    retryable_failure_seen: bool,
    visible_text_emitted: bool,
    terminal_usage: Option<Option<TokenUsageDelta>>,
    provisional_usage: ProvisionalUsage,
    active_stream_message: Option<String>,
    malformed_records: usize,
    oversized_records: usize,
    redactions: Vec<String>,
}

impl ClaudeTranscript {
    pub(super) fn new(mut redactions: Vec<String>) -> Self {
        redactions.retain(|value| !value.is_empty());
        redactions
            .sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        redactions.dedup();
        Self {
            lines: ProviderJsonLines::new(),
            session_id: None,
            session_failure: None,
            terminal: None,
            retryable_failure_seen: false,
            visible_text_emitted: false,
            terminal_usage: None,
            provisional_usage: ProvisionalUsage::default(),
            active_stream_message: None,
            malformed_records: 0,
            oversized_records: 0,
            redactions,
        }
    }

    pub(super) fn push(&mut self, chunk: &[u8]) -> Vec<ClaudeEmission> {
        if self.terminal.is_some() {
            self.lines.discard();
            return Vec::new();
        }
        let records = self.lines.push(chunk);
        self.accept_records(records)
    }

    pub(super) fn finish_stream(&mut self) -> Vec<ClaudeEmission> {
        if self.terminal.is_some() {
            self.lines.discard();
            return Vec::new();
        }
        self.lines
            .finish()
            .map_or_else(Vec::new, |record| self.accept_records([record]))
    }

    pub(super) fn token_usage(&self) -> Option<TokenUsageDelta> {
        self.terminal_usage
            .unwrap_or_else(|| self.provisional_usage.total())
    }

    pub(super) fn is_success(&self) -> bool {
        self.session_failure.is_none() && matches!(self.terminal, Some(ClaudeTerminal::Complete(_)))
    }

    pub(super) fn finish(
        mut self,
        process_failure: Option<&str>,
    ) -> Result<ClaudeAttempt, NodeRunnerError> {
        let process_failure = process_failure.filter(|detail| !detail.trim().is_empty());
        let missing_terminal = self.missing_terminal_detail();
        let terminal = self
            .terminal
            .take()
            .unwrap_or(ClaudeTerminal::Failed(missing_terminal));
        match terminal {
            ClaudeTerminal::Complete(result) => self.finish_complete(result, process_failure),
            ClaudeTerminal::Failed(diagnostic) => {
                Ok(self.finish_failed(diagnostic, process_failure))
            }
        }
    }

    fn finish_complete(
        self,
        result: Value,
        process_failure: Option<&str>,
    ) -> Result<ClaudeAttempt, NodeRunnerError> {
        if let Some(session_failure) = self.session_failure.as_deref() {
            return Ok(ClaudeAttempt::Failed(ClaudeFailure {
                session_id: self.session_id,
                retryable: self.retryable_failure_seen,
                diagnostic: combine_failure_detail(session_failure, process_failure),
            }));
        }
        if let Some(process_failure) = process_failure {
            return Ok(ClaudeAttempt::Failed(ClaudeFailure {
                session_id: self.session_id,
                retryable: self.retryable_failure_seen,
                diagnostic: process_failure.trim().to_owned(),
            }));
        }
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

    fn finish_failed(self, diagnostic: String, process_failure: Option<&str>) -> ClaudeAttempt {
        let diagnostic = match self.session_failure {
            Some(session_failure) => combine_failure_detail(&session_failure, Some(&diagnostic)),
            None => diagnostic,
        };
        ClaudeAttempt::Failed(ClaudeFailure {
            session_id: self.session_id,
            retryable: self.retryable_failure_seen,
            diagnostic: combine_failure_detail(&diagnostic, process_failure),
        })
    }

    fn accept_records(
        &mut self,
        records: impl IntoIterator<Item = ProviderJsonLine>,
    ) -> Vec<ClaudeEmission> {
        let mut emissions = Vec::new();
        for record in records {
            if self.terminal.is_some() {
                self.lines.discard();
                break;
            }
            self.accept_record(record, &mut emissions);
        }
        emissions
    }

    fn accept_record(&mut self, record: ProviderJsonLine, emissions: &mut Vec<ClaudeEmission>) {
        let ProviderJsonLine::Record(line) = record else {
            self.oversized_records = self.oversized_records.saturating_add(1);
            return;
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            self.malformed_records = self.malformed_records.saturating_add(1);
            return;
        };
        let Some(object) = event.as_object() else {
            self.malformed_records = self.malformed_records.saturating_add(1);
            return;
        };
        let Some(event_type) = object.get("type").and_then(Value::as_str) else {
            self.malformed_records = self.malformed_records.saturating_add(1);
            return;
        };
        if !matches!(
            event_type,
            "system" | "stream_event" | "assistant" | "result"
        ) {
            return;
        }
        if let Err(diagnostic) = record_session_id(object.get("session_id"), &mut self.session_id) {
            if self.session_failure.is_none() {
                self.session_failure = Some(diagnostic.to_owned());
            }
        }
        self.dispatch_event(event_type, object, emissions);
    }

    fn dispatch_event(
        &mut self,
        event_type: &str,
        object: &serde_json::Map<String, Value>,
        emissions: &mut Vec<ClaudeEmission>,
    ) {
        match event_type {
            "system" => self.parse_system(object, emissions),
            "stream_event" => self.parse_stream_event(object, emissions),
            "assistant" => self.parse_assistant(object, emissions),
            "result" => self.parse_result(object),
            _ => {}
        }
    }

    fn parse_system(
        &mut self,
        event: &serde_json::Map<String, Value>,
        emissions: &mut Vec<ClaudeEmission>,
    ) {
        if event.get("subtype").and_then(Value::as_str) != Some("api_retry") {
            return;
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
            emissions,
            LiveOutputStream::System,
            &format!("Claude API retry {attempt}/{maximum}: {error}"),
        );
    }

    fn parse_stream_event(
        &mut self,
        event: &serde_json::Map<String, Value>,
        emissions: &mut Vec<ClaudeEmission>,
    ) {
        let Some(inner) = event.get("event").and_then(Value::as_object) else {
            return;
        };
        match inner.get("type").and_then(Value::as_str) {
            Some("message_start") => self.parse_message_start(inner),
            Some("message_delta") => self.parse_message_delta(inner),
            Some("message_stop") => {
                self.active_stream_message = None;
            }
            Some("content_block_delta") => self.parse_content_delta(inner, emissions),
            _ => {}
        }
    }

    fn parse_content_delta(
        &mut self,
        event: &serde_json::Map<String, Value>,
        emissions: &mut Vec<ClaudeEmission>,
    ) {
        let Some(delta) = event.get("delta").and_then(Value::as_object) else {
            return;
        };
        let (field, stream) = match delta.get("type").and_then(Value::as_str) {
            Some("text_delta") => ("text", LiveOutputStream::Output),
            Some("thinking_delta") => ("thinking", LiveOutputStream::System),
            _ => return,
        };
        if let Some(text) = delta.get(field).and_then(Value::as_str) {
            if field == "text" {
                self.visible_text_emitted = true;
            }
            self.emit(emissions, stream, text);
        }
    }

    fn parse_message_start(&mut self, event: &serde_json::Map<String, Value>) {
        self.active_stream_message = None;
        let Some(message) = event.get("message").and_then(Value::as_object) else {
            return;
        };
        let Some(message_id) = message_identity(message) else {
            if message.contains_key("usage") {
                self.provisional_usage.invalidate();
            }
            return;
        };
        self.active_stream_message = Some(message_id.to_owned());
        if message.contains_key("usage") {
            match parse_usage_snapshot(message.get("usage"), UsageKeys::CLAUDE_STREAM) {
                Some(usage) => self.provisional_usage.replace_message(message_id, usage),
                None => self.provisional_usage.invalidate(),
            }
        }
    }

    fn parse_message_delta(&mut self, event: &serde_json::Map<String, Value>) {
        if !event.contains_key("usage") {
            return;
        }
        let Some(message_id) = self.active_stream_message.as_deref() else {
            self.provisional_usage.invalidate();
            return;
        };
        match parse_usage_snapshot(event.get("usage"), UsageKeys::CLAUDE_STREAM) {
            Some(usage) => self.provisional_usage.merge_message(message_id, usage),
            None => self.provisional_usage.invalidate(),
        }
    }

    fn parse_assistant(
        &mut self,
        event: &serde_json::Map<String, Value>,
        emissions: &mut Vec<ClaudeEmission>,
    ) {
        let Some(message) = event.get("message").and_then(Value::as_object) else {
            return;
        };
        self.record_assistant_usage(event, message);
        if self.visible_text_emitted {
            return;
        }
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            return;
        };
        for block in content {
            let Some(block) = block.as_object() else {
                continue;
            };
            if block.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    self.emit(emissions, LiveOutputStream::Output, text);
                    self.visible_text_emitted = true;
                }
            }
        }
    }

    fn record_assistant_usage(
        &mut self,
        event: &serde_json::Map<String, Value>,
        message: &serde_json::Map<String, Value>,
    ) {
        if !message.contains_key("usage") {
            return;
        }
        let Some(usage) = parse_usage_snapshot(message.get("usage"), UsageKeys::CLAUDE_STREAM)
        else {
            self.provisional_usage.invalidate();
            return;
        };
        let identity = message_identity(message).or_else(|| message_identity(event));
        if let Some(message_id) = identity {
            self.provisional_usage.replace_message(message_id, usage);
        } else {
            self.provisional_usage.add_anonymous(usage);
        }
    }

    fn parse_result(&mut self, event: &serde_json::Map<String, Value>) {
        match parse_terminal_usage(
            event.get("modelUsage"),
            event.get("model_usage"),
            event.get("usage"),
        ) {
            TerminalUsage::Empty => {}
            TerminalUsage::Valid(usage) => self.terminal_usage = Some(Some(usage)),
            TerminalUsage::Malformed => self.terminal_usage = Some(None),
        }
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
            self.terminal = Some(ClaudeTerminal::Failed(diagnostic));
            return;
        }
        self.terminal = Some(ClaudeTerminal::Complete(
            event
                .get("structured_output")
                .filter(|value| !value.is_null())
                .or_else(|| event.get("result"))
                .cloned()
                .unwrap_or(Value::Null),
        ));
    }

    fn emit(&self, emissions: &mut Vec<ClaudeEmission>, stream: LiveOutputStream, text: &str) {
        let safe = safe_provider_text(text, &self.redactions);
        for chunk in utf8_chunks(&safe, LIVE_CHUNK_BYTES) {
            emissions.push(ClaudeEmission {
                stream,
                text: chunk,
            });
        }
    }

    fn missing_terminal_detail(&self) -> String {
        let mut diagnostic = if self.retryable_failure_seen {
            "Claude execution ended after a retryable API error without a terminal result"
                .to_owned()
        } else {
            "Claude output ended without a terminal result".to_owned()
        };
        let mut discarded = Vec::new();
        if self.malformed_records > 0 {
            discarded.push(record_count(self.malformed_records, "malformed"));
        }
        if self.oversized_records > 0 {
            discarded.push(record_count(self.oversized_records, "oversized"));
        }
        if !discarded.is_empty() {
            diagnostic.push_str("; discarded ");
            diagnostic.push_str(&discarded.join(" and "));
        }
        diagnostic
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
#[path = "transcript/tests.rs"]
mod tests;
