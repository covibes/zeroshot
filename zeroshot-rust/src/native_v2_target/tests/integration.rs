use std::sync::Arc;

use openengine_cluster_protocol::RunId;
use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertValue};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

use super::super::controller_authority::credentials::test_support::{
    MemoryCredentialStore, MemoryDeviceCodeNotifier,
};
use super::super::controller_authority::TargetCredentialStore;
use super::super::*;
use super::fixtures::*;
use super::hosted_authority::*;

type ServerRequest = tokio_tungstenite::tungstenite::handshake::server::Request;
type ServerResponse = tokio_tungstenite::tungstenite::handshake::server::Response;

#[test]
fn file_registry_round_trips_named_targets_without_credentials() {
    let root = temp_root();
    let path = root.path("config/targets.json");
    let registry = FileTargetRegistry::new(path.clone());
    registry.insert(target()).assert_value();
    assert_eq!(registry.get("prod").assert_value(), target());
    assert!(matches!(
        registry.insert(target()),
        Err(TargetConnectorError::AlreadyExists(_))
    ));
    let stored = std::fs::read_to_string(path).assert_value();
    assert!(!stored.contains("accessToken"));
    assert!(!stored.contains("refreshToken"));
    assert!(!stored.contains("runtime"));
}

#[test]
fn file_registry_round_trips_direct_access_without_a_device_credential() {
    let root = temp_root();
    let path = root.path("config/targets.json");
    let registry = FileTargetRegistry::new(path.clone());
    let direct = TargetRecord {
        id: "33333333-3333-4333-8333-333333333333".to_owned(),
        name: "vm".to_owned(),
        origin: "http://127.0.0.1:8080".to_owned(),
        access: TargetAccess::Direct,
    };
    registry.insert(direct.clone()).assert_value();
    assert_eq!(registry.get("vm").assert_value(), direct);
    let stored = std::fs::read_to_string(path).assert_value();
    assert!(stored.contains(r#""mode": "direct""#));
    assert!(!stored.contains("deviceToken"));
}

#[cfg(unix)]
#[test]
fn file_registry_is_private_on_creation() {
    use std::os::unix::fs::PermissionsExt;

    let root = temp_root();
    let path = root.path("config/targets.json");
    FileTargetRegistry::new(path.clone())
        .insert(target())
        .assert_value();
    assert_eq!(
        std::fs::metadata(path).assert_value().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn connector_preserves_add_login_setup_and_target_scoped_connect() {
    let registry = MemoryRegistry::default();
    let authority = FakeAuthority::new("wss://target.example/oecp");
    let dialer = FakeDialer::default();
    let connector = NativeV2TargetConnector::new(registry, authority.clone(), dialer.clone());

    connector
        .add(TargetAdd {
            name: "prod".to_owned(),
            url: "https://target.example".to_owned(),
            direct: false,
        })
        .await
        .assert_value();
    connector.login("prod").await.assert_value();
    connector.setup(setup_request()).await.assert_value();
    let receipt = connector.submit("prod", run_request()).await.assert_value();
    connector.connect("prod").await.assert_value();
    assert_eq!(receipt.run_id, RunId::new("run-hosted"));

    let calls = authority.calls();
    let added = match calls.assert_at(0) {
        AuthorityCall::Discover(added) => Some(added),
        _ => None,
    };
    let added = added.assert_value_with("expected discovery");
    assert_eq!(added.name, "prod");
    assert_eq!(added.origin, "https://target.example");
    assert_eq!(added.id.len(), 36);
    assert!(matches!(
        &added.access,
        TargetAccess::Hosted { device_token } if device_token.len() == 36
    ));
    assert!(matches!(calls.assert_at(1), AuthorityCall::Login(record) if record == added));
    let install = match calls.assert_at(2) {
        AuthorityCall::Install(record, installed) => Some((record, installed)),
        _ => None,
    };
    let (record, installed) = install.assert_value_with("expected atomic setup install");
    assert_eq!(record, added);
    assert_eq!(installed.repository, "open-engine/zeroshot");
    assert_eq!(installed.default_branch.as_deref(), Some("main"));
    let submitted = match calls.assert_at(3) {
        AuthorityCall::Submit(record, intent) => Some((record, intent.as_ref())),
        _ => None,
    };
    let (record, request) = submitted.assert_value_with("expected target submission");
    assert_eq!(record, added);
    assert_eq!(request, &run_request());
    assert!(matches!(calls.assert_at(4), AuthorityCall::Session(record) if record == added));
    assert_eq!(
        dialer.sessions.lock().assert_value().as_slice(),
        &[(added.clone(), "wss://target.example/oecp".to_owned())]
    );
}

#[tokio::test]
async fn hosted_authority_uses_device_login_atomic_setup_and_target_wide_oecp() {
    let root = temp_root();
    let (origin, server) = spawn_target_authority(24).await;
    let credentials = Arc::new(MemoryCredentialStore::default());
    let notifier = Arc::new(MemoryDeviceCodeNotifier::default());
    let authority = TargetHttpControlAuthority::with_dependencies(
        credentials.clone(),
        notifier.clone(),
        root.path("refresh-locks"),
    );
    let target = hosted_target("local", origin.clone());
    let setup = TargetSetupDocument {
        repository: "open-engine/zeroshot".to_owned(),
        default_branch: Some("main".to_owned()),
    };

    authority.login(&target).await.assert_value();
    assert_eq!(
        notifier.values(),
        vec![(format!("{origin}/activate"), "ABCD-EFGH".to_owned())]
    );
    authority.install(&target, &setup).await.assert_value();
    let receipt = authority
        .submit(&target, &run_request())
        .await
        .assert_value();
    assert_eq!(receipt.run_id, RunId::new("run-hosted"));
    let session = authority.oecp_session(&target).await.assert_value();
    assert_eq!(
        session.endpoint(),
        format!(
            "ws://{}/native-v2/oecp",
            origin.trim_start_matches("http://")
        )
    );
    assert_eq!(
        credentials.get(&target.id).await.assert_value().as_deref(),
        Some("refresh-4")
    );

    let requests = server.await.assert_value();
    assert_eq!(requests.len(), 24);
    assert!(
        requests
            .iter()
            .all(|request| !request.path.contains("capsule"))
    );
    assert_device_exchange(&requests);
    assert_setup_submit_and_session_requests(&requests);
}

#[tokio::test]
async fn direct_authority_skips_hosted_auth_and_all_authorization_headers() {
    let root = temp_root();
    let (origin, server) = spawn_direct_target_authority(7).await;
    let credentials = Arc::new(MemoryCredentialStore::default());
    let notifier = Arc::new(MemoryDeviceCodeNotifier::default());
    let authority = TargetHttpControlAuthority::with_dependencies(
        credentials.clone(),
        notifier.clone(),
        root.path("refresh-locks"),
    );
    let target = direct_target(origin);
    let setup = TargetSetupDocument {
        repository: "open-engine/zeroshot".to_owned(),
        default_branch: Some("main".to_owned()),
    };

    authority.discover(&target).await.assert_value();
    assert_eq!(
        authority.login(&target).await.assert_error().to_string(),
        "direct target does not use login"
    );
    authority.install(&target, &setup).await.assert_value();
    assert_eq!(
        authority
            .submit(&target, &run_request())
            .await
            .assert_value()
            .run_id,
        RunId::new("run-direct")
    );
    authority.oecp_session(&target).await.assert_value();

    assert!(credentials.get(&target.id).await.assert_value().is_none());
    assert!(notifier.values().is_empty());
    let requests = server.await.assert_value();
    assert!(
        requests
            .iter()
            .all(|request| request.authorization.is_none())
    );
    assert!(
        requests
            .iter()
            .all(|request| request.path != "/.well-known/openengine-hosted-target")
    );
}

#[tokio::test]
async fn direct_target_rejects_hosted_controller_discovery() {
    let root = temp_root();
    let (origin, server) = spawn_target_authority(1).await;
    let authority = TargetHttpControlAuthority::with_dependencies(
        Arc::new(MemoryCredentialStore::default()),
        Arc::new(MemoryDeviceCodeNotifier::default()),
        root.path("refresh-locks"),
    );
    let target = direct_target(origin);
    assert!(authority.discover(&target).await.is_err());
    server.await.assert_value();
}

fn assert_device_exchange(requests: &[CapturedHttpRequest]) {
    let request = requests
        .iter()
        .find(|request| request.path == "/oauth/token" && request.body.contains("device_code="))
        .assert_value();
    assert!(
        request
            .body
            .contains("device_token=22222222-2222-4222-8222-222222222222")
    );
    assert!(request.body.contains("device_label=zeroshot-cli"));
    assert!(request.body.contains("audience=controller"));
}

fn assert_setup_submit_and_session_requests(requests: &[CapturedHttpRequest]) {
    let setup = requests
        .iter()
        .find(|request| request.path == "/native-v2/setup")
        .assert_value();
    assert_eq!(setup.authorization.as_deref(), Some("Bearer access-2"));
    let body: serde_json::Value = serde_json::from_str(&setup.body).assert_value();
    assert_eq!(
        body.get("repository").assert_value(),
        "open-engine/zeroshot"
    );
    assert!(body.get("runtime").is_none());
    let submit = requests
        .iter()
        .find(|request| request.path == "/native-v2/run")
        .assert_value();
    assert_eq!(submit.authorization.as_deref(), Some("Bearer access-3"));
    let request: serde_json::Value = serde_json::from_str(&submit.body).assert_value();
    assert_eq!(
        request.pointer("/intent/title").assert_value(),
        "Repair checkout"
    );
    assert_eq!(
        request.pointer("/intent/runtime/size").assert_value(),
        "standard"
    );
    assert!(
        request
            .pointer("/environment")
            .and_then(serde_json::Value::as_object)
            .is_some_and(serde_json::Map::is_empty)
    );
    assert!(request.pointer("/intent/source").is_none());
    let session = requests
        .iter()
        .find(|request| request.path == "/native-v2/oecp-session")
        .assert_value();
    assert_eq!(session.authorization.as_deref(), Some("Bearer access-4"));
    assert!(session.body.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosted_authorities_serialize_one_time_refresh_rotation_per_target() {
    let root = temp_root();
    let (origin, server) = spawn_target_authority(12).await;
    let credentials = Arc::new(RotatingCredentialStore::new("refresh-0"));
    let notifier = Arc::new(MemoryDeviceCodeNotifier::default());
    let lock_directory = root.path("refresh-locks");
    let first = TargetHttpControlAuthority::with_dependencies(
        credentials.clone(),
        notifier.clone(),
        lock_directory.clone(),
    );
    let second = TargetHttpControlAuthority::with_dependencies(
        credentials.clone(),
        notifier,
        lock_directory,
    );
    let target = hosted_target("local", origin);
    let (first_session, second_session) =
        tokio::join!(first.oecp_session(&target), second.oecp_session(&target));
    first_session.assert_value();
    second_session.assert_value();
    assert_eq!(credentials.value(), "refresh-2");
    let requests = server.await.assert_value();
    let refresh_bodies = requests
        .iter()
        .filter(|request| {
            request.path == "/oauth/token" && request.body.contains("grant_type=refresh_token")
        })
        .map(|request| request.body.as_str())
        .collect::<Vec<_>>();
    assert_eq!(refresh_bodies.len(), 2);
    assert!(
        refresh_bodies
            .assert_at(0)
            .contains("refresh_token=refresh-0")
    );
    assert!(
        refresh_bodies
            .assert_at(1)
            .contains("refresh_token=refresh-1")
    );
    let authorizations = requests
        .iter()
        .filter(|request| request.path == "/native-v2/oecp-session")
        .filter_map(|request| request.authorization.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(authorizations, ["Bearer access-1", "Bearer access-2"]);
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn websocket_dialer_sends_bearer_only_to_same_target_authority() {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let (sent, received) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.assert_value();
        let websocket = accept_hdr_async(
            stream,
            move |request: &ServerRequest, response: ServerResponse| {
                let authorization = request
                    .headers()
                    .get(AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let _ = sent.send(authorization);
                Ok(response)
            },
        )
        .await
        .assert_value();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        drop(websocket);
    });
    let target = hosted_target("local", format!("http://{address}"));
    let session = TargetOecpAccess::new(
        format!("ws://{address}/oecp"),
        Some("secret".to_owned()),
        &target.access,
    )
    .assert_value();
    let transport = TargetOecpWebSocketDialer
        .dial(&target, session)
        .await
        .assert_value();
    assert_eq!(
        received.await.assert_value().as_deref(),
        Some("Bearer secret")
    );
    drop(transport);
    server.await.assert_value();
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn direct_websocket_dialer_sends_no_authorization() {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let (sent, received) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.assert_value();
        let websocket = accept_hdr_async(
            stream,
            move |request: &ServerRequest, response: ServerResponse| {
                let authorization = request.headers().get(AUTHORIZATION).cloned();
                let _ = sent.send(authorization);
                Ok(response)
            },
        )
        .await
        .assert_value();
        drop(websocket);
    });
    let target = direct_target(format!("http://{address}"));
    let session =
        TargetOecpAccess::new(format!("ws://{address}/oecp"), None, &target.access).assert_value();
    let transport = TargetOecpWebSocketDialer
        .dial(&target, session)
        .await
        .assert_value();
    assert!(received.await.assert_value().is_none());
    drop(transport);
    server.await.assert_value();
}

#[tokio::test]
async fn websocket_dialer_rejects_cross_authority_before_network() {
    let target = target();
    let session = TargetOecpAccess::new(
        "wss://other.example/oecp",
        Some("secret".to_owned()),
        &target.access,
    )
    .assert_value();
    let error = TargetOecpWebSocketDialer
        .dial(&target, session)
        .await
        .assert_error_with("cross-authority session unexpectedly dialed");
    assert!(matches!(error, TargetConnectorError::InvalidOecpEndpoint));
}
