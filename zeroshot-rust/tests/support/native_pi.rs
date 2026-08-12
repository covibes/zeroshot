use std::path::{Path, PathBuf};

use serde_json::json;

use super::native_process::{
    install_test_executable, provider_environment, NativeClient, NativeProcess, ProviderProcess,
    TempState,
};

pub const API_KEY: &str = "test-native-pi-openai-key";
pub const PROMPT: &str = "Return one concise response.";
pub const RESPONSE: &str = "final Pi response";
const FAKE_PI: &str = r###"#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "pi-test-config.json"), "utf8"));
const args = process.argv.slice(2);
const deny = [
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-approve",
  "--no-tools",
];
const probe = (tail) => JSON.stringify(args) === JSON.stringify([...deny, ...tail]);

if (probe(["--version"])) {
  console.log(config.mode === "bad-version" ? "pi 0.83.9" : "pi 0.84.1");
  process.exit(0);
}
if (probe(["--help"])) {
  const flags = [
    "--mode", ...deny, "--provider", "--model", "--thinking", "--offline",
    "--list-models", "--version",
  ];
  console.log(flags.map((flag) => config.mode === "missing-flag" && flag === "--no-tools"
    ? "--no-tools-extra" : flag).join(" "));
  process.exit(0);
}
if (probe(["--offline", "--list-models", "gpt-5.4"])) {
  if (process.env.OPENAI_API_KEY !== "zeroshot-local-model-probe") process.exit(31);
  console.log("provider  model  context  max-out  thinking  images");
  console.log(config.mode === "missing-model"
    ? "openai  gpt-4.1  128K  32K  yes  yes"
    : "openai  gpt-5.4  128K  32K  yes  yes");
  process.exit(0);
}

const expectedArgs = [
  "--mode", "json", ...deny, "--provider", "openai", "--model", "gpt-5.4",
  "--thinking", "medium",
];
if (JSON.stringify(args) !== JSON.stringify(expectedArgs)) process.exit(32);
if (process.env.OPENAI_API_KEY !== config.apiKey) process.exit(33);
if ("ZEROSHOT_SECRET_SENTINEL" in process.env || "HOME" in process.env) process.exit(34);
const expectedEnv = [
  "OPENAI_API_KEY", "PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
];
if (JSON.stringify(Object.keys(process.env).sort()) !== JSON.stringify(expectedEnv)) process.exit(35);
if (process.env.PI_OFFLINE !== "1" || process.env.PI_SKIP_VERSION_CHECK !== "1"
    || process.env.PI_TELEMETRY !== "0") process.exit(36);

const cwd = process.cwd();
const privateConfig = process.env.PI_CODING_AGENT_DIR;
if (cwd === config.borrowedWorkspace || path.basename(cwd) !== "workspace"
    || !cwd.startsWith(config.state) || !privateConfig.startsWith(config.state)
    || path.basename(privateConfig) !== "config") process.exit(37);
if (fs.readdirSync(cwd).length !== 0 || fs.readdirSync(privateConfig).length !== 0) process.exit(38);
const prompt = fs.readFileSync(0, "utf8");
if (prompt !== config.prompt) process.exit(39);
fs.appendFileSync(config.counter, `${process.pid}\n`);

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text, stopReason) => ({
  role: "assistant",
  content: text ? [{ type: "thinking", thinking: "bounded" }, { type: "text", text }] : [],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.4",
  usage: config.mode === "malformed-usage" ? {} : usage,
  stopReason,
  timestamp: 2,
});
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const emitMessage = (message) => {
  emit({ type: "message_start", message });
  emit({ type: "message_end", message });
};

if (config.mode === "truncated") {
  process.stdout.write('{"type":');
  process.exit(0);
}
if (config.mode !== "no-session") {
  emit({ type: "session", version: 3, id: "native-pi-test",
    timestamp: "2026-01-01T00:00:00Z", cwd });
}
emit({ type: "agent_start" });
emit({ type: "turn_start" });
const user = { role: "user", content: prompt, timestamp: 1 };
emitMessage(user);
if (config.mode === "unknown-event") {
  emit({ type: "unknown_event" });
  process.exit(0);
}

if (config.mode === "success" || config.mode === "trailing") {
  const retryMessage = assistant("", "error");
  emitMessage(retryMessage);
  emit({ type: "turn_end", message: retryMessage, toolResults: [] });
  emit({ type: "agent_end", messages: [user, retryMessage], willRetry: true });
  emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3,
    delayMs: 1, errorMessage: "retry" });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
}
if (config.mode === "compaction") {
  const overflowMessage = assistant("", "error");
  emitMessage(overflowMessage);
  emit({ type: "turn_end", message: overflowMessage, toolResults: [] });
  emit({ type: "agent_end", messages: [user, overflowMessage], willRetry: false });
  emit({ type: "compaction_start", reason: "overflow" });
  emit({ type: "compaction_end", reason: "overflow", result: {
    summary: "bounded", firstKeptEntryId: "entry-1", tokensBefore: 2,
    estimatedTokensAfter: 1, usage, details: {},
  }, aborted: false, willRetry: true });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
}

const stopReason = config.mode === "success" || config.mode === "trailing"
  || config.mode === "compaction" || config.mode === "incomplete"
  || config.mode === "tool-message" || config.mode === "tool-message-start"
  || config.mode === "tool-agent-end"
  || config.mode === "malformed-usage" ? "stop" : config.mode;
const finalMessage = assistant(config.response, stopReason);
if (config.mode === "tool-message") {
  finalMessage.content.push({ type: "toolCall", id: "forbidden", name: "bash", arguments: {} });
}
const startMessage = config.mode === "tool-message-start" ? {
  ...finalMessage,
  content: [...finalMessage.content,
    { type: "toolCall", id: "forbidden", name: "bash", arguments: {} }],
} : finalMessage;
emit({ type: "message_start", message: startMessage });
emit({ type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "final" } });
emit({ type: "message_end", message: finalMessage });
if (config.mode === "success" || config.mode === "trailing") {
  emit({ type: "auto_retry_end", success: true, attempt: 1 });
}
emit({ type: "turn_end", message: finalMessage, toolResults: [] });
const endMessages = config.mode === "tool-agent-end"
  ? [finalMessage, { role: "toolResult", toolCallId: "forbidden", toolName: "bash",
    content: [{ type: "text", text: "hidden" }], isError: false, timestamp: 3 }]
  : [finalMessage];
emit({ type: "agent_end", messages: endMessages, willRetry: false });
if (config.mode !== "incomplete") emit({ type: "agent_settled" });
if (config.mode === "trailing") emit({ type: "queue_update", steering: [], followUp: [] });
"###;

#[derive(Clone, Copy)]
pub struct FakeMode(&'static str);

impl FakeMode {
    pub const SUCCESS: Self = Self("success");
    pub const COMPACTION: Self = Self("compaction");
    pub const BAD_VERSION: Self = Self("bad-version");
    pub const MISSING_FLAG: Self = Self("missing-flag");
    pub const MISSING_MODEL: Self = Self("missing-model");
    pub const UNKNOWN_EVENT: Self = Self("unknown-event");
    pub const TRUNCATED: Self = Self("truncated");
    pub const TRAILING: Self = Self("trailing");
    pub const NO_SESSION: Self = Self("no-session");
    pub const INCOMPLETE: Self = Self("incomplete");
    pub const TOOL_MESSAGE: Self = Self("tool-message");
    pub const TOOL_MESSAGE_START: Self = Self("tool-message-start");
    pub const TOOL_AGENT_END: Self = Self("tool-agent-end");
    pub const MALFORMED_USAGE: Self = Self("malformed-usage");
    pub const ERROR: Self = Self("error");
    pub const ABORTED: Self = Self("aborted");
    pub const DEFERRED: Self = Self("deferred");

    pub const fn label(self) -> &'static str {
        self.0
    }
}

pub struct PiFixture {
    pub state: TempState,
    pub borrowed_workspace: TempState,
    counter: PathBuf,
    environment: Vec<(String, String)>,
}

impl PiFixture {
    pub fn new(label: &str, mode: FakeMode) -> Self {
        let state = TempState::new(label);
        let borrowed_workspace = TempState::new(&format!("{label}-borrowed"));
        let (bin, counter) = install_fake_pi(&state, borrowed_workspace.path(), mode);
        Self {
            state,
            borrowed_workspace,
            counter,
            environment: provider_environment(&bin, API_KEY),
        }
    }

    pub fn spawn(&self, cluster: &str, include_credential: bool) -> (NativeProcess, NativeClient) {
        ProviderProcess::new(
            self.state.path(),
            cluster,
            self.borrowed_workspace.path(),
            &self.environment,
        )
        .spawn(include_credential)
    }

    pub fn invocation_count(&self) -> usize {
        std::fs::read_to_string(&self.counter)
            .map(|records| records.lines().count())
            .unwrap_or(0)
    }
}

fn install_fake_pi(
    state: &TempState,
    borrowed_workspace: &Path,
    mode: FakeMode,
) -> (PathBuf, PathBuf) {
    let (bin, _) = install_test_executable(state.path(), "pi", FAKE_PI.as_bytes());
    let counter = state.path().join("pi-invocations");
    std::fs::write(
        bin.join("pi-test-config.json"),
        serde_json::to_vec(&json!({
            "mode": mode.label(),
            "apiKey": API_KEY,
            "borrowedWorkspace": borrowed_workspace,
            "state": state.path(),
            "prompt": PROMPT,
            "counter": counter,
            "response": RESPONSE
        }))
        .unwrap(),
    )
    .unwrap();
    (bin, counter)
}
