#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/slice.rs"]
mod slice;

#[path = "support/json_insert.rs"]
mod json_insert;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    ApplyParams, Generation, GraphDiff, IdempotencyKey, PayloadType, PlanParams,
};
use serde_json::json;

fn graph() -> serde_json::Value {
    json!({
        "profile": "openengine.graph.single-worker/v1",
        "initialInput": {
            "kind": "record",
            "fields": {
                "count": { "type": { "kind": "integer" }, "required": true },
                "label": { "type": { "kind": "string" }, "required": false }
            }
        },
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "step", "name": "worker", "worker": "legacy.zeroshot.ship@1",
            "input": { "kind": "null" }, "output": { "kind": "null" },
            "inputBindings": [], "writeBindings": [], "timeoutMs": 1000, "attempts": 1
        }
    })
}

#[test]
fn admission_params_are_closed_named_wire_objects() {
    let plan: PlanParams = serde_json::from_value(json!({ "graph": graph() })).assert_value();
    assert_eq!(
        serde_json::to_value(plan).assert_value(),
        json!({ "graph": graph() })
    );

    let apply: ApplyParams = serde_json::from_value(json!({
        "graph": graph(),
        "input": { "label": "ready", "count": 1 },
        "ifGeneration": 0,
        "idempotencyKey": "request-1"
    }))
    .assert_value();
    assert!(!apply.dry_run);
    assert_eq!(apply.if_generation, Some(Generation::new(0).assert_value()));
    assert!(
        serde_json::from_value::<ApplyParams>(json!({
            "graph": graph(), "unknown": true
        }))
        .is_err()
    );
    for field in ["ifGeneration", "idempotencyKey"] {
        let mut value = json!({"graph":graph()});
        json_insert::json_insert(&mut value, "", field, serde_json::Value::Null);
        assert!(
            serde_json::from_value::<ApplyParams>(value.clone()).is_err(),
            "accepted explicit null {field}"
        );
        let schema = serde_json::to_value(schemars::schema_for!(ApplyParams)).assert_value();
        assert!(
            !jsonschema::validator_for(&schema)
                .assert_value()
                .is_valid(&value),
            "schema accepted explicit null {field}"
        );
    }
}

#[test]
fn idempotency_keys_are_non_empty_and_bounded() {
    assert!(IdempotencyKey::new("request-1").is_ok());
    assert!(IdempotencyKey::new("").is_err());
    assert!(IdempotencyKey::new("x".repeat(257)).is_err());
    assert!(serde_json::from_value::<IdempotencyKey>(json!("")).is_err());
}

#[test]
fn closed_payload_validation_rejects_missing_extra_and_wrong_values() {
    let graph: openengine_cluster_protocol::GraphSpec =
        serde_json::from_value(graph()).assert_value();
    let payload = &graph.initial_input;
    payload
        .validate_value(&json!({ "count": 2, "label": "ok" }))
        .assert_value();
    payload
        .validate_value(&json!({ "count": 2.0 }))
        .assert_value();
    assert!(
        payload
            .validate_value(&json!({ "label": "missing" }))
            .is_err()
    );
    assert!(
        payload
            .validate_value(&json!({ "count": 1, "extra": true }))
            .is_err()
    );
    assert!(payload.validate_value(&json!({ "count": 1.5 })).is_err());
    assert!(PayloadType::Number.validate_value(&json!(1.5)).is_ok());
}

#[test]
fn graph_diff_wire_order_is_explicit() {
    let diff: GraphDiff = serde_json::from_value(json!({
        "added": ["alpha"], "removed": ["beta"], "changed": ["gamma"]
    }))
    .assert_value();
    assert_eq!(slice::slice_at(&diff.added, 0).as_str(), "alpha");
}
