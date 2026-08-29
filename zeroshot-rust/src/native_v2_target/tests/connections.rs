use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionKey, ConnectionListRequest, ConnectionScope,
    ConnectionSetRequest, EnvironmentVariableName, StaticConnectionValues,
};
use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};

use super::super::controller_authority::TargetCredentialStore;
use super::super::TargetControlAuthority;
use super::fixtures::{hosted_target, temp_root};
use super::hosted_authority::{spawn_target_authority, test_authority};

#[tokio::test]
async fn hosted_connection_crud_uses_only_the_advertised_authenticated_routes() {
    let root = temp_root();
    let (origin, server) = spawn_target_authority(15).await;
    let (credentials, authority) = test_authority(&root);
    let target = hosted_target("local", origin);
    credentials
        .set(&target.id, "refresh-0")
        .await
        .assert_value();

    let listed = authority
        .connection_list(
            &target,
            ConnectionListRequest {
                scope: ConnectionScope::User,
            },
        )
        .await
        .assert_value();
    assert_eq!(listed.connections.assert_at(0).key.as_str(), "github");
    let values = StaticConnectionValues::new(BTreeMap::from([(
        EnvironmentVariableName::new("GH_TOKEN").assert_value(),
        "secret-token".to_owned(),
    )]))
    .assert_value();
    authority
        .connection_set(
            &target,
            ConnectionSetRequest {
                key: ConnectionKey::new("github").assert_value(),
                scope: ConnectionScope::User,
                values,
            },
        )
        .await
        .assert_value();
    let deleted = authority
        .connection_delete(
            &target,
            ConnectionDeleteRequest {
                key: ConnectionKey::new("github").assert_value(),
                scope: ConnectionScope::User,
            },
        )
        .await;
    assert!(deleted.is_ok(), "connection delete failed: {deleted:?}");

    let requests = server.await.assert_value();
    for route in [
        "/native-v2/connections/list",
        "/native-v2/connections/set",
        "/native-v2/connections/delete",
    ] {
        let request = requests
            .iter()
            .find(|request| request.path == route)
            .assert_value_with(route);
        assert!(
            request
                .authorization
                .as_deref()
                .is_some_and(|value| value.starts_with("Bearer "))
        );
    }
    let set = requests
        .iter()
        .find(|request| request.path == "/native-v2/connections/set")
        .assert_value();
    assert!(set.body.contains("secret-token"));
}
