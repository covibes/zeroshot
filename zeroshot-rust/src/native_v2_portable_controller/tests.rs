use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{
    IdempotencyKey, RunId, RunStatus, RunStatusParams, RunSubmitParams, Sha256Digest,
    TerminalResult,
};
use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::*;
use crate::native_v2_candidate::test_support::{full_graph, success_node};
use crate::native_v2_contract::{
    CodexProvider, RunSize, RunSubmission, RunTitle, RuntimePlan, SourceBranchId,
    SourceRepositoryId, SourceRevisionId, ResolvedSource,
};
use crate::native_v2_runner::{NodeHandle, NodeRunRequest, NodeRunnerError};
use crate::v2_run_ledger::{CreateRun, CreateRunOutcome, RunLedger};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "zeroshot-portable-{label}-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).assert_value_with("create portable test directory");
        Self(path)
    }

    fn child(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct NeverDispatched;

#[async_trait]
impl NodeRunner for NeverDispatched {
    async fn start(&self, _request: NodeRunRequest) -> Result<NodeHandle, NodeRunnerError> {
        Ok(None::<NodeHandle>.assert_value_with("terminal-only graph must not dispatch a node"))
    }

    async fn close_run(&self, _run_id: &RunId) {}
}

fn submission(key: &str) -> RunSubmission {
    RunSubmission {
        title: RunTitle::new("Portable controller test").assert_value_with("title"),
        graph: full_graph(vec![success_node()]),
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Tiny,
            nodes: BTreeMap::new(),
        },
        source: ResolvedSource {
            repository: SourceRepositoryId::new("open-engine/zeroshot")
                .assert_value_with("repository"),
            branch: SourceBranchId::new("main").assert_value_with("branch"),
            revision: SourceRevisionId::new("0123456789abcdef0123456789abcdef01234567")
                .assert_value_with("revision"),
        },
        submission_key: IdempotencyKey::new(key).assert_value_with("submission key"),
    }
}

fn bootstrap(
    run_id: RunId,
    submission: RunSubmission,
    workspace: PathBuf,
    storage: PathBuf,
) -> PortableControllerBootstrap {
    let environment = RunEnvironment::exact(&submission.runtime, BTreeMap::new())
        .assert_value_with("exact empty environment");
    PortableControllerBootstrap {
        run_id,
        submission,
        environment,
        github_token: None,
        workspace,
        workspace_lease: storage.join("workspace.lock"),
        storage,
        delivery_policy: DeliveryPolicy::Optional,
    }
}

async fn wait_terminal(
    client: &ClusterClient<&PortableControllerTransport>,
    run_id: &RunId,
) -> TerminalResult {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let status = client
                .run_status(RunStatusParams {
                    run_id: run_id.clone(),
                })
                .await
                .assert_value_with("portable status");
            if let RunStatus::Finished {
                terminal_result, ..
            } = status.status
            {
                return terminal_result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .assert_value_with("portable run became terminal")
}

#[tokio::test]
async fn one_run_server_is_ready_reconnectable_and_rejects_external_submission() {
    let root = TestDirectory::new("server");
    let workspace = root.child("workspace");
    let storage = root.child("state");
    std::fs::create_dir(&workspace).assert_value_with("workspace");
    let run_id = RunId::new("run-portable-server");
    let submitted = submission("portable-server");
    let controller = Arc::new(
        PortableRunController::start(
            bootstrap(
                run_id.clone(),
                submitted.clone(),
                workspace,
                storage.clone(),
            ),
            |_| Ok::<_, std::convert::Infallible>(PortableRuntime::new(Arc::new(NeverDispatched))),
        )
        .await
        .assert_value_with("start portable controller"),
    );
    assert_eq!(controller.paths().socket(), storage.join("controller.sock"));
    assert_eq!(
        controller.paths().ready(),
        storage.join("controller.ready.json")
    );
    assert_eq!(controller.paths().lease(), storage.join("controller.lock"));
    assert_eq!(controller.paths().ledger(), storage.join("runs.sqlite3"));

    let server = controller
        .clone()
        .bind()
        .await
        .assert_value_with("bind controller");
    let server_task = tokio::spawn(server.serve());
    let ready = wait_ready(controller.paths(), &run_id, Duration::from_secs(1))
        .await
        .assert_value_with("controller readiness");
    assert_eq!(ready.run_id, run_id);

    {
        let first_transport = connect_transport(controller.paths())
            .await
            .assert_value_with("first connection");
        let first_client = ClusterClient::new(first_transport.as_ref());
        assert!(matches!(
            wait_terminal(&first_client, &run_id).await,
            TerminalResult::Succeeded { .. }
        ));
    }

    let second_transport = connect_transport(controller.paths())
        .await
        .assert_value_with("reconnect");
    let second_client = ClusterClient::new(second_transport.as_ref());
    let error = second_client
        .run_submit(RunSubmitParams {
            run_id: RunId::new("run-caller-chosen"),
            submission: submitted,
        })
        .await
        .assert_error_with("external submission must be rejected");
    let error = match error {
        openengine_cluster_client::ClientError::Rpc(error) => Some(error),
        _ => None,
    }
    .assert_value_with("submission rejection was an RPC error");
    assert_eq!(
        error.data.assert_value_with("domain error data").code,
        openengine_cluster_protocol::RUN_CONFLICT
    );

    server_task.abort();
}

#[tokio::test]
async fn one_controller_exclusively_owns_a_workspace() {
    let root = TestDirectory::new("workspace-lease");
    let workspace = root.child("workspace");
    std::fs::create_dir(&workspace).assert_value_with("workspace");
    let shared_lease = root.child("workspace.lock");
    let mut first = bootstrap(
        RunId::new("run-workspace-first"),
        submission("workspace-first"),
        workspace.clone(),
        root.child("first-state"),
    );
    first.workspace_lease = shared_lease.clone();
    let first = PortableRunController::start(first, |_| {
        Ok::<_, std::convert::Infallible>(PortableRuntime::new(Arc::new(NeverDispatched)))
    })
    .await
    .assert_value_with("first workspace owner");

    let mut second = bootstrap(
        RunId::new("run-workspace-second"),
        submission("workspace-second"),
        workspace,
        root.child("second-state"),
    );
    second.workspace_lease = shared_lease;
    assert!(matches!(
        PortableRunController::start(second, |_| {
            Ok::<_, std::convert::Infallible>(PortableRuntime::new(Arc::new(NeverDispatched)))
        })
        .await,
        Err(PortableControllerError::Lease(ControllerLeaseError::Held))
    ));
    drop(first);
}

#[tokio::test]
async fn observer_reconciles_process_loss_without_constructing_or_dispatching_a_runtime() {
    let root = TestDirectory::new("observer");
    let storage = root.child("state");
    std::fs::create_dir(&storage).assert_value_with("state directory");
    let paths = PortableControllerPaths::new(storage);
    let run_id = RunId::new("run-portable-lost");
    let submitted = submission("portable-lost");
    let admitted = NativeV2Admission
        .admit_with_policy(submitted.clone(), DeliveryPolicy::Optional)
        .await
        .assert_value_with("admit durable run");
    let submission_digest = Sha256Digest::new(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&submitted).assert_value_with("encode submission"))
    ))
    .assert_value_with("submission digest");
    let ledger = SqliteRunLedger::open(paths.ledger()).assert_value_with("open durable ledger");
    let created = ledger
        .create_or_get(CreateRun {
            run_id: run_id.clone(),
            submission_key: submitted.submission_key.clone(),
            submission_digest,
            admitted,
        })
        .await
        .assert_value_with("seed nonterminal run");
    assert!(matches!(created, CreateRunOutcome::Created(_)));
    drop(ledger);

    let controller = Arc::new(
        PortableRunController::open_observer(paths.clone(), run_id.clone())
            .await
            .assert_value_with("open dead controller observer"),
    );
    assert!(matches!(
        ControllerLease::acquire(paths.lease()),
        Err(ControllerLeaseError::Held)
    ));
    let status = controller
        .inner
        .status(RunStatusParams {
            run_id: run_id.clone(),
        })
        .await
        .assert_value_with("durable lost status");
    assert_eq!(
        status.status,
        RunStatus::Finished {
            terminal_result: TerminalResult::Failed {
                reason: openengine_cluster_protocol::EnumLabel::new("runtime_lost")
                    .assert_value_with("runtime-lost label"),
            },
            metadata: Default::default(),
        }
    );

    let server = controller
        .clone()
        .bind()
        .await
        .assert_value_with("bind observer");
    let server_task = tokio::spawn(server.serve());
    wait_ready(&paths, &run_id, Duration::from_secs(1))
        .await
        .assert_value_with("observer readiness");
    let transport = connect_transport(&paths)
        .await
        .assert_value_with("observer connection");
    let client = ClusterClient::new(transport.as_ref());
    assert!(matches!(
        wait_terminal(&client, &run_id).await,
        TerminalResult::Failed { reason } if reason.as_str() == "runtime_lost"
    ));
    server_task.abort();
}

#[test]
fn bootstrap_is_private_bounded_consumed_and_exact() {
    let root = TestDirectory::new("bootstrap");
    let workspace = root.child("workspace");
    let storage = root.child("state");
    std::fs::create_dir(&workspace).assert_value_with("workspace");
    let path = root.child("controller.bootstrap.json");
    let run_id = RunId::new("run-portable-bootstrap");
    let bootstrap = bootstrap(
        run_id.clone(),
        submission("portable-bootstrap"),
        workspace,
        storage,
    );
    write_bootstrap_file(&path, &bootstrap).assert_value_with("write bootstrap");
    let loaded = load_bootstrap_file(&path).assert_value_with("load bootstrap");
    assert_eq!(loaded.run_id, run_id);
    assert!(!path.exists(), "bootstrap must be consumed exactly once");
}
