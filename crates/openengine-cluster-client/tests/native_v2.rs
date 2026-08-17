use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_client::{ClusterClient, JsonRpcTransport, TransportError};
use openengine_cluster_protocol::{
    RunForceParams, RunId, RunListParams, RunStatusParams, RunSubmitParams,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
struct RecordingTransport {
    methods: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl JsonRpcTransport for RecordingTransport {
    async fn request(&self, request: String) -> Result<String, TransportError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        let method = request["method"].as_str().unwrap().to_owned();
        self.methods.lock().await.push(method.clone());
        let result = match method.as_str() {
            "run/submit" => json!({"runId":"run-1"}),
            "run/list" => json!({"runs":[]}),
            "run/status" => json!({
                "runId":"run-1","atCursor":"v2:1","status":{"phase":"admitted"}
            }),
            "run/force" => json!({
                "runId":"run-1","atCursor":"v2:2",
                "status":{"phase":"stopping","activeExecutions":[]}
            }),
            _ => unreachable!(),
        };
        Ok(json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string())
    }
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
    .unwrap()
}

#[tokio::test]
async fn typed_run_calls_use_the_public_native_v2_method_names() {
    let transport = RecordingTransport::default();
    let client = ClusterClient::new(transport.clone());
    assert_eq!(
        client.run_submit(submit()).await.unwrap().run_id,
        RunId::new("run-1")
    );
    assert!(
        client
            .run_list(RunListParams::default())
            .await
            .unwrap()
            .runs
            .is_empty()
    );
    client
        .run_status(RunStatusParams {
            run_id: RunId::new("run-1"),
        })
        .await
        .unwrap();
    client
        .run_force(RunForceParams {
            run_id: RunId::new("run-1"),
        })
        .await
        .unwrap();
    assert_eq!(
        *transport.methods.lock().await,
        ["run/submit", "run/list", "run/status", "run/force"]
    );
}
