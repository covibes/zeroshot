use openengine_cluster_protocol::{AgentAttachEventNotification, GraphProfileSet, ServerCapabilities};
use openengine_cluster_testkit::capability_vectors::assert_agent_attach_capability;

#[path = "schema_support/mod.rs"]
mod schema_support;
use schema_support::find_schema;

#[test]
fn agent_attach_capability_vector_matches_server_capabilities() {
    let disabled = ServerCapabilities {
        graph_profiles: GraphProfileSet::new(vec![]).assert_value(),
        logs: false,
        agent_attach: false,
    };
    assert_agent_attach_capability(&disabled, false);

    let enabled = ServerCapabilities {
        graph_profiles: GraphProfileSet::new(vec![]).assert_value(),
        logs: false,
        agent_attach: true,
    };
    assert_agent_attach_capability(&enabled, true);
}

#[tokio::test]
async fn generated_agent_attach_goldens_validate_against_the_published_schema() {
    let artifacts = openengine_cluster_testkit::artifacts::generate_artifacts().await;
    let schema = find_schema(&artifacts);
    let mut event_schema = schema
        .assert_key("$defs")
        .assert_key("AgentAttachEventNotification")
        .clone();
    event_schema
        .as_object_mut()
        .assert_value()
        .insert("$defs".to_owned(), schema.assert_key("$defs").clone());
    let event_validator = jsonschema::validator_for(&event_schema).assert_value();

    let session = artifacts
        .iter()
        .find(|artifact| {
            artifact
                .relative_path
                .ends_with("/goldens/agent-attach-session.json")
        })
        .assert_value();
    let notifications: Vec<AgentAttachEventNotification> =
        serde_json::from_slice(&session.bytes).assert_value();
    assert!(!notifications.is_empty());
    for notification in &notifications {
        let value = serde_json::to_value(notification).assert_value();
        assert!(
            event_validator.is_valid(&value),
            "generated agent attach event notification failed schema validation: {value}"
        );
    }
}

#[tokio::test]
async fn generated_agent_attach_fixtures_validate_against_the_published_schema() {
    let artifacts = openengine_cluster_testkit::artifacts::generate_artifacts().await;
    let schema = find_schema(&artifacts);

    let checks = [
        ("agent-attach-params.json", "AgentAttachParams"),
        ("agent-attach-closed.json", "AgentAttachClosedNotification"),
        ("agent-attach-event.json", "AgentAttachEvent"),
    ];
    for (file_name, def_name) in checks {
        let mut def_schema = schema
            .assert_key("$defs")
            .get(def_name)
            .assert_value()
            .clone();
        assert!(
            !def_schema.is_null(),
            "schema.json is missing $defs/{def_name}"
        );
        def_schema
            .as_object_mut()
            .assert_value()
            .insert("$defs".to_owned(), schema.assert_key("$defs").clone());
        let validator = jsonschema::validator_for(&def_schema).assert_value();

        let artifact = artifacts
            .iter()
            .find(|artifact| {
                artifact
                    .relative_path
                    .ends_with(&format!("/fixtures/agent_attach/{file_name}"))
            })
            .assert_value_with(&format!("missing fixtures/agent_attach/{file_name}"));
        let value: serde_json::Value = serde_json::from_slice(&artifact.bytes).assert_value();
        let values = value.as_array().cloned().unwrap_or_else(|| vec![value]);
        for value in values {
            assert!(
                validator.is_valid(&value),
                "{file_name} entry failed schema validation against {def_name}: {value}"
            );
        }
    }
}

use openengine_cluster_testkit::assertions::{AssertValue, JsonAt};
