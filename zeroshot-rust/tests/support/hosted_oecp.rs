use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, GraphSpec,
};
use serde_json::{json, Value};
use zeroshot_engine::hosted_oecp::ports::{
    DeliveryIntent, DeliveryReadinessReceipt, DeliveryReceipt, ProxyCleanupReceipt,
    ProxyReadinessPort, ProxyReadinessReceipt, TrustedServiceError, WorktreeReadinessPort,
    WorktreeReadinessReceipt, WorkspaceDeliveryPort, ISOLATION_PROFILE, PROVIDER_PROFILE,
};
use zeroshot_engine::hosted_oecp::{HostedAuthority, HostedBackend};

#[derive(Default)]
pub struct ReadyWorktree;

#[async_trait]
impl WorktreeReadinessPort for ReadyWorktree {
    async fn verify_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError> {
        Ok(WorktreeReadinessReceipt::ready())
    }
}

#[derive(Default)]
pub struct ReadyProxy {
    pub cleanup_calls: AtomicUsize,
}

#[async_trait]
impl ProxyReadinessPort for ReadyProxy {
    async fn verify_ready(&self) -> Result<ProxyReadinessReceipt, TrustedServiceError> {
        Ok(ProxyReadinessReceipt::ready())
    }

    async fn stop_admission_and_cleanup(&self) -> Result<ProxyCleanupReceipt, TrustedServiceError> {
        self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProxyCleanupReceipt::complete())
    }
}

#[derive(Default)]
pub struct RecordingDelivery {
    pub calls: AtomicUsize,
}

#[async_trait]
impl WorkspaceDeliveryPort for RecordingDelivery {
    async fn verify_ready(&self) -> Result<DeliveryReadinessReceipt, TrustedServiceError> {
        Ok(DeliveryReadinessReceipt::ready())
    }

    async fn deliver(
        &self,
        intent: DeliveryIntent,
    ) -> Result<DeliveryReceipt, TrustedServiceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(DeliveryReceipt {
            delivery_id: intent.delivery_id,
            review_ref: "review:hosted-1".to_owned(),
        })
    }
}

pub fn backend() -> HostedBackend {
    HostedBackend::new(
        Arc::new(ReadyWorktree),
        Arc::new(ReadyProxy::default()),
        Arc::new(RecordingDelivery::default()),
        HostedAuthority::new(
            "the-open-engine/zeroshot".to_owned(),
            "a".repeat(40),
            "codex".to_owned(),
            "level2".to_owned(),
        )
        .unwrap(),
    )
}

pub fn graph() -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.single-worker/v1",
        "initialInput": legacy_ship_request_payload_type(),
        "policy": { "policy": "policy.strict@1", "default": "deny" },
        "root": {
            "kind": "step",
            "name": "ship",
            "worker": "legacy.zeroshot.ship@1",
            "input": legacy_ship_request_payload_type(),
            "output": legacy_ship_result_payload_type(),
            "inputBindings": [],
            "writeBindings": [],
            "timeoutMs": 10_000,
            "attempts": 1
        }
    }))
    .expect("hosted graph fixture must decode")
}

pub fn request(prompt: &str) -> Value {
    json!({
        "source": "prompt",
        "prompt": prompt,
        "artifacts": [],
        "isolationProfile": ISOLATION_PROFILE,
        "providerProfile": PROVIDER_PROFILE,
        "repository": "the-open-engine/zeroshot",
        "provider": "codex",
        "modelLevel": "level2",
    })
}
