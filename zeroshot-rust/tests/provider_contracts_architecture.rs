#[path = "support/architecture_boundary_macro.rs"]
mod architecture_boundary_macro;
#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_root, read, rust_sources};
architecture_boundary_macro::suppress_unused_architecture_exports!(
    architecture_support,
    repository_root,
    relative_files,
    workspace_metadata,
    product_package,
    runtime_source,
);

#[test]
fn provider_contracts_remain_provider_neutral_and_effect_free() {
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
    assert!(
        contracts.contains("pub struct SourceWorkspaceCapability<'a>")
            && contracts.contains("pub(crate) fn from_verified")
            && contracts.contains("pub unsafe fn from_verified_contract_test")
            && !contracts.contains("pub mod fake"),
        "safe callers must receive workspace capabilities only from verified product state"
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
        "rusqlite",
        "EngineFault",
        "openengine_cluster_protocol",
        "openengine_cluster_server",
        "std::process",
        "reqwest",
    ] {
        assert!(
            !contracts.contains(forbidden),
            "provider contracts crossed an owned boundary: {forbidden}"
        );
    }
}
