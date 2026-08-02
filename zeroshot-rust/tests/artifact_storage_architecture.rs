#[path = "support/architecture_boundary_macro.rs"]
mod architecture_boundary_macro;
#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_root, read, repository_root};
architecture_boundary_macro::suppress_unused_architecture_exports!(
    architecture_support,
    relative_files,
    workspace_metadata,
    product_package,
    runtime_source,
    rust_sources,
);

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
