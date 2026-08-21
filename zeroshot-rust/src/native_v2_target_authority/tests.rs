use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use openengine_cluster_client::ClusterClient;
use openengine_cluster_client::websocket::WebSocketTransport;
use openengine_cluster_protocol::{
    IdempotencyKey, ResolvedSource, RunId, RunListParams, RunSize, RunSubmission, RunTitle,
    RuntimePlan, SourceBranchId, SourceRepositoryId, SourceRevisionId,
    TargetPrivateBootstrapRequest,
};
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionIdentity, ConnectionIdentityConfig, PrincipalId, TenantId,
};
use openengine_cluster_testkit::admission::graph_fixture;
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, HeaderValue};

use super::*;
use super::private_access::encode_lower;
use crate::native_v2_cloud::{
    AllocatedCapsule, CapsuleAllocationUnavailable, CapsuleAllocator, CapsuleCleanupUnavailable,
    CapsuleDestroyed, ControllerClaimUnavailable, ExclusiveControllerClaim,
};
use crate::native_v2_contract::{AdmittedRun, CodexProvider};
use crate::native_v2_supervisor::RunRuntimeExit;
use crate::v2_run_ledger::fake::FakeRunLedger;

#[path = "tests/http.rs"]
mod http_fixture;
use http_fixture::{TestHttpRequest, http};

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
        _github_token: Option<&str>,
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
    controllers: AtomicUsize,
    submissions: AtomicUsize,
    active_submissions: AtomicUsize,
    max_active_submissions: AtomicUsize,
}

#[async_trait]
impl TargetControllerFactory for FakeFactory {
    async fn create(&self) -> Result<Arc<NativeV2CloudController>, TargetAuthorityError> {
        self.controllers.fetch_add(1, Ordering::SeqCst);
        NativeV2CloudController::new(Arc::new(FakeRunLedger::new()), Arc::new(NoAllocation))
            .await
            .map(Arc::new)
            .map_err(|error| TargetAuthorityError::unavailable(error.to_string()))
    }

    async fn submit(
        &self,
        _controller: &NativeV2CloudController,
        request: TargetRunRequest,
    ) -> Result<TargetRunReceipt, TargetAuthorityError> {
        let active = self.active_submissions.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active_submissions
            .fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        self.active_submissions.fetch_sub(1, Ordering::SeqCst);
        self.submissions.fetch_add(1, Ordering::SeqCst);
        Ok(TargetRunReceipt {
            run_id: request.run_id,
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
        (bearer_token == "control-token")
            .then(identity)
            .ok_or_else(TargetAuthorityError::unauthorized)
    }

    async fn issue_oecp(
        &self,
        _identity: &ConnectionIdentity,
        request: &TargetOecpSessionRequest,
    ) -> Result<String, TargetAuthorityError> {
        request
            .run_id
            .as_ref()
            .is_some_and(|candidate| candidate == &run_id())
            .then(|| "oecp-token".to_owned())
            .ok_or_else(|| TargetAuthorityError::invalid("run-scoped session required"))
    }

    async fn authenticate_oecp(
        &self,
        bearer_token: &str,
    ) -> Result<ConnectionIdentity, TargetAuthorityError> {
        (bearer_token == "oecp-token")
            .then(identity)
            .ok_or_else(TargetAuthorityError::unauthorized)
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

fn run_id() -> RunId {
    RunId::new("018f5e78-7f95-7c22-8d98-3f15af20c991")
}

fn request() -> TargetRunRequest {
    TargetRunRequest {
        run_id: run_id(),
        submission: RunSubmission {
            title: RunTitle::new("Target authority test").assert_value(),
            graph: graph_fixture("worker", json!({"kind": "null"})),
            initial_input: Value::Null,
            runtime: RuntimePlan::Codex {
                provider: CodexProvider::OpenAi,
                size: RunSize::Tiny,
                nodes: BTreeMap::new(),
            },
            source: ResolvedSource {
                repository: SourceRepositoryId::new("owner/repo").assert_value(),
                branch: SourceBranchId::new("main").assert_value(),
                revision: SourceRevisionId::new("0123456789abcdef0123456789abcdef01234567")
                    .assert_value(),
            },
            submission_key: IdempotencyKey::new("target-authority-test").assert_value(),
        },
        environment: BTreeMap::new(),
        github_token: None,
    }
}

#[tokio::test]
async fn concurrent_target_submissions_share_one_host_turn() {
    let factory = Arc::new(FakeFactory::default());
    let authority = Arc::new(NativeV2TargetAuthority::new(factory.clone()));
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
    assert_eq!(factory.controllers.load(Ordering::SeqCst), 1);
    assert_eq!(factory.submissions.load(Ordering::SeqCst), 2);
    assert_eq!(factory.max_active_submissions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn hosted_sessions_are_authenticated_and_run_scoped() {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let factory = Arc::new(FakeFactory::default());
    let endpoint = format!("ws://{address}{OECP_PATH}");
    let server = Arc::new(
        NativeV2TargetServer::new_hosted(
            Arc::new(NativeV2TargetAuthority::new(factory.clone())),
            Arc::new(FakeSessions),
            endpoint.clone(),
        )
        .assert_value(),
    );
    let task = tokio::spawn(server.serve(listener));

    let discovery = http(address, TestHttpRequest::empty("GET", DISCOVERY_PATH, None)).await;
    let document: TargetDiscoveryDocument = serde_json::from_slice(&discovery.body).assert_value();
    assert_eq!(document.authentication, TargetAuthentication::HostedOauth);
    assert_eq!(document.kind, DISCOVERY_KIND);

    let encoded = serde_json::to_vec(&request()).assert_value();
    assert_eq!(
        http(
            address,
            TestHttpRequest::body("POST", RUN_PATH, None, &encoded)
        )
        .await
        .status,
        401
    );
    let accepted = http(
        address,
        TestHttpRequest::body("POST", RUN_PATH, Some("control-token"), &encoded),
    )
    .await;
    assert_eq!(accepted.status, 200);
    let receipt: TargetRunReceipt = serde_json::from_slice(&accepted.body).assert_value();
    assert_eq!(receipt.run_id, run_id());

    let session_body = serde_json::to_vec(&TargetOecpSessionRequest {
        run_id: Some(run_id()),
    })
    .assert_value();
    let session = http(
        address,
        TestHttpRequest::body("POST", SESSION_PATH, Some("control-token"), &session_body),
    )
    .await;
    assert_eq!(session.status, 200);
    let session: TargetOecpSession = serde_json::from_slice(&session.body).assert_value();
    assert_eq!(session.endpoint, endpoint);
    connect_and_list(&session.endpoint, Some("oecp-token")).await;

    task.abort();
}

#[tokio::test]
async fn direct_target_remains_auth_free_without_private_bootstrap() {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let endpoint = format!("ws://{address}{OECP_PATH}");
    let server = Arc::new(
        NativeV2TargetServer::new_direct(
            Arc::new(NativeV2TargetAuthority::new(Arc::new(
                FakeFactory::default(),
            ))),
            identity(),
            endpoint.clone(),
        )
        .assert_value(),
    );
    let task = tokio::spawn(server.serve(listener));
    let session = http(
        address,
        TestHttpRequest::body("POST", SESSION_PATH, None, b"{}"),
    )
    .await;
    assert_eq!(session.status, 200);
    let session: TargetOecpSession = serde_json::from_slice(&session.body).assert_value();
    assert_eq!(session.bearer_token, None);
    connect_and_list(&endpoint, None).await;
    task.abort();
}

#[tokio::test]
async fn private_target_closes_bootstrap_and_rejects_unprivileged_children() {
    use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};

    let root = std::env::temp_dir().join(format!("zeroshot-target-key-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir(&root).assert_value();
    let key_path = root.join("key");
    std::fs::write(&key_path, "07".repeat(32)).assert_value();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).assert_value();
    }
    let bootstrap_key = TargetBootstrapKey::load_and_unlink(&key_path).assert_value();
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let endpoint = format!("ws://{address}{OECP_PATH}");
    let server = Arc::new(
        NativeV2TargetServer::new_private(
            Arc::new(NativeV2TargetAuthority::new(Arc::new(
                FakeFactory::default(),
            ))),
            identity(),
            endpoint.clone(),
            bootstrap_key,
        )
        .assert_value(),
    );
    let task = tokio::spawn(server.serve(listener));

    let encoded = serde_json::to_vec(&request()).assert_value();
    assert_eq!(
        http(
            address,
            TestHttpRequest::body("POST", RUN_PATH, None, &encoded)
        )
        .await
        .status,
        401
    );
    assert_eq!(
        http(
            address,
            TestHttpRequest::body("POST", SESSION_PATH, None, b"{}")
        )
        .await
        .status,
        401
    );
    assert!(
        tokio_tungstenite::connect_async(endpoint.clone())
            .await
            .is_err()
    );

    let token = "a".repeat(64);
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[7; 32]).assert_value());
    let mut ciphertext = token.as_bytes().to_vec();
    let nonce = [11; 12];
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(b"zeroshot-capsule-bootstrap-v1"),
        &mut ciphertext,
    )
    .assert_value();
    let bootstrap = serde_json::to_vec(&TargetPrivateBootstrapRequest {
        nonce: encode_lower(&nonce),
        ciphertext: encode_lower(&ciphertext),
    })
    .assert_value();
    assert_eq!(
        http(
            address,
            TestHttpRequest::body("POST", TARGET_PRIVATE_BOOTSTRAP_PATH, None, &bootstrap)
        )
        .await
        .status,
        204
    );
    assert_eq!(
        http(
            address,
            TestHttpRequest::body("POST", TARGET_PRIVATE_BOOTSTRAP_PATH, None, &bootstrap)
        )
        .await
        .status,
        404
    );
    let session = http(
        address,
        TestHttpRequest::body("POST", SESSION_PATH, Some(&token), b"{}"),
    )
    .await;
    assert_eq!(session.status, 200);
    connect_and_list(&endpoint, Some(&token)).await;

    task.abort();
    let _ = std::fs::remove_dir(&root);
}

async fn connect_and_list(endpoint: &str, bearer: Option<&str>) {
    let mut request = endpoint.into_client_request().assert_value();
    if let Some(bearer) = bearer {
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {bearer}")).assert_value(),
        );
    }
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
}
