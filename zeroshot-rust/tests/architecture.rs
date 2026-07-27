use std::collections::BTreeSet;

#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{
    product_package, product_root, read, relative_files, repository_root, rust_sources,
    runtime_source, workspace_metadata,
};

#[test]
fn product_uses_the_root_workspace_and_a_rust_only_layout() {
    let root = repository_root();
    let product = product_root();
    assert!(root.join("Cargo.toml").is_file());
    assert!(root.join("Cargo.lock").is_file());
    assert!(!product.join("Cargo.lock").exists());
    assert!(!product.join("package.json").exists());
    assert!(!read(&product.join("Cargo.toml")).contains("[workspace]"));

    let mut files = BTreeSet::new();
    relative_files(&product, &product, &mut files);
    for required in [
        "Cargo.toml",
        "src/artifact_store.rs",
        "src/artifact_store/fake.rs",
        "src/artifact_store/local_cas.rs",
        "src/artifact_store/local_cas/filesystem.rs",
        "src/artifact_store/local_cas/operations.rs",
        "src/execution.rs",
        "src/execution/driver.rs",
        "src/execution/local.rs",
        "src/execution/process.rs",
        "src/execution/types.rs",
        "src/fault.rs",
        "src/fault/redaction.rs",
        "src/fault/taxonomy.rs",
        "src/lib.rs",
        "src/main.rs",
        "src/observability.rs",
        "src/provider_value.rs",
        "src/scheduler.rs",
        "src/issue_provider.rs",
        "src/source_code_provider.rs",
        "tests/architecture.rs",
        "tests/artifact_store.rs",
        "tests/backend_boundary.rs",
        "tests/execution_runtime_contract.rs",
        "tests/fault_contract.rs",
        "tests/local_cas.rs",
        "tests/local_execution_runtime.rs",
        "tests/local_process_runner.rs",
        "tests/observability_contract.rs",
        "tests/provider_contracts.rs",
        "tests/provider_bounds.rs",
        "tests/scheduler_contract.rs",
    ] {
        assert!(files.contains(required), "missing product file: {required}");
    }
    for file in files {
        assert!(
            file == "Cargo.toml" || file.ends_with(".rs"),
            "native product must remain Rust-only: {file}"
        );
    }
}

#[test]
fn workspace_metadata_preserves_package_lib_and_bin_identity() {
    let metadata = workspace_metadata();
    assert_eq!(
        metadata["workspace_root"],
        repository_root().to_string_lossy().as_ref()
    );
    let targets = product_package(&metadata)["targets"]
        .as_array()
        .expect("package targets must be an array")
        .iter()
        .map(|target| {
            (
                target["name"].as_str().expect("target name").to_owned(),
                target["kind"][0].as_str().expect("target kind").to_owned(),
            )
        })
        .collect::<BTreeSet<_>>();
    for required in [
        ("zeroshot-rust".to_owned(), "bin".to_owned()),
        ("zeroshot_engine".to_owned(), "lib".to_owned()),
        ("architecture".to_owned(), "test".to_owned()),
        ("backend_boundary".to_owned(), "test".to_owned()),
        ("execution_runtime_contract".to_owned(), "test".to_owned()),
        ("fault_contract".to_owned(), "test".to_owned()),
        ("local_execution_runtime".to_owned(), "test".to_owned()),
        ("local_process_runner".to_owned(), "test".to_owned()),
        ("observability_contract".to_owned(), "test".to_owned()),
        ("scheduler_contract".to_owned(), "test".to_owned()),
    ] {
        assert!(
            targets.contains(&required),
            "missing durable target: {required:?}"
        );
    }
    assert_eq!(
        targets
            .iter()
            .filter(|(_, kind)| kind == "bin" || kind == "lib")
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            ("zeroshot-rust".to_owned(), "bin".to_owned()),
            ("zeroshot_engine".to_owned(), "lib".to_owned()),
        ]),
        "product package must retain exactly one library and one executable"
    );
}

#[test]
fn product_dependencies_stay_inside_native_contract_and_backend_boundaries() {
    let metadata = workspace_metadata();
    let dependencies = product_package(&metadata)["dependencies"]
        .as_array()
        .expect("dependencies must be an array")
        .iter()
        .map(|dependency| {
            (
                dependency["name"]
                    .as_str()
                    .expect("dependency name")
                    .to_owned(),
                dependency["kind"].as_str().unwrap_or("normal").to_owned(),
            )
        })
        .collect::<BTreeSet<_>>();
    for required in [
        (
            "openengine-cluster-protocol".to_owned(),
            "normal".to_owned(),
        ),
        ("openengine-cluster-server".to_owned(), "normal".to_owned()),
        ("rust_decimal".to_owned(), "normal".to_owned()),
        ("rusqlite".to_owned(), "normal".to_owned()),
        ("serde".to_owned(), "normal".to_owned()),
        ("sha2".to_owned(), "normal".to_owned()),
    ] {
        assert!(
            dependencies.contains(&required),
            "missing native dependency: {required:?}"
        );
    }
    for prohibited in [
        "openengine-cluster-client",
        "openengine-cluster-testkit",
        "postgres",
        "sqlx",
        "diesel",
        "reqwest",
        "hyper",
    ] {
        assert!(
            dependencies.iter().all(|(name, _)| name != prohibited),
            "prohibited native dependency: {prohibited}"
        );
    }
}

#[test]
fn runtime_reuses_the_protocol_backend_and_production_dispatcher() {
    let runtime = runtime_source();
    for required in [
        "openengine_cluster_protocol",
        "ClusterBackend",
        "ConnectionContext",
        "InitializeResult",
        "GetResult",
        "openengine_cluster_server",
        "Dispatcher",
        "NativeBackendFactory",
    ] {
        assert!(
            runtime.contains(required),
            "missing shared seam: {required}"
        );
    }
}

#[test]
fn runtime_does_not_copy_protocol_or_server_types() {
    let runtime = runtime_source();
    for copied_type in [
        "struct JsonRpc",
        "enum JsonRpc",
        "struct Dispatcher",
        "struct ConnectionContext",
        "struct InitializeParams",
        "struct GetParams",
        "struct ClusterStatus",
        "struct ServerCapabilities",
    ] {
        assert!(
            !runtime.contains(copied_type),
            "product must not copy protocol/server type: {copied_type}"
        );
    }
}

#[test]
fn runtime_has_no_alternate_runtime_seams() {
    let runtime = runtime_source();
    for forbidden_code in [
        "std::process",
        "Command::new",
        "pub mod transport",
        "pub mod client",
        "conformance_runner",
        "trait BackendFactory",
        "struct BackendFactory",
        ".zeroshot",
    ] {
        assert!(
            !runtime.contains(forbidden_code),
            "forbidden product coupling: {forbidden_code}"
        );
    }
}

#[test]
fn runtime_has_no_future_product_concerns() {
    let words = runtime_source()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<BTreeSet<_>>();
    for forbidden_word in [
        "node",
        "npm",
        "javascript",
        "config",
        "migration",
        "fallback",
        "benchmark",
        "selector",
        "transport",
        "daemon",
        "persistence",
        "verifier",
    ] {
        assert!(
            !words.contains(forbidden_word),
            "forbidden future product concern: {forbidden_word}"
        );
    }
}

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

#[test]
fn artifact_storage_stays_product_private_and_receipts_stay_byte_free() {
    let product = product_root();
    let repository = repository_root();
    let artifact_contract =
        read(&repository.join("crates/openengine-cluster-protocol/src/artifact.rs"));
    for forbidden in [
        "Vec<u8>",
        "AsyncRead",
        "PathBuf",
        "StagedArtifact",
        "ArtifactStore",
        "signed_url",
        "download_url",
        "storage_root",
        "manifest_path",
    ] {
        assert!(
            !artifact_contract.contains(forbidden),
            "protocol artifact receipt exposed storage detail: {forbidden}"
        );
    }

    for relative in [
        "protocol/openengine-cluster/v1/schema.json",
        "protocol/openengine-cluster/v1/worker.schema.json",
        "protocol/openengine-cluster/v1/fixtures/graph/positive/artifact-ref.json",
    ] {
        let projection = read(&repository.join(relative));
        for forbidden in [
            "localPath",
            "signedUrl",
            "downloadUrl",
            "storageRoot",
            "stagePath",
            "manifestPath",
        ] {
            assert!(
                !projection.contains(forbidden),
                "generated artifact projection exposed storage detail: {relative}: {forbidden}"
            );
        }
    }

    let lib = read(&product.join("src/lib.rs"));
    assert!(
        lib.contains("pub struct NativeBackend;"),
        "NativeBackend must remain uninjected until composition issue #693"
    );
    assert!(!lib.contains("ArtifactStore>"));
    assert!(!lib.contains("artifact_store:"));

    let lifecycle_and_backend = format!(
        "{}\n{}\n{}",
        read(&repository.join("crates/openengine-cluster-protocol/src/lifecycle.rs")),
        read(&repository.join("crates/openengine-cluster-server/src/lifecycle.rs")),
        read(&repository.join("crates/openengine-cluster-server/src/lib.rs"))
    );
    for forbidden in [
        "StagedArtifact",
        "ArtifactByteStream",
        "LocalCasArtifactStore",
        "manifest_path",
        "storage_root",
        "signed_url",
        "download_url",
    ] {
        assert!(
            !lifecycle_and_backend.contains(forbidden),
            "lifecycle/backend parameter exposed artifact storage detail: {forbidden}"
        );
    }
}

#[test]
fn provider_contracts_add_no_ledger_workspace_worker_protocol_adapter_or_fault_behavior() {
    let product = product_root();
    let provider_value = rust_sources(&["src/provider_value.rs", "src/provider_value"]);
    let contracts = rust_sources(&[
        "src/issue_provider.rs",
        "src/issue_provider",
        "src/source_code_provider.rs",
        "src/source_code_provider",
    ]);
    assert!(
        read(&product.join("src/lib.rs")).contains("mod provider_value;"),
        "bounded provider helpers must remain product-private"
    );
    for forbidden in [
        "pub trait Provider",
        "PlatformProfile",
        "ChangeProvider",
        "CommonProviderId",
    ] {
        assert!(
            !provider_value.contains(forbidden),
            "provider_value must not expose a common provider abstraction: {forbidden}"
        );
    }
    for forbidden in [
        "ClusterLedger",
        "rusqlite",
        "WorkspaceLease",
        "WorkerRegistry",
        "WorkerProvider",
        "EngineFault",
        "openengine_cluster_protocol",
        "openengine_cluster_server",
        "Adapter",
    ] {
        assert!(
            !contracts.contains(forbidden),
            "provider contracts crossed an owned boundary: {forbidden}"
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
