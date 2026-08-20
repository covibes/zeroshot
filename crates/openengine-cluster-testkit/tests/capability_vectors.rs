use openengine_cluster_protocol::{GraphProfile, GraphProfileSet, ServerCapabilities};
use openengine_cluster_testkit::capability_vectors::assert_advertised_profiles;

fn capabilities_of(profiles: Vec<GraphProfile>) -> ServerCapabilities {
    ServerCapabilities {
        graph_profiles: GraphProfileSet::new(profiles).assert_value(),
        logs: false,
        agent_attach: false,
    }
}

#[test]
fn empty_vector_matches_empty_capabilities() {
    assert_advertised_profiles(&capabilities_of(vec![]), &[]);
}

#[test]
fn single_worker_vector_matches_single_worker_capabilities() {
    assert_advertised_profiles(
        &capabilities_of(vec![GraphProfile::SingleWorker]),
        &[GraphProfile::SingleWorker],
    );
}

#[test]
fn full_vector_matches_full_capabilities() {
    assert_advertised_profiles(
        &capabilities_of(vec![GraphProfile::Full, GraphProfile::SingleWorker]),
        &[GraphProfile::Full, GraphProfile::SingleWorker],
    );
}

#[test]
#[should_panic(expected = "advertised graph profiles did not match expected vector")]
fn mismatch_panics() {
    assert_advertised_profiles(
        &capabilities_of(vec![GraphProfile::SingleWorker]),
        &[GraphProfile::Full],
    );
}

use openengine_cluster_testkit::assertions::AssertValue;
