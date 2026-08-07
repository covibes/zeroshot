use std::error::Error;
use std::io;
use std::net::SocketAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{ClientRequestBuilder, Message},
};

use super::server::{
    prepare_server, production_backend, serve_prepared, HostedListeners, OECP_PORT,
    OECP_WEBSOCKET_PORT, RUN_INTENT_PORT,
};
use super::server_auth::{load_transport_capability, TransportCapability, RUNTIME_CAPABILITY_HEADER};

pub async fn run_server_process() -> Result<(), Box<dyn Error>> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        tokio::time::timeout(Duration::from_secs(2), healthcheck()).await??;
        println!("zeroshot-oecp-server ready");
        return Ok(());
    }
    let backend = production_backend().await?;
    let capability = prepare_server(&backend).await?;
    let ndjson = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], OECP_PORT))).await?;
    let websocket =
        TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], OECP_WEBSOCKET_PORT))).await?;
    let run_intent = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], RUN_INTENT_PORT))).await?;
    serve_prepared(
        HostedListeners::new(ndjson, websocket, run_intent),
        backend,
        capability,
        shutdown_signal(),
    )
    .await?;
    Ok(())
}

async fn healthcheck() -> io::Result<()> {
    let capability = load_transport_capability()?;
    check_ndjson_initialize(&capability).await?;
    check_websocket_initialize(&capability).await?;
    check_run_intent_control(&capability).await
}

async fn check_ndjson_initialize(capability: &TransportCapability) -> io::Result<()> {
    let mut stream = TcpStream::connect(("127.0.0.1", OECP_PORT)).await?;
    let request = serde_json::json!({
        "_zeroshotOecpTransport": { "capability": capability.as_str() },
        "request": {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "openengine.cluster/v1" }
        }
    });
    stream.write_all(format!("{request}\n").as_bytes()).await?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).await?;
    is_ready_initialize_text(&response)
        .then_some(())
        .ok_or_else(|| io::Error::other("NDJSON initialize response unavailable"))
}

async fn check_websocket_initialize(capability: &TransportCapability) -> io::Result<()> {
    let stream = TcpStream::connect(("127.0.0.1", OECP_WEBSOCKET_PORT)).await?;
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs()
        .saturating_add(10);
    let uri = format!("ws://127.0.0.1:{OECP_WEBSOCKET_PORT}/oecp")
        .parse()
        .map_err(|_| io::Error::other("invalid healthcheck URI"))?;
    let request = ClientRequestBuilder::new(uri)
        .with_header(RUNTIME_CAPABILITY_HEADER, capability.as_str())
        .with_header("x-zero-capsule-id", "healthcheck")
        .with_header("x-zero-organization-id", "healthcheck")
        .with_header("x-zero-actor-handle", "healthcheck")
        .with_header("x-capsule-grant-expires-at", expires_at.to_string());
    let (mut socket, _) = client_async_with_config(request, stream, None)
        .await
        .map_err(io::Error::other)?;
    socket
        .send(Message::Text(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"openengine.cluster/v1"}}"#
                .into(),
        ))
        .await
        .map_err(io::Error::other)?;
    while let Some(message) = socket.next().await {
        if is_ready_initialize(message.map_err(io::Error::other)?)? {
            return Ok(());
        }
    }
    Err(io::Error::other("OECP initialize response unavailable"))
}

fn is_ready_initialize(message: Message) -> io::Result<bool> {
    let Ok(text) = message.into_text() else {
        return Ok(false);
    };
    Ok(is_ready_initialize_text(&text))
}

fn is_ready_initialize_text(text: &str) -> bool {
    let Ok(response) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let profiles = response["result"]["capabilities"]["graphProfiles"].as_array();
    response["id"] == 1
        && profiles.is_some_and(|profiles| {
            profiles
                .iter()
                .any(|profile| profile == "openengine.graph.single-worker/v1")
        })
}

async fn check_run_intent_control(capability: &TransportCapability) -> io::Result<()> {
    let mut stream = TcpStream::connect(("127.0.0.1", RUN_INTENT_PORT)).await?;
    let request = format!(
        "GET /internal/run-intents/00000000-0000-0000-0000-000000000000 HTTP/1.1\r\n\
         Host: capsule\r\n\
         {RUNTIME_CAPABILITY_HEADER}: {}\r\n\
         x-zero-run-intent-digest: sha256:{}\r\n\r\n",
        capability.as_str(),
        "0".repeat(64)
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    response
        .starts_with(b"HTTP/1.1 404 ")
        .then_some(())
        .ok_or_else(|| io::Error::other("RunIntent control response unavailable"))
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler must install");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
