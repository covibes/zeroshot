#[path = "support/architecture_boundary_macro.rs"]
mod architecture_boundary_macro;
#[path = "support/architecture.rs"]
mod architecture_support;

use architecture_support::{product_root, read};
architecture_boundary_macro::suppress_single_test_boundary_unused_exports!(architecture_support);

#[test]
fn worker_bindings_adds_no_concrete_driver_or_transport_implementation() {
    let source = read(&product_root().join("src/worker_bindings.rs"));
    for forbidden in [
        "struct CliProcessDriver",
        "struct AcpStdioDriver",
        "struct GatewayDriver",
        "impl WorkerDriver",
        "Command::new",
        "reqwest",
        "hyper",
        "std::process",
        "tokio::net",
    ] {
        assert!(
            !source.contains(forbidden),
            "worker binding compiler crossed its owned boundary: {forbidden}"
        );
    }
}
