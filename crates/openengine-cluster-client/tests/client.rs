#[path = "support/mod.rs"]
pub mod support;

use openengine_cluster_client::ClusterClient;
use openengine_cluster_protocol::{ApplyParams, GetParams, PlanParams};
use serde_json::json;
use serde_json::Value;
use support::{AssertAt, AssertValue, RecordingTransport};

fn response(method: &str) -> Value {
    [
        ("plan", json!({"ok":false,"diagnostics":[]})),
        ("apply", json!({
            "generation":null,"runId":null,"phase":"empty","deduped":false,
            "diff":{"added":["worker"],"removed":[],"changed":[]}
        })),
        ("get", json!({
            "spec":null,
            "status":{"phase":"empty","observedGeneration":null,"currentRunId":null,"atCursor":null},
            "atCursor":null
        })),
    ]
    .into_iter()
    .find_map(|(candidate, value)| (candidate == method).then_some(value))
    .assert_value_with("expected a known client method")
}

fn graph() -> openengine_cluster_protocol::GraphSpec {
    serde_json::from_str(include_str!(
        "../../../protocol/openengine-cluster/v1/fixtures/graph/positive/single-worker.json"
    ))
    .assert_value()
}

#[tokio::test]
async fn typed_admission_calls_use_named_plan_apply_and_get_methods() {
    let transport = RecordingTransport::new(response);
    let client = ClusterClient::new(transport.clone());
    assert!(
        !client
            .plan(PlanParams { graph: graph() })
            .await
            .assert_value()
            .ok
    );
    assert_eq!(
        client
            .apply(ApplyParams {
                graph: graph(),
                input: None,
                dry_run: true,
                if_generation: None,
                idempotency_key: None,
            })
            .await
            .assert_value()
            .diff
            .assert_value()
            .added
            .assert_at(0)
            .as_str(),
        "worker"
    );
    assert!(
        client
            .get(GetParams::default())
            .await
            .assert_value()
            .spec
            .is_none()
    );
    assert_eq!(transport.methods().await, ["plan", "apply", "get"]);
}
