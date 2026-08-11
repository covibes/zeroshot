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
        read(&product_root().join("src/full_v1_reducer/authorization.rs"))
    );
    assert!(reducer.contains("VerifiedGraph"));
    assert!(reducer.contains("ProductionGraphVerifier"));
    assert!(!reducer.contains("GraphSpec"));
    assert!(!reducer.contains("CompiledGraphIr"));
    assert!(!reducer.contains("PayloadType"));
    assert!(!reducer.contains("pub prefix_position"));
    assert!(reducer.contains("pub snapshot: Option<ReductionSnapshot>"));
    assert_authorization_private(&reducer);
    let ledger = read(&product_root().join("src/cluster_ledger.rs"));
    assert_snapshot_private(&ledger);
    for forbidden in [
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

    let records = read(&product_root().join("src/cluster_ledger/record.rs"));
    assert!(records.contains("ExecutionContext"));
    assert!(records.contains("ExecutionVoid"));
    let replay = read(&product_root().join("src/cluster_ledger/replay.rs"));
    assert!(replay.contains("fold_execution_context"));
    assert!(replay.contains("fold_execution_void"));
}

fn assert_authorization_private(reducer: &str) {
    let fields = reducer
        .split("pub struct ExecutionVoidAuthorization {")
        .nth(1)
        .unwrap()
        .split('}')
        .next()
        .unwrap();
    assert!(!fields.contains("pub "));
    let implementation = reducer
        .split("impl ExecutionVoidAuthorization {")
        .nth(1)
        .unwrap()
        .split("\n}")
        .next()
        .unwrap();
    assert!(
        !implementation
            .lines()
            .any(|line| line.trim_start().starts_with("pub "))
    );
}

fn assert_snapshot_private(ledger: &str) {
    let snapshot_fields = ledger
        .split("pub struct ReductionSnapshot {")
        .nth(1)
        .unwrap()
        .split('}')
        .next()
        .unwrap();
    assert!(!snapshot_fields.contains("pub "));
    let snapshot_impl = ledger
        .split("impl ReductionSnapshot {")
        .nth(1)
        .unwrap()
        .split("\n}")
        .next()
        .unwrap();
    assert!(
        !snapshot_impl
            .lines()
            .any(|line| line.trim_start().starts_with("pub "))
    );
    assert!(snapshot_impl.contains("self.position == state.position"));
    assert!(snapshot_impl.contains("self.last_hash == state.last_hash"));
    assert!(snapshot_impl.contains("Arc::ptr_eq(&self.authority, authority)"));
}
