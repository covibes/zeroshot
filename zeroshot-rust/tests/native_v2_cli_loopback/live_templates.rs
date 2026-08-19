use super::*;
use openengine_cluster_testkit::assertions::AssertValue;

const LIVE_TEMPLATE_DEADLINE: Duration = Duration::from_secs(20 * 60);

#[tokio::test(flavor = "multi_thread")]
#[ignore = "manual live template acceptance; requires network, Codex login, and the disposable repository"]
async fn shipped_cli_runs_single_worker_template_with_local_codex_login() {
    let repository = required_environment("ZEROSHOT_NATIVE_V2_LIVE_REPOSITORY");
    let root = temp_root();
    let state = ShortState::new();
    let workspace = root.path("local-workspace");
    clone_repository(&repository, &workspace);
    let proof = unique_proof("codex-openai-single-worker");
    let (runtime, input) = write_template_files(
        &root,
        LiveLane::CodexOpenAi,
        "single-worker",
        format!(
            "Create provider-proof-{proof}.txt containing exactly {proof}. Run npm test and return null."
        ),
    );
    let binary = env!("CARGO_BIN_EXE_zeroshot-rust");
    let mut command = tokio::process::Command::new(binary);
    command
        .current_dir(&workspace)
        .args([
            "run",
            "--title",
            "Live single-worker template acceptance",
            "--template",
            "single-worker",
            "--runtime-config",
        ])
        .arg(&runtime)
        .arg("--input")
        .arg(&input)
        .env("ZEROSHOT_RUST_STATE_DIR", &state.0)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    let (stdout, stderr) = run_cli_command(
        command,
        LIVE_TEMPLATE_DEADLINE,
        "local Codex single-worker template acceptance",
    )
    .await;
    assert_terminal_success(&stdout, &stderr);
    let mutation = std::fs::read_to_string(workspace.join(format!("provider-proof-{proof}.txt")))
        .assert_value();
    assert_eq!(mutation.trim_end(), proof);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "manual live template acceptance; requires root, network, provider/GitHub CLIs, and credentials"]
async fn shipped_cli_runs_software_change_template_to_confirmed_merge() {
    assert!(cli_prerequisites_available());
    let lane = LiveLane::from_environment();
    let root = temp_root();
    let proof = unique_proof(lane.sentinel());
    let (runtime, input) = write_template_files(
        &root,
        lane,
        "software-change",
        format!(
            "Add src/{proof}.js with a small production-quality exported validation helper and \
             add focused node:test coverage in test/{proof}.test.js. Include the literal {proof} \
             in the module, run npm test, and keep the change focused."
        ),
    );
    let hosting = live_hosting_config(&root, lane);
    let host =
        LoopbackHost::start_with_factory(Arc::new(ProductionTargetControllerFactory::new(hosting)))
            .await;
    let config = root.path("template-target-config");
    let binary = env!("CARGO_BIN_EXE_zeroshot-rust");
    let script = live_template_target_script();
    let mut command = cli_command(CliInvocation {
        script: &script,
        label: "live-template",
        binary,
        origin: &host.origin,
        config: &config,
        runtime: &runtime,
        graph: &input,
        input: &input,
        extra: None,
    });
    for name in [
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CODEX_API_KEY",
        GITHUB_TOKEN_ENV,
    ] {
        command.env_remove(name);
    }
    let context = format!("hosted software-change template acceptance for {lane:?}");
    let (stdout, stderr) = run_cli_command(command, LIVE_TEMPLATE_DEADLINE, &context).await;
    assert_terminal_success(&stdout, &stderr);
    assert!(stdout.contains("\"mode\":\"merge\""));
    assert!(stdout.contains("\"outcome\":\"merged\""));
}

fn write_template_files(
    root: &TempRoot,
    lane: LiveLane,
    template: &str,
    task: String,
) -> (PathBuf, PathBuf) {
    let runtime = root.path(&format!("{template}-runtime.json"));
    let input = root.path(&format!("{template}-input.json"));
    std::fs::write(
        &runtime,
        serde_json::to_vec(&template_runtime(lane, template)).assert_value(),
    )
    .assert_value();
    std::fs::write(
        &input,
        serde_json::to_vec(&json!({"task":task})).assert_value(),
    )
    .assert_value();
    (runtime, input)
}

fn template_runtime(lane: LiveLane, template: &str) -> serde_json::Value {
    let agent = || {
        json!({
            "kind":"agent",
            "model":lane.model(),
            "effort":"max",
            "sessionScope":"execution",
            "env": if template == "single-worker" { Vec::<&str>::new() } else { vec![lane.credential_name()] }
        })
    };
    let nodes = match template {
        "single-worker" => json!({"worker":agent()}),
        "software-change" => json!({
            "worker":agent(),
            "acceptance":agent(),
            "code":agent(),
            "review_repair":agent(),
            "delivery_repair":agent()
        }),
        _ => None::<serde_json::Value>.assert_value_with("live template name is closed"),
    };
    json!({
        "harness":lane.harness(),
        "provider":lane.provider(),
        "size":"standard",
        "nodes":nodes
    })
}

fn live_template_target_script() -> String {
    [
        KEYRING_PREAMBLE,
        LIVE_TARGET_PREAMBLE,
        r#"
run_output=$("$1" run --target prod --title "Live software-change template acceptance" \
  --template software-change --ship --runtime-config "$4" --input "$6" 2>&1)
run_status=$?
printf '%s\n' "$run_output"
if test "$run_status" -ne 0; then
  run_id=$(printf '%s' "$run_output" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p' | head -1)
  if test -n "$run_id"; then
    "$1" logs "$run_id" --target prod || true
    "$1" status "$run_id" --target prod || true
  fi
  exit "$run_status"
fi
"#,
    ]
    .concat()
}

fn clone_repository(repository: &str, workspace: &Path) {
    let output = std::process::Command::new("gh")
        .args(["repo", "clone", repository])
        .arg(workspace)
        .args(["--", "--depth", "1"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .assert_value();
    assert!(
        output.status.success(),
        "could not clone live repository: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn required_environment(name: &str) -> String {
    std::env::var(name).assert_value_with(&format!("{name} is required"))
}

fn unique_proof(prefix: &str) -> String {
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random).assert_value();
    let suffix = random
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{suffix}").to_lowercase()
}

struct ShortState(PathBuf);

impl ShortState {
    fn new() -> Self {
        let path = std::env::temp_dir().join(unique_proof("zv2"));
        std::fs::create_dir(&path).assert_value();
        Self(path)
    }
}

impl Drop for ShortState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn assert_terminal_success(stdout: &str, stderr: &str) {
    assert!(
        stdout.contains("\"phase\":\"finished\"")
            && stdout.contains("\"terminalResult\":{\"status\":\"succeeded\""),
        "live template run did not succeed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}
