#[path = "support/architecture_boundary_macro.rs"]
mod architecture_boundary_macro;
#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::rust_sources;
architecture_boundary_macro::suppress_unused_architecture_exports!(
    architecture_support,
    product_root,
    repository_root,
    read,
    relative_files,
    workspace_metadata,
    product_package,
    runtime_source,
);

#[test]
fn native_daemon_modules_stay_on_the_discovery_auth_and_loopback_host_boundary() {
    let daemon = rust_sources(&[
        "src/daemon_auth.rs",
        "src/daemon_discovery.rs",
        "src/daemon_listener.rs",
    ]);
    for required in [
        "authorize_request",
        "accept_hdr_async_with_config",
        "serve_websocket",
        "binding_for_route",
        "into_dispatcher",
        "probe_liveness",
        "remove_locator_if_matches",
        "openengine.cluster/v1",
        "zeroshot.daemon/v1",
        "zeroshot.daemon/v1/client-auth",
        "zeroshot.daemon/v1/server-auth",
        "ConnectionPurpose::Liveness",
        "expectation.verify",
    ] {
        assert!(
            daemon.contains(required),
            "missing native daemon boundary: {required}"
        );
    }
    assert!(
        !daemon.contains("ConnectionContext::new"),
        "daemon host bypassed binding-injected connection identity"
    );
    for required in [
        "#[cfg(unix)]\nmod platform",
        "#[cfg(windows)]\nmod platform",
        "FILE_FLAG_OPEN_REPARSE_POINT",
        "PROTECTED_DACL_SECURITY_INFORMATION",
        "MoveFileExW",
        "validate_directory_shape(&directory)?",
    ] {
        assert!(
            daemon.contains(required),
            "daemon discovery lost a supported-platform security boundary: {required}"
        );
    }
    for forbidden in [
        "ClusterLedger",
        "ExecutionRuntime",
        "FairScheduler",
        "ProviderPool",
        "ClusterCatalog",
        "RecoveryCoordinator",
        "Exporter",
        "Command::new",
        "clap",
        "hosted",
        "cloud_control_plane",
        "node_daemon",
    ] {
        assert!(
            !daemon.contains(forbidden),
            "native daemon crossed a non-goal boundary: {forbidden}"
        );
    }
}
