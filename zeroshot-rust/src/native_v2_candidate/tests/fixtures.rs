use openengine_cluster_protocol::GraphSpec;

use super::*;
use crate::native_v2_candidate::test_support::{full_graph, success_node};

#[derive(Clone, Copy)]
pub(super) enum RuntimePlanKind {
    Codex,
    Claude,
}

pub(super) fn runtime(kind: RuntimePlanKind) -> RuntimePlan {
    let agent = NodeRuntimeBinding::Agent {
        model: worker_catalog::ModelId::new(match kind {
            RuntimePlanKind::Codex => "gpt-5.6-sol",
            RuntimePlanKind::Claude => "claude-sonnet-5",
        })
        .assert_value_with("model"),
        effort: Some(ReasoningEffort::Max),
        session_scope: SessionScope::Execution,
        env: BTreeSet::new(),
    };
    let delivery = NodeRuntimeBinding::GitDelivery {
        env: BTreeSet::from([
            EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value_with("token name")
        ]),
    };
    let nodes = BTreeMap::from([
        (
            NodeName::new("worker").assert_value_with("worker name"),
            agent,
        ),
        (
            NodeName::new("deliver").assert_value_with("delivery name"),
            delivery,
        ),
    ]);
    match kind {
        RuntimePlanKind::Codex => RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            nodes,
        },
        RuntimePlanKind::Claude => RuntimePlan::Claude {
            provider: crate::native_v2_contract::ClaudeProvider::Anthropic,
            nodes,
        },
    }
}

pub(super) fn shipping_graph() -> GraphSpec {
    full_graph(vec![
        json!({
            "kind":"step","name":"worker","worker":"agent.worker@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":10000,"attempts":1
        }),
        json!({
            "kind":"verifier","name":"deliver","worker":"builtin.git-delivery@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":10000,"attempts":1,
            "signals":{"delivery":["merged","ci_failed"]},
            "diagnostic":{"kind":"string"}
        }),
        success_node(),
    ])
}

pub(super) async fn admitted(kind: RuntimePlanKind) -> AdmittedRun {
    NativeV2Admission
        .admit(RunSubmission {
            graph: shipping_graph(),
            initial_input: Value::Null,
            runtime: runtime(kind),
            ship: true,
            submission_key: IdempotencyKey::new("candidate-config").assert_value_with("key"),
        })
        .await
        .assert_value_with("admitted")
}

pub(super) fn candidate_config(
    kind: RuntimePlanKind,
    repository: &TempRepository,
    github: Arc<ScriptedGitHub>,
    ship: bool,
) -> NativeV2CandidateConfig {
    let pool = HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value_with("pool");
    let harness = match kind {
        RuntimePlanKind::Codex => NativeV2HarnessConfig::Codex(NativeV2CodexConfig {
            provider: CodexProvider::OpenAi,
            executable: PathBuf::from("/usr/bin/false"),
            workspace: repository.workspace.clone(),
            runtime_home: repository.root.child("codex-home"),
            search_path: "/usr/bin:/bin".to_owned(),
            process_pool: pool,
        }),
        RuntimePlanKind::Claude => NativeV2HarnessConfig::Claude(ClaudeAdapterConfig {
            provider: crate::native_v2_contract::ClaudeProvider::Anthropic,
            executable: "/usr/bin/false".to_owned(),
            prefix_arguments: Vec::new(),
            workspace: repository.workspace.clone(),
            base_environment: ClaudeProcessEnvironment::new(BTreeMap::from([
                (
                    "HOME".to_owned(),
                    repository.root.path().to_string_lossy().into_owned(),
                ),
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ]))
            .assert_value_with("Claude environment"),
            turn_timeout: Duration::from_secs(1),
            process_pool: pool,
        }),
    };
    NativeV2CandidateConfig {
        harness,
        delivery: NativeV2DeliveryConfig {
            workspace: repository.workspace.clone(),
            git_program: PathBuf::from("/usr/bin/git"),
            target: DeliveryTarget::new("acme/project", "main", repository.base.clone())
                .assert_value_with("target"),
            ship_authorized: ship,
            poll: DeliveryPollPolicy::new(2, Duration::ZERO).assert_value_with("poll"),
        },
        github,
    }
}

pub(super) async fn wait_for_terminal(
    controller: &NativeV2CloudController,
    run_id: &RunId,
) -> TerminalResult {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = ClusterBackend::run_status(
                controller,
                &ConnectionContext::default(),
                RunStatusParams {
                    run_id: run_id.clone(),
                },
            )
            .await
            .assert_value_with("OECP status");
            if let RunStatus::Finished { terminal_result } = status.status {
                return terminal_result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .assert_value_with("candidate became terminal")
}

use openengine_cluster_testkit::assertions::{AssertValue};
