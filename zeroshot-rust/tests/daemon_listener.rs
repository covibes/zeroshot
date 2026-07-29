use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
#[path = "support/daemon.rs"]
mod daemon_support;

use daemon_support::{CountingFactory, TempProfile, authenticated_initialize, locator_credentials};
use openengine_cluster_protocol::{ClusterStatus, InitializeResult, ServerCapabilities};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use zeroshot_engine::daemon_auth::{
    AuthorizationCallback, ConnectionPurpose, DAEMON_ROUTE, DaemonCredentials,
};
use zeroshot_engine::daemon_discovery::{
    CLUSTER_PROTOCOL, DAEMON_PROTOCOL, DaemonLocator, acquire_start_guard, read_locator,
    replace_locator,
};
use zeroshot_engine::daemon_listener::{
    DaemonListener, DaemonListenerError, ListenerConfig, LivenessOutcome, probe_liveness,
};

fn test_config() -> ListenerConfig {
    ListenerConfig {
        startup_lock_timeout: Duration::from_millis(500),
        liveness_timeout: Duration::from_millis(150),
        handshake_timeout: Duration::from_millis(200),
        drain_timeout: Duration::from_millis(80),
        shutdown_timeout: Duration::from_millis(300),
        max_active_connections: 8,
        max_pending_handshakes: 8,
        max_liveness_connections: 2,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_profile_start_has_one_owner_and_loser_cannot_remove_it() {
    let profile = TempProfile::new("concurrent-start");
    let factory = CountingFactory::default();
    let first =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), test_config());
    let second =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), test_config());
    let (first, second) = tokio::join!(first, second);

    let (owner, loser) = match (first, second) {
        (Ok(owner), Err(loser)) | (Err(loser), Ok(owner)) => (owner, loser),
        _ => panic!("expected exactly one owner and one loser"),
    };
    assert!(matches!(loser, DaemonListenerError::AlreadyRunning));
    assert_eq!(
        read_locator(&profile.profile).expect("read owner locator"),
        Some(owner.locator().clone())
    );
    assert!(factory.initialized.load(Ordering::SeqCst) >= 1);

    let response = authenticated_initialize(owner.locator()).await;
    assert_eq!(
        response["result"]["protocolVersion"],
        "openengine.cluster/v1"
    );
    owner.shutdown().await.expect("owner shutdown");
    assert_eq!(
        read_locator(&profile.profile).expect("locator removed"),
        None
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn raw_handshake_burst_owns_only_the_configured_pre_auth_bound() {
    let profile = TempProfile::new("pre-auth-bound");
    let config = ListenerConfig {
        handshake_timeout: Duration::from_secs(2),
        max_pending_handshakes: 2,
        ..test_config()
    };
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await
    .expect("start listener");
    let address: SocketAddr = listener
        .locator()
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("listener endpoint")
        .parse()
        .expect("listener address");

    let mut sockets = Vec::new();
    for _ in 0..2 {
        let mut socket = TcpStream::connect(address).await.expect("raw connection");
        socket.write_all(b"G").await.expect("partial handshake");
        sockets.push(socket);
    }
    timeout(Duration::from_millis(200), async {
        while listener.pending_handshakes() != config.max_pending_handshakes {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("listener admitted bounded raw handshakes");
    let incumbent = listener.locator().clone();
    let contender = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::LivenessIndeterminate)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("preserved incumbent locator"),
        Some(incumbent)
    );

    for _ in 0..16 {
        if let Ok(mut socket) = TcpStream::connect(address).await {
            let _ = socket.write_all(b"G").await;
            sockets.push(socket);
        }
        assert!(
            listener.pending_handshakes() <= config.max_pending_handshakes,
            "accepted pre-auth ownership exceeded its finite bound"
        );
        tokio::task::yield_now().await;
    }
    assert_eq!(listener.pending_handshakes(), config.max_pending_handshakes);

    drop(sockets);
    timeout(Duration::from_millis(500), listener.shutdown())
        .await
        .expect("bounded listener shutdown")
        .expect("listener shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn liveness_is_unstarvable_by_full_sessions_and_stalled_raw_handshakes() {
    let profile = TempProfile::new("unstarvable-liveness");
    let config = ListenerConfig {
        liveness_timeout: Duration::from_millis(120),
        handshake_timeout: Duration::from_millis(500),
        drain_timeout: Duration::from_millis(50),
        max_active_connections: 1,
        ..test_config()
    };
    let factory = CountingFactory::default();
    let owner = DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), config)
        .await
        .expect("start owner");
    let locator = owner.locator().clone();
    let credentials = locator_credentials(&locator);
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("session request");
    let proof = credentials
        .apply_to_request(&mut request)
        .expect("session proof");
    let address: SocketAddr = request
        .uri()
        .authority()
        .expect("session authority")
        .as_str()
        .parse()
        .expect("session address");
    let stream = TcpStream::connect(address).await.expect("session connect");
    let (session, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authenticated occupying session");
    assert!(proof.verify(&response));

    let mut stalled = TcpStream::connect(address)
        .await
        .expect("stalled raw connect");
    stalled.write_all(b"G").await.expect("partial handshake");
    tokio::task::yield_now().await;

    let contender =
        DaemonListener::start_with_config(profile.profile.clone(), factory, config).await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::AlreadyRunning)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("owner locator"),
        Some(locator)
    );

    drop(session);
    drop(stalled);
    timeout(Duration::from_millis(500), owner.shutdown())
        .await
        .expect("owner bounded shutdown")
        .expect("owner shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_purpose_accepts_only_initialize_before_backend_access() {
    let profile = TempProfile::new("liveness-method");
    let factory = CountingFactory::default();
    let listener =
        DaemonListener::start_with_config(profile.profile.clone(), factory.clone(), test_config())
            .await
            .expect("start listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("liveness request");
    let proof = credentials
        .prepare_request(&mut request, ConnectionPurpose::Liveness)
        .expect("liveness proof");
    let address = request
        .uri()
        .authority()
        .expect("liveness authority")
        .as_str();
    let stream = TcpStream::connect(address)
        .await
        .expect("liveness connection");
    let (mut websocket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authenticated liveness upgrade");
    assert!(proof.verify(&response));
    websocket
        .send(Message::Text(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "get",
                "params": {}
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send forbidden liveness method");
    let ended = timeout(Duration::from_millis(200), websocket.next())
        .await
        .expect("liveness method rejected");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }
    assert_eq!(factory.created.load(Ordering::SeqCst), 0);
    assert_eq!(factory.initialized.load(Ordering::SeqCst), 0);
    listener.shutdown().await.expect("shutdown listener");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authenticated_liveness_burst_owns_only_its_reserved_capacity() {
    let profile = TempProfile::new("liveness-capacity");
    let config = ListenerConfig {
        liveness_timeout: Duration::from_secs(2),
        max_liveness_connections: 2,
        ..test_config()
    };
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        config,
    )
    .await
    .expect("start listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let address: SocketAddr = locator
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("liveness endpoint")
        .parse()
        .expect("liveness address");

    let mut held = Vec::new();
    for _ in 0..config.max_liveness_connections {
        let mut request = locator
            .endpoint
            .as_str()
            .into_client_request()
            .expect("liveness request");
        let proof = credentials
            .prepare_request(&mut request, ConnectionPurpose::Liveness)
            .expect("liveness proof");
        let stream = TcpStream::connect(address)
            .await
            .expect("liveness connection");
        let (websocket, response) = tokio_tungstenite::client_async(request, stream)
            .await
            .expect("liveness upgrade");
        assert!(proof.verify(&response));
        held.push(websocket);
    }
    timeout(Duration::from_millis(200), async {
        while listener.active_liveness_connections() != config.max_liveness_connections {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reserved liveness capacity filled");

    let mut overflow_request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("overflow request");
    let overflow_proof = credentials
        .prepare_request(&mut overflow_request, ConnectionPurpose::Liveness)
        .expect("overflow proof");
    let overflow_stream = TcpStream::connect(address)
        .await
        .expect("overflow connection");
    let (mut overflow, overflow_response) =
        tokio_tungstenite::client_async(overflow_request, overflow_stream)
            .await
            .expect("authenticated overflow upgrade");
    assert!(overflow_proof.verify(&overflow_response));
    let ended = timeout(Duration::from_millis(200), overflow.next())
        .await
        .expect("overflow liveness rejected");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }
    assert_eq!(
        listener.active_liveness_connections(),
        config.max_liveness_connections
    );

    drop(overflow);
    drop(held);
    timeout(Duration::from_millis(500), listener.shutdown())
        .await
        .expect("bounded liveness shutdown")
        .expect("liveness shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_response_requires_exact_json_rpc_correlation_and_shape() {
    let profile = TempProfile::new("liveness-response");
    let credentials =
        DaemonCredentials::generate(profile.profile.digest()).expect("locator credentials");
    let responder = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stale responder");
    let address = responder.local_addr().expect("responder address");
    let locator = DaemonLocator {
        endpoint: format!("ws://{address}{DAEMON_ROUTE}"),
        cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
        daemon_protocol: DAEMON_PROTOCOL.to_owned(),
        profile_digest: credentials.profile_digest.clone(),
        daemon_nonce: credentials.daemon_nonce.clone(),
        capability: credentials.capability.clone(),
    };
    let initialize_result = serde_json::to_value(InitializeResult::new(
        ServerCapabilities::default(),
        ClusterStatus::empty(),
    ))
    .expect("initialize result");
    let valid = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "daemon-liveness",
        "result": initialize_result.clone()
    });
    let mut wrong_protocol = valid.clone();
    wrong_protocol["result"]["protocolVersion"] = serde_json::json!("other/v1");
    let mut missing_protocol = valid.clone();
    missing_protocol["result"]
        .as_object_mut()
        .expect("result object")
        .remove("protocolVersion");
    let mut missing_capabilities = valid.clone();
    missing_capabilities["result"]
        .as_object_mut()
        .expect("result object")
        .remove("capabilities");
    let mut missing_status = valid.clone();
    missing_status["result"]
        .as_object_mut()
        .expect("result object")
        .remove("status");
    let mut unknown_result_field = valid.clone();
    unknown_result_field["result"]["unexpected"] = serde_json::json!(true);
    let mut unknown_top_level_field = valid.clone();
    unknown_top_level_field["unexpected"] = serde_json::json!(true);
    let mut result_and_error = valid.clone();
    result_and_error["error"] = serde_json::json!({"code": -32603, "message": "stale response"});
    let cases = vec![
        ("valid", valid.to_string(), true),
        (
            "wrong id with correct result",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "other-request",
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        (
            "missing id",
            serde_json::json!({"jsonrpc": "2.0", "result": initialize_result.clone()}).to_string(),
            false,
        ),
        (
            "numeric id",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        (
            "wrong jsonrpc version",
            serde_json::json!({
                "jsonrpc": "1.0",
                "id": "daemon-liveness",
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        (
            "missing jsonrpc version",
            serde_json::json!({
                "id": "daemon-liveness",
                "result": initialize_result.clone()
            })
            .to_string(),
            false,
        ),
        ("top-level array", serde_json::json!([]).to_string(), false),
        (
            "missing result",
            serde_json::json!({"jsonrpc": "2.0", "id": "daemon-liveness"}).to_string(),
            false,
        ),
        (
            "non-object result",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "daemon-liveness",
                "result": null
            })
            .to_string(),
            false,
        ),
        ("wrong protocol", wrong_protocol.to_string(), false),
        ("missing protocol", missing_protocol.to_string(), false),
        (
            "missing capabilities",
            missing_capabilities.to_string(),
            false,
        ),
        ("missing status", missing_status.to_string(), false),
        (
            "unknown result field",
            unknown_result_field.to_string(),
            false,
        ),
        (
            "unknown top-level field",
            unknown_top_level_field.to_string(),
            false,
        ),
        ("result and error", result_and_error.to_string(), false),
        (
            "error only",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "daemon-liveness",
                "error": {"code": -32603, "message": "stale response"}
            })
            .to_string(),
            false,
        ),
        ("malformed json", "{".to_owned(), false),
    ];
    let responses = cases
        .iter()
        .map(|(_, response, _)| response.clone())
        .collect::<Vec<_>>();
    let responder_task = tokio::spawn(async move {
        for response in responses {
            let (stream, _) = responder.accept().await.expect("probe connection");
            let (callback, receipt) = AuthorizationCallback::new(credentials.clone());
            let mut websocket = accept_hdr_async(stream, callback)
                .await
                .expect("authenticated responder");
            assert_eq!(receipt.take(), Some(ConnectionPurpose::Liveness));
            let request = timeout(Duration::from_millis(200), websocket.next())
                .await
                .expect("bounded initialize request")
                .expect("initialize request")
                .expect("valid initialize frame");
            let Message::Text(request) = request else {
                panic!("liveness request must be text");
            };
            let request: serde_json::Value =
                serde_json::from_str(request.as_ref()).expect("initialize JSON");
            assert_eq!(request["id"], "daemon-liveness");
            websocket
                .send(Message::Text(response.into()))
                .await
                .expect("stale response");
        }
    });

    for (name, _, expected) in &cases {
        let expected = if *expected {
            LivenessOutcome::Alive
        } else {
            LivenessOutcome::DefinitelyStale
        };
        assert_eq!(
            probe_liveness(&locator, Duration::from_millis(250)).await,
            expected,
            "case: {name}"
        );
    }
    timeout(Duration::from_secs(4), responder_task)
        .await
        .expect("bounded responder matrix")
        .expect("responder task");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_port_timeout_is_indeterminate_and_preserves_incumbent_locator() {
    let profile = TempProfile::new("initialize-only-liveness");
    let impostor = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("impostor listener");
    let impostor_address = impostor.local_addr().expect("impostor address");
    let impostor_task = tokio::spawn(async move {
        if let Ok((socket, _)) = impostor.accept().await {
            tokio::time::sleep(Duration::from_secs(1)).await;
            drop(socket);
        }
    });
    let stale_credentials = DaemonCredentials::generate(profile.profile.digest()).expect("stale");
    let stale = DaemonLocator {
        endpoint: format!("ws://{impostor_address}{DAEMON_ROUTE}"),
        cluster_protocol: CLUSTER_PROTOCOL.to_owned(),
        daemon_protocol: DAEMON_PROTOCOL.to_owned(),
        profile_digest: stale_credentials.profile_digest,
        daemon_nonce: stale_credentials.daemon_nonce,
        capability: stale_credentials.capability,
    };
    replace_locator(&profile.profile, &stale).expect("publish stale locator");

    let contender = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await;
    assert!(matches!(
        contender,
        Err(DaemonListenerError::LivenessIndeterminate)
    ));
    assert_eq!(
        read_locator(&profile.profile).expect("preserved ambiguous locator"),
        Some(stale)
    );
    impostor_task.abort();
    let _ = impostor_task.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_stops_accepting_drains_bounded_releases_port_and_removes_only_owner_locator() {
    let profile = TempProfile::new("bounded-shutdown");
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        ListenerConfig {
            drain_timeout: Duration::from_secs(2),
            shutdown_timeout: Duration::from_millis(30),
            ..test_config()
        },
    )
    .await
    .expect("start listener");
    let locator = listener.locator().clone();
    let credentials = locator_credentials(&locator);
    let mut request = locator
        .endpoint
        .as_str()
        .into_client_request()
        .expect("request");
    let proof = credentials
        .apply_to_request(&mut request)
        .expect("credentials");
    let address: SocketAddr = request
        .uri()
        .authority()
        .expect("authority")
        .as_str()
        .parse()
        .expect("socket address");
    let stream = TcpStream::connect(address).await.expect("connect");
    let (mut websocket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authorized idle connection");
    assert!(proof.verify(&response));

    timeout(Duration::from_millis(500), listener.shutdown())
        .await
        .expect("shutdown obeyed its drain deadline")
        .expect("bounded shutdown");
    assert_eq!(read_locator(&profile.profile).expect("locator state"), None);
    let rebound = TcpListener::bind(address).await.expect("listener released");
    drop(rebound);
    let ended = timeout(Duration::from_millis(200), websocket.next())
        .await
        .expect("idle connection terminated");
    if let Some(Ok(message)) = ended {
        assert!(message.is_close());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_absolute_deadline_bounds_matching_cleanup_lock_and_reports_timeout() {
    let profile = TempProfile::new("shutdown-cleanup-deadline");
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        ListenerConfig {
            shutdown_timeout: Duration::from_millis(60),
            ..test_config()
        },
    )
    .await
    .expect("start listener");
    let locator = listener.locator().clone();
    let cleanup_blocker =
        acquire_start_guard(&profile.profile, Duration::from_millis(100)).expect("hold lock");

    let result = timeout(Duration::from_millis(200), listener.shutdown())
        .await
        .expect("shutdown respected absolute product deadline");
    assert!(matches!(result, Err(DaemonListenerError::ShutdownTimeout)));
    assert_eq!(
        read_locator(&profile.profile).expect("locator preserved while cleanup blocked"),
        Some(locator)
    );

    drop(cleanup_blocker);
    timeout(Duration::from_millis(500), async {
        loop {
            if read_locator(&profile.profile)
                .expect("eventual cleanup state")
                .is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("timed-out cleanup attempt completed after lock release");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_leaves_stale_locator_that_next_owner_cleans_without_reusing_secrets() {
    let profile = TempProfile::new("crash-handoff");
    let crashed = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await
    .expect("start crashed listener");
    let stale = crashed.locator().clone();
    let stale_address: SocketAddr = stale
        .endpoint
        .strip_prefix("ws://")
        .and_then(|endpoint| endpoint.strip_suffix(DAEMON_ROUTE))
        .expect("stale endpoint")
        .parse()
        .expect("stale address");
    drop(crashed);
    timeout(Duration::from_millis(200), async {
        while let Ok(stream) = TcpStream::connect(stale_address).await {
            drop(stream);
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("crashed listener released");

    let replacement = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await
    .expect("clean stale crash locator");
    assert_ne!(replacement.locator().endpoint, stale.endpoint);
    assert_ne!(replacement.locator().capability, stale.capability);
    assert_ne!(replacement.locator().daemon_nonce, stale.daemon_nonce);
    assert_eq!(
        read_locator(&profile.profile).expect("replacement locator"),
        Some(replacement.locator().clone())
    );
    replacement.shutdown().await.expect("replacement shutdown");
}
