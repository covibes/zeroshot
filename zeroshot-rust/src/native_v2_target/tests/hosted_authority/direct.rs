use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;
use tokio::net::TcpListener;

use super::{CapturedHttpRequest, read_http_request, write_http_response_with_status};

enum RunResponse {
    Accepted,
    Rejected,
}

pub(in crate::native_v2_target::tests) async fn spawn_direct_target_authority(
    request_count: usize,
) -> (String, tokio::task::JoinHandle<Vec<CapturedHttpRequest>>) {
    spawn_direct_target_authority_with_response(request_count, RunResponse::Accepted).await
}

pub(in crate::native_v2_target::tests) async fn spawn_rejecting_direct_target_authority()
-> (String, tokio::task::JoinHandle<()>) {
    let (origin, server) =
        spawn_direct_target_authority_with_response(2, RunResponse::Rejected).await;
    (
        origin,
        tokio::spawn(async move { drop(server.await.assert_value()) }),
    )
}

async fn spawn_direct_target_authority_with_response(
    request_count: usize,
    run_response: RunResponse,
) -> (String, tokio::task::JoinHandle<Vec<CapturedHttpRequest>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let address = listener.local_addr().assert_value();
    let origin = format!("http://{address}");
    let server = tokio::spawn(async move {
        let mut captured = Vec::new();
        for _ in 0..request_count {
            let (mut stream, _) = listener.accept().await.assert_value();
            let request = read_http_request(&mut stream).await;
            let (status, body) = response(&request, address, &run_response);
            write_http_response_with_status(&mut stream, status, &body).await;
            captured.push(request);
        }
        captured
    });
    (origin, server)
}

fn response(
    request: &CapturedHttpRequest,
    address: std::net::SocketAddr,
    run_response: &RunResponse,
) -> (&'static str, String) {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/.well-known/zeroshot-native-v2") => ("200 OK", discovery()),
        ("POST", "/native-v2/run") => run_submission_response(run_response),
        ("POST", "/native-v2/oecp-session") => (
            "200 OK",
            format!(r#"{{"endpoint":"ws://{address}/native-v2/oecp"}}"#),
        ),
        unexpected => None::<(&str, String)>
            .assert_value_with(&format!("unexpected direct request: {unexpected:?}")),
    }
}

fn discovery() -> String {
    json!({
        "kind": "zeroshot.native-v2-target/v2",
        "authentication": "none",
        "runPath": "/native-v2/run",
        "sessionPath": "/native-v2/oecp-session",
        "oecpPath": "/native-v2/oecp",
        "audience": "controller",
    })
    .to_string()
}

fn run_submission_response(response: &RunResponse) -> (&'static str, String) {
    match response {
        RunResponse::Accepted => (
            "200 OK",
            r#"{"runId":"018f5e78-7f95-7c22-8d98-3f15af20c991"}"#.to_owned(),
        ),
        RunResponse::Rejected => (
            "400 Bad Request",
            r#"{"message":"required payload target issueNumber is not defined by a binding"}"#
                .to_owned(),
        ),
    }
}
