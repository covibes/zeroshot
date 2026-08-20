//! Transport-neutral, cursorless, future-only agent-attach event streaming and subscription
//! cancellation. Unlike [`crate::logs`], establishing a subscription is fallible: the caller's
//! [`ExecutionRef`] must resolve to a live execution.

pub mod fixtures;
pub mod ports;

use std::sync::Arc;

use openengine_cluster_protocol::{
    AgentAttachEvent, AgentAttachParams, AgentAttachResult, ExecutionRef, SubscriptionId,
    DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY, GONE, NOT_FOUND,
};

pub use ports::{AgentAttachStore, AgentAttachStoreError, AgentAttachSubscription};

use crate::subscription_stream::{BoundedEventHandle, BoundedEventStream, BoundedStreamItem};
use crate::{BackendError, ClusterBackend, Dispatcher};

/// One item yielded by [`AgentAttachEventStream`]: either a live progress event, or a terminal
/// slow-consumer close (overflow). Ordinary cancellation (dropping [`AgentAttachHandle`]) yields
/// no `Closed` item -- the stream simply stops.
pub type AgentAttachStreamItem = BoundedStreamItem<AgentAttachEvent>;

/// A single bounded live receiver with no buffering or replay -- unlike a durable observation
/// store, `agent/attach` has no retained history to page through.
pub type AgentAttachEventStream = BoundedEventStream<AgentAttachEvent>;

/// Drop-to-cancel subscription handle. Cancellation only affects live-subscriber bookkeeping; it
/// never mutates admission or lifecycle cluster state.
pub type AgentAttachHandle = BoundedEventHandle;

/// Parameters for [`subscribe_and_stream_agent_attach`], grouped to keep that function's argument
/// count reasonable.
pub struct SubscribeAndStreamAgentAttachRequest {
    pub execution: ExecutionRef,
    pub subscription_id: SubscriptionId,
    pub queue_capacity: usize,
}

/// Canonical [`AgentAttachStoreError`] -> [`BackendError`] mapping: `UnknownExecution` and a
/// wrong-cluster `ExecutionRef` are indistinguishable at the store layer, so both surface as
/// `NOT_FOUND`; `InactiveExecution` surfaces as `GONE`. Neither carries the private execution
/// identity in `details`. Every [`ClusterBackend::agent_attach`] implementation in this crate
/// (production and test fixtures alike) uses this same mapping.
#[must_use]
pub fn default_agent_attach_error_mapping(error: AgentAttachStoreError) -> BackendError {
    match error {
        AgentAttachStoreError::UnknownExecution => {
            BackendError::application(NOT_FOUND, "execution not found", None)
        }
        AgentAttachStoreError::InactiveExecution => {
            BackendError::application(GONE, "execution is no longer active", None)
        }
    }
}

/// Establishes a subscription against `store` for `request.execution` and wraps it as an
/// [`AgentAttachEventStream`]. Shared by every [`ClusterBackend::agent_attach`] implementation
/// (production and test fixtures alike); callers supply `map_err` since how an
/// [`AgentAttachStoreError`] maps to a [`BackendError`] is backend-specific in principle, even
/// though every implementation in this crate happens to use
/// [`default_agent_attach_error_mapping`].
pub async fn subscribe_and_stream_agent_attach(
    store: &Arc<dyn AgentAttachStore>,
    request: SubscribeAndStreamAgentAttachRequest,
    map_err: impl FnOnce(AgentAttachStoreError) -> BackendError,
) -> Result<(AgentAttachResult, AgentAttachEventStream, AgentAttachHandle), BackendError> {
    let SubscribeAndStreamAgentAttachRequest {
        execution,
        subscription_id,
        queue_capacity,
    } = request;
    let subscription = store
        .subscribe(&execution, queue_capacity)
        .await
        .map_err(map_err)?;
    let result = AgentAttachResult { subscription_id };
    let (stream, handle) =
        AgentAttachEventStream::new(subscription.receiver, subscription.overflowed);
    Ok((result, stream, handle))
}

impl<B> Dispatcher<B>
where
    B: ClusterBackend,
{
    /// Non-NDJSON passthrough to the backend's `agent/attach` subscription. NDJSON `agent/attach`/
    /// `subscription/cancel` line framing lives in `stdio/agent_attach.rs`; this only exposes the
    /// typed in-process subscription surface.
    pub async fn agent_attach(
        &self,
        params: AgentAttachParams,
    ) -> Result<(AgentAttachResult, AgentAttachEventStream, AgentAttachHandle), BackendError> {
        self.backend()
            .agent_attach(self.context(), params, DEFAULT_SUBSCRIPTION_QUEUE_CAPACITY)
            .await
    }
}
