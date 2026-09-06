use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;
use tokio::net::TcpListener;

use super::{read_http_request, write_http_response, write_http_response_with_status};

pub(in crate::native_v2_target::tests) async fn spawn_rejecting_direct_target_authority()
-> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.assert_value();
    let origin = format!("http://{}", listener.local_addr().assert_value());
    let server = tokio::spawn(async move {
        let (mut discovery, _) = listener.accept().await.assert_value();
        let request = read_http_request(&mut discovery).await;
        assert_eq!(request.path, "/.well-known/zeroshot-native-v2");
        let body = json!({
            "kind": "zeroshot.native-v2-target/v2",
            "authentication": "none",
            "runPath": "/native-v2/run",
            "sessionPath": "/native-v2/oecp-session",
            "oecpPath": "/native-v2/oecp",
            "audience": "controller",
        })
        .to_string();
        write_http_response(&mut discovery, &body).await;

        let (mut submission, _) = listener.accept().await.assert_value();
        let request = read_http_request(&mut submission).await;
        assert_eq!(request.path, "/native-v2/run");
        write_http_response_with_status(
            &mut submission,
            "400 Bad Request",
            r#"{"message":"required payload target issueNumber is not defined by a binding"}"#,
        )
        .await;
    });
    (origin, server)
}
