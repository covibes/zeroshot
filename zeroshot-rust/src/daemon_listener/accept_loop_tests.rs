use std::fs;
use std::path::PathBuf;

use super::*;
use crate::daemon_discovery::{random_hex, read_locator, replace_locator};

#[derive(Clone, Copy)]
struct UnusedFactory;

#[derive(Clone, Copy)]
struct UnusedBackend;

impl crate::NativeBackendFactory for UnusedFactory {
    type Backend = UnusedBackend;

    fn create(&self) -> Self::Backend {
        UnusedBackend
    }
}

#[async_trait::async_trait]
impl crate::ClusterBackend for UnusedBackend {
    async fn initialize(
        &self,
        _context: &crate::ConnectionContext,
        _params: openengine_cluster_protocol::InitializeParams,
    ) -> Result<
        openengine_cluster_protocol::InitializeResult,
        openengine_cluster_server::BackendError,
    > {
        panic!("controlled failing accept loop must not create a backend")
    }

    async fn get(
        &self,
        _context: &crate::ConnectionContext,
        _params: openengine_cluster_protocol::GetParams,
    ) -> Result<openengine_cluster_protocol::GetResult, openengine_cluster_server::BackendError>
    {
        panic!("controlled failing accept loop must not create a backend")
    }
}

#[derive(Clone, Copy)]
enum FailureMode {
    Error,
    Panic,
}

struct FailingAcceptor {
    _listener: TcpListener,
    mode: FailureMode,
}

impl ConnectionAcceptor for FailingAcceptor {
    fn accept(&self) -> impl Future<Output = io::Result<(TcpStream, SocketAddr)>> + Send {
        let mode = self.mode;
        async move {
            match mode {
                FailureMode::Error => Err(io::Error::other("controlled accept failure")),
                FailureMode::Panic => panic!("controlled accept loop panic"),
            }
        }
    }
}

struct TestProfile {
    profile: NativeProfile,
    root: PathBuf,
}

impl Drop for TestProfile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

async fn failing_owner(
    mode: FailureMode,
    label: &str,
) -> (DaemonListener, TestProfile, SocketAddr) {
    let root = std::env::temp_dir().join(format!(
        "zeroshot-accept-{label}-{}-{}",
        std::process::id(),
        random_hex().expect("temporary profile suffix")
    ));
    let profile = NativeProfile::new(&root, format!("native-profile:{label}"));
    let tcp = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind controlled acceptor");
    let address = tcp.local_addr().expect("controlled acceptor address");
    let credentials =
        DaemonCredentials::generate(profile.digest().to_owned()).expect("credentials");
    let locator = locator_for(address, &credentials);
    replace_locator(&profile, &locator).expect("publish controlled locator");
    let config = ListenerConfig::default();
    let host = AcceptLoop::new(
        FailingAcceptor {
            _listener: tcp,
            mode,
        },
        Arc::new(UnusedFactory),
        credentials,
        config,
    );
    let owner = spawn_listener_owner(host, profile.clone(), locator);
    (owner, TestProfile { profile, root }, address)
}

async fn assert_failure_cleanup_before_shutdown(mode: FailureMode, label: &str) {
    let (owner, profile, address) = failing_owner(mode, label).await;
    timeout(Duration::from_millis(500), async {
        loop {
            let locator_removed = read_locator(&profile.profile)
                .expect("automatic failure cleanup state")
                .is_none();
            let socket_released = match TcpListener::bind(address).await {
                Ok(rebound) => {
                    drop(rebound);
                    true
                }
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => false,
                Err(error) => panic!("unexpected rebind failure: {error}"),
            };
            if locator_removed && socket_released {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned accept failure released locator and socket");
    assert!(matches!(
        owner.shutdown().await,
        Err(DaemonListenerError::Task)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accept_error_cleans_owner_before_shutdown_and_remains_task_failure() {
    assert_failure_cleanup_before_shutdown(FailureMode::Error, "accept-error").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accept_loop_panic_cleans_owner_before_shutdown_and_remains_task_failure() {
    assert_failure_cleanup_before_shutdown(FailureMode::Panic, "accept-panic").await;
}
