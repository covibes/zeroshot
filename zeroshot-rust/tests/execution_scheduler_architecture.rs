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
fn execution_runtime_and_scheduler_stay_engine_private() {
    let execution = rust_sources(&["src/execution.rs", "src/execution", "src/scheduler.rs"]);
    for required in [
        "trait ExecutionRuntime",
        "struct LocalExecutionRuntime",
        "struct LocalProcessRunner",
        "struct FairScheduler",
    ] {
        assert!(
            execution.contains(required),
            "missing execution/scheduler seam: {required}"
        );
    }
    for forbidden in [
        "RemoteExecutionRuntime",
        "kubernetes",
        "pod",
        "broker",
        "outbox",
        "reqwest",
        "hyper",
        "NativeBackendFactory",
        "NativeBackend",
        "ClusterLedger",
        "CredentialResolver",
        "WorkspaceManager",
        "CliDriver",
        "AcpDriver",
        "GatewayDriver",
    ] {
        assert!(
            !execution.contains(forbidden),
            "execution/scheduler crossed an owned boundary: {forbidden}"
        );
    }
}
