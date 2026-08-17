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
    assert!(reducer.contains("pub use crate::native_v2_contract"));
    assert_eq!(
        reducer.matches("crate::").count(),
        1,
        "the reducer may import only native-v2's neutral execution identities"
    );
    for forbidden in [
        "tokio::",
        "async fn",
        "std::process",
        "std::time",
        "std::thread",
    ] {
        assert!(
            !reducer.contains(forbidden),
            "pure reducer imported an effectful concern: {forbidden}"
        );
    }
}
