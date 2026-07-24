use openengine_cluster_protocol::{GraphProfile, GraphProfilesError, ServerCapabilities};
use serde_json::json;

fn capabilities_of(profiles: Vec<GraphProfile>) -> ServerCapabilities {
    ServerCapabilities {
        graph_profiles: openengine_cluster_protocol::GraphProfileSet::new(profiles).unwrap(),
        logs: false,
    }
}

#[test]
fn empty_capabilities_round_trip() {
    let value = capabilities_of(vec![]);
    let json = serde_json::to_value(&value).unwrap();
    assert_eq!(json, json!({ "graphProfiles": [], "logs": false }));
    let parsed: ServerCapabilities = serde_json::from_value(json).unwrap();
    assert_eq!(parsed, value);
}

#[test]
fn single_worker_capabilities_round_trip() {
    let value = capabilities_of(vec![GraphProfile::SingleWorker]);
    let json = serde_json::to_value(&value).unwrap();
    assert_eq!(
        json,
        json!({ "graphProfiles": ["openengine.graph.single-worker/v1"], "logs": false })
    );
    let parsed: ServerCapabilities = serde_json::from_value(json).unwrap();
    assert_eq!(parsed, value);
}

#[test]
fn full_v1_capabilities_round_trip() {
    let value = capabilities_of(vec![GraphProfile::Full, GraphProfile::SingleWorker]);
    let json = serde_json::to_value(&value).unwrap();
    assert_eq!(
        json,
        json!({
            "graphProfiles": [
                "openengine.graph.full/v1",
                "openengine.graph.single-worker/v1"
            ],
            "logs": false
        })
    );
    let parsed: ServerCapabilities = serde_json::from_value(json).unwrap();
    assert_eq!(parsed, value);
}

#[test]
fn duplicate_profiles_are_rejected() {
    let error = openengine_cluster_protocol::GraphProfileSet::new(vec![
        GraphProfile::SingleWorker,
        GraphProfile::SingleWorker,
    ])
    .unwrap_err();
    assert_eq!(error, GraphProfilesError::Duplicate);
}

#[test]
fn reversed_declaration_order_is_rejected() {
    let error = openengine_cluster_protocol::GraphProfileSet::new(vec![
        GraphProfile::SingleWorker,
        GraphProfile::Full,
    ])
    .unwrap_err();
    assert_eq!(error, GraphProfilesError::Unordered);
}

#[test]
fn unknown_profile_string_fails_deserialization() {
    let json = json!({ "graphProfiles": ["openengine.graph.unknown/v1"] });
    assert!(serde_json::from_value::<ServerCapabilities>(json).is_err());
}

#[test]
fn json_schema_matches_canonical_profile_order() {
    let schema = serde_json::to_value(schemars::schema_for!(ServerCapabilities)).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();

    for graph_profiles in [
        json!([]),
        json!(["openengine.graph.full/v1"]),
        json!(["openengine.graph.single-worker/v1"]),
        json!([
            "openengine.graph.full/v1",
            "openengine.graph.single-worker/v1"
        ]),
    ] {
        let value = json!({ "graphProfiles": graph_profiles });
        assert!(validator.is_valid(&value), "schema rejected {value}");
    }

    for graph_profiles in [
        json!([
            "openengine.graph.single-worker/v1",
            "openengine.graph.full/v1"
        ]),
        json!(["openengine.graph.full/v1", "openengine.graph.full/v1"]),
        json!(["openengine.graph.unknown/v1"]),
    ] {
        let value = json!({ "graphProfiles": graph_profiles });
        assert!(!validator.is_valid(&value), "schema accepted {value}");
    }
}

#[test]
fn missing_field_defaults_to_empty() {
    let value: ServerCapabilities = serde_json::from_value(json!({})).unwrap();
    assert_eq!(value, capabilities_of(vec![]));
}

#[test]
fn extra_field_is_rejected() {
    let json = json!({ "graphProfiles": [], "unknownField": true });
    assert!(serde_json::from_value::<ServerCapabilities>(json).is_err());
}
