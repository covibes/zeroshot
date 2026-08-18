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
    failed: bool,
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
            failed: false,
        }
    }

    fn validate(&self) -> Result<(), NodeRunnerError> {
        if !self.completed || self.failed || self.messages.is_empty() {
            return Err(NodeRunnerError::Driver);
        }
        Ok(())
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
        if event_type == "item.started" || event_type == "item.completed" {
            return self.accept_item(&event, event_type == "item.completed");
        }
        self.accept_turn_event(event_type)
    }

    fn accept_turn_event(
        &mut self,
        event_type: &str,
    ) -> Result<Option<CodexEmission>, NodeRunnerError> {
        let message = match event_type {
            "turn.started" => "Codex turn started",
            "turn.completed" => {
                self.completed = true;
                "Codex turn completed"
            }
            "turn.failed" | "error" => {
                self.failed = true;
                "Codex turn failed"
            }
            _ => return Ok(None),
        };
        Ok(Some(CodexEmission::Progress(message.to_owned())))
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
        completed: bool,
    ) -> Result<Option<CodexEmission>, NodeRunnerError> {
        let Some(item) = event.get("item") else {
            return Err(NodeRunnerError::Driver);
        };
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .ok_or(NodeRunnerError::Driver)?;
        if item_type != "agent_message" {
            return Ok(Some(CodexEmission::Progress(progress_message(
                item_type, completed,
            ))));
        }
        if !completed {
            return Ok(None);
        }
        let message = item
            .get("text")
            .and_then(Value::as_str)
            .ok_or(NodeRunnerError::Driver)?;
        self.messages.push(message.to_owned());
        Ok(Some(CodexEmission::AgentMessage(message.to_owned())))
    }
}

fn progress_message(item_type: &str, completed: bool) -> String {
    let activity = match item_type {
        "reasoning" => "reasoning",
        "command_execution" => "command",
        "file_change" => "file change",
        "mcp_tool_call" => "tool call",
        "web_search" => "web search",
        _ => "activity",
    };
    let phase = if completed { "completed" } else { "started" };
    format!("Codex {activity} {phase}")
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
}
