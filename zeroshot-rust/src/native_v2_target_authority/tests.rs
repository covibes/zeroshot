use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::ClusterClient;
use openengine_cluster_client::websocket::WebSocketTransport;
use openengine_cluster_protocol::{
    IdempotencyKey, RunId, RunListParams, RunSize, RunTitle, RuntimePlan,
};
use openengine_cluster_testkit::assertions::AssertValue;
use openengine_cluster_testkit::admission::graph_fixture;
use serde_json::{json, Value};
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, HeaderValue};

use super::*;
use crate::native_v2_cloud::{
    AllocatedCapsule, CapsuleAllocationUnavailable, CapsuleAllocator, CapsuleCleanupUnavailable,
    CapsuleDestroyed, ControllerClaimUnavailable, ExclusiveControllerClaim,
};
use crate::native_v2_contract::{AdmittedRun, CodexProvider};
use crate::native_v2_supervisor::{RunEnvironment, RunRuntimeExit};
use crate::v2_run_ledger::fake::FakeRunLedger;

#[path = "tests/run_submission.rs"]
mod run_submission;
use run_submission::assert_run_submission;
#[path = "tests/http.rs"]
mod http_fixture;
use http_fixture::{http, TestHttpRequest};

struct Claim;
impl ExclusiveControllerClaim for Claim {}

struct NoAllocation;

#[async_trait]
impl CapsuleAllocator for NoAllocation {
    async fn claim_controller(
        &self,
        _run_id: &RunId,
    ) -> Result<Arc<dyn ExclusiveControllerClaim>, ControllerClaimUnavailable> {
        Ok(Arc::new(Claim))
    }

    async fn allocate(
        &self,
        _run_id: &RunId,
        _admitted: &AdmittedRun,
        _environment: &RunEnvironment,
    ) -> Result<AllocatedCapsule, CapsuleAllocationUnavailable> {
        Err(CapsuleAllocationUnavailable)
    }

    async fn destroy_or_confirm_absent(
        &self,
        _run_id: &RunId,
        _exit: RunRuntimeExit,
    ) -> Result<CapsuleDestroyed, CapsuleCleanupUnavailable> {
        Ok(CapsuleDestroyed::confirmed())
    }
}

#[derive(Default)]
struct FakeFactory {
    calls: AtomicUsize,
    submissions: AtomicUsize,
    active_submissions: AtomicUsize,
    max_active_submissions: AtomicUsize,
}

#[async_trait]
impl TargetControllerFactory for FakeFactory {
    async fn create(
        &self,
        _setup: &TargetSetupDocument,
    ) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        NativeV2CloudController::new(Arc::new(FakeRunLedger::new()), Arc::new(NoAllocation))
            .await
            .map(Arc::new)
            .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))
    }

    async fn submit(
        &self,
        _setup: &TargetSetupDocument,
        _controller: &NativeV2CloudController,
        _request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        let active = self.active_submissions.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active_submissions
            .fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        self.active_submissions.fetch_sub(1, Ordering::SeqCst);
        self.submissions.fetch_add(1, Ordering::SeqCst);
        Ok(TargetRunReceipt {
            run_id: RunId::new("run-fake"),
        })
    }
}

struct FakeSessions;

#[async_trait]
impl TargetSessionAuthority for FakeSessions {
    async fn authenticate_control(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError> {
        if bearer_token == "control-token" {
            Ok(identity())
        } else {
            Err(TargetAuthorityError::unauthorized())
        }
    }

    async fn issue_oecp(
        &self,
        _identity: &ConnectionIdentity,
    ) -> Result<String, TargetAuthorityError> {
        Ok("oecp-token".to_owned())
    }

    async fn authenticate_oecp(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError> {
        if bearer_token == "oecp-token" {
            Ok(identity())
        } else {
            Err(TargetAuthorityError::unauthorized())
        }
    }
}

fn identity() -> ConnectionIdentity {
    ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new("test-user"),
        tenant: TenantId::new("test-target"),
        issued_at_ms: None,
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    })
}

fn setup(repository: &str) -> TargetSetupDocument {
    TargetSetupDocument {
        repository: repository.to_owned(),
        default_branch: None,
    }
}

fn intent() -> TargetRunIntent {
    TargetRunIntent {
        title: RunTitle::new("Target authority test").assert_value(),
        graph: graph_fixture("worker", json!({"kind": "null"})),
        initial_input: Value::Null,
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Tiny,
            nodes: BTreeMap::new(),
        },
        branch: None,
        submission_key: IdempotencyKey::new("target-authority-test").assert_value(),
    }
}

fn request() -> TargetRunRequest {
    TargetRunRequest {
        intent: intent(),
        environment: BTreeMap::new(),
    }
}

struct TempSetupRoot(std::path::PathBuf);

impl TempSetupRoot {
    fn new() -> Self {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).assert_value();
        let path = std::env::temp_dir().join(format!(
            "zeroshot-v2-target-setup-{}-{}",
            std::process::id(),
            encode_hex(&random)
        ));
        Self(path)
    }
}

impl Drop for TempSetupRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn file_setup_store_atomically_replaces_and_restores_one_document() {
    let root = TempSetupRoot::new();
    let store = Arc::new(FileTargetSetupStore::new(root.0.join("setup.json")));
    let first_factory = Arc::new(FakeFactory::default());
    let first = NativeV2TargetAuthority::with_setup_store(first_factory, store.clone())
        .await
        .assert_value();
    first.install(setup("owner/first")).await.assert_value();
    first.install(setup("owner/current")).await.assert_value();
    drop(first);

    let restored_factory = Arc::new(FakeFactory::default());
    let restored =
        NativeV2TargetAuthority::with_setup_store(restored_factory.clone(), store.clone())
            .await
            .assert_value();
    restored.controller().await.assert_value();
    assert_eq!(restored_factory.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        restored
            .install(setup("owner/current"))
            .await
            .assert_value(),
        TargetSetupOutcome::Unchanged
    );
    assert_eq!(
        restored
            .install(setup("owner/divergent"))
            .await
            .assert_value(),
        TargetSetupOutcome::Installed
    );
    assert_eq!(
        store.load().await.assert_value(),
        Some(setup("owner/divergent"))
    );
}

#[tokio::test]
async fn setup_replacement_keeps_the_shared_controller_and_updates_later_submissions() {
    let factory = Arc::new(FakeFactory::default());
    let authority = NativeV2TargetAuthority::new(factory.clone());
    assert_eq!(
        authority.install(setup("owner/first")).await.assert_value(),
        TargetSetupOutcome::Installed
    );
    assert_eq!(
        authority
            .install(setup("owner/second"))
            .await
            .assert_value(),
        TargetSetupOutcome::Installed
    );
    let first = authority.controller().await.assert_value();
    let second = authority.controller().await.assert_value();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(factory.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        authority
            .install(setup("owner/second"))
            .await
            .assert_value(),
        TargetSetupOutcome::Unchanged
    );
    assert_eq!(
        authority.install(setup("owner/third")).await.assert_value(),
        TargetSetupOutcome::Installed
    );
}

#[tokio::test]
async fn concurrent_target_submissions_share_one_host_submission_turn() {
    let factory = Arc::new(FakeFactory::default());
    let authority = Arc::new(
        NativeV2TargetAuthority::with_installed_setup(factory.clone(), setup("owner/repo"))
            .assert_value(),
    );
    let left = {
        let authority = authority.clone();
        tokio::spawn(async move { authority.submit(request()).await })
    };
    let right = {
        let authority = authority.clone();
        tokio::spawn(async move { authority.submit(request()).await })
    };
    let (left, right) = tokio::join!(left, right);
    assert_eq!(
        left.assert_value().assert_value(),
        right.assert_value().assert_value()
    );
    assert_eq!(factory.submissions.load(Ordering::SeqCst), 2);
    assert_eq!(factory.max_active_submissions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn loopback_routes_setup_session_and_target_scoped_oecp() {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let factory = Arc::new(FakeFactory::default());
    let authority = Arc::new(NativeV2TargetAuthority::new(factory.clone()));
    let endpoint = format!("ws://{address}{OECP_PATH}");
    let server = Arc::new(
        NativeV2TargetServer::new_hosted(authority, Arc::new(FakeSessions), endpoint.clone())
            .assert_value(),
    );
    let server_task = tokio::spawn(server.serve(listener));

    let discovery = http(address, TestHttpRequest::empty("GET", DISCOVERY_PATH, None)).await;
    assert_eq!(discovery.status, 200);
    let document: TargetDiscoveryDocument = serde_json::from_slice(&discovery.body).assert_value();
    assert_eq!(document, TargetDiscoveryDocument::default());
    assert_pre_setup_routes(address, &factory).await;
    let encoded_setup = serde_json::to_vec(&setup("owner/repo")).assert_value();
    assert_setup_outcome(address, &encoded_setup, TargetSetupOutcome::Installed).await;
    assert_run_submission(address, &factory).await;
    let session = http(
        address,
        TestHttpRequest::empty("POST", SESSION_PATH, Some("control-token")),
    )
    .await;
    assert_eq!(session.status, 200);
    let session: TargetOecpSession = serde_json::from_slice(&session.body).assert_value();
    assert_eq!(session.endpoint, endpoint);
    assert_eq!(factory.calls.load(Ordering::SeqCst), 1);

    let mut rejected_request = session
        .endpoint
        .clone()
        .into_client_request()
        .assert_value();
    rejected_request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer wrong-token"),
    );
    assert!(
        tokio_tungstenite::connect_async(rejected_request)
            .await
            .is_err()
    );

    let mut request = session.endpoint.into_client_request().assert_value();
    request
        .headers_mut()
        .insert(AUTHORIZATION, HeaderValue::from_static("Bearer oecp-token"));
    let (websocket, _) = tokio_tungstenite::connect_async(request)
        .await
        .assert_value();
    let client = ClusterClient::new(WebSocketTransport::new(websocket));
    client.initialize().await.assert_value();
    let listed = client.run_list(RunListParams {}).await.assert_value();
    assert!(listed.runs.is_empty());
    assert_setup_outcome(address, &encoded_setup, TargetSetupOutcome::Unchanged).await;
    let divergent = http(
        address,
        TestHttpRequest::body(
            "PUT",
            SETUP_PATH,
            Some("control-token"),
            &serde_json::to_vec(&setup("owner/other")).assert_value(),
        ),
    )
    .await;
    assert_eq!(divergent.status, 200);
    assert_eq!(
        serde_json::from_slice::<TargetSetupResult>(&divergent.body)
            .assert_value()
            .outcome,
        TargetSetupOutcome::Installed
    );

    server_task.abort();
}

#[tokio::test]
async fn direct_loopback_routes_control_and_oecp_without_bearers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let factory = Arc::new(FakeFactory::default());
    let authority = Arc::new(NativeV2TargetAuthority::new(factory.clone()));
    let endpoint = format!("ws://{address}{OECP_PATH}");
    let server = Arc::new(
        NativeV2TargetServer::new_direct(authority, identity(), endpoint.clone()).assert_value(),
    );
    let server_task = tokio::spawn(server.serve(listener));

    let discovery = http(address, TestHttpRequest::empty("GET", DISCOVERY_PATH, None)).await;
    let document: TargetDiscoveryDocument = serde_json::from_slice(&discovery.body).assert_value();
    assert_eq!(document.authentication, TargetAuthentication::None);

    let encoded_setup = serde_json::to_vec(&setup("owner/repo")).assert_value();
    let installed = http(
        address,
        TestHttpRequest::body("PUT", SETUP_PATH, None, &encoded_setup),
    )
    .await;
    assert_eq!(installed.status, 200);
    let session = http(address, TestHttpRequest::empty("POST", SESSION_PATH, None)).await;
    assert_eq!(session.status, 200);
    let session: TargetOecpSession = serde_json::from_slice(&session.body).assert_value();
    assert_eq!(session.endpoint, endpoint);
    assert_eq!(session.bearer_token, None);

    let request = session.endpoint.into_client_request().assert_value();
    assert!(request.headers().get(AUTHORIZATION).is_none());
    let (websocket, _) = tokio_tungstenite::connect_async(request)
        .await
        .assert_value();
    let client = ClusterClient::new(WebSocketTransport::new(websocket));
    client.initialize().await.assert_value();
    assert!(
        client
            .run_list(RunListParams {})
            .await
            .assert_value()
            .runs
            .is_empty()
    );
    assert_eq!(factory.calls.load(Ordering::SeqCst), 1);

    server_task.abort();
}

async fn assert_pre_setup_routes(address: std::net::SocketAddr, factory: &FakeFactory) {
    let unauthorized = http(
        address,
        TestHttpRequest::body(
            "PUT",
            SETUP_PATH,
            None,
            &serde_json::to_vec(&setup("owner/repo")).assert_value(),
        ),
    )
    .await;
    assert_eq!(unauthorized.status, 401);
    let session = http(
        address,
        TestHttpRequest::empty("POST", SESSION_PATH, Some("control-token")),
    )
    .await;
    assert_eq!(session.status, 409);
    assert_eq!(factory.calls.load(Ordering::SeqCst), 0);
    let cross_path = http(
        address,
        TestHttpRequest::empty("GET", OECP_PATH, Some("control-token")),
    )
    .await;
    assert_eq!(cross_path.status, 404);
}

async fn assert_setup_outcome(
    address: std::net::SocketAddr,
    encoded_setup: &[u8],
    expected: TargetSetupOutcome,
) {
    let response = http(
        address,
        TestHttpRequest::body("PUT", SETUP_PATH, Some("control-token"), encoded_setup),
    )
    .await;
    assert_eq!(response.status, 200);
    assert_eq!(
        serde_json::from_slice::<TargetSetupResult>(&response.body)
            .assert_value()
            .outcome,
        expected
    );
}
