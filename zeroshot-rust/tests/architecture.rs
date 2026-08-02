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
    assert!(
        !product.join("build.rs").exists(),
        "native product must not add an unowned build script"
    );
    assert!(!read(&product.join("Cargo.toml")).contains("[workspace]"));

    let mut files = BTreeSet::new();
    relative_files(&product, &product, &mut files);
    for file in files {
        assert!(
            file == "Cargo.toml" || file.ends_with(".rs"),
            "native product must remain Rust-only: {file}"
        );
    }
}

#[test]
fn product_contains_the_required_native_files() {
    let product = product_root();
    let mut files = BTreeSet::new();
    relative_files(&product, &product, &mut files);
    for required in [
        "Cargo.toml",
        "src/admission_manifest.rs",
        "src/artifact_store.rs",
        "src/artifact_store/fake.rs",
        "src/artifact_store/local_cas.rs",
        "src/artifact_store/local_cas/filesystem.rs",
        "src/artifact_store/local_cas/operations.rs",
        "src/daemon_auth.rs",
        "src/daemon_discovery.rs",
        "src/daemon_listener.rs",
        "src/execution.rs",
        "src/execution/driver.rs",
        "src/execution/local.rs",
        "src/execution/process.rs",
        "src/execution/types.rs",
        "src/fault.rs",
        "src/fault/redaction.rs",
        "src/fault/taxonomy.rs",
        "src/product_errors.rs",
        "src/lib.rs",
        "src/main.rs",
        "src/observability.rs",
        "src/provider_value.rs",
        "src/required_proof.rs",
        "src/role_contract.rs",
        "src/scheduler.rs",
        "src/issue_provider.rs",
        "src/native_credentials.rs",
        "src/native_credentials/fake.rs",
        "src/native_credentials/lease.rs",
        "src/native_credentials/material.rs",
        "src/native_credentials/resolver.rs",
        "src/native_credentials/source.rs",
        "src/native_settings.rs",
        "src/native_settings/paths.rs",
        "src/native_settings/profile.rs",
        "src/native_settings/resolve.rs",
        "src/source_code_provider.rs",
        "src/workspace_lease.rs",
        "src/workspace_lease/adapters.rs",
        "src/workspace_lease/borrowed.rs",
        "src/workspace_lease/manager.rs",
        "src/workspace_lease/resource.rs",
        "src/workspace_lease/resource/fake.rs",
        "src/workspace_lease/store.rs",
        "src/workspace_lease/store/fake.rs",
        "src/workspace_lease/store/sqlite.rs",
        "src/workspace_lease/types.rs",
        "src/worker_bindings.rs",
        "src/worker_catalog.rs",
        "tests/architecture.rs",
        "tests/worker_catalog_architecture.rs",
        "tests/role_contracts.rs",
        "tests/role_contracts_architecture.rs",
        "tests/required_proof_architecture.rs",
        "tests/admission_manifest.rs",
        "tests/admission_manifest_architecture.rs",
        "tests/worker_bindings.rs",
        "tests/worker_bindings_architecture.rs",
        "tests/artifact_store.rs",
        "tests/backend_boundary.rs",
        "tests/credential_resolution.rs",
        "tests/credential_lifecycle.rs",
        "tests/native_credentials_architecture.rs",
        "tests/execution_scheduler_architecture.rs",
        "tests/artifact_storage_architecture.rs",
        "tests/provider_contracts_architecture.rs",
        "tests/full_v1_reducer_architecture.rs",
        "tests/native_daemon_architecture.rs",
        "tests/execution_runtime_contract.rs",
        "tests/daemon_auth.rs",
        "tests/daemon_discovery.rs",
        "tests/daemon_listener.rs",
        "tests/fault_contract.rs",
        "tests/local_cas.rs",
        "tests/local_execution_runtime.rs",
        "tests/local_process_runner.rs",
        "tests/namespace_isolation.rs",
        "tests/native_config.rs",
        "tests/native_profiles.rs",
        "tests/observability_contract.rs",
        "tests/provider_contracts.rs",
        "tests/product_errors.rs",
        "tests/required_proof_contract.rs",
        "tests/provider_bounds.rs",
        "tests/source_authority_contract.rs",
        "tests/scheduler_contract.rs",
        "tests/worker_catalog.rs",
        "tests/workspace_leases.rs",
        "tests/workspace_modes.rs",
        "tests/workspace_recovery.rs",
    ] {
        assert!(files.contains(required), "missing product file: {required}");
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
        ("admission_manifest".to_owned(), "test".to_owned()),
        (
            "admission_manifest_architecture".to_owned(),
            "test".to_owned(),
        ),
        ("worker_bindings".to_owned(), "test".to_owned()),
        ("worker_bindings_architecture".to_owned(), "test".to_owned()),
        ("architecture".to_owned(), "test".to_owned()),
        ("backend_boundary".to_owned(), "test".to_owned()),
        ("credential_resolution".to_owned(), "test".to_owned()),
        ("credential_lifecycle".to_owned(), "test".to_owned()),
        (
            "native_credentials_architecture".to_owned(),
            "test".to_owned(),
        ),
        (
            "execution_scheduler_architecture".to_owned(),
            "test".to_owned(),
        ),
        (
            "artifact_storage_architecture".to_owned(),
            "test".to_owned(),
        ),
        (
            "provider_contracts_architecture".to_owned(),
            "test".to_owned(),
        ),
        ("full_v1_reducer_architecture".to_owned(), "test".to_owned()),
        ("native_daemon_architecture".to_owned(), "test".to_owned()),
        ("execution_runtime_contract".to_owned(), "test".to_owned()),
        ("fault_contract".to_owned(), "test".to_owned()),
        ("local_execution_runtime".to_owned(), "test".to_owned()),
        ("local_process_runner".to_owned(), "test".to_owned()),
        ("observability_contract".to_owned(), "test".to_owned()),
        ("source_authority_contract".to_owned(), "test".to_owned()),
        ("required_proof_contract".to_owned(), "test".to_owned()),
        ("required_proof_architecture".to_owned(), "test".to_owned()),
        ("role_contracts".to_owned(), "test".to_owned()),
        ("role_contracts_architecture".to_owned(), "test".to_owned()),
        ("scheduler_contract".to_owned(), "test".to_owned()),
        ("workspace_leases".to_owned(), "test".to_owned()),
        ("workspace_modes".to_owned(), "test".to_owned()),
        ("workspace_recovery".to_owned(), "test".to_owned()),
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
fn product_errors_are_one_private_projection_without_command_or_daemon_host_behavior() {
    let projection = read(&product_root().join("src/product_errors.rs"));
    for required in [
        "ProductErrorCode",
        "from_engine_fault",
        "from_protocol_error",
        "from_backend_error",
        "deny_unknown_fields",
        "exit_status",
        "daemon_control",
        "render_text",
        "render_json",
    ] {
        assert!(
            projection.contains(required),
            "missing product error projection boundary: {required}"
        );
    }
    for forbidden in [
        "fault.sources()",
        "error.message",
        "error.details",
        "RawDiagnostic",
        "Command::new",
        "TcpListener",
        "WebSocket",
        "clap",
        "Exporter",
        "telemetry",
        "retry(",
    ] {
        assert!(
            !projection.contains(forbidden),
            "product error projection crossed a non-goal boundary: {forbidden}"
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

#[test]
fn workspace_leases_cannot_mutate_graph_outcomes() {
    let leases = rust_sources(&["src/workspace_lease.rs", "src/workspace_lease"]);
    for forbidden in [
        "ClusterLedger",
        "CommitRequest",
        "MutationIdentity",
        "RecordPayload",
        "ExecutionVoid",
        "TerminalProjection",
        "full_v1_reducer",
        "crate::scheduler",
    ] {
        assert!(
            !leases.contains(forbidden),
            "workspace leases imported graph outcome authority: {forbidden}"
        );
    }
}

#[test]
fn product_modules_require_issue_authorization() {
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
        BTreeSet::from([
            "admission_manifest.rs",
            "artifact_store",
            "artifact_store.rs",
            "cluster_ledger",
            "cluster_ledger.rs",
            "daemon_auth.rs",
            "daemon_discovery.rs",
            "daemon_listener.rs",
            "execution",
            "execution.rs",
            "fault",
            "fault.rs",
            "full_v1_reducer.rs",
            "issue_provider",
            "issue_provider.rs",
            "lib.rs",
            "main.rs",
            "native_credentials",
            "native_credentials.rs",
            "native_settings",
            "native_settings.rs",
            "observability.rs",
            "product_errors.rs",
            "provider_value",
            "provider_value.rs",
            "required_proof.rs",
            "role_contract.rs",
            "scheduler.rs",
            "source_code_provider",
            "source_code_provider.rs",
            "worker_bindings.rs",
            "worker_catalog.rs",
            "workspace_lease",
            "workspace_lease.rs",
        ]),
        "new product modules require an issue-authorized architecture amendment"
    );
}
