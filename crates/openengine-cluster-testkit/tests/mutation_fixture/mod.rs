use std::sync::Arc;

use openengine_cluster_protocol::StopMode;
use openengine_cluster_testkit::admission::InMemoryAdmissionStore;
use openengine_cluster_testkit::lifecycle::stop;

use crate::admission_support::FixtureClient;
use crate::lifecycle_support::running;

/// A terminal run: `running()` immediately force-stopped, reaching `Phase::Finished` at
/// generation 1. Shared by mutation methods (resubmit, delete) that require a terminal
/// retained run (or, for delete, an empty cluster) to mutate from.
pub async fn terminal_run() -> (FixtureClient, Arc<InMemoryAdmissionStore>) {
    let (client, store) = running().await;
    client
        .stop(stop(StopMode::Force, 1, "terminal-run-fixture"))
        .await
        .expect("fixture force-stop reaches a terminal run");
    (client, store)
}
