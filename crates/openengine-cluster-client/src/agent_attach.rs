//! Typed in-process `agent/attach` subscription client. Wraps a [`Dispatcher`] directly since
//! NDJSON/WebSocket subscription framing is bound by a later issue. No dedup or reconnect logic
//! exists here -- `agent/attach` has no cursor to resume from.

use openengine_cluster_protocol::{AgentAttachParams, AgentAttachResult};
use openengine_cluster_server::agent_attach::{AgentAttachEventStream, AgentAttachHandle};
use openengine_cluster_server::{BackendError, ClusterBackend, Dispatcher};

/// Typed in-process `agent/attach` client. Wraps a [`Dispatcher`] directly since NDJSON/WebSocket
/// subscription framing is bound by a later issue.
pub struct AgentAttachClient<B> {
    dispatcher: Dispatcher<B>,
}

impl<B> AgentAttachClient<B>
where
    B: ClusterBackend,
{
    #[must_use]
    pub const fn new(dispatcher: Dispatcher<B>) -> Self {
        Self { dispatcher }
    }

    pub async fn agent_attach(
        &self,
        params: AgentAttachParams,
    ) -> Result<(AgentAttachResult, AgentAttachEventStream, AgentAttachHandle), BackendError> {
        self.dispatcher.agent_attach(params).await
    }
}
