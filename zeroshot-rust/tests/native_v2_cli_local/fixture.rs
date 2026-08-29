use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Output};
use std::time::Duration;

use openengine_cluster_testkit::TemporaryDirectory;
use openengine_cluster_testkit::assertions::{AssertValue, JsonAt};
use serde_json::{Value, json};
use tokio::process::{Child, Command};
use tokio::io::AsyncWriteExt as _;
use tokio::time::{Instant, sleep, timeout};

const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const DECLARED_KEY: &str = "local-declared-key";

pub(super) struct LocalFixture {
    root: TemporaryDirectory,
    pub(super) repository: PathBuf,
    state: PathBuf,
    pub(super) config_blocker: PathBuf,
    graph: PathBuf,
    input: PathBuf,
    runtime: PathBuf,
    pub(super) head: String,
}

impl LocalFixture {
    pub(super) fn new() -> Self {
        // Keep the controller socket below Unix's short `sun_path` limit.
        let root = TemporaryDirectory::for_test("zv2l");
        let repository = root.path("repository");
        let state = root.path("state");
        let bin = root.path("bin");
        let config_blocker = root.path("config-blocker");
        fs::create_dir_all(&repository).assert_value_with("create repository");
        fs::create_dir_all(&bin).assert_value_with("create fake binary directory");
        fs::write(
            &config_blocker,
            b"local commands must not open target state\n",
        )
        .assert_value_with("write config blocker");
        write_fake_codex(&bin.join("codex"));
        initialize_repository(&repository);
        let head = git(&repository, &["rev-parse", "HEAD"]);

        let graph = root.path("graph.json");
        let input = root.path("input.json");
        let runtime = root.path("runtime.json");
        write_json(&graph, &local_graph());
        write_json(&input, &Value::Null);
        write_json(&runtime, &local_runtime());
        Self {
            root,
            repository,
            state,
            config_blocker,
            graph,
            input,
            runtime,
            head,
        }
    }

    fn command_with_inline(&self, args: &[&str], mode: &str, inline: bool) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_zeroshot-rust"));
        command
            .args(args)
            .current_dir(&self.repository)
            .env_clear()
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.root.path("bin").display()),
            )
            .env("ZEROSHOT_RUST_STATE_DIR", &self.state)
            .env("ZEROSHOT_RUST_CONFIG_DIR", &self.config_blocker)
            .env("UNDECLARED_SECRET", "must-not-cross")
            .kill_on_drop(true);
        if inline {
            command
                .env("OPENAI_API_KEY", DECLARED_KEY)
                .env("FAKE_CODEX_MODE", mode);
        }
        command
    }

    fn command(&self, args: &[&str], mode: &str) -> Command {
        self.command_with_inline(args, mode, true)
    }

    pub(super) async fn run(&self, title: &str, mode: &str, detach: bool) -> Output {
        self.run_request(title, mode, (detach, None)).await
    }

    pub(super) async fn run_with_key(&self, title: &str, mode: &str, key: &str) -> Output {
        self.run_request(title, mode, (true, Some(key))).await
    }

    async fn run_request(&self, title: &str, mode: &str, options: (bool, Option<&str>)) -> Output {
        let (detach, submission_key) = options;
        let mut arguments = vec![
            "run",
            "--title",
            title,
            "--graph",
            self.graph.to_str().assert_value_with("graph path"),
            "--input",
            self.input.to_str().assert_value_with("input path"),
            "--runtime-config",
            self.runtime.to_str().assert_value_with("runtime path"),
        ];
        if let Some(key) = submission_key {
            arguments.extend(["--submission-key", key]);
        }
        if detach {
            arguments.push("-d");
        }
        self.output(&arguments, mode).await
    }

    pub(super) async fn submit_detached(&self, mode: &str) -> String {
        let output = self.run("Detached local acceptance", mode, true).await;
        assert_success(&output, "detached local run");
        let receipt: Value =
            serde_json::from_slice(&output.stdout).assert_value_with("run receipt JSON");
        let run_id = receipt
            .assert_key("runId")
            .as_str()
            .assert_value_with("run identity")
            .to_owned();
        assert_local_run_id(&run_id);
        run_id
    }

    async fn output(&self, args: &[&str], mode: &str) -> Output {
        timeout(CLI_TIMEOUT, self.command(args, mode).output())
            .await
            .assert_value_with("local CLI deadline")
            .assert_value_with("start local CLI")
    }

    pub(super) async fn connection_set(&self) -> Value {
        let mut command = self.command(&["connection", "set", "openai", "--json-stdin"], "finish");
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().assert_value_with("spawn connection set");
        child
            .stdin
            .take()
            .assert_value_with("connection set stdin")
            .write_all(
                br#"{"OPENAI_API_KEY":"local-declared-key","FAKE_CODEX_MODE":"finish","EXTRA":"not-injected"}"#,
            )
            .await
            .assert_value_with("write connection JSON");
        let output = timeout(CLI_TIMEOUT, child.wait_with_output())
            .await
            .assert_value_with("connection set deadline")
            .assert_value_with("wait for connection set");
        assert_success(&output, "connection set");
        serde_json::from_slice(&output.stdout).assert_value_with("connection set JSON")
    }

    pub(super) async fn run_from_stored_connection(&self) -> Output {
        let arguments = [
            "run",
            "--title",
            "Stored connection run",
            "--graph",
            self.graph.to_str().assert_value_with("graph path"),
            "--input",
            self.input.to_str().assert_value_with("input path"),
            "--runtime-config",
            self.runtime.to_str().assert_value_with("runtime path"),
        ];
        timeout(
            CLI_TIMEOUT,
            self.command_with_inline(&arguments, "finish", false)
                .output(),
        )
        .await
        .assert_value_with("stored connection run deadline")
        .assert_value_with("start stored connection run")
    }

    pub(super) async fn json(&self, args: &[&str], mode: &str) -> Value {
        let output = self.output(args, mode).await;
        assert_success(&output, "local CLI JSON command");
        serde_json::from_slice(&output.stdout).assert_value_with("local CLI JSON output")
    }

    pub(super) async fn interrupted(&self, args: &[&str], mode: &str) -> Output {
        let mut command = self.command(args, mode);
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        let child = command.spawn().assert_value_with("spawn observer CLI");
        interrupt_after_observation(child).await
    }

    pub(super) async fn assert_replay(&self, command: &str, run_id: &str, expected: &str) {
        let output = self.output(&[command, run_id], "block").await;
        assert_success(&output, "terminal observation replay");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(expected),
            "{command} replay did not contain {expected:?}"
        );
    }

    pub(super) async fn listed_run(&self, run_id: &str) -> Value {
        self.json(&["list"], "block")
            .await
            .assert_key("runs")
            .as_array()
            .assert_value_with("run list")
            .iter()
            .find(|run| run.assert_key("runId") == run_id)
            .assert_value_with(&format!("run {run_id} was absent from local inventory"))
            .clone()
    }

    pub(super) async fn wait_running(&self, run_id: &str) -> Value {
        let deadline = Instant::now() + CLI_TIMEOUT;
        loop {
            let output = self.output(&["status", run_id], "block").await;
            if output.status.success() {
                let status: Value =
                    serde_json::from_slice(&output.stdout).assert_value_with("status JSON");
                if status.assert_key("status").assert_key("phase") == "running"
                    && status
                        .assert_key("status")
                        .assert_key("activeExecutions")
                        .as_array()
                        .is_some_and(|active| !active.is_empty())
                {
                    return status;
                }
            }
            assert!(Instant::now() < deadline, "run did not become active");
            sleep(Duration::from_millis(30)).await;
        }
    }

    pub(super) async fn wait_terminal(&self, run_id: &str, mode: &str, reason: &str) -> Value {
        let deadline = Instant::now() + CLI_TIMEOUT;
        loop {
            let output = self.output(&["status", run_id], mode).await;
            if output.status.success() {
                let status: Value =
                    serde_json::from_slice(&output.stdout).assert_value_with("status JSON");
                if status.assert_key("status").assert_key("phase") == "finished"
                    && status
                        .assert_key("status")
                        .assert_key("terminalResult")
                        .assert_key("reason")
                        == reason
                {
                    return status;
                }
            }
            assert!(
                Instant::now() < deadline,
                "run did not finish with reason {reason}"
            );
            sleep(Duration::from_millis(30)).await;
        }
    }

    pub(super) fn run_storage(&self, run_id: &str) -> PathBuf {
        self.state.join("runs").join(run_id)
    }

    pub(super) fn ready_pid(&self, run_id: &str) -> u32 {
        let bytes = fs::read(self.run_storage(run_id).join("controller.ready.json"))
            .assert_value_with("controller ready file");
        let ready: Value =
            serde_json::from_slice(&bytes).assert_value_with("controller ready JSON");
        assert_eq!(ready.assert_key("runId"), run_id);
        let pid = ready
            .assert_key("pid")
            .as_u64()
            .assert_value_with("controller PID");
        u32::try_from(pid).assert_value_with("controller PID fits u32")
    }
}

impl Drop for LocalFixture {
    fn drop(&mut self) {
        let runs = self.state.join("runs");
        if let Ok(entries) = fs::read_dir(runs) {
            for ready in entries
                .flatten()
                .map(|entry| entry.path().join("controller.ready.json"))
            {
                let Ok(bytes) = fs::read(ready) else {
                    continue;
                };
                let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                let Some(pid) = value.get("pid").and_then(Value::as_u64) else {
                    continue;
                };
                let Ok(pid) = u32::try_from(pid) else {
                    continue;
                };
                let _ = signal(pid, libc::SIGKILL);
            }
        }
        if let Ok(pid) = fs::read_to_string(self.repository.join("fake-codex.pid")) {
            if let Ok(pid) = pid.trim().parse::<u32>() {
                let _ = signal(pid, libc::SIGKILL);
            }
        }
    }
}

async fn interrupt_after_observation(child: Child) -> Output {
    let pid = child.id().assert_value_with("observer CLI PID");
    sleep(Duration::from_millis(350)).await;
    signal(pid, libc::SIGINT).assert_value_with("interrupt observer CLI");
    timeout(CLI_TIMEOUT, child.wait_with_output())
        .await
        .assert_value_with("observer CLI exit deadline")
        .assert_value_with("wait for observer CLI")
}

pub(super) async fn wait_for_exit(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_exists(pid) {
        assert!(Instant::now() < deadline, "process {pid} did not exit");
        sleep(Duration::from_millis(20)).await;
    }
}

pub(super) fn process_exists(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

pub(super) fn signal(pid: u32, value: i32) -> std::io::Result<()> {
    if unsafe { libc::kill(pid as i32, value) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub(super) fn assert_success(output: &Output, context: &str) {
    assert!(
        output.status.success(),
        "{context} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

pub(super) fn json_lines(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|line| serde_json::from_str(line).assert_value_with("JSON output line"))
        .collect()
}

pub(super) fn receipt_run_id(output: &Output) -> String {
    let receipt: Value =
        serde_json::from_slice(&output.stdout).assert_value_with("run receipt JSON");
    receipt
        .assert_key("runId")
        .as_str()
        .assert_value_with("run receipt identity")
        .to_owned()
}

pub(super) fn assert_local_run_id(run_id: &str) {
    assert!(uuid::Uuid::parse_str(run_id).is_ok_and(|value| {
        value.get_version_num() == 7 && value.hyphenated().to_string() == run_id
    }));
}

fn initialize_repository(repository: &Path) {
    git(repository, &["init"]);
    git(repository, &["config", "user.name", "Local CLI Test"]);
    git(
        repository,
        &["config", "user.email", "local-cli@example.invalid"],
    );
    git(repository, &["config", "commit.gpgsign", "false"]);
    fs::write(repository.join("seed.txt"), b"seed\n").assert_value_with("seed repository");
    git(repository, &["add", "seed.txt"]);
    git(repository, &["commit", "-m", "seed"]);
    git(repository, &["branch", "-M", "feature/local"]);
    git(
        repository,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/local-fixture.git",
        ],
    );
}

pub(super) fn git(repository: &Path, arguments: &[&str]) -> String {
    let output = StdCommand::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .assert_value_with("run Git fixture command");
    assert_success(&output, "Git fixture command");
    String::from_utf8(output.stdout)
        .assert_value_with("Git UTF-8 output")
        .trim()
        .to_owned()
}

fn write_fake_codex(path: &Path) {
    fs::write(
        path,
        br#"#!/bin/sh
test "${CODEX_API_KEY-}" = "local-declared-key" || exit 41
test -z "${OPENAI_API_KEY+x}" || exit 42
test -z "${UNDECLARED_SECRET+x}" || exit 43
printf '%s\n' "$$" > "$PWD/fake-codex.pid"
printf 'preserved\n' > "$PWD/local-mutation.txt"
printf 'declared-only\n' > "$PWD/environment-proof.txt"
printf '%s\n' '{"type":"thread.started","thread_id":"local-thread"}'
printf '%s\n' '{"type":"turn.started"}'
if test "${FAKE_CODEX_MODE-}" = block; then
  parent="$PPID"
  trap 'exit 0' TERM INT HUP
  while kill -0 "$parent" 2>/dev/null; do
    printf '%s\n' '{"type":"turn.started"}'
    sleep 0.05
  done
  exit 0
fi
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"null"}}'
printf '%s\n' '{"type":"turn.completed"}'
"#,
    )
    .assert_value_with("write fake Codex");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .assert_value_with("make fake Codex executable");
}

fn local_runtime() -> Value {
    json!({
        "harness":"codex",
        "provider":"openai",
        "size":"small",
        "nodes":{
            "worker":{
                "kind":"agent",
                "model":"gpt-5.6",
                "effort":"high",
                "sessionScope":"execution",
                "connections":{"openai":["OPENAI_API_KEY", "FAKE_CODEX_MODE"]}
            }
        }
    })
}

fn local_graph() -> Value {
    json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1", "default":"deny"},
        "root":{
            "kind":"seq",
            "name":"root",
            "state":{"kind":"null"},
            "children":[
                {
                    "kind":"step",
                    "name":"worker",
                    "worker":"agent.worker@1",
                    "instructions":"Exercise the local worker.",
                    "input":{"kind":"null"},
                    "output":{"kind":"null"},
                    "inputBindings":[],
                    "writeBindings":[],
                    "timeoutMs":30000,
                    "attempts":1
                },
                {"kind":"succeed", "name":"done", "output":{"kind":"null"}, "bindings":[]}
            ],
            "promotedStatePaths":[]
        }
    })
}

fn write_json(path: &Path, value: &Value) {
    let bytes = serde_json::to_vec(value).assert_value_with("encode fixture JSON");
    fs::write(path, bytes).assert_value_with("write fixture JSON");
}
