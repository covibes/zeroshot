//! Shared default-dispatcher constructor for `logs`/`agent_attach` tests that exercise their
//! `ClusterBackend` default (capability-disabled) implementation.

use std::sync::Arc;

use openengine_cluster_protocol::RunId;
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};
use openengine_cluster_server::{ConnectionContext, Dispatcher};

/// A [`Dispatcher`] over the `watch`-only [`FixtureBackend`], used by `logs`/`agent_attach` tests
/// to exercise their `ClusterBackend` default (capability-disabled) implementation: this backend
/// overrides neither, so any call falls straight through to the trait's `INVALID_PHASE` default.
pub fn bare_watch_dispatcher(queue_capacity: usize) -> Dispatcher<FixtureBackend> {
    let store = Arc::new(FixtureStore::new(
        RunId::new("run-1"),
        Vec::new(),
        queue_capacity,
    ));
    Dispatcher::new(FixtureBackend::new(store), ConnectionContext::default())
}
