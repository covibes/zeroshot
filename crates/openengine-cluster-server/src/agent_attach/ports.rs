//! Transport-neutral, cursorless, future-only agent-attach subscription store contract.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{AgentAttachEvent, ExecutionRef};
use tokio::sync::mpsc;

/// A freshly registered live agent-attach subscription: a bounded receiver plus the overflow flag
/// the store sets if this subscription's queue ever fills.
pub struct AgentAttachSubscription {
    pub receiver: mpsc::Receiver<AgentAttachEvent>,
    pub overflowed: Arc<AtomicBool>,
}

/// Errors a store can return when resolving an [`ExecutionRef`]. Unlike [`crate::logs::LogStore`],
/// `agent/attach` is scoped to a single execution that must resolve -- a per-cluster-scoped store
/// cannot and must not distinguish an unknown ref from one that belongs to another cluster, since
/// both must map to the exact same [`UnknownExecution`](AgentAttachStoreError::UnknownExecution)
/// no-leak response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentAttachStoreError {
    UnknownExecution,
    InactiveExecution,
}

/// Backend-neutral, cursorless, future-only agent-attach observation port. There is no retained
/// history to replay: a subscriber only ever observes events published after it registers.
#[async_trait]
pub trait AgentAttachStore: Send + Sync {
    async fn subscribe(
        &self,
        execution: &ExecutionRef,
        queue_capacity: usize,
    ) -> Result<AgentAttachSubscription, AgentAttachStoreError>;
}
