use super::*;
use crate::daemon_auth::ServerProofExpectation;

struct PreparedProbe {
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    address: SocketAddr,
    expectation: ServerProofExpectation,
}

pub async fn probe_liveness(locator: &DaemonLocator, deadline: Duration) -> LivenessOutcome {
    timeout(deadline, probe_liveness_inner(locator))
        .await
        .unwrap_or(LivenessOutcome::Indeterminate)
}

async fn probe_liveness_inner(locator: &DaemonLocator) -> LivenessOutcome {
    execute_probe(locator)
        .await
        .unwrap_or_else(std::convert::identity)
}

async fn execute_probe(locator: &DaemonLocator) -> Result<LivenessOutcome, LivenessOutcome> {
    let prepared = prepare_probe(locator)?;
    let websocket = open_probe(prepared).await?;
    Ok(exchange_initialize(websocket).await)
}

fn prepare_probe(locator: &DaemonLocator) -> Result<PreparedProbe, LivenessOutcome> {
    if locator.cluster_protocol != CLUSTER_PROTOCOL || locator.daemon_protocol != DAEMON_PROTOCOL {
        return Err(LivenessOutcome::DefinitelyStale);
    }
    let mut request = match locator.endpoint.as_str().into_client_request() {
        Ok(request) => request,
        Err(_) => return Err(LivenessOutcome::DefinitelyStale),
    };
    let Some(address) = loopback_address(&request) else {
        return Err(LivenessOutcome::DefinitelyStale);
    };
    let expectation = match DaemonCredentials::from_locator(locator)
        .prepare_request(&mut request, ConnectionPurpose::Liveness)
    {
        Ok(expectation) => expectation,
        Err(_) => return Err(LivenessOutcome::Indeterminate),
    };
    Ok(PreparedProbe {
        request,
        address,
        expectation,
    })
}

async fn open_probe(
    prepared: PreparedProbe,
) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>, LivenessOutcome> {
    let stream = match TcpStream::connect(prepared.address).await {
        Ok(stream) => stream,
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            return Err(LivenessOutcome::DefinitelyStale);
        }
        Err(_) => return Err(LivenessOutcome::Indeterminate),
    };
    let (websocket, response) =
        match tokio_tungstenite::client_async(prepared.request, stream).await {
            Ok(connected) => connected,
            Err(WebSocketError::Http(_)) => return Err(LivenessOutcome::DefinitelyStale),
            Err(_) => return Err(LivenessOutcome::Indeterminate),
        };
    if !prepared.expectation.verify(&response) {
        return Err(LivenessOutcome::DefinitelyStale);
    }
    Ok(websocket)
}

async fn exchange_initialize(
    mut websocket: tokio_tungstenite::WebSocketStream<TcpStream>,
) -> LivenessOutcome {
    let initialize = serde_json::json!({
        "jsonrpc": JSON_RPC_VERSION,
        "id": "daemon-liveness",
        "method": "initialize",
        "params": { "protocolVersion": PROTOCOL_VERSION }
    });
    if websocket
        .send(Message::Text(initialize.to_string().into()))
        .await
        .is_err()
    {
        return LivenessOutcome::Indeterminate;
    }
    while let Some(message) = websocket.next().await {
        let message = match message {
            Ok(message) => message,
            Err(_) => return LivenessOutcome::Indeterminate,
        };
        let Message::Text(text) = message else {
            if message.is_close() {
                return LivenessOutcome::Indeterminate;
            }
            continue;
        };
        let response: Value = match serde_json::from_str(text.as_ref()) {
            Ok(response) => response,
            Err(_) => return LivenessOutcome::DefinitelyStale,
        };
        return classify_liveness_response(&response);
    }
    LivenessOutcome::Indeterminate
}

fn classify_liveness_response(response: &Value) -> LivenessOutcome {
    let Some(object) = response.as_object() else {
        return LivenessOutcome::DefinitelyStale;
    };
    if object.len() != 3
        || object.get("jsonrpc").and_then(Value::as_str) != Some(JSON_RPC_VERSION)
        || object.get("id").and_then(Value::as_str) != Some("daemon-liveness")
    {
        return LivenessOutcome::DefinitelyStale;
    }
    if object.contains_key("error") && !object.contains_key("result") {
        return LivenessOutcome::Indeterminate;
    }
    let Some(raw_result) = object.get("result") else {
        return LivenessOutcome::DefinitelyStale;
    };
    let Ok(result) = serde_json::from_value::<InitializeResult>(raw_result.clone()) else {
        return LivenessOutcome::DefinitelyStale;
    };
    if result.validate_protocol_version().is_ok()
        && serde_json::to_value(result).ok().as_ref() == Some(raw_result)
    {
        LivenessOutcome::Alive
    } else {
        LivenessOutcome::DefinitelyStale
    }
}

fn loopback_address(
    request: &tokio_tungstenite::tungstenite::handshake::client::Request,
) -> Option<SocketAddr> {
    let uri = request.uri();
    if uri.scheme_str() != Some("ws")
        || uri.path() != DAEMON_ROUTE
        || uri.query().is_some()
        || uri.host() != Some("127.0.0.1")
    {
        return None;
    }
    Some(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        uri.port_u16()?,
    ))
}
