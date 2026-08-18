use super::super::*;
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
fn setup_base_contract_matches_current_hosted_semantics() {
    assert_eq!(
        normalize_base(None, None).assert_value(),
        TargetBase::Default
    );
    assert_eq!(
        normalize_base(Some("main"), None).assert_value(),
        TargetBase::Branch {
            branch: "main".to_owned()
        }
    );
    let revision = "a".repeat(40);
    assert_eq!(
        normalize_base(Some(&revision), Some("main")).assert_value(),
        TargetBase::Revision {
            revision: revision.clone(),
            target_branch: "main".to_owned()
        }
    );
    assert!(normalize_base(Some(&revision), None).is_err());
    assert!(normalize_base(None, Some("main")).is_err());
    assert!(normalize_base(Some("main"), Some("release")).is_err());
    for invalid in ["refs/heads/release.lock", "topic@{one", "mäin"] {
        assert!(normalize_base(Some(invalid), None).is_err());
    }
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
