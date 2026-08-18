#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/json_insert.rs"]
mod json_insert;

#[path = "support/json_read.rs"]
mod json_read;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    RunId, RunListParams, RunListResult, RunSize, RunStatus, RunStatusResult, RunSubmitParams,
    RunSubmitResult, RunTitle, SourceBranchId, SourceRepositoryId, SourceRevisionId,
    SourceSnapshot,
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

fn submission() -> Value {
    json!({
        "title": "Protocol contract",
        "graph": graph(),
        "initialInput": null,
        "runtime": {
            "harness": "codex",
            "provider": "openai",
            "size": "tiny",
            "nodes": {}
        },
        "source": {
            "repository": "open-engine/zeroshot",
            "targetBranch": "main",
            "baseRevision": "0123456789abcdef0123456789abcdef01234567"
        },
        "submissionKey": "submission-1"
    })
}

#[test]
fn submit_is_closed_secret_free_and_requires_actual_initial_input() {
    let wire = json!({
        "runId": "run-1",
        "submission": submission()
    });
    let params: RunSubmitParams = serde_json::from_value(wire.clone()).assert_value();
    assert_eq!(serde_json::to_value(params).assert_value(), wire);

    let mut missing_input = wire.clone();
    missing_input
        .pointer_mut("/submission")
        .assert_value()
        .as_object_mut()
        .assert_value()
        .remove("initialInput");
    assert!(serde_json::from_value::<RunSubmitParams>(missing_input).is_err());

    let mut unknown = wire;
    json_insert::json_insert(&mut unknown, "/submission", "credential", json!("secret"));
    assert!(serde_json::from_value::<RunSubmitParams>(unknown).is_err());
}

#[test]
fn submit_rejects_removed_ship_and_inventory_is_closed() {
    let mut wire = json!({ "runId": "run-1", "submission": submission() });
    json_insert::json_insert(&mut wire, "", "ship", json!(false));
    assert!(serde_json::from_value::<RunSubmitParams>(wire).is_err());

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
            title: RunTitle::new("Protocol contract").assert_value(),
            source: SourceSnapshot {
                repository: SourceRepositoryId::new("open-engine/zeroshot").assert_value(),
                target_branch: SourceBranchId::new("main").assert_value(),
                base_revision: SourceRevisionId::new("0123456789abcdef0123456789abcdef01234567")
                    .assert_value(),
            },
            size: RunSize::Tiny,
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
