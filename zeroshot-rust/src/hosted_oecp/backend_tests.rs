use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use async_trait::async_trait;
use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, ApplyParams, DispatchState,
    Generation, GetParams, GraphSpec, IdempotencyKey, Phase, StopMode, StopParams, WatchEvent,
    WatchParams, WorkerErrorCode, GONE,
};
use openengine_cluster_server::admission::CancellationSignal;
use openengine_cluster_server::watch::WatchStreamItem;
use openengine_cluster_server::{ClusterBackend, ConnectionContext};
use serde_json::json;
use tokio::sync::Notify;
use tokio::time::{sleep, timeout, Duration};

use super::HostedBackend;
use crate::hosted_oecp::test_support::{all_processes_absent, NodeWorkerFixture};
use crate::hosted_oecp::ports::{
    DeliveryIntent, DeliveryReadinessReceipt, DeliveryReceipt, ProxyCleanupReceipt,
    ProxyReadinessPort, ProxyReadinessReceipt, TrustedServiceError, WorktreeReadinessPort,
    WorktreeReadinessReceipt, WorkspaceDeliveryPort,
};
#[path = "backend_semantics_tests.rs"]
mod lifecycle_semantics;
#[path = "backend_stop_tests.rs"]
mod stop_semantics;

#[derive(Default)]
struct ReadyWorktree;

#[async_trait]
impl WorktreeReadinessPort for ReadyWorktree {
    async fn verify_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError> {
        Ok(WorktreeReadinessReceipt::ready())
    }
}

#[derive(Default)]
struct GatedWorktree {
    entered: Notify,
    released: AtomicBool,
    release: Notify,
}

impl GatedWorktree {
    fn allow(&self) {
        self.released.store(true, Ordering::Release);
        self.release.notify_waiters();
    }
}

#[async_trait]
impl WorktreeReadinessPort for GatedWorktree {
    async fn verify_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError> {
        self.entered.notify_one();
        loop {
            let released = self.release.notified();
            if self.released.load(Ordering::Acquire) {
                break;
            }
            released.await;
        }
        Ok(WorktreeReadinessReceipt::ready())
    }
}

#[derive(Default)]
struct OrderedProxy {
    cleaned: AtomicBool,
    calls: AtomicUsize,
    fail_cleanup: bool,
}

#[async_trait]
impl ProxyReadinessPort for OrderedProxy {
    async fn verify_ready(&self) -> Result<ProxyReadinessReceipt, TrustedServiceError> {
        Ok(ProxyReadinessReceipt::ready())
    }

    async fn stop_admission_and_cleanup(&self) -> Result<ProxyCleanupReceipt, TrustedServiceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.cleaned.store(true, Ordering::SeqCst);
        if self.fail_cleanup {
            Err(TrustedServiceError::Unavailable)
        } else {
            Ok(ProxyCleanupReceipt::complete())
        }
    }
}

struct OrderedDelivery {
    proxy: Arc<OrderedProxy>,
    pid_file: PathBuf,
    calls: AtomicUsize,
    ordering_failed: AtomicBool,
    fail_delivery: bool,
}

#[async_trait]
impl WorkspaceDeliveryPort for OrderedDelivery {
    async fn verify_ready(&self) -> Result<DeliveryReadinessReceipt, TrustedServiceError> {
        Ok(DeliveryReadinessReceipt::ready())
    }

    async fn deliver(
        &self,
        intent: DeliveryIntent,
    ) -> Result<DeliveryReceipt, TrustedServiceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let pids = fs::read_to_string(&self.pid_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|value| value.parse::<u32>().ok())
            .collect::<Vec<_>>();
        let process_tree_is_dead = pids.len() == 3 && all_processes_absent(&pids);
        if !self.proxy.cleaned.load(Ordering::SeqCst) || !process_tree_is_dead {
            self.ordering_failed.store(true, Ordering::SeqCst);
            return Err(TrustedServiceError::InvalidReceipt);
        }
        if self.fail_delivery {
            return Err(TrustedServiceError::Unavailable);
        }
        Ok(DeliveryReceipt {
            delivery_id: intent.delivery_id,
            review_ref: "review:hosted-test".to_owned(),
        })
    }
}

struct RuntimeFixture {
    _worker: NodeWorkerFixture,
    backend: HostedBackend,
    proxy: Arc<OrderedProxy>,
    delivery: Arc<OrderedDelivery>,
}
impl RuntimeFixture {
    fn new(result_delay_ms: u64) -> Self {
        Self::with_faults(result_delay_ms, false, false)
    }

    fn with_faults(result_delay_ms: u64, fail_cleanup: bool, fail_delivery: bool) -> Self {
        let worker = NodeWorkerFixture::new("backend");
        let pid_file = worker.pids_path();
        let proxy = Arc::new(OrderedProxy {
            fail_cleanup,
            ..OrderedProxy::default()
        });
        let delivery = Arc::new(OrderedDelivery {
            proxy: Arc::clone(&proxy),
            pid_file: pid_file.clone(),
            calls: AtomicUsize::new(0),
            ordering_failed: AtomicBool::new(false),
            fail_delivery,
        });
        let mut backend =
            HostedBackend::new(Arc::new(ReadyWorktree), proxy.clone(), delivery.clone());
        backend.worker_command = worker.command("main", result_delay_ms);
        Self {
            _worker: worker,
            backend,
            proxy,
            delivery,
        }
    }

    async fn wait_finished(&self) {
        for _ in 0..200 {
            let result = self
                .backend
                .get(&ConnectionContext::default(), GetParams::default())
                .await
                .expect("hosted get");
            if result.status.phase == Phase::Finished {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("hosted backend did not finish");
    }
}

fn graph(timeout_ms: u64) -> GraphSpec {
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
            "timeoutMs": timeout_ms,
            "attempts": 1
        }
    }))
    .expect("hosted graph")
}

async fn apply_and_collect(fixture: &RuntimeFixture, key: &str) -> Vec<WatchEvent> {
    let (_receipt, mut stream, _handle) = fixture
        .backend
        .watch(&ConnectionContext::default(), WatchParams::default(), 16)
        .await
        .expect("parked watch");
    fixture
        .backend
        .apply(&ConnectionContext::default(), apply(key))
        .await
        .expect("apply starts real worker");
    let mut events = Vec::new();
    loop {
        let item = timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("watch event deadline")
            .expect("watch remains live through Finished");
        let WatchStreamItem::Record(record) = item else {
            panic!("hosted watch must not overflow")
        };
        let finished = matches!(record.event, WatchEvent::Finished { .. });
        events.push(record.event);
        if finished {
            return events;
        }
    }
}

#[tokio::test]
async fn canonical_watch_is_ordered_bounded_and_secret_free() {
    let fixture = RuntimeFixture::new(25);
    let events = apply_and_collect(&fixture, "hosted-events-1").await;
    assert_eq!(events.len(), 4);
    assert!(matches!(events[0], WatchEvent::Phase { .. }));
    assert!(matches!(events[1], WatchEvent::NodeBegin { .. }));
    assert!(matches!(events[2], WatchEvent::NodeEnd { .. }));
    assert!(matches!(events[3], WatchEvent::Finished { .. }));
    let encoded = serde_json::to_string(&events).expect("events serialize");
    assert!(!encoded.contains("OPENROUTER_INPUT_CANARY"));
    assert!(!encoded.contains("OPENROUTER_STDERR_CANARY"));
    assert!(!encoded.contains("OPENROUTER_RESULT_CANARY"));
    let reconnect = match fixture
        .backend
        .watch(&ConnectionContext::default(), WatchParams::default(), 16)
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("finished live task accepted reconnect"),
    };
    assert_eq!(reconnect.code, GONE);
}
#[tokio::test]
async fn cleanup_failure_is_terminal_and_skips_delivery() {
    let fixture = RuntimeFixture::with_faults(25, true, false);
    let events = apply_and_collect(&fixture, "hosted-cleanup-fault-1").await;
    let WatchEvent::NodeEnd { outcome, .. } = &events[2] else {
        panic!("third event is NodeEnd")
    };
    assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Crash));
    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn delivery_failure_is_terminal_without_duplicate_delivery() {
    let fixture = RuntimeFixture::with_faults(25, false, true);
    let events = apply_and_collect(&fixture, "hosted-delivery-fault-1").await;
    let WatchEvent::NodeEnd { outcome, .. } = &events[2] else {
        panic!("third event is NodeEnd")
    };
    assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Crash));
    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    assert!(!fixture.delivery.ordering_failed.load(Ordering::SeqCst));
    fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("hosted-delivery-fault-1"),
        )
        .await
        .expect("committed apply replays after delivery fault");
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
}

fn apply_with_timeout(key: &str, timeout_ms: u64) -> ApplyParams {
    ApplyParams {
        graph: graph(timeout_ms),
        input: Some(json!({
            "source": "prompt",
            "prompt": "OPENROUTER_INPUT_CANARY",
            "artifacts": [],
            "isolationProfile": "isolation.prepared-worktree@1",
            "providerProfile": "provider.fixed-proxy@1"
        })),
        dry_run: false,
        if_generation: None,
        idempotency_key: Some(IdempotencyKey::new(key).expect("idempotency key")),
    }
}

fn apply(key: &str) -> ApplyParams {
    apply_with_timeout(key, 10_000)
}
fn stop_params(mode: StopMode, generation: Generation, key: &str) -> StopParams {
    StopParams {
        mode,
        if_generation: generation,
        idempotency_key: IdempotencyKey::new(key).expect("stop idempotency key"),
    }
}

#[tokio::test]
async fn process_result_is_delivered_once_after_cleanup_and_tree_death() {
    let fixture = RuntimeFixture::new(25);
    let first = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-apply-1"))
        .await
        .expect("apply starts real worker");
    assert_eq!(first.phase, Phase::Running);
    fixture.wait_finished().await;

    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    assert!(!fixture.delivery.ordering_failed.load(Ordering::SeqCst));

    let replay = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-apply-1"))
        .await
        .expect("same apply replays");
    assert_eq!(replay.run_id, first.run_id);
    assert!(replay.deduped);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    let mut reused = apply("hosted-apply-1");
    reused.input = Some(json!({
        "source": "prompt",
        "prompt": "different request",
        "artifacts": [],
        "isolationProfile": "isolation.prepared-worktree@1",
        "providerProfile": "provider.fixed-proxy@1"
    }));
    let reuse_error = fixture
        .backend
        .apply(&ConnectionContext::default(), reused)
        .await
        .expect_err("same key with different parameters is rejected");
    assert_eq!(
        reuse_error.code,
        openengine_cluster_protocol::IDEMPOTENCY_REUSE
    );

    let conflict = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-apply-2"))
        .await
        .expect_err("distinct second apply is rejected");
    assert_eq!(conflict.code, openengine_cluster_protocol::RUN_CONFLICT);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn timeout_reaps_before_failure_delivery() {
    let fixture = RuntimeFixture::new(10_000);
    fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            apply_with_timeout("hosted-timeout-1", 10),
        )
        .await
        .expect("apply starts real worker");
    fixture.wait_finished().await;
    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    assert!(!fixture.delivery.ordering_failed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn shutdown_without_a_run_still_cleans_the_proxy() {
    let fixture = RuntimeFixture::new(10_000);
    fixture
        .backend
        .verify_startup_readiness()
        .await
        .expect("startup readiness");
    fixture
        .backend
        .shutdown()
        .await
        .expect("empty shutdown cleanup");
    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn watch_unknown_run_and_invalid_cursor_are_not_found() {
    let unknown = super::map_watch_store_error(
        openengine_cluster_server::admission::StoreError::UnknownRun,
        false,
    );
    assert_eq!(unknown.code, openengine_cluster_protocol::NOT_FOUND);

    let invalid_cursor = super::map_watch_store_error(
        openengine_cluster_server::admission::StoreError::RunGone {
            tombstoned_at: None,
        },
        true,
    );
    assert_eq!(invalid_cursor.code, openengine_cluster_protocol::NOT_FOUND);
}

#[test]
fn watch_internal_failures_are_redacted_and_never_not_found() {
    let canary = "HOSTED_JOURNAL_INTERNAL_CANARY";
    let error = super::map_watch_store_error(
        openengine_cluster_server::admission::StoreError::Internal(canary.to_owned()),
        false,
    );

    assert_eq!(error.code, openengine_cluster_protocol::INTERNAL_ERROR_CODE);
    assert_ne!(error.code, openengine_cluster_protocol::NOT_FOUND);
    assert!(!error.message.contains(canary));
    assert!(!format!("{error:?}").contains(canary));
}
