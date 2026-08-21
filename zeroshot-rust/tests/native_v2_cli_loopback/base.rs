pub(crate) use std::any::Any;
pub(crate) use std::collections::{BTreeMap, BTreeSet};
pub(crate) use std::io;
pub(crate) use std::path::{Path, PathBuf};
pub(crate) use std::sync::atomic::{AtomicUsize, Ordering};
pub(crate) use std::sync::{Arc, Mutex};
pub(crate) use std::time::Duration;

pub(crate) use async_trait::async_trait;
pub(crate) use openengine_cluster_protocol::{
    IdempotencyKey, RunId, RunSubmitParams, RunTitle, WorkerOutcome,
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
    ExclusiveControllerClaim, NativeV2CloudController,
};
pub(crate) use zeroshot_engine::native_v2_admission::{DeliveryPolicy, NativeV2Admission};
pub(crate) use zeroshot_engine::native_v2_cli::TargetRunIntent;
pub(crate) use zeroshot_engine::native_v2_claude::ClaudeProcessEnvironment;
pub(crate) use zeroshot_engine::native_v2_contract::{
    AdmittedRun, NodeInvocation, NodeRuntimeBinding, RuntimePlan,
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
    TargetOecpSessionRequest, TargetRunReceipt, TargetRunRequest, TargetSessionAuthority,
};
pub(crate) use zeroshot_engine::v2_run_ledger::fake::FakeRunLedger;

pub(crate) const HOSTED_DISCOVERY_PATH: &str = "/.well-known/zeroshot-native-v2";
pub(crate) const TEST_SOURCE_REVISION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) const KEYRING_PREAMBLE: &str = r#"
mkdir -p "$3/keyring-control" "$3/keyring-data" || exit 90
chmod 700 "$3/keyring-control" "$3/keyring-data" || exit 90
export XDG_DATA_HOME="$3/keyring-data"
eval "$(printf '\n' | gnome-keyring-daemon --control-directory="$3/keyring-control" --unlock --components=secrets)"
printf ready | secret-tool store --label='Zeroshot native-v2 acceptance' zeroshot-test "$$" || exit 90
test "$(secret-tool lookup zeroshot-test "$$")" = ready || exit 90
secret-tool clear zeroshot-test "$$" || exit 90
"#;

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
        _github_token: Option<&str>,
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
    async fn create(&self) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        test_controller(Arc::new(ImmediateAllocator::default())).await
    }

    async fn submit(
        &self,
        controller: &NativeV2CloudController,
        request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        submit_test_run(controller, request).await
    }
}

pub(crate) struct FixedAllocatorFactory {
    pub(crate) allocator: Arc<dyn CapsuleAllocator>,
    pub(crate) delivery_policy: DeliveryPolicy,
}

#[async_trait]
impl TargetControllerFactory for FixedAllocatorFactory {
    async fn create(&self) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        test_controller_with_policy(self.allocator.clone(), self.delivery_policy).await
    }

    async fn submit(
        &self,
        controller: &NativeV2CloudController,
        request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        submit_test_run(controller, request).await
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
    controller: &NativeV2CloudController,
    request: TargetRunRequest,
) -> Result<TargetRunReceipt, TargetAuthorityError> {
    let TargetRunRequest {
        run_id,
        submission,
        environment,
        github_token,
    } = request;
    let exact_environment = RunEnvironment::exact(&submission.runtime, environment)
        .map_err(|error| TargetAuthorityError::invalid(error.to_string()))?;
    let receipt = controller
        .submit_with_exact_environment_and_github_token(
            RunSubmitParams { run_id, submission },
            exact_environment,
            github_token,
        )
        .await
        .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))?;
    Ok(TargetRunReceipt {
        run_id: receipt.run_id,
    })
}

use openengine_cluster_testkit::assertions::{AssertValue};
