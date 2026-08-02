#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_root, read};
const _: fn() -> std::path::PathBuf = architecture_support::repository_root;
const _: fn(&std::path::Path, &std::path::Path, &mut std::collections::BTreeSet<String>) =
    architecture_support::relative_files;
const _: fn() -> serde_json::Value = architecture_support::workspace_metadata;
const _: for<'a> fn(&'a serde_json::Value) -> &'a serde_json::Value =
    architecture_support::product_package;
const _: fn() -> String = architecture_support::runtime_source;
const _: fn(&[&str]) -> String = architecture_support::rust_sources;

#[test]
fn role_contract_adds_no_config_credential_driver_or_graph_compiler_concerns() {
    let source = read(&product_root().join("src/role_contract.rs"));
    for forbidden in [
        "mod config",
        "struct NativeConfig",
        "struct WorkerConfig",
        "struct ProviderConfig",
        "CredentialResolver",
        "CredentialLease",
        "resolve_credentials",
        "struct GatewayDriver",
        "struct CliProcessDriver",
        "struct AcpStdioDriver",
        "impl WorkerDriver",
        "GraphSpec",
        "CompiledGraphIr",
        "WorkerDescriptor",
        "ClusterLedger",
        "std::process",
        "Command::new",
        "tokio::",
        "async fn",
        "openengine_cluster_protocol",
        "rusqlite",
    ] {
        assert!(
            !source.contains(forbidden),
            "role contract pack crossed its owned boundary: {forbidden}"
        );
    }
}

#[test]
fn role_name_is_pinned_to_exactly_the_three_native_roles() {
    let source = read(&product_root().join("src/role_contract.rs"));
    let variants = source
        .split("pub enum RoleName {")
        .nth(1)
        .expect("RoleName enum must be present")
        .split('}')
        .next()
        .expect("RoleName enum must be closed")
        .split(',')
        .map(str::trim)
        .filter(|variant| !variant.is_empty())
        .collect::<Vec<_>>();
    assert_eq!(variants, vec!["Classifier", "Verifier", "Worker"]);
}
