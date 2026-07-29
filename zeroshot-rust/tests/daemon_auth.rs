use std::sync::atomic::Ordering;
use std::time::Duration;

#[path = "support/daemon.rs"]
mod daemon_support;

use daemon_support::{CountingFactory, TempProfile, authenticated_initialize, locator_credentials};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::StatusCode;
use zeroshot_engine::daemon_auth::{
    AUTHORIZATION_HEADER, DAEMON_NONCE_HEADER, DAEMON_ROUTE, PROFILE_DIGEST_HEADER,
    DaemonCredentials, authorize_request,
};
use zeroshot_engine::daemon_listener::{DaemonListener, ListenerConfig};

#[test]
fn credentials_are_256_bit_capabilities_with_exact_request_values() {
    let profile_digest = "a".repeat(64);
    let first = DaemonCredentials::generate(&profile_digest).expect("first credentials");
    assert_eq!(first.capability.len(), 64);
    assert!(first.capability.bytes().all(|byte| byte.is_ascii_hexdigit()));

    let mut request = "ws://127.0.0.1:31001/daemon/initialize"
        .into_client_request()
        .expect("request");
    first.apply_to_request(&mut request).expect("headers");
    assert!(authorize_request(&request, &first));

    request
        .headers_mut()
        .append(PROFILE_DIGEST_HEADER, profile_digest.parse().expect("header"));
    assert!(!authorize_request(&request, &first));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_stale_profile_nonce_and_route_are_indistinguishable_before_backend_access() {
    let profile = TempProfile::new("auth-rejections");
    let factory = CountingFactory::default();
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        factory.clone(),
        ListenerConfig {
            handshake_timeout: Duration::from_millis(200),
            ..ListenerConfig::default()
        },
    )
    .await
    .expect("start daemon");
    let locator = listener.locator().clone();
    let valid = locator_credentials(&locator);

    let mut cases = Vec::new();
    let mut wrong_capability = valid.clone();
    wrong_capability.capability = "0".repeat(64);
    cases.push((DAEMON_ROUTE.to_owned(), wrong_capability));
    let mut wrong_profile = valid.clone();
    wrong_profile.profile_digest = "1".repeat(64);
    cases.push((DAEMON_ROUTE.to_owned(), wrong_profile));
    let mut wrong_nonce = valid.clone();
    wrong_nonce.daemon_nonce = "2".repeat(64);
    cases.push((DAEMON_ROUTE.to_owned(), wrong_nonce));
    cases.push(("/other".to_owned(), valid.clone()));

    let address = locator
        .endpoint
        .strip_prefix("ws://")
        .and_then(|rest| rest.strip_suffix(DAEMON_ROUTE))
        .expect("loopback endpoint")
        .to_owned();
    let mut rejection_shapes = Vec::new();
    for (route, credentials) in cases {
        let mut request = format!("ws://{address}{route}")
            .into_client_request()
            .expect("request");
        credentials.apply_to_request(&mut request).expect("headers");
        let stream = TcpStream::connect(&address).await.expect("loopback connect");
        let error = tokio_tungstenite::client_async(request, stream)
            .await
            .expect_err("authorization must reject");
        let WebSocketError::Http(response) = error else {
            panic!("expected uniform HTTP rejection, got {error:?}");
        };
        rejection_shapes.push((response.status(), response.body().clone()));
    }

    assert!(
        rejection_shapes
            .iter()
            .all(|shape| shape == &rejection_shapes[0]),
        "rejections must be indistinguishable: {rejection_shapes:?}"
    );
    assert_eq!(rejection_shapes[0].0, StatusCode::NOT_FOUND);
    assert_eq!(factory.created.load(Ordering::SeqCst), 0);
    assert_eq!(factory.initialized.load(Ordering::SeqCst), 0);

    let response = authenticated_initialize(&locator).await;
    assert_eq!(response["result"]["protocolVersion"], "openengine.cluster/v1");
    assert_eq!(factory.created.load(Ordering::SeqCst), 1);
    assert_eq!(factory.initialized.load(Ordering::SeqCst), 1);
    listener.shutdown().await.expect("shutdown daemon");
}

#[test]
fn missing_and_malformed_authorization_headers_fail_the_same_predicate() {
    let credentials = DaemonCredentials {
        profile_digest: "3".repeat(64),
        daemon_nonce: "4".repeat(64),
        capability: "5".repeat(64),
    };
    let mut request = "ws://127.0.0.1:31002/daemon/initialize"
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        PROFILE_DIGEST_HEADER,
        credentials.profile_digest.parse().expect("profile"),
    );
    request.headers_mut().insert(
        DAEMON_NONCE_HEADER,
        credentials.daemon_nonce.parse().expect("nonce"),
    );
    assert!(!authorize_request(&request, &credentials));
    request.headers_mut().insert(
        AUTHORIZATION_HEADER,
        format!("bearer {}", credentials.capability)
            .parse()
            .expect("authorization"),
    );
    assert!(!authorize_request(&request, &credentials));
}
