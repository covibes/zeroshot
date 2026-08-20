use super::*;

#[tokio::test]
async fn dropping_live_registration_revokes_attach_authority_and_settles_viewers() {
    let mut fixture = live_attach_fixture("dropped-live-registration").await;
    fixture.first_emitted.notified().await;
    let (params, mut attached) = attach_working(&fixture).await;

    drop(fixture.registration);
    assert!(matches!(
        fixture.service.attach(params).await,
        Err(NativeV2ObservationError::ExecutionNotLive)
    ));
    fixture.release.notify_one();
    assert_eq!(attach_text(&mut attached).await, "after attach");
    fixture.handle.completion().await.assert_value();
    assert_attach_settled(&mut attached).await;
}

use openengine_cluster_testkit::assertions::{AssertValue};
