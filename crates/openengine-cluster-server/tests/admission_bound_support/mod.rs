//! Transport-generic duplicate-in-flight-id and bounded-task-admission scenarios, used identically
//! by `tests/subscription_ndjson.rs` (over NDJSON) and `tests/websocket.rs` (over WebSocket) since
//! both drive the exact same admission/dedup behavior against the shared `Dispatcher`/
//! connection-task machinery, independent of wire framing.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    AgentAttachParams, AgentAttachResult, ClusterStatus, GetParams, GetResult, InitializeParams,
    InitializeResult, LogsParams, LogsResult, RunId, ServerCapabilities, WatchParams, WatchResult,
};
use openengine_cluster_server::agent_attach::{AgentAttachEventStream, AgentAttachHandle};
use openengine_cluster_server::logs::{LogEventStream, LogsHandle};
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};
use openengine_cluster_server::watch::{WatchEventStream, WatchHandle};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use serde_json::Value;
use tokio::sync::Notify;

use crate::gated_backend_support::GatedBackend;

/// Minimal capability both wire harnesses share: writing framed requests and reading the next
/// decoded JSON-RPC frame, regardless of wire framing (NDJSON lines vs WebSocket text frames).
pub trait RequestChannel {
    async fn send_get(&mut self, id: i64);
    async fn send_raw(&mut self, text: &str);
    async fn recv_raw(&mut self) -> String;
    async fn recv_value(&mut self) -> Value;
}

/// Spawn glue letting [`spawn_gated_harness`] construct any wire harness `H` against a fresh
/// gated backend without each binding needing its own copy of that setup.
pub trait GatedHarnessSpawn: Sized {
    async fn spawn_gated(backend: GatedBackend) -> Self;
    async fn shut_down(self);
}

/// Spawn glue for exact subscription-envelope validation against an instrumented backend.
pub trait SubscriptionValidationHarness: GatedHarnessSpawn + RequestChannel {
    async fn spawn_subscription_validation(backend: SubscriptionCountingBackend) -> Self;
}

/// Constructs a fresh `FixtureStore`/[`GatedBackend`] pair (gating only `get`) and spawns `H`
/// against it, returning the harness alongside the gate so a test can release it once its
/// in-flight-request assertions are set up.
pub async fn spawn_gated_harness<H: GatedHarnessSpawn>() -> (H, Arc<Notify>) {
    let store = Arc::new(FixtureStore::new(RunId::new("run-1"), Vec::new(), 8));
    let gate = Arc::new(Notify::new());
    let harness = H::spawn_gated(GatedBackend {
        inner: FixtureBackend::new(store),
        gate: Arc::clone(&gate),
    })
    .await;
    (harness, gate)
}

#[derive(Default)]
pub struct SubscriptionCallCounters {
    watch: AtomicUsize,
    logs: AtomicUsize,
    agent_attach: AtomicUsize,
}

impl SubscriptionCallCounters {
    fn assert_zero(&self) {
        assert_eq!(self.watch.load(Ordering::SeqCst), 0, "watch backend calls");
        assert_eq!(self.logs.load(Ordering::SeqCst), 0, "logs backend calls");
        assert_eq!(
            self.agent_attach.load(Ordering::SeqCst),
            0,
            "agent/attach backend calls"
        );
    }

    fn assert_one_each(&self) {
        assert_eq!(self.watch.load(Ordering::SeqCst), 1, "watch backend calls");
        assert_eq!(self.logs.load(Ordering::SeqCst), 1, "logs backend calls");
        assert_eq!(
            self.agent_attach.load(Ordering::SeqCst),
            1,
            "agent/attach backend calls"
        );
    }
}

pub struct SubscriptionCountingBackend {
    counters: Arc<SubscriptionCallCounters>,
}

#[async_trait]
impl ClusterBackend for SubscriptionCountingBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult::empty())
    }

    async fn watch(
        &self,
        _context: &ConnectionContext,
        _params: WatchParams,
        _queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        self.counters.watch.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::application("TEST", "unexpected watch", None))
    }

    async fn logs(
        &self,
        _context: &ConnectionContext,
        _params: LogsParams,
        _queue_capacity: usize,
    ) -> Result<(LogsResult, LogEventStream, LogsHandle), BackendError> {
        self.counters.logs.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::application("TEST", "unexpected logs", None))
    }

    async fn agent_attach(
        &self,
        _context: &ConnectionContext,
        _params: AgentAttachParams,
        _queue_capacity: usize,
    ) -> Result<(AgentAttachResult, AgentAttachEventStream, AgentAttachHandle), BackendError> {
        self.counters.agent_attach.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::application(
            "TEST",
            "unexpected agent attach",
            None,
        ))
    }
}

fn assert_duplicate_response(response: &Value, id: i64) {
    assert_eq!(response["id"], id);
    assert_eq!(response["error"]["code"], -32600);
    assert_eq!(response["error"]["data"]["code"], "DUPLICATE_REQUEST_ID");
}

fn assert_get_success(response: &Value, id: i64) {
    assert_eq!(response["id"], id);
    assert!(response.get("result").is_some(), "{response}");
}

async fn fill_task_slots<H: RequestChannel>(harness: &mut H, max_connection_tasks: i64) -> Value {
    for id in 0..max_connection_tasks {
        harness.send_get(id).await;
    }
    harness.send_get(max_connection_tasks).await;
    tokio::time::timeout(Duration::from_secs(1), harness.recv_value())
        .await
        .expect("the bounded admission rejection must not wait for blocked backend calls")
}

fn assert_server_busy(response: &Value, id: i64) {
    assert_eq!(response["id"], id);
    assert_eq!(response["error"]["code"], -32000);
    assert_eq!(response["error"]["data"]["code"], "SERVER_BUSY");
}

/// Sends two `get` requests sharing request id `1` while `gate` blocks the first from completing,
/// asserts the second is rejected as a synchronous `DUPLICATE_REQUEST_ID` error (the first request
/// is still blocked on the gate, so the only frame that can possibly exist yet is the duplicate
/// rejection for the second), then releases the gate and asserts the first request completes
/// normally.
pub async fn assert_duplicate_in_flight_ids_are_rejected<H: RequestChannel>(
    harness: &mut H,
    gate: &Notify,
) {
    harness.send_get(1).await;
    harness.send_get(1).await;

    let duplicate = harness.recv_value().await;
    assert_duplicate_response(&duplicate, 1);

    gate.notify_one();
    let first = harness.recv_value().await;
    assert_get_success(&first, 1);
}

/// Sends `max_connection_tasks + 1` distinct-id `get` requests, all blocked on `harness`'s gated
/// backend, and asserts the request past the bound is rejected with a synchronous `SERVER_BUSY`
/// error that does not wait for any of the blocked backend calls to complete.
pub async fn assert_excess_requests_are_rejected_with_server_busy<H: RequestChannel>(
    harness: &mut H,
    max_connection_tasks: i64,
) {
    let rejected = fill_task_slots(harness, max_connection_tasks).await;
    assert_server_busy(&rejected, max_connection_tasks);
}

/// Proves an envelope with a legacy typed-request id still reaches duplicate detection before its
/// pre-encoded strict-version error.
pub async fn assert_wrong_version_envelope_retains_duplicate_precedence<H: RequestChannel>(
    harness: &mut H,
    gate: &Notify,
) {
    harness.send_get(1).await;
    harness
        .send_raw(r#"{"jsonrpc":"1.0","id":1,"method":"watch","params":{}}"#)
        .await;

    let duplicate = harness.recv_value().await;
    assert_duplicate_response(&duplicate, 1);
    gate.notify_one();
    let completed = harness.recv_value().await;
    assert_get_success(&completed, 1);
}

fn duplicate_subscription_frames(id: i64, method: &str) -> [String; 4] {
    [
        format!(
            r#"{{"jsonrpc":"2.0","jsonrpc":"2.0","id":{id},"method":"{method}","params":{{}}}}"#
        ),
        format!(
            r#"{{"jsonrpc":"2.0","id":{},"id":{id},"method":"{method}","params":{{}}}}"#,
            id - 1
        ),
        format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"get","method":"{method}","params":{{}}}}"#
        ),
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":[],"params":{{}}}}"#),
    ]
}

async fn assert_subscription_envelopes_are_not_classified<H: RequestChannel>(harness: &mut H) {
    for (id, method) in [(41, "watch"), (42, "logs"), (43, "agent/attach")] {
        harness
            .send_raw(&format!(
                r#"{{"jsonrpc":"1.0","id":{id},"method":"{method}","params":{{}}}}"#
            ))
            .await;
        assert_eq!(
            harness.recv_raw().await,
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#,
            "{method}"
        );

        for frame in duplicate_subscription_frames(id + 100, method) {
            harness.send_raw(&frame).await;
            assert_eq!(
                harness.recv_raw().await,
                format!(
                    r#"{{"jsonrpc":"2.0","id":{},"error":{{"code":-32601,"message":"Method not found"}}}}"#,
                    id + 100
                ),
                "{method}: {frame}"
            );
        }
    }
}

async fn assert_unknown_subscription_members_are_accepted<H: RequestChannel>(harness: &mut H) {
    for (id, method, params, message) in [
        (201, "watch", "{}", "unexpected watch"),
        (202, "logs", "{}", "unexpected logs"),
        (
            203,
            "agent/attach",
            r#"{"execution":"exec-1"}"#,
            "unexpected agent attach",
        ),
    ] {
        harness
            .send_raw(&format!(
                r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params},"extension":true}}"#
            ))
            .await;
        assert_eq!(
            harness.recv_raw().await,
            format!(
                r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32000,"message":"{message}","data":{{"code":"TEST"}}}}}}"#
            ),
            "{method}"
        );
    }
}

/// Runs strict and duplicate-field subscription-envelope scenarios against an instrumented
/// backend, asserting exact response bytes and zero subscription backend calls.
pub async fn assert_subscription_envelope_validation_for_binding<H>()
where
    H: SubscriptionValidationHarness,
{
    let counters = Arc::new(SubscriptionCallCounters::default());
    let mut harness = H::spawn_subscription_validation(SubscriptionCountingBackend {
        counters: Arc::clone(&counters),
    })
    .await;
    assert_subscription_envelopes_are_not_classified(&mut harness).await;
    counters.assert_zero();
    assert_unknown_subscription_members_are_accepted(&mut harness).await;
    counters.assert_one_each();
    harness.shut_down().await;
}

/// Proves id-less malformed input remains subject to the legacy task-slot boundary.
pub async fn assert_malformed_frame_is_dropped_at_task_saturation<H: RequestChannel>(
    harness: &mut H,
    max_connection_tasks: i64,
) {
    let saturated = fill_task_slots(harness, max_connection_tasks).await;
    assert_server_busy(&saturated, max_connection_tasks);

    harness.send_raw("{").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), harness.recv_value())
            .await
            .is_err(),
        "an id-less malformed frame must be dropped when every task slot is occupied"
    );
}

/// Binding-specific setup and liveness proofs for duplicate-key and unknown-member cancellation.
pub trait DuplicateCancellationChannel {
    async fn arrange_targets(&mut self);
    async fn send_duplicate_cancellation(&mut self);
    async fn recv_raw(&mut self) -> String;
    async fn assert_targets_remain_active(&mut self);
    async fn assert_unknown_member_cancellation_is_accepted(&mut self);
}

/// Proves duplicate cancellation keys retain typed-deserialization failure semantics and cancel
/// none of the binding's arranged targets, while unknown top-level members remain accepted.
pub async fn assert_duplicate_cancellation_is_malformed<C: DuplicateCancellationChannel>(
    channel: &mut C,
) {
    channel.arrange_targets().await;
    channel.send_duplicate_cancellation().await;
    assert_eq!(
        channel.recv_raw().await,
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}"#
    );
    channel.assert_targets_remain_active().await;
    channel
        .assert_unknown_member_cancellation_is_accepted()
        .await;
}
