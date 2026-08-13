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
            file == "Cargo.toml"
                || file.ends_with(".rs")
                || matches!(
                    file.as_str(),
                    "hosted-node/capsule-entrypoint.js"
                        | "hosted-node/config-check.js"
                        | "hosted-node/declarative-cluster.js"
                        | "hosted-node/engine-adapter.js"
                        | "hosted-node/git-askpass.js"
                        | "hosted-node/hosted-config.js"
                        | "hosted-node/issue-hydration.js"
                        | "hosted-node/runtime-capability.js"
                        | "hosted-node/worker-launcher.js"
                        | "hosted-node/worker.js"
                        | "hosted-node/workspace-bootstrap.js"
                        | "hosted-node/workspace-delivery-github.js"
                        | "hosted-node/workspace-ship.js"
                        | "hosted-node/workspace-tools.js"
                ),
            "native product may contain only Rust or the issue-authorized private hosted adapter: {file}"
        );
    }
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
    assert!(
        !dependencies.contains(&("openengine-cluster-client".to_owned(), "normal".to_owned())),
        "cluster client is test-only and must not enter the native runtime"
    );
    assert!(
        dependencies.contains(&("openengine-cluster-client".to_owned(), "dev".to_owned())),
        "the process proof must use the real Rust cluster client"
    );
}

#[test]
fn runtime_reuses_the_protocol_backend_and_production_dispatcher() {
    let runtime = rust_sources(&["src/lib.rs", "src/main.rs", "src/native_admission.rs"]);
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
fn production_composition_cannot_call_debug_reducer_fixtures() {
    let runtime = rust_sources(&[
        "src/lib.rs",
        "src/main.rs",
        "src/native_admission.rs",
        "src/native_execution.rs",
        "src/native_execution",
    ]);
    for fixture in ["dispatch_reduction_fixture", "terminalize_fixture"] {
        assert!(
            !runtime.contains(fixture),
            "production composition referenced debug fixture: {fixture}"
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
        "persistence",
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
fn manifest_keeps_the_cluster_client_dev_only_and_excludes_testkit_or_node() {
    let manifest = read(&product_root().join("Cargo.toml"));
    let (runtime, dev) = manifest
        .split_once("[dev-dependencies]")
        .expect("native manifest must declare dev dependencies");
    assert!(!runtime.contains("openengine-cluster-client"));
    assert!(dev.contains("openengine_cluster_client.workspace = true"));
    for forbidden_dependency in ["openengine-cluster-testkit", "node", "npm"] {
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
            "bin",
            "artifact_store",
            "artifact_store.rs",
            "cluster_ledger",
            "cluster_ledger.rs",
            "daemon_auth.rs",
            "daemon_discovery.rs",
            "daemon_listener",
            "daemon_listener.rs",
            "execution",
            "execution.rs",
            "fault",
            "fault.rs",
            "full_v1_reducer",
            "full_v1_reducer.rs",
            "hosted_oecp",
            "issue_provider",
            "issue_provider.rs",
            "lib.rs",
            "main.rs",
            "native_credentials",
            "native_credentials.rs",
            "native_admission.rs",
            "native_execution",
            "native_execution.rs",
            "native_settings",
            "native_settings.rs",
            "native_worker_protocol.rs",
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
            "worker_catalog",
            "worker_catalog.rs",
            "workspace_lease",
            "workspace_lease.rs",
        ]),
        "new product modules require an issue-authorized architecture amendment"
    );
}
