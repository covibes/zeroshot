#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/json_insert.rs"]
mod json_insert;

#[path = "support/json_read.rs"]
mod json_read;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    RunId, RunListParams, RunListResult, RunStatus, RunStatusResult, RunSubmitParams,
    RunSubmitResult,
};
use serde_json::{json, Value};

fn graph() -> Value {
    serde_json::from_str(
        r#"{
            "profile":"openengine.graph.full/v1",
            "initialInput":{"kind":"null"},
            "policy":{"policy":"policy.native-v2@1","default":"deny"},
            "root":{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        }"#,
    )
    .assert_value()
}

#[test]
fn submit_is_closed_secret_free_and_requires_actual_initial_input() {
    let wire = json!({
        "graph": graph(),
        "initialInput": null,
        "ship": true,
        "submissionKey": "submission-1"
    });
    let params: RunSubmitParams = serde_json::from_value(wire.clone()).assert_value();
    assert_eq!(serde_json::to_value(params).assert_value(), wire);

    let mut missing_input = wire.clone();
    missing_input
        .as_object_mut()
        .assert_value()
        .remove("initialInput");
    assert!(serde_json::from_value::<RunSubmitParams>(missing_input).is_err());

    let mut unknown = wire;
    json_insert::json_insert(&mut unknown, "", "provider", json!("openai"));
    assert!(serde_json::from_value::<RunSubmitParams>(unknown).is_err());
}

#[test]
fn submit_defaults_ship_to_false_and_inventory_is_closed() {
    let params: RunSubmitParams = serde_json::from_value(json!({
        "graph": graph(),
        "initialInput": null,
        "submissionKey": "submission-1"
    }))
    .assert_value();
    assert!(!params.ship);

    assert!(serde_json::from_value::<RunListParams>(json!({})).is_ok());
    assert!(serde_json::from_value::<RunListParams>(json!({ "cursor": "v2:1" })).is_err());
}

#[test]
fn submit_and_list_results_expose_only_public_run_identity_and_status() {
    let run_id = RunId::new("run-1");
    assert_eq!(
        serde_json::to_value(RunSubmitResult {
            run_id: run_id.clone()
        })
        .assert_value(),
        json!({ "runId": "run-1" })
    );

    let result = RunListResult {
        runs: vec![RunStatusResult {
            run_id,
            at_cursor: openengine_cluster_protocol::Cursor::new("v2:1"),
            status: RunStatus::Admitted {},
        }],
    };
    let wire = serde_json::to_value(result).assert_value();
    assert_eq!(
        json_read::json_at(&wire, "/runs/0/runId")
            .as_str()
            .assert_value(),
        "run-1"
    );
    assert!(wire.to_string().find("capsule").is_none());
}
