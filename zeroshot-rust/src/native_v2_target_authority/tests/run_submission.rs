use std::net::SocketAddr;
use std::sync::atomic::Ordering;

use openengine_cluster_protocol::RunId;
use openengine_cluster_testkit::assertions::AssertValue;

use super::*;

pub(super) async fn assert_run_submission(address: SocketAddr, factory: &FakeFactory) {
    let bare_intent = http(
        address,
        TestHttpRequest::body(
            "POST",
            RUN_PATH,
            Some("control-token"),
            &serde_json::to_vec(&intent()).assert_value(),
        ),
    )
    .await;
    assert_eq!(bare_intent.status, 400);

    let submitted = http(
        address,
        TestHttpRequest::body(
            "POST",
            RUN_PATH,
            Some("control-token"),
            &serde_json::to_vec(&request()).assert_value(),
        ),
    )
    .await;
    assert_eq!(submitted.status, 200);
    assert_eq!(
        serde_json::from_slice::<TargetRunReceipt>(&submitted.body)
            .assert_value()
            .run_id,
        RunId::new("run-fake")
    );
    assert_eq!(factory.submissions.load(Ordering::SeqCst), 1);
}
