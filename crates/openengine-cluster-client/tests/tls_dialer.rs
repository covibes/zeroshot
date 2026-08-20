//! Real-network coverage for the outbound WebSocket TLS, endpoint, and dependency policies.

use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{
    dial_websocket, WebSocketDialError, WebSocketDialOptions, WebSocketEndpointError,
};
use rcgen::{generate_simple_self_signed, CertifiedKey};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_async;

#[path = "support/mod.rs"]
pub mod support;
use support::{AssertAt, AssertValue};

fn local_tls_acceptor() -> (TlsAcceptor, CertificateDer<'static>) {
    let CertifiedKey { cert, key_pair } =
        generate_simple_self_signed(vec![IpAddr::V4(Ipv4Addr::LOCALHOST).to_string()])
            .assert_value();
    let certificate = cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key)
        .assert_value();
    (TlsAcceptor::from(Arc::new(config)), certificate)
}

async fn spawn_tls_websocket() -> (String, CertificateDer<'static>, JoinHandle<bool>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .assert_value();
    let address = listener.local_addr().assert_value();
    let (acceptor, certificate) = local_tls_acceptor();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.assert_value();
        let Ok(stream) = acceptor.accept(stream).await else {
            return false;
        };
        accept_async(stream).await.is_ok()
    });
    (format!("wss://{address}/cluster"), certificate, server)
}

async fn expect_dial_error(endpoint: &str, options: WebSocketDialOptions) -> WebSocketDialError {
    dial_websocket(endpoint, options)
        .await
        .err()
        .assert_value_with("expected WebSocket dialing to fail")
}

#[tokio::test]
async fn wss_trusts_an_explicitly_configured_local_root() {
    let (endpoint, certificate, server) = spawn_tls_websocket().await;
    let options = WebSocketDialOptions::default().with_additional_root_certificate(certificate);
    let transport = dial_websocket(&endpoint, options).await.assert_value();
    assert!(server.await.assert_value());
    drop(transport);
}

#[tokio::test]
async fn wss_fails_closed_for_an_untrusted_local_root() {
    let (endpoint, _certificate, server) = spawn_tls_websocket().await;
    let error = expect_dial_error(&endpoint, WebSocketDialOptions::default()).await;
    assert!(matches!(error, WebSocketDialError::Connection(_)));
    assert!(!server.await.assert_value());
}

#[tokio::test]
async fn plaintext_is_refused_by_default_without_opening_a_socket() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .assert_value();
    let endpoint = format!("ws://{}/cluster", listener.local_addr().assert_value());
    let error = expect_dial_error(&endpoint, WebSocketDialOptions::default()).await;
    assert!(matches!(&error, WebSocketDialError::PlaintextNotAllowed));
    assert!(
        error
            .to_string()
            .contains("WebSocketDialOptions::allow_plaintext(true)")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn explicit_plaintext_opt_in_dials_loopback() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .assert_value();
    let endpoint = format!("ws://{}/cluster", listener.local_addr().assert_value());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.assert_value();
        accept_async(stream).await.assert_value();
    });
    let transport = dial_websocket(
        &endpoint,
        WebSocketDialOptions::default().allow_plaintext(true),
    )
    .await
    .assert_value();
    server.await.assert_value();
    drop(transport);
}

#[tokio::test]
async fn endpoint_policy_rejects_before_opening_a_socket() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .assert_value();
    let address = listener.local_addr().assert_value();
    let cases = [
        (format!("http://{address}/cluster"), "scheme"),
        (format!("ws://user@{address}/cluster"), "userinfo"),
        (format!("ws://{address}/cluster?token=secret"), "query"),
        (format!("ws://{address}/cluster#section"), "fragment"),
        ("wss:///cluster".to_owned(), "host"),
    ];
    for (endpoint, expected) in cases {
        let error = expect_dial_error(
            &endpoint,
            WebSocketDialOptions::default().allow_plaintext(true),
        )
        .await;
        let endpoint_error = match error {
            WebSocketDialError::Endpoint(error) => Some(error),
            _ => None,
        }
        .assert_value_with("expected endpoint preflight failure");
        let matches_expected = match expected {
            "scheme" => matches!(endpoint_error, WebSocketEndpointError::UnsupportedScheme(_)),
            "userinfo" => matches!(endpoint_error, WebSocketEndpointError::UserInfo),
            "query" => matches!(endpoint_error, WebSocketEndpointError::Query),
            "fragment" => matches!(endpoint_error, WebSocketEndpointError::Fragment),
            "host" => matches!(
                endpoint_error,
                WebSocketEndpointError::MissingHost | WebSocketEndpointError::InvalidUri(_)
            ),
            _ => false,
        };
        assert!(matches_expected, "unexpected endpoint error for {endpoint}");
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

async fn read_http_request(stream: &mut (impl AsyncRead + Unpin)) {
    let mut request = Vec::new();
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let mut buffer = [0_u8; 1024];
        let count = stream.read(&mut buffer).await.assert_value();
        assert_ne!(count, 0, "client closed before sending its handshake");
        request.extend_from_slice(
            buffer
                .get(..count)
                .assert_value_with("read count must fit the read buffer"),
        );
    }
}

#[tokio::test]
async fn wss_redirect_to_plaintext_is_rejected_without_opening_the_target() {
    let redirect_target = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .assert_value();
    let target_address = redirect_target.local_addr().assert_value();
    let redirect_source = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .assert_value();
    let source_address = redirect_source.local_addr().assert_value();
    let (acceptor, certificate) = local_tls_acceptor();
    let redirect_server = tokio::spawn(async move {
        let (stream, _) = redirect_source.accept().await.assert_value();
        let mut stream = acceptor.accept(stream).await.assert_value();
        read_http_request(&mut stream).await;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: ws://{target_address}/downgraded\r\nContent-Length: 0\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .assert_value();
    });
    let endpoint = format!("wss://{source_address}/cluster");
    let options = WebSocketDialOptions::default().with_additional_root_certificate(certificate);
    let error = expect_dial_error(&endpoint, options).await;
    assert!(matches!(
        error,
        WebSocketDialError::RedirectRejected { status } if status.as_u16() == 302
    ));
    redirect_server.await.assert_value();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), redirect_target.accept())
            .await
            .is_err()
    );
}

fn lockfile_packages(lockfile: &str) -> impl Iterator<Item = (&str, &str)> {
    lockfile.split("[[package]]").filter_map(|package| {
        let mut name = None;
        let mut version = None;
        for line in package.lines() {
            if let Some(value) = line.strip_prefix("name = \"") {
                name = value.strip_suffix('"');
            } else if let Some(value) = line.strip_prefix("version = \"") {
                version = value.strip_suffix('"');
            }
            if name.is_some() && version.is_some() {
                break;
            }
        }
        name.zip(version)
    })
}

#[test]
fn cargo_lock_uses_one_rustls_lineage_and_no_native_tls_implementation() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .assert_value();
    let lockfile = std::fs::read_to_string(workspace.join("Cargo.lock")).assert_value();
    let packages: Vec<_> = lockfile_packages(&lockfile).collect();
    let rustls_versions: Vec<_> = packages
        .iter()
        .filter_map(|(name, version)| (*name == "rustls").then_some(*version))
        .collect();
    assert_eq!(
        rustls_versions.len(),
        1,
        "Cargo.lock must contain exactly one rustls package, got {rustls_versions:?}"
    );
    assert!(
        rustls_versions.assert_at(0).starts_with("0.23."),
        "the selected TLS lineage is rustls 0.23, got {}",
        rustls_versions.assert_at(0)
    );
    const FORBIDDEN_TLS_PACKAGES: &[&str] = &[
        "aws-lc-rs",
        "aws-lc-sys",
        "native-tls",
        "openssl",
        "openssl-sys",
        "tokio-native-tls",
        "hyper-tls",
        "boring",
        "boring-sys",
        "tokio-boring",
        "s2n-tls",
        "s2n-tls-sys",
    ];
    let forbidden_found: Vec<_> = packages
        .iter()
        .filter_map(|(name, _)| FORBIDDEN_TLS_PACKAGES.contains(name).then_some(*name))
        .collect();
    assert!(
        forbidden_found.is_empty(),
        "Cargo.lock contains a second/native TLS implementation: {forbidden_found:?}"
    );
}
