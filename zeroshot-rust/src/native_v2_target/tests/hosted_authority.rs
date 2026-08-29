use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use super::super::controller_authority::credentials::CredentialStorePreparation;
use super::super::controller_authority::TargetCredentialStore;
use super::super::*;

pub(super) struct RotatingCredentialStore {
    state: Mutex<RotatingCredentialState>,
}

pub(super) struct LoginBlockingCredentialStore {
    value: Mutex<String>,
    prepare_started: Notify,
    prepare_release: Notify,
    reads: AtomicUsize,
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
                    "kind": "zeroshot.native-v2-target/v2",
                    "authentication": "none",
                    "runPath": "/native-v2/run",
                    "sessionPath": "/native-v2/oecp-session",
                    "oecpPath": "/native-v2/oecp",
                    "audience": "controller",
                })
                .to_string(),
                ("POST", "/native-v2/run") => {
                    r#"{"runId":"018f5e78-7f95-7c22-8d98-3f15af20c991"}"#.to_owned()
                }
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
    if let Some(response) = hosted_run_response(request) {
        return response;
    }
    if let Some(response) = connection_response(request) {
        return response;
    }
    if let Some(response) = controller_response(request, address) {
        return response;
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/oauth/metadata") => oauth_metadata(origin),
        ("GET", "/.well-known/zeroshot-native-v2") => hosted_discovery(origin),
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

fn connection_response(request: &CapturedHttpRequest) -> Option<String> {
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/native-v2/connections/list") => Some(
            json!({
                "connections": [{
                    "key": "github",
                    "scope": "user",
                    "kind": "static",
                    "fields": ["GH_TOKEN"]
                }]
            })
            .to_string(),
        ),
        ("POST", "/native-v2/connections/set") => Some(
            json!({
                "connection": {
                    "key": "github",
                    "scope": "user",
                    "kind": "static",
                    "fields": ["GH_TOKEN"]
                }
            })
            .to_string(),
        ),
        ("POST", "/native-v2/connections/delete") => Some(json!({"deleted": true}).to_string()),
        _ => None,
    }
}

fn hosted_run_response(request: &CapturedHttpRequest) -> Option<String> {
    let queued = || {
        json!({
            "runId": "run-hosted",
            "title": "Hosted queue test",
            "source": source(),
            "size": "medium",
            "atCursor": "cloud:1",
            "status": {"phase": "queued"}
        })
    };
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/native-v2/runs") => Some(json!({"runs": [queued()]}).to_string()),
        ("GET", "/native-v2/runs/run-hosted") => Some(queued().to_string()),
        ("GET", "/native-v2/runs/run-hosted/watch") => Some(
            json!({
                "type": "event",
                "event": {
                    "subscriptionId": "watch-1",
                    "runId": "run-hosted",
                    "title": "Hosted queue test",
                    "source": source(),
                    "size": "medium",
                    "cursor": "cloud:1",
                    "status": {"phase": "queued"}
                }
            })
            .to_string()
                + "\n{\"type\":\"event\"",
        ),
        ("GET", "/native-v2/runs/run-hosted/watch?from_cursor=cloud%3A1") => Some(format!(
            "{}\n{}\n",
            json!({
                "type": "event",
                "event": {
                    "subscriptionId": "watch-2",
                    "runId": "run-hosted",
                    "title": "Hosted queue test",
                    "source": source(),
                    "size": "medium",
                    "cursor": "v2:3",
                    "status": {
                        "phase": "finished",
                        "terminalResult": {"status": "succeeded", "output": null}
                    }
                }
            }),
            json!({"type": "closed", "reason": "done"})
        )),
        ("GET", "/native-v2/runs/run-hosted/logs?from_cursor=v2%3A2&execution=worker%2F1") => {
            Some(format!(
                "{}\n{}\n",
                json!({
                    "type": "event",
                    "event": {
                        "subscriptionId": "logs-1",
                        "runId": "run-hosted",
                        "cursor": "v2:4",
                        "execution": "worker/1",
                        "record": {
                            "level": "info",
                            "target": "agent",
                            "message": "retained output"
                        }
                    }
                }),
                json!({"type": "closed", "reason": "done"})
            ))
        }
        ("POST", "/native-v2/runs/run-hosted/force") => Some(queued().to_string()),
        _ => None,
    }
}

fn source() -> serde_json::Value {
    json!({
        "repository": "open-engine/zeroshot",
        "branch": "main",
        "revision": "0123456789abcdef0123456789abcdef01234567"
    })
}

fn controller_response(
    request: &CapturedHttpRequest,
    address: std::net::SocketAddr,
) -> Option<String> {
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/native-v2/run") => {
            Some(r#"{"runId":"018f5e78-7f95-7c22-8d98-3f15af20c991"}"#.to_owned())
        }
        ("POST", "/native-v2/oecp-session") => Some(format!(
            r#"{{"endpoint":"ws://{address}/native-v2/oecp","bearerToken":"oecp-session-token"}}"#
        )),
        _ => None,
    }
}

fn hosted_discovery(origin: &str) -> String {
    json!({
        "kind": "zeroshot.native-v2-target/v2",
        "authentication": "hosted_oauth",
        "runPath": "/native-v2/run",
        "sessionPath": "/native-v2/oecp-session",
        "oecpPath": "/native-v2/oecp",
        "audience": "controller",
        "oauth": {
            "metadataUrl": format!("{origin}/oauth/metadata"),
            "deviceAuthorizationEndpoint": format!("{origin}/oauth/device"),
            "tokenEndpoint": format!("{origin}/oauth/token"),
            "revocationEndpoint": format!("{origin}/oauth/revoke"),
            "clientId": "zeroshot-cli",
            "deviceGrantType": "urn:ietf:params:oauth:grant-type:device_code",
            "deviceExchangeFields": ["device_token", "device_label"]
        },
        "loginSession": {
            "routeTemplate": "/session",
            "method": "GET",
            "cachePolicy": "no-store"
        },
        "extensions": {
            "hosted_runs": {
                "kind": "zeroshot.hosted-runs/v1",
                "base_url": origin,
                "route_templates": hosted_run_routes()
            },
            "connections": {
                "kind": "zeroshot.connections/v1",
                "baseUrl": origin,
                "routeTemplates": {
                    "list": "/native-v2/connections/list",
                    "set": "/native-v2/connections/set",
                    "delete": "/native-v2/connections/delete"
                },
                "dynamicKinds": ["github_app"]
            }
        }
    })
    .to_string()
}

fn hosted_run_routes() -> serde_json::Value {
    json!({
        "force": "/native-v2/runs/{run_id}/force",
        "list": "/native-v2/runs",
        "logs": "/native-v2/runs/{run_id}/logs{?from_cursor,execution}",
        "status": "/native-v2/runs/{run_id}",
        "watch": "/native-v2/runs/{run_id}/watch{?from_cursor}"
    })
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

impl LoginBlockingCredentialStore {
    pub(super) fn new(value: &str) -> Self {
        Self {
            value: Mutex::new(value.to_owned()),
            prepare_started: Notify::new(),
            prepare_release: Notify::new(),
            reads: AtomicUsize::new(0),
        }
    }

    pub(super) async fn wait_until_prepared(&self) {
        self.prepare_started.notified().await;
    }

    pub(super) fn release_login(&self) {
        self.prepare_release.notify_one();
    }

    pub(super) fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    pub(super) fn value(&self) -> String {
        self.value.lock().assert_value().clone()
    }
}

#[async_trait]
impl TargetCredentialStore for LoginBlockingCredentialStore {
    async fn prepare_for_login(
        &self,
        _target_id: &str,
    ) -> Result<CredentialStorePreparation, TargetAuthorityError> {
        self.prepare_started.notify_one();
        self.prepare_release.notified().await;
        Ok(CredentialStorePreparation::Managed)
    }

    async fn get(&self, _target_id: &str) -> Result<Option<String>, TargetAuthorityError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(Some(self.value()))
    }

    async fn set(&self, _target_id: &str, refresh_token: &str) -> Result<(), TargetAuthorityError> {
        *self.value.lock().assert_value() = refresh_token.to_owned();
        Ok(())
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
