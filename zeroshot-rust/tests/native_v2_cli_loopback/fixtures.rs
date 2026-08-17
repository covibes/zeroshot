use super::*;

pub(crate) fn write_fixture_files(root: &TempRoot) -> (PathBuf, PathBuf, PathBuf) {
    let runtime = root.path("runtime.json");
    let graph = root.path("graph.json");
    let input = root.path("input.json");
    std::fs::write(
        &runtime,
        serde_json::to_vec(&json!({
            "harness":"codex",
            "provider":"openai",
            "nodes":{
                "worker":{
                    "kind":"agent",
                    "model":"gpt-5.6",
                    "effort":"max",
                    "sessionScope":"execution",
                    "env":[]
                }
            }
        }))
        .assert_value(),
    )
    .assert_value();
    std::fs::write(
        &graph,
        serde_json::to_vec(&minimal_graph(10_000)).assert_value(),
    )
    .assert_value();
    std::fs::write(&input, b"null").assert_value();
    (runtime, graph, input)
}

pub(crate) fn write_live_fixture_files(
    root: &TempRoot,
    lane: LiveLane,
) -> (PathBuf, PathBuf, PathBuf) {
    let runtime = root.path("live-runtime.json");
    let graph = root.path("live-graph.json");
    let input = root.path("live-input.json");
    std::fs::write(
        &runtime,
        serde_json::to_vec(&json!({
            "harness":lane.harness(),
            "provider":lane.provider(),
            "nodes":{
                "worker":{
                    "kind":"agent",
                    "model":lane.model(),
                    "effort":"max",
                    "sessionScope":"execution",
                    "env":[lane.credential_name()]
                }
            }
        }))
        .assert_value(),
    )
    .assert_value();
    std::fs::write(
        &graph,
        serde_json::to_vec(&minimal_graph(600_000)).assert_value(),
    )
    .assert_value();
    std::fs::write(&input, b"null").assert_value();
    (runtime, graph, input)
}

pub(crate) fn write_delivery_fixture_files(root: &TempRoot) -> (PathBuf, PathBuf, PathBuf) {
    const RUNTIME: &str = r#"{
      "harness":"codex",
      "provider":"openai",
      "nodes":{
        "deliver":{"kind":"git_delivery","env":["GH_TOKEN"]},
        "repair":{"kind":"agent","model":"gpt-5.6","effort":"max","sessionScope":"execution","env":[]}
      }
    }"#;
    const GRAPH: &str = r#"{
      "profile":"openengine.graph.full/v1",
      "initialInput":{"kind":"null"},
      "policy":{"policy":"policy.native-v2@1","default":"deny"},
      "root":{"kind":"seq","name":"root","state":{"kind":"null"},"children":[
        {"kind":"loop","name":"delivery_loop","state":{"kind":"null"},
         "body":{"kind":"seq","name":"delivery_attempt","state":{"kind":"null"},"children":[
           {"kind":"verifier","name":"deliver","worker":"builtin.git-delivery@1",
            "input":{"kind":"null"},"output":{"kind":"null"},"inputBindings":[],
            "writeBindings":[],"timeoutMs":10000,"attempts":1,
            "signals":{"delivery":["merged","ci_failed"]},"diagnostic":{"kind":"string"}},
           {"kind":"choice","name":"delivery_route","state":{"kind":"null"},"branches":[{
              "when":{"kind":"in","value":{"name":"deliver","source":"signal","field":"delivery"},
                      "labels":["ci_failed"]},
              "node":{"kind":"step","name":"repair","worker":"agent.repair@1",
                      "input":{"kind":"null"},"output":{"kind":"null"},"inputBindings":[],
                      "writeBindings":[],"timeoutMs":10000,"attempts":1}}],
            "otherwise":{"kind":"succeed","name":"merged","output":{"kind":"null"},"bindings":[]},
            "promotedStatePaths":[]}],"promotedStatePaths":[]},
         "until":{"kind":"in","value":{"name":"deliver","source":"signal","field":"delivery"},
                  "labels":["merged"]},"maxIterations":3,"promotedStatePaths":[]},
        {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}],
       "promotedStatePaths":[]}
    }"#;
    let runtime = root.path("delivery-runtime.json");
    let graph = root.path("delivery-graph.json");
    let input = root.path("delivery-input.json");
    serde_json::from_str::<serde_json::Value>(RUNTIME).assert_value();
    serde_json::from_str::<serde_json::Value>(GRAPH).assert_value();
    std::fs::write(&runtime, RUNTIME).assert_value();
    std::fs::write(&graph, GRAPH).assert_value();
    std::fs::write(&input, b"null").assert_value();
    (runtime, graph, input)
}

pub(crate) fn minimal_graph(timeout_ms: u64) -> serde_json::Value {
    json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{
            "kind":"seq",
            "name":"root",
            "state":{"kind":"null"},
            "children":[
                {
                    "kind":"step",
                    "name":"worker",
                    "worker":"agent.worker@1",
                    "input":{"kind":"null"},
                    "output":{"kind":"null"},
                    "inputBindings":[],
                    "writeBindings":[],
                    "timeoutMs":timeout_ms,
                    "attempts":1
                },
                {
                    "kind":"succeed",
                    "name":"done",
                    "output":{"kind":"null"},
                    "bindings":[]
                }
            ],
            "promotedStatePaths":[]
        }
    })
}

pub(crate) fn live_hosting_config(root: &TempRoot, lane: LiveLane) -> ProductionHostingConfig {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "the production live lane requires a root supervisor"
    );
    let credential = std::env::var(lane.credential_name())
        .assert_value_with(&format!("{} is required", lane.credential_name()));
    assert!(!credential.is_empty(), "provider credential is empty");
    let credential_name =
        EnvironmentVariableName::new(lane.credential_name()).assert_value_with("credential name");
    let controller_environment = BTreeMap::from([(credential_name, credential)]);
    let codex_executable = if lane.uses_codex() {
        PathBuf::from(
            std::env::var_os("ZEROSHOT_NATIVE_V2_CODEX_EXECUTABLE").assert_value_with(
                "ZEROSHOT_NATIVE_V2_CODEX_EXECUTABLE is required for a Codex live lane",
            ),
        )
    } else {
        PathBuf::from("/usr/bin/false")
    };
    let (claude_executable, claude_prefix_arguments) = if lane.uses_codex() {
        ("/usr/bin/false".to_owned(), Vec::new())
    } else {
        (
            std::env::var("ZEROSHOT_NATIVE_V2_CLAUDE_EXECUTABLE")
                .unwrap_or_else(|_| "/usr/bin/npx".to_owned()),
            vec![
                "-y".to_owned(),
                "@anthropic-ai/claude-code@2.1.233".to_owned(),
            ],
        )
    };
    ProductionHostingConfig {
        storage_root: root.path("live-target"),
        controller_environment,
        codex_executable,
        claude_executable,
        claude_prefix_arguments,
        claude_process_environment: ClaudeProcessEnvironment::default(),
        executable_search_path: std::env::var("ZEROSHOT_NATIVE_V2_LIVE_PATH")
            .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_owned()),
        git_program: PathBuf::from("/usr/bin/git"),
        gh_program: PathBuf::from("/usr/bin/gh"),
        process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000)
            .assert_value_with("production process pool"),
        claude_turn_timeout: Duration::from_secs(10 * 60),
    }
}

pub(crate) fn shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        r#"
"$1" target add prod --url "$2" || exit $?
"$1" target login prod || exit $?
"$1" target setup prod --repository open-engine/zeroshot --runtime-config "$4" --base main || exit $?
detached=$("$1" run --target prod --graph "$5" --input "$6" --submission-key acceptance-1 -d) || exit $?
run_id=$(printf '%s' "$detached" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
test -n "$run_id" || exit 91
listed=$("$1" list --target prod) || exit $?
attempt=0
while :; do
  active=$("$1" status "$run_id" --target prod) || exit $?
  execution=$(printf '%s' "$active" | sed -n 's/.*"execution":"\([^"]*\)".*/\1/p')
  test -n "$execution" && break
  attempt=$((attempt + 1))
  test "$attempt" -lt 50 || exit 92
  sleep 0.05
done
watch_output=$(timeout --preserve-status --signal=INT 1 "$1" watch "$run_id" --target prod)
logs_output=$(timeout --preserve-status --signal=INT 1 "$1" logs "$run_id" --target prod)
attach_output=$(timeout --preserve-status --signal=INT 1 "$1" attach "$run_id" "$execution" --target prod)
forced=$("$1" force-stop "$run_id" --target prod) || exit $?
attempt=0
while :; do
  terminal=$("$1" status "$run_id" --target prod) || exit $?
  printf '%s' "$terminal" | grep -q '"phase":"finished"' && break
  attempt=$((attempt + 1))
  test "$attempt" -lt 50 || exit 93
  sleep 0.05
done
printf '%s\n' \
  "DETACHED=$detached" \
  "LIST=$listed" \
  "ACTIVE=$active" \
  "EXECUTION=$execution" \
  "WATCH=$watch_output" \
  "LOGS=$logs_output" \
  "ATTACH=$attach_output" \
  "FORCED=$forced" \
  "TERMINAL=$terminal" \
  "RUN_ID=$run_id"
"#,
    ]
    .concat()
}

pub(crate) fn live_shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        r#"
"$1" target add prod --url "$2" || exit $?
"$1" target login prod || exit $?
"$1" target setup prod --repository the-open-engine/zeroshot --runtime-config "$4" --base main || exit $?
live_output=$("$1" run --target prod --graph "$5" --input "$6" --submission-key "$7") || exit $?
printf 'LIVE=%s\n' "$live_output"
"#,
    ]
    .concat()
}

pub(crate) fn delivery_shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        r#"
"$1" target add prod --url "$2" || exit $?
"$1" target login prod || exit $?
"$1" target setup prod --repository acme/project --runtime-config "$4" --base main || exit $?
result=$("$1" run --target prod --graph "$5" --input "$6" --submission-key "$7" --ship) || exit $?
printf 'DELIVERY=%s\n' "$result"
"#,
    ]
    .concat()
}

pub(crate) fn loss_shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        r#"
"$1" target add prod --url "$2" || exit $?
"$1" target login prod || exit $?
"$1" target setup prod --repository open-engine/zeroshot --runtime-config "$4" --base main || exit $?
detached=$("$1" run --target prod --graph "$5" --input "$6" --submission-key loss-1 -d) || exit $?
run_id=$(printf '%s' "$detached" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
test -n "$run_id" || exit 91
attempt=0
while :; do
  terminal=$("$1" status "$run_id" --target prod) || exit $?
  printf '%s' "$terminal" | grep -q '"phase":"finished"' && break
  attempt=$((attempt + 1))
  test "$attempt" -lt 100 || exit 92
  sleep 0.05
done
printf 'LOST=%s\nRUN_ID=%s\n' "$terminal" "$run_id"
"#,
    ]
    .concat()
}

pub(crate) struct CliInvocation<'a> {
    pub(crate) script: &'a str,
    pub(crate) label: &'a str,
    pub(crate) binary: &'a str,
    pub(crate) origin: &'a str,
    pub(crate) config: &'a Path,
    pub(crate) runtime: &'a Path,
    pub(crate) graph: &'a Path,
    pub(crate) input: &'a Path,
    pub(crate) extra: Option<&'a str>,
}

pub(crate) fn cli_command(invocation: CliInvocation<'_>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("dbus-run-session");
    command
        .arg("--")
        .arg("bash")
        .arg("--noprofile")
        .arg("--norc")
        .arg("-c")
        .arg(invocation.script)
        .arg(invocation.label)
        .arg(invocation.binary)
        .arg(invocation.origin)
        .arg(invocation.config)
        .arg(invocation.runtime)
        .arg(invocation.graph)
        .arg(invocation.input)
        .env("ZEROSHOT_RUST_CONFIG_DIR", invocation.config);
    if let Some(extra) = invocation.extra {
        command.arg(extra);
    }
    command
}

pub(crate) async fn run_cli_command(
    mut command: tokio::process::Command,
    deadline: Duration,
    context: &str,
) -> (String, String) {
    let output = tokio::time::timeout(deadline, command.output())
        .await
        .assert_value_with(&format!("{context} timed out"))
        .assert_value_with("dbus-run-session starts");
    let stdout = String::from_utf8(output.stdout).assert_value();
    let stderr = String::from_utf8(output.stderr).assert_value();
    assert!(
        output.status.success(),
        "{context} failed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    (stdout, stderr)
}

pub(crate) fn cli_prerequisites_available() -> bool {
    for prerequisite in [
        "dbus-run-session",
        "gnome-keyring-daemon",
        "secret-tool",
        "timeout",
    ] {
        if std::process::Command::new(prerequisite)
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping native-v2 CLI loopback: {prerequisite} is unavailable");
            return false;
        }
    }
    true
}

use openengine_cluster_testkit::assertions::{AssertValue};
