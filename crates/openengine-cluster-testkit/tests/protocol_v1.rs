use async_trait::async_trait;
use openengine_cluster_client::{
    ClientError, ClusterClient, InProcessTransport, JsonRpcTransport, NdjsonTransport,
    TransportError,
};
use openengine_cluster_protocol::{
    ApplyParams, ClusterStatus, Generation, GetParams, GetResult, IdempotencyKey, InitializeResult,
    PlanParams, ServerCapabilities, StopMode, StopParams, TerminalResult, UpdateParams,
    PROTOCOL_VERSION,
};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::{BackendError, ClusterBackend};
use openengine_cluster_server::{ConnectionContext, Dispatcher};
use openengine_cluster_testkit::EmptyBackend;
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, InMemoryAdmissionStore, ScriptedOutcome,
    ScriptedVerifier,
};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

#[path = "stdio_subprocess_support/mod.rs"]
mod stdio_subprocess_support;

async fn assert_admission_effects(store: &InMemoryAdmissionStore) {
    let effects = store.inspect().await;
    assert_eq!(effects.control_journal.len(), 1);
    assert_eq!(
        effects.seed_ledger.assert_at(0).input,
        serde_json::Value::Null
    );
    assert_eq!(
        effects.control.cursor,
        Some(effects.seed_ledger.assert_at(0).cursor.clone())
    );
}

#[test]
fn protocol_version_is_exact() {
    assert_eq!(PROTOCOL_VERSION, "openengine.cluster/v1");
}

#[test]
fn canonical_empty_results_have_exact_wire_shape() {
    let status = ClusterStatus::empty();
    let initialize = InitializeResult::new(ServerCapabilities::default(), status.clone());
    let get = GetResult {
        spec: None,
        status,
        at_cursor: None,
        terminal_result: None,
    };

    assert_eq!(
        serde_json::to_value(initialize).assert_value(),
        serde_json::json!({
            "protocolVersion": "openengine.cluster/v1",
            "capabilities": { "graphProfiles": [], "logs": false, "agentAttach": false },
            "status": {
                "phase": "empty",
                "observedGeneration": null,
                "currentRunId": null,
                "atCursor": null
            }
        })
    );
    assert_eq!(
        serde_json::to_value(get).assert_value(),
        serde_json::json!({
            "spec": null,
            "status": {
                "phase": "empty",
                "observedGeneration": null,
                "currentRunId": null,
                "atCursor": null
            },
            "atCursor": null
        })
    );
}

#[test]
fn terminal_result_has_one_exact_closed_wire_algebra() {
    let succeeded = TerminalResult::Succeeded {
        output: serde_json::json!({ "value": 42 }),
    };
    assert_eq!(
        serde_json::to_value(&succeeded).assert_value(),
        serde_json::json!({ "status": "succeeded", "output": { "value": 42 } })
    );
    assert_eq!(
        serde_json::from_value::<TerminalResult>(serde_json::json!({
            "status": "succeeded",
            "output": { "value": 42 }
        }))
        .assert_value(),
        succeeded
    );
    assert!(
        serde_json::from_value::<TerminalResult>(serde_json::json!({
            "status": "succeeded",
            "output": null,
            "unexpected": true
        }))
        .is_err()
    );
    let failed = serde_json::from_value::<TerminalResult>(serde_json::json!({
        "status": "failed",
        "reason": "attempts_exhausted"
    }))
    .assert_value();
    assert_eq!(
        serde_json::to_value(failed).assert_value(),
        serde_json::json!({ "status": "failed", "reason": "attempts_exhausted" })
    );
    assert!(
        serde_json::from_value::<TerminalResult>(serde_json::json!({
            "status": "failed",
            "reason": "not a bounded enum label"
        }))
        .is_err()
    );
}

#[test]
fn initialize_result_constructs_and_validates_the_exact_protocol_version() {
    let valid = InitializeResult::new(ServerCapabilities::default(), ClusterStatus::empty());
    assert_eq!(valid.protocol_version, PROTOCOL_VERSION);
    assert!(valid.validate_protocol_version().is_ok());

    let invalid = InitializeResult {
        protocol_version: "openengine.cluster/v0".to_owned(),
        capabilities: ServerCapabilities::default(),
        status: ClusterStatus::empty(),
    };
    assert!(invalid.validate_protocol_version().is_err());
}

#[test]
fn generation_is_bounded_to_javascript_safe_integers() {
    assert!(Generation::new(9_007_199_254_740_991).is_ok());
    assert!(Generation::new(9_007_199_254_740_992).is_err());
    assert!(serde_json::from_str::<Generation>("9007199254740992").is_err());
    assert_eq!(
        serde_json::from_str::<Generation>("7.0")
            .assert_value()
            .get(),
        7
    );
    assert!(serde_json::from_str::<Generation>("7.5").is_err());
}

#[tokio::test]
async fn initialize_and_get_match_across_transports() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());
    let in_process = ClusterClient::new(InProcessTransport::new(dispatcher));

    let (subprocess, stdin, stdout) = stdio_subprocess_support::spawn();
    let stdio = ClusterClient::new(NdjsonTransport::new(stdout, stdin));

    let in_process_initialize = in_process.initialize().await.assert_value();
    let in_process_get = in_process
        .get(openengine_cluster_protocol::GetParams::default())
        .await
        .assert_value();
    let stdio_initialize = stdio.initialize().await.assert_value();
    let stdio_get = stdio
        .get(openengine_cluster_protocol::GetParams::default())
        .await
        .assert_value();

    assert_eq!(stdio_initialize, in_process_initialize);
    assert_eq!(stdio_get, in_process_get);
    assert_eq!(stdio_initialize.protocol_version, PROTOCOL_VERSION);
    assert_eq!(stdio_initialize.capabilities, ServerCapabilities::default());
    assert_eq!(stdio_initialize.status, ClusterStatus::empty());
    assert_eq!(stdio_get.spec, None);
    assert_eq!(stdio_get.status, ClusterStatus::empty());
    assert_eq!(stdio_get.at_cursor, None);

    drop(stdio);
    subprocess.join().await;
}

#[tokio::test]
async fn admission_transcript_matches_in_process_and_stdio() {
    let graph = graph_fixture("worker", serde_json::json!({"kind":"null"}));
    let compiled = compiled_from_graph_fixture(&graph);
    let verifier = Arc::new(ScriptedVerifier::new(vec![
        ScriptedOutcome::approve(compiled.clone(), vec![]),
        ScriptedOutcome::approve(compiled, vec![]),
    ]));
    let store = Arc::new(InMemoryAdmissionStore::default());
    let backend = AdmissionCoordinator::from_shared(verifier, Arc::clone(&store));
    let in_process = ClusterClient::new(InProcessTransport::new(Dispatcher::new(
        backend,
        ConnectionContext::default(),
    )));

    let (subprocess, stdin, stdout) = stdio_subprocess_support::spawn();
    let stdio = ClusterClient::new(NdjsonTransport::new(stdout, stdin));

    assert_eq!(
        stdio.initialize().await.assert_value(),
        in_process.initialize().await.assert_value()
    );
    let plan = PlanParams {
        graph: graph.clone(),
    };
    assert_eq!(
        stdio.plan(plan.clone()).await.assert_value(),
        in_process.plan(plan).await.assert_value()
    );
    let apply = ApplyParams {
        graph: graph.clone(),
        input: Some(serde_json::Value::Null),
        dry_run: false,
        if_generation: Some(Generation::new(0).assert_value()),
        idempotency_key: Some(IdempotencyKey::new("transcript-create").assert_value()),
    };
    assert_eq!(
        stdio.apply(apply.clone()).await.assert_value(),
        in_process.apply(apply).await.assert_value()
    );
    let stdio_get = stdio.get(GetParams::default()).await.assert_value();
    let in_process_get = in_process.get(GetParams::default()).await.assert_value();
    assert_eq!(stdio_get, in_process_get);
    assert_eq!(stdio_get.spec, Some(graph));
    assert_admission_effects(store.as_ref()).await;

    let update = UpdateParams {
        labels: None,
        log_level: Some(openengine_cluster_protocol::LogLevel::Debug),
        suspended: Some(false),
        if_generation: Generation::new(1).assert_value(),
        idempotency_key: IdempotencyKey::new("transport-update").assert_value(),
    };
    assert_eq!(
        stdio.update(update.clone()).await.assert_value(),
        in_process.update(update).await.assert_value()
    );
    let stop = StopParams {
        mode: StopMode::Drain,
        if_generation: Generation::new(1).assert_value(),
        idempotency_key: IdempotencyKey::new("transport-stop").assert_value(),
    };
    assert_eq!(
        stdio.stop(stop.clone()).await.assert_value(),
        in_process.stop(stop).await.assert_value()
    );
    let stdio_finished = stdio.get(GetParams::default()).await.assert_value();
    let in_process_finished = in_process.get(GetParams::default()).await.assert_value();
    assert_eq!(stdio_finished, in_process_finished);
    assert_eq!(
        stdio_finished.status.phase,
        openengine_cluster_protocol::Phase::Finished
    );

    drop(stdio);
    subprocess.join().await;
}

#[tokio::test]
async fn rejects_invalid_jsonrpc_inputs_deterministically() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());
    let cases = [
        ("{", -32700, serde_json::Value::Null),
        ("[]", -32600, serde_json::Value::Null),
        (
            r#"{"jsonrpc":"1.0","id":1,"method":"get","params":{}}"#,
            -32600,
            serde_json::Value::Null,
        ),
        (
            r#"{"jsonrpc":"2.0","id":"pos","method":"get","params":[]}"#,
            -32602,
            serde_json::json!("pos"),
        ),
        (
            r#"{"jsonrpc":"2.0","id":4,"method":"missing","params":{}}"#,
            -32601,
            serde_json::json!(4),
        ),
    ];

    for (request, expected_code, expected_id) in cases {
        let response: serde_json::Value =
            serde_json::from_str(&dispatcher.dispatch(request).await).assert_value();
        assert_eq!(
            response.assert_key("error").assert_key("code"),
            expected_code,
            "{request}"
        );
        assert_eq!(response.assert_key("id"), &expected_id, "{request}");
    }
}

#[tokio::test]
async fn unknown_methods_ignore_parameter_shape() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());
    let requests = [
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":[]}"#,
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":null}"#,
        r#"{"jsonrpc":"2.0","id":10,"method":"missing","params":"scalar"}"#,
        r#"{"jsonrpc":"2.0","id":10,"method":"missing"}"#,
    ];

    for request in requests {
        let response: serde_json::Value =
            serde_json::from_str(&dispatcher.dispatch(request).await).assert_value();
        assert_eq!(response.assert_key("id"), 10, "{request}");
        assert_eq!(
            response.assert_key("error").assert_key("code"),
            -32601,
            "{request}"
        );
    }
}

#[tokio::test]
async fn unsupported_protocol_version_has_stable_domain_code() {
    let dispatcher = Dispatcher::new(EmptyBackend, ConnectionContext::default());
    let client = ClusterClient::new(InProcessTransport::new(dispatcher));

    let error = client
        .initialize_with_version("openengine.cluster/v0")
        .await
        .assert_error();
    match error {
        ClientError::Rpc(error) => {
            assert_eq!(error.code, -32000);
            assert_eq!(
                error.data.assert_value().code,
                "UNSUPPORTED_PROTOCOL_VERSION"
            );
        }
        other => assert!(
            matches!(other, ClientError::Rpc(_)),
            "expected a JSON-RPC error"
        ),
    }
}

#[derive(Clone, Copy)]
struct FailingBackend;

#[async_trait]
impl ClusterBackend for FailingBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: openengine_cluster_protocol::InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Err(BackendError::new("BACKEND_FAILURE", "database unavailable"))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: openengine_cluster_protocol::GetParams,
    ) -> Result<GetResult, BackendError> {
        Err(BackendError::new("BACKEND_FAILURE", "database unavailable"))
    }
}

#[tokio::test]
async fn backend_failures_are_structured_internal_errors() {
    let dispatcher = Dispatcher::new(FailingBackend, ConnectionContext::default());
    let response: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(r#"{"jsonrpc":"2.0","id":9,"method":"get","params":{}}"#)
            .await,
    )
    .assert_value();

    assert_eq!(response.assert_key("id"), 9);
    assert_eq!(response.assert_key("error").assert_key("code"), -32603);
    assert_eq!(
        response
            .assert_key("error")
            .assert_key("data")
            .assert_key("code"),
        "BACKEND_FAILURE"
    );
}

#[derive(Clone, Copy)]
struct WrongVersionBackend;

#[async_trait]
impl ClusterBackend for WrongVersionBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: openengine_cluster_protocol::InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult {
            protocol_version: "openengine.cluster/v0".to_owned(),
            capabilities: ServerCapabilities::default(),
            status: ClusterStatus::empty(),
        })
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: openengine_cluster_protocol::GetParams,
    ) -> Result<GetResult, BackendError> {
        None::<Result<GetResult, BackendError>>.assert_value_with("this test only initializes")
    }
}

#[tokio::test]
async fn dispatcher_rejects_a_backend_response_with_the_wrong_protocol_version() {
    let dispatcher = Dispatcher::new(WrongVersionBackend, ConnectionContext::default());
    let response: serde_json::Value = serde_json::from_str(
        &dispatcher
            .dispatch(
                r#"{"jsonrpc":"2.0","id":10,"method":"initialize","params":{"protocolVersion":"openengine.cluster/v1"}}"#,
            )
            .await,
    )
    .assert_value();

    assert_eq!(response.assert_key("id"), 10);
    assert_eq!(response.assert_key("error").assert_key("code"), -32603);
    assert_eq!(
        response
            .assert_key("error")
            .assert_key("data")
            .assert_key("code"),
        "INTERNAL_ERROR"
    );
    assert!(response.get("result").is_none());
}

#[tokio::test]
async fn stdio_emits_protocol_frames_only() {
    let mut child = stdio_subprocess_support::spawn_child();
    let mut stdin = child.stdin.take().assert_value();
    stdin
        .write_all(
            concat!(
                "{\"jsonrpc\":\"2.0\",\"id\":\"init\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"openengine.cluster/v1\"}}\n",
                "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"get\",\"params\":{}}\n"
            )
            .as_bytes(),
        )
        .await
        .assert_value();
    drop(stdin);

    let output = child.wait_with_output().await.assert_value();
    assert!(output.status.success());
    assert_eq!(output.stderr, b"");
    let stdout = String::from_utf8(output.stdout).assert_value();
    let lines: Vec<_> = stdout.lines().collect();
    assert_eq!(lines.len(), 2, "stdout must contain exactly two frames");
    for line in lines {
        assert!(!line.is_empty());
        serde_json::from_str::<serde_json::Value>(line).assert_value();
    }
}

#[path = "protocol_v1/client_rejections.rs"]
mod client_rejections;

use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertValue, JsonAt};
