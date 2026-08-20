use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::super::controller_authority::TargetCredentialStore;
use super::super::*;

pub(super) struct RotatingCredentialStore {
    state: Mutex<RotatingCredentialState>,
}

struct RotatingCredentialState {
    value: String,
    in_flight: bool,
    writes: usize,
}

#[derive(Debug)]
pub(super) struct CapturedHttpRequest {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) authorization: Option<String>,
    pub(super) body: String,
}

#[derive(Serialize)]
struct HostedDiscoveryFixture {
    kind: &'static str,
    oauth: OAuthDiscoveryFixture,
    session: SessionDiscoveryFixture,
}

#[derive(Serialize)]
struct OAuthDiscoveryFixture {
    metadata_url: String,
    device_authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: String,
    client_id: &'static str,
    device_grant_type: &'static str,
    device_exchange_fields: [&'static str; 2],
    audience: &'static str,
}

#[derive(Serialize)]
struct SessionDiscoveryFixture {
    route_template: &'static str,
    method: &'static str,
    cache_policy: &'static str,
}

pub(super) async fn spawn_target_authority(
    request_count: usize,
) -> (String, tokio::task::JoinHandle<Vec<CapturedHttpRequest>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let origin = format!("http://{address}");
    let server_origin = origin.clone();
    let server = tokio::spawn(serve_target_authority(
        listener,
        request_count,
        server_origin,
        address,
    ));
    (origin, server)
}

pub(super) async fn spawn_direct_target_authority(
    request_count: usize,
) -> (String, tokio::task::JoinHandle<Vec<CapturedHttpRequest>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let origin = format!("http://{address}");
    let server = tokio::spawn(async move {
        let mut captured = Vec::new();
        for _ in 0..request_count {
            let (mut stream, _) = listener.accept().await.assert_value();
            let request = read_http_request(&mut stream).await;
            let body = match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/.well-known/zeroshot-native-v2") => json!({
                    "kind": "zeroshot.native-v2-target/v1",
                    "authentication": "none",
                    "setupPath": "/native-v2/setup",
                    "runPath": "/native-v2/run",
                    "sessionPath": "/native-v2/oecp-session",
                    "audience": "controller",
                })
                .to_string(),
                ("PUT", "/native-v2/setup") => r#"{"outcome":"installed"}"#.to_owned(),
                ("POST", "/native-v2/run") => r#"{"runId":"run-direct"}"#.to_owned(),
                ("POST", "/native-v2/oecp-session") => {
                    format!(r#"{{"endpoint":"ws://{address}/native-v2/oecp"}}"#)
                }
                unexpected => None::<String>
                    .assert_value_with(&format!("unexpected direct request: {unexpected:?}")),
            };
            write_http_response(&mut stream, &body).await;
            captured.push(request);
        }
        captured
    });
    (origin, server)
}

async fn serve_target_authority(
    listener: TcpListener,
    request_count: usize,
    origin: String,
    address: std::net::SocketAddr,
) -> Vec<CapturedHttpRequest> {
    let mut captured = Vec::new();
    let mut token_index = 0_u8;
    for _ in 0..request_count {
        let (mut stream, _) = listener.accept().await.assert_value();
        let request = read_http_request(&mut stream).await;
        let body = authority_response(&request, &origin, address, &mut token_index);
        write_http_response(&mut stream, &body).await;
        captured.push(request);
    }
    captured
}

fn authority_response(
    request: &CapturedHttpRequest,
    origin: &str,
    address: std::net::SocketAddr,
    token_index: &mut u8,
) -> String {
    if let Some(response) = controller_response(request, address) {
        return response;
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/.well-known/openengine-hosted-target") => hosted_discovery(origin),
        ("GET", "/oauth/metadata") => oauth_metadata(origin),
        ("GET", "/.well-known/zeroshot-native-v2") => json!({
            "kind": "zeroshot.native-v2-target/v1",
            "authentication": "hosted_oauth",
            "setupPath": "/native-v2/setup",
            "runPath": "/native-v2/run",
            "sessionPath": "/native-v2/oecp-session",
            "audience": "controller",
        })
        .to_string(),
        ("POST", "/oauth/device") => json!({
            "device_code": "device-code",
            "user_code": "ABCD-EFGH",
            "verification_uri": format!("{origin}/activate"),
            "expires_in": 60,
            "interval": 0,
        })
        .to_string(),
        ("POST", "/oauth/token") => token_response(token_index),
        ("GET", "/session") => json!({
            "kind": "openengine.target-session/v1",
            "organization_id": "organization-1",
        })
        .to_string(),
        unexpected => None::<String>
            .assert_value_with(&format!("unexpected authority request: {unexpected:?}")),
    }
}

fn controller_response(
    request: &CapturedHttpRequest,
    address: std::net::SocketAddr,
) -> Option<String> {
    match (request.method.as_str(), request.path.as_str()) {
        ("PUT", "/native-v2/setup") => Some(r#"{"outcome":"installed"}"#.to_owned()),
        ("POST", "/native-v2/run") => Some(r#"{"runId":"run-hosted"}"#.to_owned()),
        ("POST", "/native-v2/oecp-session") => Some(format!(
            r#"{{"endpoint":"ws://{address}/native-v2/oecp","bearerToken":"oecp-session-token"}}"#
        )),
        _ => None,
    }
}

fn hosted_discovery(origin: &str) -> String {
    let fixture = HostedDiscoveryFixture {
        kind: "openengine.hosted-target/v1",
        oauth: OAuthDiscoveryFixture {
            metadata_url: format!("{origin}/oauth/metadata"),
            device_authorization_endpoint: format!("{origin}/oauth/device"),
            token_endpoint: format!("{origin}/oauth/token"),
            revocation_endpoint: format!("{origin}/oauth/revoke"),
            client_id: "zeroshot-cli",
            device_grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_exchange_fields: ["device_token", "device_label"],
            audience: "capsule",
        },
        session: SessionDiscoveryFixture {
            route_template: "/session",
            method: "GET",
            cache_policy: "no-store",
        },
    };
    serde_json::to_string(&fixture).unwrap_or_else(|_| std::process::abort())
}

fn oauth_metadata(origin: &str) -> String {
    json!({
        "device_authorization_endpoint": format!("{origin}/oauth/device"),
        "token_endpoint": format!("{origin}/oauth/token"),
        "revocation_endpoint": format!("{origin}/oauth/revoke"),
    })
    .to_string()
}

fn token_response(token_index: &mut u8) -> String {
    *token_index += 1;
    json!({
        "access_token": format!("access-{token_index}"),
        "refresh_token": format!("refresh-{token_index}"),
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_expires_in": 86_400,
        "scope": "controller",
    })
    .to_string()
}

async fn write_http_response(stream: &mut tokio::net::TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.assert_value();
    stream.write_all(body.as_bytes()).await.assert_value();
    stream.shutdown().await.assert_value();
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> CapturedHttpRequest {
    let (mut bytes, header_end) = read_http_head(stream).await;
    let head = std::str::from_utf8(bytes.get(..header_end).assert_value()).assert_value();
    let (method, path) = request_line(head);
    let content_length = header_value(head, "content-length")
        .map_or(0, |value| value.parse::<usize>().assert_value());
    let authorization = header_value(head, "authorization").map(str::to_owned);
    read_http_body(stream, &mut bytes, header_end + content_length).await;
    CapturedHttpRequest {
        method,
        path,
        authorization,
        body: String::from_utf8(
            bytes
                .get(header_end..header_end + content_length)
                .assert_value()
                .to_vec(),
        )
        .assert_value(),
    }
}

async fn read_http_head(stream: &mut tokio::net::TcpStream) -> (Vec<u8>, usize) {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0_u8; 4096];
        let count = stream.read(&mut chunk).await.assert_value();
        assert!(count > 0, "HTTP request ended before headers");
        bytes.extend_from_slice(chunk.get(..count).assert_value());
        assert!(bytes.len() <= 128 * 1024, "HTTP request too large");
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            return (bytes, index + 4);
        }
    }
}

fn request_line(head: &str) -> (String, String) {
    let mut parts = head.lines().next().assert_value().split_ascii_whitespace();
    (
        parts.next().assert_value().to_owned(),
        parts.next().assert_value().to_owned(),
    )
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

async fn read_http_body(stream: &mut tokio::net::TcpStream, bytes: &mut Vec<u8>, needed: usize) {
    while bytes.len() < needed {
        let mut chunk = [0_u8; 4096];
        let count = stream.read(&mut chunk).await.assert_value();
        assert!(count > 0, "HTTP request ended before body");
        bytes.extend_from_slice(chunk.get(..count).assert_value());
    }
}

impl RotatingCredentialStore {
    pub(super) fn new(value: &str) -> Self {
        Self {
            state: Mutex::new(RotatingCredentialState {
                value: value.to_owned(),
                in_flight: false,
                writes: 0,
            }),
        }
    }

    pub(super) fn value(&self) -> String {
        self.state.lock().assert_value().value.clone()
    }
}

#[async_trait]
impl TargetCredentialStore for RotatingCredentialStore {
    async fn get(&self, _target_id: &str) -> Result<Option<String>, TargetAuthorityError> {
        let value = {
            let mut state = self.state.lock().assert_value();
            if state.in_flight {
                return Err(TargetAuthorityError::new("concurrent refresh-family read"));
            }
            state.in_flight = true;
            state.value.clone()
        };
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        Ok(Some(value))
    }

    async fn set(&self, _target_id: &str, refresh_token: &str) -> Result<(), TargetAuthorityError> {
        let mut state = self.state.lock().assert_value();
        let expected = format!("refresh-{}", state.writes + 1);
        if !state.in_flight || refresh_token != expected {
            return Err(TargetAuthorityError::new("invalid refresh rotation"));
        }
        state.value = refresh_token.to_owned();
        state.in_flight = false;
        state.writes += 1;
        Ok(())
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
