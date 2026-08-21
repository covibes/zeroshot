use super::super::*;
use super::super::contract::PreparedTargetSetup;
use super::fixtures::setup_request;

#[test]
fn target_origins_match_the_existing_hosted_cli_contract() {
    assert_eq!(
        normalize_origin("https://target.example").assert_value(),
        "https://target.example"
    );
    assert_eq!(
        normalize_origin("http://127.0.0.1:8080").assert_value(),
        "http://127.0.0.1:8080"
    );
    for invalid in [
        "http://target.example",
        "https://user@target.example",
        "https://target.example/path",
        "https://target.example?query=1",
        "https://target.example/#fragment",
    ] {
        assert!(normalize_origin(invalid).is_err(), "accepted {invalid}");
    }
}

#[test]
fn target_access_is_explicit_and_hosted_remains_the_default() {
    let hosted = prepare_target(TargetAdd {
        name: "cloud".to_owned(),
        url: "https://target.example".to_owned(),
        direct: false,
    })
    .assert_value();
    assert!(matches!(hosted.access, TargetAccess::Hosted { .. }));

    let direct = prepare_target(TargetAdd {
        name: "vm".to_owned(),
        url: "http://127.0.0.1:8080".to_owned(),
        direct: true,
    })
    .assert_value();
    assert_eq!(direct.access, TargetAccess::Direct);
}

#[test]
fn setup_carries_one_optional_default_branch() {
    let request = setup_request();
    assert_eq!(
        prepare_setup(&request).assert_value(),
        PreparedTargetSetup {
            repository: "open-engine/zeroshot".to_owned(),
            default_branch: Some("main".to_owned()),
        }
    );

    let mut remote_default = request;
    remote_default.default_branch = None;
    assert_eq!(
        prepare_setup(&remote_default).assert_value().default_branch,
        None
    );
}

#[test]
fn setup_repository_bounds_match_the_shared_authority_contract() {
    let mut request = setup_request();
    request.repository = format!("{}/repo", "a".repeat(101));
    assert!(matches!(
        prepare_setup(&request),
        Err(TargetConnectorError::InvalidRepository)
    ));
}

use openengine_cluster_testkit::assertions::{AssertValue};
