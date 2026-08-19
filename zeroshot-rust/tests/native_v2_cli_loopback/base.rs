pub(crate) use std::any::Any;
pub(crate) use std::collections::{BTreeMap, BTreeSet};
pub(crate) use std::io;
pub(crate) use std::path::{Path, PathBuf};
pub(crate) use std::sync::atomic::{AtomicUsize, Ordering};
pub(crate) use std::sync::{Arc, Mutex};
pub(crate) use std::time::Duration;

pub(crate) use async_trait::async_trait;
pub(crate) use openengine_cluster_protocol::{
    IdempotencyKey, RunId, RunSubmission, RunSubmitParams, RunTitle, SourceBranchId,
    SourceRepositoryId, SourceRevisionId, SourceSnapshot, WorkerOutcome,
};
pub(crate) use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
pub(crate) use openengine_cluster_testkit::TemporaryDirectory as TempRoot;
pub(crate) use serde_json::json;
pub(crate) use tokio::io::{AsyncReadExt, AsyncWriteExt};
pub(crate) use tokio::net::{TcpListener, TcpStream};
pub(crate) use tokio::sync::watch;
pub(crate) use zeroshot_engine::execution::process::HostedProcessPool;
pub(crate) use zeroshot_engine::native_v2_cloud::{
    AllocatedCapsule, CapsuleAllocationUnavailable, CapsuleAllocator, CapsuleCleanup,
    CapsuleCleanupUnavailable, CapsuleDestroyed, ControllerClaimUnavailable,
    ExclusiveControllerClaim, NativeV2CloudController, run_intent_digest,
};
pub(crate) use zeroshot_engine::native_v2_admission::{DeliveryPolicy, NativeV2Admission};
pub(crate) use zeroshot_engine::native_v2_claude::ClaudeProcessEnvironment;
pub(crate) use zeroshot_engine::native_v2_contract::{
    AdmittedRun, EnvironmentVariableName, NodeInvocation, NodeRuntimeBinding, RuntimePlan,
};
pub(crate) use zeroshot_engine::native_v2_delivery::{
    DeliveryPollPolicy, DeliveryTarget, GitHubAuthorityError, GitHubChecks, GitHubCredential,
    GitHubDeliveryAuthority, GitHubMergeRequestOutcome, GitHubPushRequest, GitHubReviewObservation,
    GitHubReviewReceipt, GitHubReviewRequest, GitHubReviewState, NativeV2DeliveryAdapter,
    NativeV2DeliveryConfig, GITHUB_TOKEN_ENV,
};
pub(crate) use zeroshot_engine::native_v2_hosting::{
    ProductionHostingConfig, ProductionTargetControllerFactory,
};
pub(crate) use zeroshot_engine::native_v2_runner::{
    DriverControl, DriverInvocation, LiveOutput, LiveOutputStream, NativeNodeRunner, NodeDriver,
    NodeRunnerError, NodeSession, ResolvedEnvironment, SessionFactory,
};
pub(crate) use zeroshot_engine::native_v2_supervisor::{RunEnvironment, RunRuntimeExit};
pub(crate) use zeroshot_engine::native_v2_target_authority::{
    NativeV2TargetAuthority, NativeV2TargetServer, TargetAuthorityError, TargetControllerFactory,
    TargetBase, TargetRunIntent, TargetRunReceipt, TargetSessionAuthority, TargetSetupDocument,
};
pub(crate) use zeroshot_engine::v2_run_ledger::fake::FakeRunLedger;

pub(crate) const HOSTED_DISCOVERY_PATH: &str = "/.well-known/openengine-hosted-target";
pub(crate) const KEYRING_PREAMBLE: &str = r#"
mkdir -p "$3/keyring-control" "$3/keyring-data" || exit 90
chmod 700 "$3/keyring-control" "$3/keyring-data" || exit 90
export XDG_DATA_HOME="$3/keyring-data"
eval "$(printf '\n' | gnome-keyring-daemon --control-directory="$3/keyring-control" --unlock --components=secrets)"
printf ready | secret-tool store --label='Zeroshot native-v2 acceptance' zeroshot-test "$$" || exit 90
test "$(secret-tool lookup zeroshot-test "$$")" = ready || exit 90
secret-tool clear zeroshot-test "$$" || exit 90
"#;

static NEXT_TEST_RUN: AtomicUsize = AtomicUsize::new(1);

pub(crate) fn temp_root() -> TempRoot {
    TempRoot::for_test("zeroshot-native-v2-cli")
}

pub(crate) struct ControllerClaim;
impl ExclusiveControllerClaim for ControllerClaim {}

pub(crate) fn controller_claim() -> Arc<dyn ExclusiveControllerClaim> {
    Arc::new(ControllerClaim)
}

pub(crate) fn confirmed_capsule_destroyed() -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
    Ok(CapsuleDestroyed::confirmed())
}

pub(crate) struct ImmediateCleanup;

#[async_trait]
impl CapsuleCleanup for ImmediateCleanup {
    async fn destroy_or_confirm_absent(
        &self,
        _exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        confirmed_capsule_destroyed()
    }
}

#[derive(Default)]
pub(crate) struct ImmediateAllocator {
    pub(crate) losses: Mutex<Vec<watch::Sender<bool>>>,
}

impl ImmediateAllocator {
    pub(crate) fn signal_loss(&self) -> bool {
        let losses = self.losses.lock().assert_value();
        let Some(sender) = losses.last() else {
            return false;
        };
        sender.send(true).is_ok()
    }
}

#[async_trait]
impl CapsuleAllocator for ImmediateAllocator {
    async fn claim_controller(
        &self,
        _run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        Ok(controller_claim())
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        admitted: &AdmittedRun,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        let runner = NativeNodeRunner::new(
            admitted,
            Arc::new(BlockingDriver),
            Arc::new(ImmediateSessionFactory),
        )
        .map_err(|_| CapsuleAllocationUnavailable)?;
        let (loss, receiver) = watch::channel(false);
        self.losses.lock().assert_value().push(loss);
        Ok(AllocatedCapsule {
            runner: Arc::new(runner),
            loss: receiver,
            cleanup: Arc::new(ImmediateCleanup),
        })
    }

    async fn destroy_or_confirm_absent(
        &self,
        _run_id: &RunId,
        _exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        confirmed_capsule_destroyed()
    }
}

pub(crate) struct BlockingDriver;

#[async_trait]
impl NodeDriver for BlockingDriver {
    async fn run(
        &self,
        _invocation: DriverInvocation,
        mut control: DriverControl,
    ) -> Result<WorkerOutcome, NodeRunnerError> {
        control.emit(LiveOutput::new(
            LiveOutputStream::Output,
            "acceptance-live-output",
        )?)?;
        control.cancelled().await;
        Err(NodeRunnerError::Cancelled)
    }
}

pub(crate) struct ImmediateSession {
    pub(crate) live: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl NodeSession for ImmediateSession {
    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn is_live(&self) -> bool {
        self.live.load(std::sync::atomic::Ordering::Acquire)
    }

    async fn close(&self) {
        self.live.store(false, std::sync::atomic::Ordering::Release);
    }
}

pub(crate) struct ImmediateSessionFactory;

#[async_trait]
impl SessionFactory for ImmediateSessionFactory {
    async fn open(
        &self,
        _invocation: &NodeInvocation,
        _environment: &ResolvedEnvironment,
    ) -> Result<Arc<dyn NodeSession>, NodeRunnerError> {
        Ok(Arc::new(ImmediateSession {
            live: std::sync::atomic::AtomicBool::new(true),
        }))
    }
}

pub(crate) struct TestControllerFactory;

#[async_trait]
impl TargetControllerFactory for TestControllerFactory {
    async fn create(
        &self,
        _setup: &TargetSetupDocument,
    ) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        test_controller(Arc::new(ImmediateAllocator::default())).await
    }

    async fn submit(
        &self,
        setup: &TargetSetupDocument,
        controller: &NativeV2CloudController,
        intent: TargetRunIntent,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        submit_test_run(
            setup,
            controller,
            intent,
            ("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &BTreeMap::new()),
        )
        .await
    }
}

pub(crate) struct FixedAllocatorFactory {
    pub(crate) allocator: Arc<dyn CapsuleAllocator>,
    pub(crate) environment: BTreeMap<EnvironmentVariableName, String>,
    pub(crate) resolved_base_revision: String,
    pub(crate) delivery_policy: DeliveryPolicy,
}

#[async_trait]
impl TargetControllerFactory for FixedAllocatorFactory {
    async fn create(
        &self,
        _setup: &TargetSetupDocument,
    ) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        test_controller_with_policy(self.allocator.clone(), self.delivery_policy).await
    }

    async fn submit(
        &self,
        setup: &TargetSetupDocument,
        controller: &NativeV2CloudController,
        intent: TargetRunIntent,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        submit_test_run(
            setup,
            controller,
            intent,
            (&self.resolved_base_revision, &self.environment),
        )
        .await
    }
}

async fn test_controller(
    allocator: Arc<dyn CapsuleAllocator>,
) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
    test_controller_with_policy(allocator, DeliveryPolicy::Required).await
}

async fn test_controller_with_policy(
    allocator: Arc<dyn CapsuleAllocator>,
    delivery_policy: DeliveryPolicy,
) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
    NativeV2CloudController::new_with_delivery_policy(
        Arc::new(FakeRunLedger::new()),
        allocator,
        delivery_policy,
    )
    .await
    .map(Arc::new)
    .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))
}

pub(crate) async fn submit_test_run(
    setup: &TargetSetupDocument,
    controller: &NativeV2CloudController,
    intent: TargetRunIntent,
    resolution: (&str, &BTreeMap<EnvironmentVariableName, String>),
) -> Result<TargetRunReceipt, TargetAuthorityError> {
    let (resolved_base_revision, environment) = resolution;
    let intent_digest = run_intent_digest(&intent)
        .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
    if let Some(existing) = controller
        .resolve_intent(&intent.submission_key, &intent_digest)
        .await
        .map_err(|error| TargetAuthorityError::conflict(error.to_string()))?
    {
        return Ok(TargetRunReceipt {
            run_id: existing.run_id,
        });
    }
    let source = test_source_snapshot(setup, resolved_base_revision)?;
    let run_id = RunId::new(format!(
        "run-loopback-{}",
        NEXT_TEST_RUN.fetch_add(1, Ordering::Relaxed)
    ));
    let TargetRunIntent {
        title,
        graph,
        initial_input,
        runtime,
        submission_key,
    } = intent;
    let submission = RunSubmission {
        source,
        title,
        graph,
        initial_input,
        runtime,
        submission_key,
    };
    let exact_environment = RunEnvironment::exact(&submission.runtime, environment.clone())
        .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
    let receipt = controller
        .submit_with_intent_digest_and_exact_environment(
            RunSubmitParams { run_id, submission },
            intent_digest,
            exact_environment,
        )
        .await
        .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))?;
    Ok(TargetRunReceipt {
        run_id: receipt.run_id,
    })
}

fn test_source_snapshot(
    setup: &TargetSetupDocument,
    resolved_base_revision: &str,
) -> Result<SourceSnapshot, TargetAuthorityError> {
    let (target_branch, base_revision) = match &setup.base {
        TargetBase::Default => ("main", resolved_base_revision),
        TargetBase::Branch { branch } => (branch.as_str(), resolved_base_revision),
        TargetBase::Revision {
            revision,
            target_branch,
        } => (target_branch.as_str(), revision.as_str()),
    };
    Ok(SourceSnapshot {
        repository: SourceRepositoryId::new(&setup.repository)
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?,
        target_branch: SourceBranchId::new(target_branch)
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?,
        base_revision: SourceRevisionId::new(base_revision)
            .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?,
    })
}

use openengine_cluster_testkit::assertions::{AssertValue};
