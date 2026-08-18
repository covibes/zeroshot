use std::collections::VecDeque;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    AgentAttachEvent, BoundedAssistantOutput, BoundedLogMessage, BoundedLogTarget, ClusterStatus,
    Cursor, ExecutionRef, GetParams, GetResult, InitializeParams, InitializeResult, LogLevel,
    LogRecord, RunAttachEventNotification, RunAttachParams, RunAttachResult, RunForceParams,
    RunForceResult, RunId, RunListParams, RunListResult, RunLogEventNotification, RunLogsParams,
    RunLogsResult, RunStatus, RunStatusParams, RunStatusResult, RunSubmitParams, RunSubmitResult,
    RunSize, RunTitle, RunWatchEventNotification, RunWatchParams, RunWatchResult,
    ServerCapabilities, SubscriptionCloseReason, SubscriptionId,
};
use openengine_cluster_server::native_v2::{
    RunAttachEventStream, RunLogEventStream, RunSubscriptionItem, RunSubscriptionSource,
    RunSubscriptionStream, RunWatchEventStream,
};
use openengine_cluster_server::watch::fixtures::{await_ndjson_shutdown, spawn_ndjson};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};
use openengine_cluster_testkit::native_v2_source_fixture;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

struct VecSource<E> {
    items: VecDeque<RunSubscriptionItem<E>>,
}

#[async_trait]
impl<E: Send> RunSubscriptionSource<E> for VecSource<E> {
    async fn next(&mut self) -> Option<RunSubscriptionItem<E>> {
        self.items.pop_front()
    }
}

fn stream<E: Send + 'static>(items: Vec<RunSubscriptionItem<E>>) -> RunSubscriptionStream<E> {
    RunSubscriptionStream::new(VecSource {
        items: items.into(),
    })
}

#[derive(Clone, Copy)]
struct FakeBackend;

fn run_id() -> RunId {
    RunId::new("run-1")
}

fn cursor(value: u64) -> Cursor {
    Cursor::new(format!("v2:{value}"))
}

fn title() -> RunTitle {
    RunTitle::new("Protocol server test").assert_value()
}

fn status(phase: RunStatus, at: u64) -> RunStatusResult {
    RunStatusResult {
        run_id: run_id(),
        title: title(),
        source: native_v2_source_fixture(),
        size: RunSize::Tiny,
        at_cursor: cursor(at),
        status: phase,
    }
}

fn execution() -> ExecutionRef {
    ExecutionRef::new("execution-1").assert_value()
}

#[async_trait]
impl ClusterBackend for FakeBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult::empty())
    }

    async fn run_submit(
        &self,
        _context: &ConnectionContext,
        params: RunSubmitParams,
    ) -> Result<RunSubmitResult, BackendError> {
        assert_eq!(params.run_id, run_id());
        assert_eq!(params.submission.initial_input, Value::Null);
        Ok(RunSubmitResult { run_id: run_id() })
    }

    async fn run_list(
        &self,
        _context: &ConnectionContext,
        _params: RunListParams,
    ) -> Result<RunListResult, BackendError> {
        Ok(RunListResult {
            runs: vec![status(RunStatus::Admitted {}, 1)],
        })
    }

    async fn run_status(
        &self,
        _context: &ConnectionContext,
        _params: RunStatusParams,
    ) -> Result<RunStatusResult, BackendError> {
        Ok(status(
            RunStatus::Running {
                active_executions: vec![],
            },
            2,
        ))
    }

    async fn run_watch(
        &self,
        _context: &ConnectionContext,
        _params: RunWatchParams,
    ) -> Result<(RunWatchResult, RunWatchEventStream), BackendError> {
        let subscription_id = SubscriptionId::new("watch-1");
        Ok((
            RunWatchResult {
                subscription_id: subscription_id.clone(),
                run_id: run_id(),
                at_cursor: cursor(2),
            },
            stream(vec![
                RunSubscriptionItem::Event(RunWatchEventNotification {
                    subscription_id,
                    run_id: run_id(),
                    title: title(),
                    source: native_v2_source_fixture(),
                    size: RunSize::Tiny,
                    cursor: cursor(3),
                    status: RunStatus::Running {
                        active_executions: vec![],
                    },
                }),
                RunSubscriptionItem::Closed {
                    reason: SubscriptionCloseReason::Done,
                },
                RunSubscriptionItem::Event(RunWatchEventNotification {
                    subscription_id: SubscriptionId::new("watch-1"),
                    run_id: run_id(),
                    title: title(),
                    source: native_v2_source_fixture(),
                    size: RunSize::Tiny,
                    cursor: cursor(99),
                    status: RunStatus::Running {
                        active_executions: vec![],
                    },
                }),
            ]),
        ))
    }

    async fn run_logs(
        &self,
        _context: &ConnectionContext,
        _params: RunLogsParams,
    ) -> Result<(RunLogsResult, RunLogEventStream), BackendError> {
        let subscription_id = SubscriptionId::new("logs-1");
        Ok((
            RunLogsResult {
                subscription_id: subscription_id.clone(),
                run_id: run_id(),
                at_cursor: cursor(3),
            },
            stream(vec![RunSubscriptionItem::Event(RunLogEventNotification {
                subscription_id,
                run_id: run_id(),
                cursor: cursor(4),
                execution: Some(execution()),
                record: LogRecord {
                    level: LogLevel::Info,
                    target: BoundedLogTarget::new("agent").assert_value(),
                    message: BoundedLogMessage::new("safe output").assert_value(),
                },
            })]),
        ))
    }

    async fn run_attach(
        &self,
        _context: &ConnectionContext,
        _params: RunAttachParams,
    ) -> Result<(RunAttachResult, RunAttachEventStream), BackendError> {
        let subscription_id = SubscriptionId::new("attach-1");
        Ok((
            RunAttachResult {
                subscription_id: subscription_id.clone(),
                run_id: run_id(),
                execution: execution(),
            },
            stream(vec![RunSubscriptionItem::Event(
                RunAttachEventNotification {
                    subscription_id,
                    run_id: run_id(),
                    execution: execution(),
                    event: AgentAttachEvent::Output {
                        text: BoundedAssistantOutput::new("live").assert_value(),
                    },
                },
            )]),
        ))
    }

    async fn run_force(
        &self,
        _context: &ConnectionContext,
        _params: RunForceParams,
    ) -> Result<RunForceResult, BackendError> {
        let result = status(
            RunStatus::Stopping {
                active_executions: vec![],
            },
            5,
        );
        Ok(RunForceResult {
            run_id: result.run_id,
            title: result.title,
            source: result.source,
            size: result.size,
            at_cursor: result.at_cursor,
            status: result.status,
        })
    }
}

fn graph() -> Value {
    json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.native-v2@1", "default": "deny" },
        "root": {
            "kind": "succeed", "name": "done", "output": { "kind": "null" }, "bindings": []
        }
    })
}

fn submission() -> Value {
    json!({
        "title": "Protocol server test",
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

#[tokio::test]
async fn unary_run_methods_route_through_the_typed_backend() {
    let dispatcher = Dispatcher::new(FakeBackend, ConnectionContext::default());
    let cases = [
        (
            "run/submit",
            json!({
                "runId": "run-1",
                "submission": submission()
            }),
        ),
        ("run/list", json!({})),
        ("run/status", json!({ "runId": "run-1" })),
        ("run/force", json!({ "runId": "run-1" })),
    ];
    for (index, (method, params)) in cases.into_iter().enumerate() {
        let response = dispatcher
            .dispatch(
                &json!({"jsonrpc":"2.0","id":index as i64,"method":method,"params":params})
                    .to_string(),
            )
            .await;
        let response: Value = serde_json::from_str(&response).assert_value();
        assert!(response.get("result").is_some(), "{method}: {response}");
    }
}

#[tokio::test]
async fn typed_direct_subscription_surface_reuses_run_observation_values() {
    let dispatcher = Dispatcher::new(FakeBackend, ConnectionContext::default());
    let (_, mut watch) = dispatcher
        .run_watch(RunWatchParams {
            run_id: run_id(),
            from_cursor: None,
        })
        .await
        .assert_value();
    assert!(matches!(
        watch.next().await,
        Some(RunSubscriptionItem::Event(RunWatchEventNotification { .. }))
    ));
    assert!(matches!(
        watch.next().await,
        Some(RunSubscriptionItem::Closed { .. })
    ));
    assert!(watch.next().await.is_none(), "close must be terminal");

    let (_, mut logs) = dispatcher
        .run_logs(RunLogsParams {
            run_id: run_id(),
            from_cursor: None,
            execution: None,
        })
        .await
        .assert_value();
    assert!(matches!(
        logs.next().await,
        Some(RunSubscriptionItem::Event(RunLogEventNotification { .. }))
    ));

    let (_, mut attach) = dispatcher
        .run_attach(RunAttachParams {
            run_id: run_id(),
            execution: execution(),
        })
        .await
        .assert_value();
    assert!(matches!(
        attach.next().await,
        Some(RunSubscriptionItem::Event(
            RunAttachEventNotification { .. }
        ))
    ));
}

async fn write_request(writer: &mut DuplexStream, method: &str, params: Value) {
    let request = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    writer
        .write_all(request.to_string().as_bytes())
        .await
        .assert_value();
    writer.write_all(b"\n").await.assert_value();
    writer.flush().await.assert_value();
}

async fn read_value(reader: &mut BufReader<DuplexStream>) -> Value {
    let mut line = String::new();
    assert!(reader.read_line(&mut line).await.assert_value() > 0);
    serde_json::from_str(&line).assert_value()
}

#[tokio::test]
async fn ndjson_routes_run_watch_and_emits_resume_cursor_on_close() {
    let (mut writer, reader, server) = spawn_ndjson(FakeBackend);
    let mut reader = BufReader::new(reader);
    write_request(&mut writer, "run/watch", json!({ "runId": "run-1" })).await;

    let response = read_value(&mut reader).await;
    assert_eq!(
        response.assert_at("result").assert_at("subscriptionId"),
        "watch-1"
    );
    let event = read_value(&mut reader).await;
    assert_eq!(event.assert_at("method"), "event");
    assert_eq!(event.assert_at("params").assert_at("cursor"), "v2:3");
    let closed = read_value(&mut reader).await;
    assert_eq!(closed.assert_at("method"), "subscription/closed");
    assert_eq!(
        closed.assert_at("params").assert_at("lastDeliveredCursor"),
        "v2:3"
    );

    drop(writer);
    await_ndjson_shutdown(server).await;
}
#[path = "support/assert_value.rs"]
mod assert_value;
use assert_value::AssertValue;
#[path = "support/assert_at.rs"]
mod assert_at;
use assert_at::AssertAt;
