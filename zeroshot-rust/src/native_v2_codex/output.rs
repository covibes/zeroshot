use serde_json::Value;

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
    pub(super) messages: Vec<String>,
    completed: bool,
    failure: Option<String>,
}

pub(super) struct CodexOutputDecoder {
    pending: Vec<u8>,
    output: CodexOutput,
}

impl CodexOutputDecoder {
    pub(super) fn new() -> Self {
        Self {
            pending: Vec::new(),
            output: CodexOutput::empty(),
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<Vec<CodexEmission>, NodeRunnerError> {
        self.pending.extend_from_slice(bytes);
        let mut emitted = Vec::new();
        while let Some(line) = take_complete_line(&mut self.pending) {
            if let Some(message) = self.output.accept_bytes(&line)? {
                emitted.push(message);
            }
        }
        Ok(emitted)
    }

    pub(super) fn finish(mut self) -> Result<CodexOutput, NodeRunnerError> {
        if !self.pending.is_empty() {
            self.output.accept_bytes(&self.pending)?;
        }
        self.output.validate()?;
        Ok(self.output)
    }
}

fn take_complete_line(pending: &mut Vec<u8>) -> Option<Vec<u8>> {
    let newline = pending.iter().position(|byte| *byte == b'\n')?;
    let remainder = pending.split_off(newline + 1);
    let mut line = std::mem::replace(pending, remainder);
    line.pop();
    Some(line)
}

impl CodexOutput {
    #[cfg(test)]
    pub(super) fn parse(bytes: &[u8]) -> Result<Self, NodeRunnerError> {
        let mut decoder = CodexOutputDecoder::new();
        decoder.push(bytes)?;
        decoder.finish()
    }

    fn empty() -> Self {
        Self {
            thread_id: None,
            messages: Vec::new(),
            completed: false,
            failure: None,
        }
    }

    fn validate(&self) -> Result<(), NodeRunnerError> {
        if self.completed == self.failure.is_some() || self.completed && self.messages.is_empty() {
            return Err(NodeRunnerError::Driver);
        }
        Ok(())
    }

    pub(super) fn failure_message(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    pub(super) fn final_message(&self) -> Result<&str, NodeRunnerError> {
        self.messages
            .last()
            .map(String::as_str)
            .ok_or(NodeRunnerError::Driver)
    }

    fn accept_bytes(&mut self, line: &[u8]) -> Result<Option<CodexEmission>, NodeRunnerError> {
        let line = std::str::from_utf8(line).map_err(|_| NodeRunnerError::Driver)?;
        if line.trim().is_empty() {
            return Ok(None);
        }
        let event: Value = serde_json::from_str(line).map_err(|_| NodeRunnerError::Driver)?;
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or(NodeRunnerError::Driver)?;
        if event_type == "thread.started" {
            return self.accept_thread(&event).map(|()| None);
        }
        if matches!(
            event_type,
            "item.started" | "item.updated" | "item.completed"
        ) {
            return self.accept_item(&event, event_type);
        }
        self.accept_turn_event(&event, event_type)
    }

    fn accept_turn_event(
        &mut self,
        event: &Value,
        event_type: &str,
    ) -> Result<Option<CodexEmission>, NodeRunnerError> {
        let message = match event_type {
            "turn.started" => "Codex turn started",
            "turn.completed" => {
                self.completed = true;
                "Codex turn completed"
            }
            "turn.failed" | "error" => {
                self.record_failure(event, event_type);
                "Codex turn failed"
            }
            _ => return Ok(None),
        };
        Ok(Some(CodexEmission::Progress(message.to_owned())))
    }

    fn record_failure(&mut self, event: &Value, event_type: &str) {
        if self.failure.is_some() {
            return;
        }
        let detail = if event_type == "turn.failed" {
            event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        } else {
            event.get("message").and_then(Value::as_str)
        };
        self.failure = Some(
            detail
                .filter(|message| !message.trim().is_empty())
                .unwrap_or("Codex turn failed without provider detail")
                .to_owned(),
        );
    }

    fn accept_thread(&mut self, event: &Value) -> Result<(), NodeRunnerError> {
        let thread_id = event
            .get("thread_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(NodeRunnerError::Driver)?;
        match self.thread_id.as_deref() {
            Some(current) if current != thread_id => Err(NodeRunnerError::Driver),
            Some(_) => Ok(()),
            None => {
                self.thread_id = Some(thread_id.to_owned());
                Ok(())
            }
        }
    }

    fn accept_item(
        &mut self,
        event: &Value,
        event_type: &str,
    ) -> Result<Option<CodexEmission>, NodeRunnerError> {
        let Some(item) = event.get("item") else {
            return Err(NodeRunnerError::Driver);
        };
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .ok_or(NodeRunnerError::Driver)?;
        let phase = event_type
            .strip_prefix("item.")
            .ok_or(NodeRunnerError::Driver)?;
        match item_type {
            "agent_message" if event_type == "item.completed" => {
                let message = item
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or(NodeRunnerError::Driver)?;
                self.messages.push(message.to_owned());
                Ok(Some(CodexEmission::AgentMessage(message.to_owned())))
            }
            "agent_message" => Ok(None),
            _ => Ok(Some(CodexEmission::Progress(semantic_item(
                item, item_type, phase,
            )))),
        }
    }
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
mod tests {
    use openengine_cluster_testkit::assertions::AssertValue;
    use serde_json::json;

    use super::*;

    #[test]
    fn normalizes_worker_and_verifier_messages() {
        let worker = CodexOutput::parse(
            br#"{"type":"thread.started","thread_id":"thread-1"}
{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":42}"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}
"#,
        )
        .assert_value();
        assert_eq!(worker.final_message().assert_value(), r#"{"answer":42}"#);

        let verifier_events = concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-2\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",",
            "\"text\":\"{\\\"output\\\":{\\\"ok\\\":true},",
            "\\\"signals\\\":{\\\"decision\\\":\\\"pass\\\"},",
            "\\\"diagnostic\\\":null}\"}}\n",
            "{\"type\":\"turn.completed\"}\n",
        );
        let verifier = CodexOutput::parse(verifier_events.as_bytes()).assert_value();
        assert_eq!(
            serde_json::from_str::<Value>(verifier.final_message().assert_value()).assert_value(),
            json!({
                "output": { "ok": true },
                "signals": { "decision": "pass" },
                "diagnostic": null
            })
        );
    }

    #[test]
    fn rejects_missing_terminal_or_final_message() {
        assert_eq!(
            CodexOutput::parse(br#"{"type":"thread.started","thread_id":"thread-1"}"#).err(),
            Some(NodeRunnerError::Driver)
        );
        assert_eq!(
            CodexOutput::parse(br#"{"type":"turn.completed"}"#).err(),
            Some(NodeRunnerError::Driver)
        );
    }

    #[test]
    fn retains_terminal_failure_detail_for_the_retry_policy() {
        let failed = CodexOutput::parse(
            br#"{"type":"thread.started","thread_id":"thread-1"}
{"type":"turn.failed","error":{"message":"service unavailable"}}
"#,
        )
        .assert_value();

        assert_eq!(failed.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(failed.failure_message(), Some("service unavailable"));
    }

    #[test]
    fn projects_provider_items_to_semantic_attach_messages() {
        let mut decoder = CodexOutputDecoder::new();
        let emissions = decoder
            .push(
                concat!(
                    "{\"type\":\"item.updated\",\"item\":{\"type\":\"reasoning\",\"text\":\"checking tests\"}}\n",
                    "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",",
                    "\"command\":\"cargo test\",\"aggregated_output\":\"ok\",",
                    "\"exit_code\":0,\"status\":\"completed\"}}\n",
                    "{\"type\":\"item.completed\",\"item\":{\"type\":\"file_change\",",
                    "\"changes\":[{\"path\":\"src/lib.rs\",\"kind\":\"update\"}],",
                    "\"status\":\"completed\"}}\n",
                    "{\"type\":\"item.completed\",\"item\":{\"type\":\"mcp_tool_call\",",
                    "\"server\":\"github\",\"tool\":\"get_pr\",",
                    "\"result\":{\"number\":7},\"status\":\"completed\"}}\n",
                )
                .as_bytes(),
            )
            .assert_value();
        let messages = emissions
            .iter()
            .map(|emission| emission.log().1)
            .collect::<Vec<_>>();

        assert_eq!(
            messages,
            [
                "Codex reasoning updated: checking tests",
                "Codex command completed: cargo test [completed] exit=0\nok",
                "Codex file change completed: update src/lib.rs",
                "Codex tool completed: github.get_pr result={\"number\":7}",
            ]
        );
    }
}
