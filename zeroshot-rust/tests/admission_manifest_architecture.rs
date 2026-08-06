#[path = "support/architecture_boundary_macro.rs"]
mod architecture_boundary_macro;
#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_root, read};
architecture_boundary_macro::suppress_unused_architecture_exports!(
    architecture_support,
    rust_sources,
    runtime_source,
    product_package,
    workspace_metadata,
    relative_files,
    repository_root,
);

#[test]
fn admission_manifest_stays_protocol_driver_and_credential_free() {
    let source = read(&product_root().join("src/admission_manifest.rs"));
    for forbidden in [
        "openengine_cluster_protocol",
        "openengine_cluster_server",
        "std::process",
        "Command::new",
        "reqwest",
        "PathBuf",
        "std::fs",
        "serde_json::Value",
        "ClusterLedger",
    ] {
        assert!(
            !source.contains(forbidden),
            "admission manifest compiler crossed its owned boundary: {forbidden}"
        );
    }
}
