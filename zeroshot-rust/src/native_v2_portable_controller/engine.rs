use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::RunId;
use tokio::sync::watch;

use crate::native_v2_admission::DeliveryPolicy;
use crate::native_v2_cloud::{
    CapsuleCleanup, CapsuleCleanupUnavailable, CapsuleDestroyed, ExclusiveControllerClaim,
};
use crate::native_v2_runner::NodeRunner;
use crate::native_v2_supervisor::{RunEnvironment, RunRuntimeExit};
use crate::v2_run_ledger::RunLedger;

pub struct PortableRuntime {
    pub runner: Arc<dyn NodeRunner>,
    pub cleanup: Arc<dyn CapsuleCleanup>,
}

/// The shared one-run execution boundary used by hosted and standalone controllers.
pub struct PortableRunEngine {
    supervisor: Arc<crate::native_v2_supervisor::NativeV2Supervisor>,
    removable: watch::Receiver<bool>,
}

pub struct PortableRunEngineBootstrap {
    pub run_id: RunId,
    pub ledger: Arc<dyn RunLedger>,
    pub environment: RunEnvironment,
    pub runtime: PortableRuntime,
    pub loss: watch::Receiver<bool>,
    pub controller_claim: Arc<dyn ExclusiveControllerClaim>,
    pub delivery_policy: DeliveryPolicy,
    pub live_output: Arc<dyn crate::native_v2_supervisor::LiveOutputRegistrar>,
}

impl PortableRunEngine {
    #[must_use]
    pub fn start(bootstrap: PortableRunEngineBootstrap) -> Arc<Self> {
        let PortableRunEngineBootstrap {
            run_id,
            ledger,
            environment,
            runtime,
            mut loss,
            controller_claim,
            delivery_policy,
            live_output,
        } = bootstrap;
        let supervisor = Arc::new(
            crate::native_v2_supervisor::NativeV2Supervisor::new(
                run_id,
                ledger,
                runtime.runner,
                Arc::new(environment),
            )
            .with_delivery_policy(delivery_policy)
            .with_live_output(live_output)
            .with_runtime_cleanup(Arc::new(PortableRuntimeCleanup(runtime.cleanup))),
        );
        let (removable_sender, removable) = watch::channel(false);
        let engine = Arc::new(Self {
            supervisor: supervisor.clone(),
            removable,
        });
        tokio::spawn(async move {
            let _controller_claim = controller_claim;
            let drive_supervisor = supervisor.clone();
            let mut drive = Box::pin(async move { drive_supervisor.drive().await });
            let result = tokio::select! {
                result = &mut drive => result,
                () = wait_for_runtime_loss(&mut loss) => {
                    supervisor.runtime_lost().await;
                    drive.await
                }
            };
            if result.is_ok() {
                removable_sender.send_replace(true);
            }
        });
        engine
    }

    pub async fn force_stop(
        &self,
    ) -> Result<(), crate::native_v2_supervisor::NativeV2SupervisorError> {
        self.supervisor.force_stop().await?;
        self.supervisor.drive().await.map(|_| ())
    }

    pub async fn wait_removable(&self) {
        let mut removable = self.removable.clone();
        while !*removable.borrow_and_update() && removable.changed().await.is_ok() {}
    }
}

async fn wait_for_runtime_loss(loss: &mut watch::Receiver<bool>) {
    loop {
        if *loss.borrow_and_update() || loss.changed().await.is_err() {
            return;
        }
    }
}

struct PortableRuntimeCleanup(Arc<dyn CapsuleCleanup>);

#[async_trait]
impl crate::native_v2_supervisor::RunRuntimeCleanup for PortableRuntimeCleanup {
    async fn cleanup(
        &self,
        exit: RunRuntimeExit,
    ) -> Result<(), crate::native_v2_supervisor::RuntimeCleanupUnavailable> {
        self.0
            .destroy_or_confirm_absent(exit)
            .await
            .map(|_| ())
            .map_err(|_| crate::native_v2_supervisor::RuntimeCleanupUnavailable)
    }
}

impl PortableRuntime {
    #[must_use]
    pub fn new(runner: Arc<dyn NodeRunner>) -> Self {
        Self {
            runner,
            cleanup: Arc::new(ConfirmedCleanup),
        }
    }

    #[must_use]
    pub fn with_cleanup(runner: Arc<dyn NodeRunner>, cleanup: Arc<dyn CapsuleCleanup>) -> Self {
        Self { runner, cleanup }
    }
}

struct ConfirmedCleanup;

#[async_trait]
impl CapsuleCleanup for ConfirmedCleanup {
    async fn destroy_or_confirm_absent(
        &self,
        _exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        Ok(CapsuleDestroyed::confirmed())
    }
}
