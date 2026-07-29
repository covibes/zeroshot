#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_root, read, rust_sources};
const _: fn() -> std::path::PathBuf = architecture_support::repository_root;
const _: fn() -> serde_json::Value = architecture_support::workspace_metadata;
const _: for<'a> fn(&'a serde_json::Value) -> &'a serde_json::Value =
    architecture_support::product_package;
const _: fn() -> String = architecture_support::runtime_source;

#[test]
fn required_proof_contract_stays_product_private_byte_free_and_non_executing() {
    let product = product_root();
    let proof = read(&product.join("src/required_proof.rs"));
    let ledger = rust_sources(&["src/cluster_ledger.rs", "src/cluster_ledger"]);
    let protocol = rust_sources(&[
        "../crates/openengine-cluster-protocol/src",
        "../crates/openengine-cluster-server/src",
    ]);
    assert!(read(&product.join("src/lib.rs")).contains("pub mod required_proof;"));
    for required in [
        "struct TrustedGate",
        "struct ProofAttemptIntent",
        "struct ProofAttemptReceipt",
        "struct AcceptedProofRef",
        "trait ArtifactReverification",
        "struct PerformProofAttempt",
        "struct InspectProofAttempt",
        "struct ReconcileProofAttempt",
        "reconcile_after_uncertainty",
    ] {
        assert!(
            proof.contains(required),
            "missing required-proof contract: {required}"
        );
    }
    for required in [
        "RequiredProofIntent",
        "RequiredProofReceipt",
        "RequiredProofAcceptance",
        "required_proofs",
    ] {
        assert!(
            ledger.contains(required),
            "ledger misses required-proof fold: {required}"
        );
    }
    for forbidden in [
        "std::process",
        "tokio::process",
        "Command::new",
        "PathBuf",
        "gh issue",
        "octocrab",
        "reqwest",
        "SourceCodeProvider",
    ] {
        assert!(
            !proof.contains(forbidden),
            "required-proof contract crossed a non-goal boundary: {forbidden}"
        );
    }
    for private_type in [
        "TrustedGate",
        "ProofAttemptIntent",
        "ProofAttemptReceipt",
        "AcceptedProofRef",
        "ArtifactReverification",
    ] {
        assert!(
            !protocol.contains(private_type),
            "product-private proof type leaked into protocol/server: {private_type}"
        );
    }
}
