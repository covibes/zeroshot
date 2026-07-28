use std::sync::Arc;

use openengine_cluster_protocol::{
    GraphProfileSet, InitializeParams, LogEventNotification, ServerCapabilities, PROTOCOL_VERSION,
};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::logs::LogStore;
use openengine_cluster_server::{ClusterBackend, ConnectionContext};
use openengine_cluster_testkit::admission::{InMemoryAdmissionStore, ScriptedVerifier};
use openengine_cluster_testkit::capability_vectors::assert_logs_capability;
use openengine_cluster_testkit::logs::InMemoryLogStore;

#[path = "schema_support/mod.rs"]
mod schema_support;
use schema_support::find_schema;

fn initialize_params() -> InitializeParams {
    InitializeParams {
        protocol_version: PROTOCOL_VERSION.to_owned(),
    }
}

#[tokio::test]
async fn logs_capability_is_true_only_when_a_log_store_is_injected() {
    let plain = AdmissionCoordinator::new(
        ScriptedVerifier::new(vec![]),
        InMemoryAdmissionStore::default(),
    );
    let plain_capabilities = plain
        .initialize(&ConnectionContext::default(), initialize_params())
        .await
        .unwrap()
        .capabilities;
    assert_logs_capability(&plain_capabilities, false);

    let with_store = AdmissionCoordinator::new(
        ScriptedVerifier::new(vec![]),
        InMemoryAdmissionStore::default(),
    )
    .with_log_store(Arc::new(InMemoryLogStore::default()) as Arc<dyn LogStore>);
    let with_store_capabilities = with_store
        .initialize(&ConnectionContext::default(), initialize_params())
        .await
        .unwrap()
        .capabilities;
    assert_logs_capability(&with_store_capabilities, true);
}

#[test]
fn logs_capability_vector_matches_server_capabilities() {
    let disabled = ServerCapabilities {
        graph_profiles: GraphProfileSet::new(vec![]).unwrap(),
        logs: false,
        agent_attach: false,
    };
    assert_logs_capability(&disabled, false);

    let enabled = ServerCapabilities {
        graph_profiles: GraphProfileSet::new(vec![]).unwrap(),
        logs: true,
        agent_attach: false,
    };
    assert_logs_capability(&enabled, true);
}

#[tokio::test]
async fn generated_logs_goldens_validate_against_the_published_schema() {
    let artifacts = openengine_cluster_testkit::artifacts::generate_artifacts().await;
    let schema = find_schema(&artifacts);
    let mut event_schema = schema["$defs"]["LogEventNotification"].clone();
    event_schema["$defs"] = schema["$defs"].clone();
    let event_validator = jsonschema::validator_for(&event_schema).unwrap();

    let session = artifacts
        .iter()
        .find(|artifact| {
            artifact
                .relative_path
                .ends_with("/goldens/logs-session.json")
        })
        .unwrap();
    let notifications: Vec<LogEventNotification> = serde_json::from_slice(&session.bytes).unwrap();
    assert!(!notifications.is_empty());
    for notification in &notifications {
        let value = serde_json::to_value(notification).unwrap();
        assert!(
            event_validator.is_valid(&value),
            "generated log event notification failed schema validation: {value}"
        );
    }
}
