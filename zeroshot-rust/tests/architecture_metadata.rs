use std::collections::BTreeSet;

#[path = "support/architecture.rs"]
pub mod architecture_support;

use architecture_support::{
    product_package, product_root, relative_files, repository_root, workspace_metadata,
};

const REQUIRED_NATIVE_FILES: &[&str] = &[
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
    "src/execution/process/session_runtime.rs",
    "src/execution/process/spawn_recovery.rs",
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
    "tests/architecture_metadata.rs",
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
    "tests/support/process_runner.rs",
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
];

fn product_targets(metadata: &serde_json::Value) -> BTreeSet<(String, String)> {
    product_package(metadata)["targets"]
        .as_array()
        .expect("package targets must be an array")
        .iter()
        .map(|target| {
            (
                target["name"].as_str().expect("target name").to_owned(),
                target["kind"][0].as_str().expect("target kind").to_owned(),
            )
        })
        .collect::<BTreeSet<_>>()
}

#[test]
fn product_contains_the_required_native_files() {
    let product = product_root();
    let mut files = BTreeSet::new();
    relative_files(&product, &product, &mut files);
    for &required in REQUIRED_NATIVE_FILES {
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
    let targets = product_targets(&metadata);
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
        ("architecture_metadata".to_owned(), "test".to_owned()),
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
            ("zeroshot-oecp-server".to_owned(), "bin".to_owned()),
            ("zeroshot-rust".to_owned(), "bin".to_owned()),
            ("zeroshot_engine".to_owned(), "lib".to_owned()),
        ]),
        "product package must retain its library and issue-authorized executables"
    );
}
