#[path = "support/mod.rs"]
pub mod support;

use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{
    RunForceParams, RunId, RunListParams, RunStatusParams, RunSubmitParams,
};
use serde_json::{json, Value};
use support::{AssertValue, RecordingTransport};

fn response(method: &str) -> Value {
    [
        ("run/submit", json!({"runId":"run-1"})),
        ("run/list", json!({"runs":[]})),
        (
            "run/status",
            json!({
                "runId":"run-1","atCursor":"v2:1","status":{"phase":"admitted"}
            }),
        ),
        (
            "run/force",
            json!({
                "runId":"run-1","atCursor":"v2:2",
                "status":{"phase":"stopping","activeExecutions":[]}
            }),
        ),
    ]
    .into_iter()
    .find_map(|(candidate, value)| (candidate == method).then_some(value))
    .assert_value_with("expected a known native v2 client method")
}

fn submit() -> RunSubmitParams {
    serde_json::from_value(json!({
        "graph": {
            "profile":"openengine.graph.full/v1",
            "initialInput":{"kind":"null"},
            "policy":{"policy":"policy.native-v2@1","default":"deny"},
            "root":{
                "kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]
            }
        },
        "initialInput":null,
        "ship":false,
        "submissionKey":"submission-1"
    }))
    .assert_value()
}

#[tokio::test]
async fn typed_run_calls_use_the_public_native_v2_method_names() {
    let transport = RecordingTransport::new(response);
    let client = ClusterClient::new(transport.clone());
    assert_eq!(
        client.run_submit(submit()).await.assert_value().run_id,
        RunId::new("run-1")
    );
    assert!(
        client
            .run_list(RunListParams::default())
            .await
            .assert_value()
            .runs
            .is_empty()
    );
    client
        .run_status(RunStatusParams {
            run_id: RunId::new("run-1"),
        })
        .await
        .assert_value();
    client
        .run_force(RunForceParams {
            run_id: RunId::new("run-1"),
        })
        .await
        .assert_value();
    assert_eq!(
        transport.methods().await,
        ["run/submit", "run/list", "run/status", "run/force"]
    );
}
