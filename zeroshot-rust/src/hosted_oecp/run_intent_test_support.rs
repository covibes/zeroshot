use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, GraphNode, GraphProfile,
    GraphSpec, NodeName, PolicyBinding, PolicyDefault, PolicyRef, PositiveInteger, StepNode,
    WorkerRef,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::{sleep, Duration, Instant};

use super::ports::{
    DeliveryIntent, DeliveryReadinessReceipt, DeliveryReceipt, ProxyCleanupReceipt,
    ProxyReadinessPort, ProxyReadinessReceipt, TrustedServiceError, WorktreeReadinessPort,
    WorktreeReadinessReceipt, WorkspaceDeliveryPort, ISOLATION_PROFILE, PROVIDER_PROFILE,
};
use super::run_intent::RunIntentExecutor;
use super::run_intent_http::serve_run_intent_http;
use super::server::{serve_prepared, HostedListeners};
use super::server_auth::{TransportCapability, RUNTIME_CAPABILITY_HEADER};
use super::test_support::NodeWorkerFixture;
use super::{HostedAuthority, HostedAuthorityConfig, HostedBackend};

pub(super) const INTENT_ID: &str = "019f7437-8701-71e3-a056-2ba05c37609c";
pub(super) const OTHER_INTENT_ID: &str = "019f7437-8701-71e3-a056-2ba05c37609d";
pub(super) const CAPABILITY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

pub(super) fn credential_bundle(provider: &str, environment: Value) -> Value {
    json!({
        "githubToken": "github-canary",
        "repository": "the-open-engine/zeroshot",
        "baseRevision": "a".repeat(40),
        "delivery": {
            "version": "zeroshot.delivery/v1",
            "mode": "pr",
            "repository": "the-open-engine/zeroshot",
            "targetBranch": "main",
            "baseRevision": "a".repeat(40),
        },
        "runtime": {
            "provider": provider,
            "executable": "future-cli",
            "model": "future/model",
            "command": "future-cli-wrapper",
            "environment": environment,
            "files": {".config/future/config.json": "{\"enabled\":true}"},
            "settings": {"defaultProvider": provider}
        }
    })
}

pub(super) fn hosted_authority() -> HostedAuthority {
    HostedAuthority::new(HostedAuthorityConfig {
        repository: "the-open-engine/zeroshot".to_owned(),
        base_revision: "a".repeat(40),
        provider: "codex".to_owned(),
    })
    .expect("hosted authority")
}

pub(super) fn graph() -> GraphSpec {
    GraphSpec {
        profile: GraphProfile::SingleWorker,
        initial_input: legacy_ship_request_payload_type(),
        policy: PolicyBinding {
            policy: PolicyRef::new("policy.strict@1").expect("policy reference"),
            default: PolicyDefault::Deny,
        },
        root: GraphNode::Step(StepNode {
            name: NodeName::new("ship").expect("node name"),
            worker: WorkerRef::new("legacy.zeroshot.ship@1").expect("worker reference"),
            input: legacy_ship_request_payload_type(),
            output: legacy_ship_result_payload_type(),
            input_bindings: Vec::new(),
            write_bindings: Vec::new(),
            timeout_ms: PositiveInteger::new(10_000).expect("worker timeout"),
            attempts: PositiveInteger::new(1).expect("worker attempts"),
        }),
    }
}

pub(super) fn input() -> Value {
    json!({
        "source": "prompt",
        "prompt": "credential-free queued run",
        "artifacts": []
    })
}

pub(super) fn direct_input() -> Value {
    json!({
        "source": "prompt",
        "prompt": "credential-free queued run",
        "artifacts": [],
        "isolationProfile": ISOLATION_PROFILE,
        "providerProfile": PROVIDER_PROFILE,
        "repository": "the-open-engine/zeroshot",
        "provider": "codex",
        "modelLevel": "level2"
    })
}

pub(super) fn envelope() -> Value {
    json!({
        "version": "zeroshot.run-intent/v2",
        "graph": graph(),
        "input": input()
    })
}

pub(super) fn encoded_envelope() -> Vec<u8> {
    serde_json::to_vec(&envelope()).expect("run intent serializes")
}

pub(super) fn credential_request(capability: &str, body: &[u8]) -> Vec<u8> {
    let headers = format!(
        "PUT /internal/credentials HTTP/1.1\r\n\
         Host: 127.0.0.1\r\n\
         {RUNTIME_CAPABILITY_HEADER}: {capability}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    [headers.as_bytes(), body].concat()
}

pub(super) struct TestServices {
    worktree_ready: AtomicBool,
    proxy_ready: AtomicBool,
    delivery_ready: AtomicBool,
    proxy_cleanup_calls: AtomicUsize,
    delivery_calls: AtomicUsize,
}

impl Default for TestServices {
    fn default() -> Self {
        Self {
            worktree_ready: AtomicBool::new(true),
            proxy_ready: AtomicBool::new(true),
            delivery_ready: AtomicBool::new(true),
            proxy_cleanup_calls: AtomicUsize::new(0),
            delivery_calls: AtomicUsize::new(0),
        }
    }
}

impl TestServices {
    pub(super) fn set_worktree_ready(&self, ready: bool) {
        self.worktree_ready.store(ready, Ordering::SeqCst);
    }

    pub(super) fn delivery_calls(&self) -> usize {
        self.delivery_calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl WorktreeReadinessPort for TestServices {
    async fn verify_ready(&self) -> Result<WorktreeReadinessReceipt, TrustedServiceError> {
        if self.worktree_ready.load(Ordering::SeqCst) {
            Ok(WorktreeReadinessReceipt::ready())
        } else {
            Err(TrustedServiceError::Unavailable)
        }
    }
}

#[async_trait]
impl ProxyReadinessPort for TestServices {
    async fn verify_ready(&self) -> Result<ProxyReadinessReceipt, TrustedServiceError> {
        self.proxy_ready
            .load(Ordering::SeqCst)
            .then(ProxyReadinessReceipt::ready)
            .ok_or(TrustedServiceError::Unavailable)
    }

    async fn stop_admission_and_cleanup(&self) -> Result<ProxyCleanupReceipt, TrustedServiceError> {
        self.proxy_cleanup_calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProxyCleanupReceipt::complete())
    }
}

#[async_trait]
impl WorkspaceDeliveryPort for TestServices {
    async fn verify_ready(&self) -> Result<DeliveryReadinessReceipt, TrustedServiceError> {
        self.delivery_ready
            .load(Ordering::SeqCst)
            .then(DeliveryReadinessReceipt::ready)
            .ok_or(TrustedServiceError::Unavailable)
    }

    async fn deliver(
        &self,
        intent: DeliveryIntent,
    ) -> Result<DeliveryReceipt, TrustedServiceError> {
        let attempt = self.delivery_calls.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(DeliveryReceipt {
            delivery_id: intent.delivery_id,
            review_ref: format!("review:run-intent-{attempt}"),
        })
    }
}

pub(super) fn test_backend(services: Arc<TestServices>) -> HostedBackend {
    HostedBackend::new(
        services.clone(),
        services.clone(),
        services,
        hosted_authority(),
    )
}

pub(super) async fn bind_listener() -> TcpListener {
    TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind test listener")
}

pub(super) async fn http_exchange(
    executor: Arc<dyn RunIntentExecutor>,
    request: Vec<u8>,
) -> Vec<u8> {
    let listener = bind_listener().await;
    let address = listener.local_addr().expect("control listener address");
    let backend = Arc::new(test_backend(Arc::new(TestServices::default())));
    let serving = tokio::spawn(async move {
        let (server, _) = listener.accept().await.expect("accept HTTP request");
        let capability = Arc::new(
            TransportCapability::parse(CAPABILITY.as_bytes()).expect("transport capability"),
        );
        serve_run_intent_http(server, backend, executor, capability).await
    });
    let response = tcp_http_exchange(address, request).await;
    serving
        .await
        .expect("HTTP task joins")
        .expect("HTTP exchange succeeds");
    response
}

pub(super) fn response_status(response: &[u8]) -> u16 {
    std::str::from_utf8(response)
        .expect("response is UTF-8")
        .split_whitespace()
        .nth(1)
        .expect("response status")
        .parse()
        .expect("numeric response status")
}

pub(super) fn response_json(response: &[u8]) -> Value {
    let body = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| &response[index + 4..])
        .expect("response body");
    serde_json::from_slice(body).expect("response JSON")
}

pub(super) struct HostedServerHarness {
    pub(super) worker: NodeWorkerFixture,
    pub(super) backend: Arc<HostedBackend>,
    pub(super) services: Arc<TestServices>,
    pub(super) control_address: SocketAddr,
    shutdown: oneshot::Sender<()>,
    serving: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl HostedServerHarness {
    pub(super) async fn start() -> Self {
        let services = Arc::new(TestServices::default());
        Self::start_with_services(services).await
    }

    pub(super) async fn start_with_services(services: Arc<TestServices>) -> Self {
        Self::start_config(services, "main", 25).await
    }

    pub(super) async fn start_with_worker(mode: &str) -> Self {
        Self::start_config(Arc::new(TestServices::default()), mode, 25).await
    }

    async fn start_config(services: Arc<TestServices>, mode: &str, delay_ms: u64) -> Self {
        let worker = NodeWorkerFixture::new("run-intent");
        let mut backend = test_backend(Arc::clone(&services));
        backend.worker_command = worker.command(mode, delay_ms);
        let backend = Arc::new(backend);
        let ndjson = bind_listener().await;
        let websocket = bind_listener().await;
        let run_intent = bind_listener().await;
        let control_address = run_intent.local_addr().expect("control address");
        let capability = Arc::new(
            TransportCapability::parse(CAPABILITY.as_bytes()).expect("transport capability"),
        );
        let (shutdown, shutdown_rx) = oneshot::channel();
        let serving = tokio::spawn(serve_prepared(
            HostedListeners::new(ndjson, websocket, run_intent),
            Arc::clone(&backend),
            capability,
            async move {
                let _ = shutdown_rx.await;
            },
        ));
        Self {
            worker,
            backend,
            services,
            control_address,
            shutdown,
            serving,
        }
    }

    pub(super) async fn shutdown(self) {
        self.shutdown.send(()).expect("request server shutdown");
        self.serving
            .await
            .expect("server task joins")
            .expect("server shuts down");
    }

    pub(super) async fn shutdown_after_runtime_failure(self) {
        self.shutdown.send(()).expect("request server shutdown");
        let error = self
            .serving
            .await
            .expect("server task joins")
            .expect_err("failed runtime makes shutdown report cleanup failure");
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
    }
}

pub(super) async fn assert_http_replay_and_conflicts(address: SocketAddr, body: &[u8]) {
    let digest = super::run_intent::digest_bytes(body);
    let replay = tcp_http_exchange(address, put_request(INTENT_ID, &digest, body)).await;
    assert!(matches!(response_status(&replay), 200 | 202));

    let mut conflicting = envelope();
    conflicting["input"]["prompt"] = json!("different");
    let conflicting = serde_json::to_vec(&conflicting).expect("conflict fixture");
    let conflicting_digest = super::run_intent::digest_bytes(&conflicting);
    let conflict = tcp_http_exchange(
        address,
        put_request(OTHER_INTENT_ID, &conflicting_digest, &conflicting),
    )
    .await;
    assert_eq!(response_status(&conflict), 409);

    let digest_conflict =
        tcp_http_exchange(address, get_request(INTENT_ID, &conflicting_digest)).await;
    assert_eq!(response_status(&digest_conflict), 409);
    let not_found = tcp_http_exchange(address, get_request(OTHER_INTENT_ID, &digest)).await;
    assert_eq!(response_status(&not_found), 404);
}

pub(super) async fn wait_for_http_terminal(address: SocketAddr, digest: &str) -> Value {
    response_json(&wait_for_http_terminal_response(address, digest).await)
}

pub(super) async fn wait_for_http_terminal_response(address: SocketAddr, digest: &str) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = tcp_http_exchange(address, get_request(INTENT_ID, digest)).await;
        let body = response_json(&response);
        if body["state"] != "running" {
            return response;
        }
        assert!(Instant::now() < deadline, "run intent did not finish");
        sleep(Duration::from_millis(10)).await;
    }
}

pub(super) async fn wait_for_http_not_found(address: SocketAddr, digest: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = tcp_http_exchange(address, get_request(INTENT_ID, digest)).await;
        if response_status(&response) == 404 {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "run intent did not become retryable"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

pub(super) fn put_request(intent_id: &str, digest: &str, body: &[u8]) -> Vec<u8> {
    format!(
        "PUT /internal/run-intents/{intent_id} HTTP/1.1\r\n\
         Host: capsule\r\n\
         Content-Type: application/json\r\n\
         {RUNTIME_CAPABILITY_HEADER}: {CAPABILITY}\r\n\
         x-zero-run-intent-digest: {digest}\r\n\
         Content-Length: {}\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes()
}

pub(super) fn get_request(intent_id: &str, digest: &str) -> Vec<u8> {
    format!(
        "GET /internal/run-intents/{intent_id} HTTP/1.1\r\n\
         Host: capsule\r\n\
         {RUNTIME_CAPABILITY_HEADER}: {CAPABILITY}\r\n\
         x-zero-run-intent-digest: {digest}\r\n\r\n"
    )
    .into_bytes()
}

pub(super) async fn tcp_http_exchange(address: SocketAddr, request: Vec<u8>) -> Vec<u8> {
    let mut stream = TcpStream::connect(address)
        .await
        .expect("connect control listener");
    stream
        .write_all(&request)
        .await
        .expect("write HTTP request");
    stream.shutdown().await.expect("finish HTTP request");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read HTTP response");
    response
}
