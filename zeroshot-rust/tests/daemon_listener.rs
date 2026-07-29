use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::StreamExt;
#[path = "support/daemon.rs"]
mod daemon_support;

use daemon_support::{CountingFactory, TempProfile, authenticated_initialize, locator_credentials};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use zeroshot_engine::daemon_auth::{DAEMON_ROUTE, DaemonCredentials};
use zeroshot_engine::daemon_discovery::{
    CLUSTER_PROTOCOL, DAEMON_PROTOCOL, DaemonLocator, read_locator, replace_locator,
};
use zeroshot_engine::daemon_listener::{DaemonListener, DaemonListenerError, ListenerConfig};

fn test_config() -> ListenerConfig {
    ListenerConfig {
        startup_lock_timeout: Duration::from_millis(500),
        liveness_timeout: Duration::from_millis(150),
        handshake_timeout: Duration::from_millis(200),
        drain_timeout: Duration::from_millis(80),
        max_active_connections: 8,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_profile_start_has_one_owner_and_loser_cannot_remove_it() {
    let profile = TempProfile::new("concurrent-start");
    let factory = CountingFactory::default();
    let first = DaemonListener::start_with_config(
        profile.profile.clone(),
        factory.clone(),
        test_config(),
    );
    let second = DaemonListener::start_with_config(
        profile.profile.clone(),
        factory.clone(),
        test_config(),
    );
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
    assert_eq!(response["result"]["protocolVersion"], "openengine.cluster/v1");
    owner.shutdown().await.expect("owner shutdown");
    assert_eq!(read_locator(&profile.profile).expect("locator removed"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_port_without_authenticated_initialize_is_stale_and_rotated() {
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

    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
    )
    .await
    .expect("replace unauthenticated port");
    assert_ne!(listener.locator().endpoint, stale.endpoint);
    assert_ne!(listener.locator().capability, stale.capability);
    assert_ne!(listener.locator().daemon_nonce, stale.daemon_nonce);
    impostor_task.abort();
    let _ = impostor_task.await;
    listener.shutdown().await.expect("shutdown replacement");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_stops_accepting_drains_bounded_releases_port_and_removes_only_owner_locator() {
    let profile = TempProfile::new("bounded-shutdown");
    let listener = DaemonListener::start_with_config(
        profile.profile.clone(),
        CountingFactory::default(),
        test_config(),
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
    credentials.apply_to_request(&mut request).expect("credentials");
    let address: SocketAddr = request
        .uri()
        .authority()
        .expect("authority")
        .as_str()
        .parse()
        .expect("socket address");
    let stream = TcpStream::connect(address).await.expect("connect");
    let (mut websocket, _) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("authorized idle connection");

    let started = Instant::now();
    listener.shutdown().await.expect("bounded shutdown");
    assert!(started.elapsed() < Duration::from_millis(500));
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
        loop {
            match TcpStream::connect(stale_address).await {
                Ok(stream) => {
                    drop(stream);
                    tokio::task::yield_now().await;
                }
                Err(_) => break,
            }
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
