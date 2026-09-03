use serde_json::Value;

use crate::native_v2_capsule::provider_json_lines::{ProviderJsonLine, ProviderJsonLines};
use crate::native_v2_contract::{TokenUsageDelta, parse_token_usage_delta};
use crate::native_v2_runner::{LiveOutputStream, NodeRunnerError};

pub(super) enum CodexEmission {
    AgentMessage(String),
    Progress(String),
}

impl CodexEmission {
    pub(super) fn log(&self) -> (LiveOutputStream, &str) {
        match self {
            Self::AgentMessage(message) => (LiveOutputStream::Output, message),
            Self::Progress(message) => (LiveOutputStream::System, message.as_str()),
        }
    }
}

pub(super) struct CodexOutput {
    pub(super) thread_id: Option<String>,
    thread_failure: Option<String>,
    final_message: Option<String>,
    terminal: Option<CodexTerminal>,
    failure: Option<String>,
    token_usage: Option<TokenUsageDelta>,
    malformed_records: usize,
    oversized_records: usize,
}

pub(super) struct CodexOutputDecoder {
    lines: ProviderJsonLines,
    output: CodexOutput,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CodexTerminal {
    Completed,
    Failed,
}

enum TerminalUsage {
    Empty,
    Valid(TokenUsageDelta),
    Malformed,
}

enum AcceptedLine {
    Emission(CodexEmission),
    Ignored,
    Malformed,
    ThreadFailure(String),
}

impl CodexOutputDecoder {
    pub(super) fn new() -> Self {
        Self {
            lines: ProviderJsonLines::new(),
            output: CodexOutput::empty(),
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> Vec<CodexEmission> {
        if self.output.is_settled() {
            self.lines.discard();
            return Vec::new();
        }
        let mut emitted = Vec::new();
        for line in self.lines.push(bytes) {
            if self.output.is_settled() {
                break;
            }
            if let Some(emission) = self.accept_line(line) {
                emitted.push(emission);
            }
        }
        if self.output.is_settled() {
            self.lines.discard();
        }
        emitted
    }

    pub(super) fn finish(mut self) -> CodexOutput {
        if self.output.is_settled() {
            self.lines.discard();
        } else if let Some(line) = self.lines.finish() {
            self.accept_line(line);
        }
        self.output.finalize();
        self.output
    }

    fn accept_line(&mut self, line: ProviderJsonLine) -> Option<CodexEmission> {
        match line {
            ProviderJsonLine::Oversized => {
                self.output.oversized_records = self.output.oversized_records.saturating_add(1);
                None
            }
            ProviderJsonLine::Record(line) => match self.output.accept_bytes(&line) {
                AcceptedLine::Emission(emission) => Some(emission),
                AcceptedLine::Ignored => None,
                AcceptedLine::Malformed => {
                    self.output.malformed_records = self.output.malformed_records.saturating_add(1);
                    None
                }
                AcceptedLine::ThreadFailure(detail) => {
                    if self.output.thread_failure.is_none() {
                        self.output.thread_failure = Some(detail);
                    }
                    None
                }
            },
        }
    }
}

impl CodexOutput {
    #[cfg(test)]
    pub(super) fn parse(bytes: &[u8]) -> Self {
        let mut decoder = CodexOutputDecoder::new();
        decoder.push(bytes);
        decoder.finish()
    }

    fn empty() -> Self {
        Self {
            thread_id: None,
            thread_failure: None,
            final_message: None,
            terminal: None,
            failure: None,
            token_usage: None,
            malformed_records: 0,
            oversized_records: 0,
        }
    }

    pub(super) fn provider_failure(detail: String) -> Self {
        let mut output = Self::empty();
        output.merge_failure_detail(detail);
        output
    }

    fn is_settled(&self) -> bool {
        self.terminal.is_some()
    }

    fn finalize(&mut self) {
        self.finalize_terminal();
        self.prepend_thread_failure();
    }

    fn finalize_terminal(&mut self) {
        match self.terminal {
            Some(CodexTerminal::Completed) if self.final_message.is_none() => {
                self.failure = Some(
                    self.incomplete_detail("Codex turn completed without a final agent message"),
                );
            }
            Some(CodexTerminal::Completed) => self.failure = None,
            Some(CodexTerminal::Failed) => {
                if self.failure.is_none() {
                    self.failure =
                        Some(self.incomplete_detail("Codex turn failed without provider detail"));
                }
            }
            None => {
                if self.failure.is_none() {
                    self.failure = Some(
                        self.incomplete_detail("Codex output ended without a terminal turn event"),
                    );
                }
            }
        }
    }

    fn prepend_thread_failure(&mut self) {
        if let Some(thread_failure) = self.thread_failure.take() {
            self.failure = Some(match self.failure.take() {
                Some(failure) if failure == thread_failure => thread_failure,
                Some(failure) => format!("{thread_failure}; {failure}"),
                None => thread_failure,
            });
        }
    }

    fn incomplete_detail(&self, message: &str) -> String {
        match (self.malformed_records, self.oversized_records) {
            (0, 0) => message.to_owned(),
            (malformed, oversized) => format!(
                "{message}; ignored {malformed} malformed and {oversized} oversized output records"
            ),
        }
    }

    pub(super) fn merge_failure_detail(&mut self, detail: String) {
        let detail = detail.trim();
        if detail.is_empty() {
            return;
        }
        self.failure = Some(match self.failure.take() {
            Some(existing) if existing == detail => existing,
            Some(existing) => format!("{existing}; {detail}"),
            None => detail.to_owned(),
        });
        self.terminal = Some(CodexTerminal::Failed);
    }

    pub(super) fn failure_message(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    pub(super) fn token_usage(&self) -> Option<TokenUsageDelta> {
        self.token_usage
    }

    pub(super) fn final_message(&self) -> Result<&str, NodeRunnerError> {
        self.final_message.as_deref().ok_or(NodeRunnerError::Driver)
    }

    fn accept_bytes(&mut self, line: &[u8]) -> AcceptedLine {
        let Ok(line) = std::str::from_utf8(line) else {
            return AcceptedLine::Malformed;
        };
        if line.trim().is_empty() {
            return AcceptedLine::Ignored;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return AcceptedLine::Malformed;
        };
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            return AcceptedLine::Malformed;
        };
        if event_type == "thread.started" {
            return self.accept_thread(&event);
        }
        if matches!(
            event_type,
            "item.started" | "item.updated" | "item.completed"
        ) {
            return self.accept_item(&event, event_type);
        }
        self.accept_turn_event(&event, event_type)
    }

    fn accept_turn_event(&mut self, event: &Value, event_type: &str) -> AcceptedLine {
        if self.is_settled() {
            return AcceptedLine::Ignored;
        }
        let message = match event_type {
            "turn.started" => "Codex turn started",
            "turn.completed" => {
                self.terminal = Some(CodexTerminal::Completed);
                self.failure = None;
                self.record_terminal_usage(event);
                "Codex turn completed"
            }
            "turn.failed" => {
                self.terminal = Some(CodexTerminal::Failed);
                self.record_terminal_usage(event);
                if let Some(detail) = failure_detail(event, event_type) {
                    self.failure = Some(detail);
                }
                "Codex turn failed"
            }
            "error" => {
                if event.get("usage").is_some() {
                    self.token_usage = token_usage(event.get("usage"));
                }
                self.failure = failure_detail(event, event_type)
                    .or_else(|| Some("Codex stream error without provider detail".to_owned()));
                "Codex stream error"
            }
            _ => return AcceptedLine::Ignored,
        };
        AcceptedLine::Emission(CodexEmission::Progress(message.to_owned()))
    }

    fn record_terminal_usage(&mut self, event: &Value) {
        match terminal_usage(event) {
            TerminalUsage::Empty => {}
            TerminalUsage::Valid(usage) => self.token_usage = Some(usage),
            TerminalUsage::Malformed => self.token_usage = None,
        }
    }

    fn accept_thread(&mut self, event: &Value) -> AcceptedLine {
        let Some(thread_id) = event
            .get("thread_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return AcceptedLine::Malformed;
        };
        match self.thread_id.as_deref() {
            Some(current) if current != thread_id => AcceptedLine::ThreadFailure(
                "Codex output contained conflicting thread IDs".to_owned(),
            ),
            Some(_) => AcceptedLine::Ignored,
            None => {
                self.thread_id = Some(thread_id.to_owned());
                AcceptedLine::Ignored
            }
        }
    }

    fn accept_item(&mut self, event: &Value, event_type: &str) -> AcceptedLine {
        let Some(item) = event.get("item") else {
            return AcceptedLine::Malformed;
        };
        let Some(item_type) = item.get("type").and_then(Value::as_str) else {
            return AcceptedLine::Malformed;
        };
        let Some(phase) = event_type.strip_prefix("item.") else {
            return AcceptedLine::Malformed;
        };
        match item_type {
            "agent_message" if event_type == "item.completed" => {
                let Some(message) = item.get("text").and_then(Value::as_str) else {
                    return AcceptedLine::Malformed;
                };
                self.final_message = Some(message.to_owned());
                AcceptedLine::Emission(CodexEmission::AgentMessage(message.to_owned()))
            }
            "agent_message" => AcceptedLine::Ignored,
            _ => AcceptedLine::Emission(CodexEmission::Progress(semantic_item(
                item, item_type, phase,
            ))),
        }
    }
}

fn token_usage(value: Option<&Value>) -> Option<TokenUsageDelta> {
    parse_token_usage_delta(
        value,
        Some("cached_input_tokens"),
        Some("cache_write_input_tokens"),
    )
}

fn terminal_usage(event: &Value) -> TerminalUsage {
    match event.get("usage") {
        None | Some(Value::Null) => TerminalUsage::Empty,
        Some(Value::Object(usage)) if usage.is_empty() => TerminalUsage::Empty,
        value => token_usage(value).map_or(TerminalUsage::Malformed, TerminalUsage::Valid),
    }
}

fn failure_detail(event: &Value, event_type: &str) -> Option<String> {
    let detail = if event_type == "turn.failed" {
        event.get("error").and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
    } else {
        event.get("message").and_then(Value::as_str).or_else(|| {
            event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
    };
    detail
        .filter(|message| !message.trim().is_empty())
        .map(str::to_owned)
}

fn semantic_item(item: &Value, item_type: &str, phase: &str) -> String {
    match item_type {
        "reasoning" => semantic_reasoning(item, phase),
        "command_execution" => semantic_command(item, phase),
        "file_change" => semantic_file_change(item, phase),
        "mcp_tool_call" => semantic_tool_call(item, phase),
        "web_search" => semantic_web_search(item, phase),
        "todo_list" => semantic_todo_list(item, phase),
        "error" => format!(
            "Codex activity error: {}",
            item.get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ),
        _ => format!("Codex activity {phase}: {item_type}"),
    }
}

fn semantic_reasoning(item: &Value, phase: &str) -> String {
    match item.get("text").and_then(Value::as_str) {
        Some(text) if !text.is_empty() => format!("Codex reasoning {phase}: {text}"),
        _ => format!("Codex reasoning {phase}"),
    }
}

fn semantic_command(item: &Value, phase: &str) -> String {
    let command = item
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("unknown command");
    let mut message = format!("Codex command {phase}: {command}");
    if let Some(status) = item.get("status").and_then(Value::as_str) {
        message.push_str(&format!(" [{status}]"));
    }
    if let Some(exit_code) = item.get("exit_code").and_then(Value::as_i64) {
        message.push_str(&format!(" exit={exit_code}"));
    }
    if let Some(output) = item
        .get("aggregated_output")
        .and_then(Value::as_str)
        .filter(|output| !output.is_empty())
    {
        message.push('\n');
        message.push_str(output);
    }
    message
}

fn semantic_file_change(item: &Value, phase: &str) -> String {
    let changes = item
        .get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| {
                    Some(format!(
                        "{} {}",
                        change.get("kind")?.as_str()?,
                        change.get("path")?.as_str()?
                    ))
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|changes| !changes.is_empty())
        .unwrap_or_else(|| "unknown changes".to_owned());
    let status = item.get("status").and_then(Value::as_str).unwrap_or(phase);
    format!("Codex file change {status}: {changes}")
}

fn semantic_tool_call(item: &Value, phase: &str) -> String {
    let server = item
        .get("server")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let tool = item
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let status = item.get("status").and_then(Value::as_str).unwrap_or(phase);
    let mut message = format!("Codex tool {status}: {server}.{tool}");
    if let Some(error) = item
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        message.push_str(&format!(" error={error}"));
    } else if let Some(result) = item.get("result").filter(|result| !result.is_null()) {
        message.push_str(" result=");
        message.push_str(&result.to_string());
    }
    message
}

fn semantic_web_search(item: &Value, phase: &str) -> String {
    let query = item
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("unknown query");
    format!("Codex web search {phase}: {query}")
}

fn semantic_todo_list(item: &Value, phase: &str) -> String {
    let items = item
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let text = item.get("text")?.as_str()?;
                    let marker = if item.get("completed").and_then(Value::as_bool) == Some(true) {
                        "done"
                    } else {
                        "pending"
                    };
                    Some(format!("{marker}: {text}"))
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| "empty".to_owned());
    format!("Codex plan {phase}: {items}")
}

#[cfg(test)]
#[path = "output/tests.rs"]
mod tests;
