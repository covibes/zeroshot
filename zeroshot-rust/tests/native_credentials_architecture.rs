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
fn native_credentials_resolve_without_ambient_state_or_secret_surfaces() {
    let credentials = rust_sources(&["src/native_credentials.rs", "src/native_credentials"]);
    for required in [
        "FaultModule::Credential",
        "write_volatile",
        "compiler_fence",
        "CredentialCapability",
        "compare_exchange",
    ] {
        assert!(
            credentials.contains(required),
            "missing native credential boundary: {required}"
        );
    }
    for forbidden in [
        "std::env::var",
        "Command::new",
        "std::process",
        "reqwest",
        "keychain",
        "node",
        "crate::cluster_ledger",
        "crate::full_v1_reducer",
        "crate::execution",
        "impl Serialize for SecretMaterial",
        "pub fn expose",
    ] {
        assert!(
            !credentials.contains(forbidden),
            "native credentials crossed an owned boundary: {forbidden}"
        );
    }
}
