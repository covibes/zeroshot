use std::sync::Arc;

use openengine_cluster_client::ClientError;
use openengine_cluster_testkit::admission::{InMemoryAdmissionStore, ScriptedOutcome, ScriptedVerifier};
use openengine_cluster_testkit::fixture::dispatcher_fixture;
pub use openengine_cluster_testkit::fixture::FixtureClient;

mod committed;
pub use committed::committed;

pub fn client(
    outcomes: Vec<ScriptedOutcome>,
) -> (
    FixtureClient,
    Arc<ScriptedVerifier>,
    Arc<InMemoryAdmissionStore>,
) {
    let (client, _dispatcher, _backend, verifier, store) = dispatcher_fixture(outcomes);
    (client, verifier, store)
}

pub fn rpc_code(error: ClientError) -> String {
    match error {
        ClientError::Rpc(error) => error.data.expect("domain error data").code,
        other => panic!("expected RPC error, got {other}"),
    }
}
