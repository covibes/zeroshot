use std::io;
use std::sync::Arc;

use openengine_cluster_protocol::{
    Cursor, ExecutionRef, RunForceParams, RunId, RunLogsParams, RunStatusParams, RunWatchParams,
};
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use zeroshot_engine::native_v2_cloud::NativeV2CloudController;
use zeroshot_engine::native_v2_target_authority::NativeV2TargetAuthority;

use super::{read_request, write_json_response};

pub(super) async fn serve_hosted_run(
    mut stream: TcpStream,
    authority: Arc<NativeV2TargetAuthority>,
) -> io::Result<()> {
    let request = read_request(&mut stream).await?;
    assert_eq!(
        request.authorization.as_deref(),
        Some("Bearer control-token")
    );
    let controller = authority.controller().await.assert_value();
    let (path, query) = request.path.split_once('?').unwrap_or((&request.path, ""));

    if request.method == "GET" && path == "/native-v2/runs" {
        let mut runs = Vec::new();
        for summary in controller.list().await.assert_value() {
            runs.push(
                controller
                    .status(RunStatusParams {
                        run_id: summary.run_id,
                    })
                    .await
                    .assert_value(),
            );
        }
        return write_json_response(&mut stream, &json!({"runs": runs})).await;
    }

    let route = path
        .strip_prefix("/native-v2/runs/")
        .assert_value_with("hosted run route prefix");
    let mut segments = route.split('/');
    let run_id = RunId::new(segments.next().assert_value_with("hosted run ID"));
    let operation = segments.next();
    assert!(segments.next().is_none(), "unexpected hosted run route");

    match (request.method.as_str(), operation) {
        ("GET", None) => {
            let status = controller
                .status(RunStatusParams { run_id })
                .await
                .assert_value();
            write_json_response(&mut stream, &serde_json::to_value(status).assert_value()).await
        }
        ("POST", Some("force")) => {
            assert_eq!(request.body, "{}");
            let forced = controller
                .force(RunForceParams { run_id })
                .await
                .assert_value();
            write_json_response(&mut stream, &serde_json::to_value(forced).assert_value()).await
        }
        ("GET", Some("watch")) => serve_hosted_watch(&mut stream, controller, run_id, query).await,
        ("GET", Some("logs")) => serve_hosted_logs(&mut stream, controller, run_id, query).await,
        unexpected => None::<io::Result<()>>
            .assert_value_with(&format!("unexpected hosted run request: {unexpected:?}")),
    }
}

async fn serve_hosted_watch(
    stream: &mut TcpStream,
    controller: Arc<NativeV2CloudController>,
    run_id: RunId,
    query: &str,
) -> io::Result<()> {
    let from_cursor = query_value(query, "from_cursor").map(Cursor::new);
    write_ndjson_head(stream).await?;
    if from_cursor.is_none() {
        let current = controller
            .status(RunStatusParams {
                run_id: run_id.clone(),
            })
            .await
            .assert_value();
        write_ndjson_frame(
            stream,
            &json!({
                "type":"event",
                "event":{
                    "subscriptionId":"hosted-queued",
                    "runId":current.run_id,
                    "title":current.title,
                    "source":current.source,
                    "size":current.size,
                    "cursor":"cloud:queued",
                    "status":{"phase":"queued"}
                }
            }),
        )
        .await?;
    }
    let controller_cursor = from_cursor.filter(|cursor| cursor.as_str() != "cloud:queued");
    let (_, mut subscription) = controller
        .watch(RunWatchParams {
            run_id,
            from_cursor: controller_cursor,
        })
        .await
        .assert_value();
    while let Some(event) = subscription.recv().await.assert_value() {
        write_ndjson_frame(stream, &json!({"type":"event", "event":event})).await?;
    }
    write_ndjson_frame(stream, &json!({"type":"closed", "reason":"done"})).await
}

async fn serve_hosted_logs(
    stream: &mut TcpStream,
    controller: Arc<NativeV2CloudController>,
    run_id: RunId,
    query: &str,
) -> io::Result<()> {
    let from_cursor = query_value(query, "from_cursor").map(Cursor::new);
    let execution =
        query_value(query, "execution").map(|value| ExecutionRef::new(value).assert_value());
    let (_, mut subscription) = controller
        .logs(RunLogsParams {
            run_id,
            from_cursor,
            execution,
        })
        .await
        .assert_value();
    write_ndjson_head(stream).await?;
    while let Some(event) = subscription.recv().await.assert_value() {
        write_ndjson_frame(stream, &json!({"type":"event", "event":event})).await?;
    }
    write_ndjson_frame(stream, &json!({"type":"closed", "reason":"done"})).await
}

fn query_value(query: &str, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
}

async fn write_ndjson_head(stream: &mut TcpStream) -> io::Result<()> {
    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        )
        .await
}

async fn write_ndjson_frame(stream: &mut TcpStream, frame: &serde_json::Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(frame).assert_value();
    bytes.push(b'\n');
    stream.write_all(&bytes).await
}
