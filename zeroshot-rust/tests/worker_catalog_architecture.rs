use std::collections::BTreeSet;

#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_package, product_root, read, relative_files, workspace_metadata};

const _: fn() -> String = architecture_support::runtime_source;
const _: fn(&[&str]) -> String = architecture_support::rust_sources;
const EXPECTED_TOP_LEVEL_SOURCE_ENTRIES: [&str; 21] = [
    "artifact_store",
    "artifact_store.rs",
    "cluster_ledger",
    "cluster_ledger.rs",
    "execution",
    "execution.rs",
    "fault",
    "fault.rs",
    "full_v1_reducer.rs",
    "issue_provider",
    "issue_provider.rs",
    "lib.rs",
    "main.rs",
    "observability.rs",
    "provider_value",
    "provider_value.rs",
    "required_proof.rs",
    "scheduler.rs",
    "source_code_provider",
    "source_code_provider.rs",
    "worker_catalog.rs",
];

fn is_architecture_guard(relative: &str) -> bool {
    matches!(
        relative,
        "tests/architecture.rs"
            | "tests/required_proof_architecture.rs"
            | "tests/worker_catalog_architecture.rs"
    )
}

#[test]
fn worker_catalog_has_no_build_or_node_typescript_source_inputs() {
    let product = product_root();
    let manifest = read(&product.join("Cargo.toml"));
    assert!(
        !manifest
            .lines()
            .any(|line| line.trim_start().starts_with("build =")),
        "native product manifest must not configure a build script"
    );

    let metadata = workspace_metadata();
    let has_build_target = product_package(&metadata)["targets"]
        .as_array()
        .expect("package targets must be an array")
        .iter()
        .any(|target| {
            target["kind"]
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|kind| kind == "custom-build"))
        });
    assert!(
        !has_build_target,
        "native product must not have a custom build target"
    );

    let mut product_files = BTreeSet::new();
    relative_files(&product, &product, &mut product_files);
    let mut build_and_source_inputs = manifest;
    for relative in product_files
        .iter()
        .filter(|relative| relative.ends_with(".rs") && !is_architecture_guard(relative))
    {
        build_and_source_inputs.push('\n');
        build_and_source_inputs.push_str(&read(&product.join(relative)));
    }
    for target in product_package(&metadata)["targets"]
        .as_array()
        .expect("package targets must be an array")
    {
        let source = target["src_path"]
            .as_str()
            .expect("Cargo target must have a source path");
        let source = std::path::Path::new(source);
        let relative = source
            .strip_prefix(&product)
            .ok()
            .and_then(|path| path.to_str());
        if source.starts_with(&product) && relative.is_none_or(|path| !is_architecture_guard(path))
        {
            build_and_source_inputs.push('\n');
            build_and_source_inputs.push_str(&read(source));
        }
    }
    for forbidden in [
        "agent-cli-provider",
        "provider-registry",
        "node_modules",
        "package.json",
        "tsconfig",
        ".ts\"",
        ".tsx\"",
        ".js\"",
        ".jsx\"",
        "Command::new(\"node\")",
        "Command::new(\"npm\")",
    ] {
        assert!(
            !build_and_source_inputs.contains(forbidden),
            "native crate input consumes Node/TypeScript source: {forbidden}"
        );
    }
}

#[test]
fn worker_catalog_adds_no_out_of_scope_product_construction() {
    let product = product_root();
    let mut product_files = BTreeSet::new();
    relative_files(&product, &product.join("src"), &mut product_files);
    let top_level_source_entries = product_files
        .iter()
        .filter_map(|relative| {
            relative
                .strip_prefix("src/")
                .and_then(|path| path.split('/').next())
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        top_level_source_entries,
        BTreeSet::from(EXPECTED_TOP_LEVEL_SOURCE_ENTRIES),
        "new product modules require an issue-authorized architecture amendment"
    );

    let catalog_source = read(&product.join("src/worker_catalog.rs"));
    for forbidden in [
        "pub struct RoleContract",
        "pub enum RoleContract",
        "RoleContractPack",
        "RoleManifest",
        "pub mod worker_registry",
        "mod worker_registry;",
        "struct WorkerRegistry",
        "impl WorkerRegistry",
        "impl WorkerRegistry for",
        "pub mod config",
        "mod config;",
        "mod native_config",
        "struct NativeConfig",
        "struct WorkerConfig",
        "struct ProviderConfig",
        "struct NativeSettings",
        "mod credentials;",
        "mod credential;",
        "CredentialResolver",
        "CredentialLease",
        "CredentialCodec",
        "resolve_credentials",
        "decode_credentials",
        "ExecutableCodec",
        "encode_executable",
        "decode_executable",
        "struct GatewayDriver",
        "struct CliProcessDriver",
        "struct AcpStdioDriver",
        "impl WorkerDriver for",
        "impl BuiltinWorkerDriver for",
        "struct ProtocolDescriptor",
        "struct WorkerDescriptor",
        "WorkerDescriptor::new",
        "openengine_cluster_protocol::worker",
    ] {
        assert!(
            !catalog_source.contains(forbidden),
            "worker catalog crossed its owned boundary: {forbidden}"
        );
    }
}

#[test]
fn manifest_has_no_client_testkit_or_node_dependencies() {
    let manifest = read(&product_root().join("Cargo.toml"));
    for forbidden_dependency in [
        "openengine-cluster-client",
        "openengine-cluster-testkit",
        "node",
        "npm",
    ] {
        assert!(
            !manifest.contains(forbidden_dependency),
            "forbidden product dependency: {forbidden_dependency}"
        );
    }
}
