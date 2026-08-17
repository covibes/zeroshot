#[path = "support/architecture_boundary_macro.rs"]
mod architecture_boundary_macro;
#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_root, read};
architecture_boundary_macro::suppress_unused_architecture_exports!(
    architecture_support,
    repository_root,
    relative_files,
    workspace_metadata,
    product_package,
    runtime_source,
    rust_sources,
);

#[test]
fn full_v1_reduction_reuses_verified_ir_and_stays_pure() {
    let reducer = format!(
        "{}\n{}",
        read(&product_root().join("src/full_v1_reducer.rs")),
        read(&product_root().join("src/full_v1_reducer/history.rs"))
    );
    assert!(reducer.contains("VerifiedGraph"));
    assert!(reducer.contains("ProductionGraphVerifier"));
    assert!(!reducer.contains("GraphSpec"));
    assert!(!reducer.contains("CompiledGraphIr"));
    assert!(!reducer.contains("PayloadType"));
    assert!(!reducer.contains("pub prefix_position"));
    for forbidden in [
        "crate::cluster_ledger",
        "ReplayState",
        "ReductionSnapshot",
        "RecordPayload",
        "CanonicalDigest",
        "ExecutionVoidAuthorization",
        "ReductionDispatchAuthorization",
        "ReductionTerminalAuthorization",
        "tokio::",
        "async fn",
        "std::process",
        "std::time",
        "std::thread",
        "crate::execution",
        "crate::scheduler",
        "crate::artifact_store",
        "crate::issue_provider",
        "crate::source_code_provider",
        "ClusterBackend",
        "Dispatcher",
    ] {
        assert!(
            !reducer.contains(forbidden),
            "pure reducer imported an effectful concern: {forbidden}"
        );
    }

    let legacy_adapter =
        read(&product_root().join("src/cluster_ledger/mutations/reducer_authorization.rs"));
    assert!(legacy_adapter.contains("Temporary compatibility adapter"));
    assert!(legacy_adapter.contains("Native-v2 must not use this module"));
}
