use std::os::unix::fs::PermissionsExt;

use openengine_cluster_testkit::assertions::AssertValue;
use super::*;
use zeroshot_engine::native_v2_claude::{ClaudeAdapter, ClaudeAdapterConfig, ClaudeProcessEnvironment};
use zeroshot_engine::native_v2_codex::{NativeV2CodexAdapter, NativeV2CodexConfig};
use zeroshot_engine::native_v2_contract::{ClaudeProvider, CodexProvider};

type ClaimResult = Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable>;
type AllocationResult = Result<AllocatedCapsule, CapsuleAllocationUnavailable>;
type DestructionResult = Result<CapsuleDestroyed, CapsuleCleanupUnavailable>;

#[derive(Clone, Copy, Debug)]
enum RetryLane {
    Codex,
    Claude,
}

impl RetryLane {
    const fn label(self) -> &'static str {
        match self {
            Self::Codex => "codex-retry",
            Self::Claude => "claude-retry",
        }
    }

    const fn credential(self) -> &'static str {
        match self {
            Self::Codex => "OPENAI_API_KEY",
            Self::Claude => "ANTHROPIC_API_KEY",
        }
    }

    const fn script(self) -> &'static str {
        match self {
            Self::Codex => CODEX_RETRY_SCRIPT,
            Self::Claude => CLAUDE_RETRY_SCRIPT,
        }
    }
}

struct RetryAllocator {
    lane: RetryLane,
    workspace: PathBuf,
    runtime_home: PathBuf,
    executable: PathBuf,
    losses: Mutex<Vec<watch::Sender<bool>>>,
}

impl RetryAllocator {
    fn new(root: &TempRoot, lane: RetryLane) -> Self {
        let workspace = root.path(&format!("{}-workspace", lane.label()));
        let runtime_home = root.path(&format!("{}-runtime", lane.label()));
        let executable = root.path(&format!("{}-provider", lane.label()));
        std::fs::create_dir_all(&workspace).assert_value();
        std::fs::create_dir_all(&runtime_home).assert_value();
        std::fs::write(&executable, lane.script()).assert_value();
        let mut permissions = std::fs::metadata(&executable).assert_value().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions).assert_value();
        Self {
            lane,
            workspace,
            runtime_home,
            executable,
            losses: Mutex::new(Vec::new()),
        }
    }

    fn capture(&self, name: &str) -> PathBuf {
        self.workspace.join(name)
    }
}

#[async_trait]
impl CapsuleAllocator for RetryAllocator {
    async fn claim_controller(&self, _run_id: &RunId) -> ClaimResult {
        Ok(controller_claim())
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        admitted: &AdmittedRun,
        _github_token: Option<&str>,
    ) -> AllocationResult {
        let runner = match self.lane {
            RetryLane::Codex => self.codex_runner(admitted)?,
            RetryLane::Claude => self.claude_runner(admitted)?,
        };
        let (loss, receiver) = watch::channel(false);
        self.losses.lock().assert_value().push(loss);
        Ok(AllocatedCapsule {
            runner,
            loss: receiver,
            cleanup: Arc::new(ImmediateCleanup),
        })
    }

    async fn destroy_or_confirm_absent(
        &self,
        _run_id: &RunId,
        _exit: RunRuntimeExit,
    ) -> DestructionResult {
        confirmed_capsule_destroyed()
    }
}

impl RetryAllocator {
    fn codex_runner(
        &self,
        admitted: &AdmittedRun,
    ) -> Result<Arc<dyn zeroshot_engine::native_v2_runner::NodeRunner>, CapsuleAllocationUnavailable>
    {
        let adapter = Arc::new(NativeV2CodexAdapter::new_local(NativeV2CodexConfig {
            provider: CodexProvider::OpenAi,
            executable: self.executable.clone(),
            workspace: self.workspace.clone(),
            runtime_home: self.runtime_home.clone(),
            local_user: None,
            search_path: "/usr/bin:/bin".to_owned(),
            process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000)
                .map_err(|_| CapsuleAllocationUnavailable)?,
        }));
        let runner = NativeNodeRunner::new(admitted, adapter.clone(), adapter)
            .map_err(|_| CapsuleAllocationUnavailable)?;
        Ok(Arc::new(runner))
    }

    fn claude_runner(
        &self,
        admitted: &AdmittedRun,
    ) -> Result<Arc<dyn zeroshot_engine::native_v2_runner::NodeRunner>, CapsuleAllocationUnavailable>
    {
        let base_environment = ClaudeProcessEnvironment::new(BTreeMap::from([
            (
                "HOME".to_owned(),
                self.runtime_home.to_string_lossy().into_owned(),
            ),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ]))
        .map_err(|_| CapsuleAllocationUnavailable)?;
        let adapter = Arc::new(
            ClaudeAdapter::new_local(ClaudeAdapterConfig {
                provider: ClaudeProvider::Anthropic,
                executable: self.executable.to_string_lossy().into_owned(),
                prefix_arguments: Vec::new(),
                workspace: self.workspace.clone(),
                runtime_home: self.runtime_home.clone(),
                local_user_home: None,
                base_environment,
                turn_timeout: Duration::from_secs(10),
                process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000)
                    .map_err(|_| CapsuleAllocationUnavailable)?,
            })
            .map_err(|_| CapsuleAllocationUnavailable)?,
        );
        NativeNodeRunner::new(admitted, adapter.clone(), adapter)
            .map(|runner| {
                Arc::new(runner) as Arc<dyn zeroshot_engine::native_v2_runner::NodeRunner>
            })
            .map_err(|_| CapsuleAllocationUnavailable)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn shipped_cli_observes_one_bounded_provider_continuation_for_both_harnesses() {
    if !cli_prerequisites_available() {
        return;
    }
    for lane in [RetryLane::Codex, RetryLane::Claude] {
        let root = temp_root();
        let allocator = Arc::new(RetryAllocator::new(&root, lane));
        let host = LoopbackHost::start_with_factory(Arc::new(FixedAllocatorFactory {
            allocator: allocator.clone(),
            delivery_policy: DeliveryPolicy::Optional,
        }))
        .await;
        let config = root.path(&format!("{}-config", lane.label()));
        let (runtime, graph, input) = write_retry_files(&root, lane);
        let binary = env!("CARGO_BIN_EXE_zeroshot-rust");
        let mut command = cli_command(CliInvocation {
            script: &retry_shell_script(),
            label: lane.label(),
            binary,
            origin: &host.origin,
            config: &config,
            runtime: &runtime,
            graph: &graph,
            input: &input,
            extra: Some(lane.label()),
            source_revision: Some(TEST_SOURCE_REVISION),
        });
        command.env(lane.credential(), "sentinel-secret");
        let (stdout, stderr) = run_cli_command(
            command,
            Duration::from_secs(60),
            &format!("shipped CLI {:?} retry acceptance", lane),
        )
        .await;

        assert!(stderr.contains("ABCD-EFGH"));
        assert!(
            stdout.contains("provider failed; continuing once"),
            "retry was not observed for {lane:?}\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );
        assert!(stdout.contains("provider failure:"));
        assert!(stdout.contains("[REDACTED]"));
        assert!(!stdout.contains("sentinel-secret"));
        assert!(stdout.contains("\"terminalResult\":{\"status\":\"succeeded\""));
        assert_eq!(
            std::fs::read_to_string(allocator.capture("attempt-2.prompt")).assert_value(),
            "Continue"
        );
        assert!(!allocator.capture("attempt-3.prompt").exists());
    }
}

fn write_retry_files(root: &TempRoot, lane: RetryLane) -> (PathBuf, PathBuf, PathBuf) {
    let runtime = root.path(&format!("{}-runtime.json", lane.label()));
    let graph = root.path(&format!("{}-graph.json", lane.label()));
    let input = root.path(&format!("{}-input.json", lane.label()));
    let (harness, provider, model) = match lane {
        RetryLane::Codex => ("codex", "openai", "gpt-5.6-sol"),
        RetryLane::Claude => ("claude", "anthropic", "claude-sonnet-5"),
    };
    std::fs::write(
        &runtime,
        serde_json::to_vec(&json!({
            "harness":harness,
            "provider":provider,
            "size":"medium",
            "nodes":{"worker":{
                "kind":"agent","model":model,"effort":"max",
                "sessionScope":"execution","connections":{"provider":[lane.credential()]}
            }}
        }))
        .assert_value(),
    )
    .assert_value();
    std::fs::write(
        &graph,
        serde_json::to_vec(&native_v2_graph(
            json!({"kind":"null"}),
            json!({
                "kind":"seq","name":"root","state":{"kind":"null"},"children":[
                    {"kind":"step","name":"worker","worker":"agent.worker@1",
                     "instructions":"Complete the retry acceptance node.",
                     "input":{"kind":"null"},"output":{"kind":"null"},
                     "inputBindings":[],"writeBindings":[],"timeoutMs":10_000,"attempts":1},
                    {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
                ],"promotedStatePaths":[]
            }),
        ))
        .assert_value(),
    )
    .assert_value();
    std::fs::write(&input, b"null").assert_value();
    (runtime, graph, input)
}

fn retry_shell_script() -> String {
    [
        KEYRING_PREAMBLE,
        LOOPBACK_TARGET_PREAMBLE,
        r#"
result=$("$1" run --target prod --title "Provider retry acceptance" \
  --runtime-config "$4" --graph "$5" --input "$6" --submission-key "$7" -d) || exit $?
run_id=$(printf '%s' "$result" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p' | head -1)
test -n "$run_id" || exit 91
"#,
        WAIT_FOR_FINISHED_STATUS,
        r#"
logs=$(timeout 10 "$1" logs "$run_id" --target prod) || exit $?
printf 'RETRY=%s\nLOGS=%s\nSTATUS=%s\n' "$result" "$logs" "$status"
"#,
    ]
    .concat()
}

const CODEX_RETRY_SCRIPT: &str = r#"#!/bin/sh
set -eu
prompt=$(/usr/bin/cat)
attempt=1
if [ -e attempt.state ]; then attempt=$(( $(/usr/bin/cat attempt.state) + 1 )); fi
/usr/bin/printf '%s' "$attempt" > attempt.state
/usr/bin/printf '%s' "$prompt" > "attempt-$attempt.prompt"
if [ "$attempt" = 1 ]; then
  /usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"retry-thread"}'
  /usr/bin/printf '%s\n' '{"type":"turn.failed","error":{"message":"lost sentinel-secret"}}'
  exit 1
fi
/usr/bin/printf '%s\n' '{"type":"thread.started","thread_id":"retry-thread"}'
/usr/bin/printf '%s%s\n' \
  '{"type":"item.completed","item":{"type":"agent_message",' \
  '"text":"{\"response\":null}"}}'
/usr/bin/printf '%s\n' '{"type":"turn.completed"}'
"#;

const CLAUDE_RETRY_SCRIPT: &str = r#"#!/bin/sh
set -eu
attempt=1
if [ -e attempt.state ]; then attempt=$(( $(/usr/bin/cat attempt.state) + 1 )); fi
/usr/bin/printf '%s' "$attempt" > attempt.state
prompt=
for argument in "$@"; do prompt=$argument; done
/usr/bin/printf '%s' "$prompt" > "attempt-$attempt.prompt"
if [ "$attempt" = 1 ]; then
  /usr/bin/printf '%s\n' '{"type":"system","subtype":"init","session_id":"retry-session"}'
  /usr/bin/printf '%s%s\n' \
    '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,' \
    '"error":"lost sentinel-secret"}'
  /usr/bin/printf '%s%s\n' \
    '{"type":"result","subtype":"error_during_execution","is_error":true,' \
    '"result":"lost sentinel-secret","session_id":"retry-session"}'
  exit 1
fi
/usr/bin/printf '%s\n' '{"type":"system","subtype":"init","session_id":"retry-session"}'
/usr/bin/printf '%s%s\n' \
  '{"type":"result","subtype":"success","is_error":false,' \
  '"result":"{\"response\":null}","session_id":"retry-session"}'
"#;
