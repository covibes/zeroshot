use std::fs;
use std::path::PathBuf;

use openengine_cluster_server::method_registry::{MethodKind, METHOD_REGISTRY};
use openengine_cluster_testkit::artifacts::generate_artifacts;
use serde_json::Value;

fn assert_method_surface(document: &Value, source: &str) {
    let methods = document["methods"]
        .as_array()
        .unwrap_or_else(|| panic!("{source} OpenRPC methods must be an array"));
    assert_eq!(
        methods.len(),
        METHOD_REGISTRY.len(),
        "{source} OpenRPC and registry method counts differ"
    );

    for (method, descriptor) in methods.iter().zip(METHOD_REGISTRY) {
        assert_eq!(
            method["name"], descriptor.name,
            "{source} method order drift"
        );
        assert_eq!(
            method["x-subscription"],
            matches!(descriptor.kind, MethodKind::Subscription(_)),
            "{source} subscription metadata drift for {}",
            descriptor.name
        );
        assert_eq!(
            method["x-transport-requirements"]["serverPush"],
            descriptor.transport_requirements.server_push,
            "{source} server-push metadata drift for {}",
            descriptor.name
        );
        assert_eq!(
            method["x-transport-requirements"]["inboundNotifications"],
            descriptor.transport_requirements.inbound_notifications,
            "{source} inbound-notification metadata drift for {}",
            descriptor.name
        );
    }
}

#[tokio::test]
async fn generated_and_committed_openrpc_match_the_server_method_registry() {
    let artifacts = generate_artifacts().await;
    let generated = artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with("/openrpc.json"))
        .expect("generator must emit OpenRPC");
    let generated: Value = serde_json::from_slice(&generated.bytes).unwrap();
    assert_method_surface(&generated, "generated");

    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let committed =
        fs::read(workspace.join("protocol/openengine-cluster/v1/openrpc.json")).unwrap();
    let committed: Value = serde_json::from_slice(&committed).unwrap();
    assert_method_surface(&committed, "committed");
    assert_eq!(generated, committed, "committed OpenRPC artifact drifted");
}
