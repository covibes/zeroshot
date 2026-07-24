//! Typed in-process `logs` subscription client. Wraps a [`Dispatcher`] directly since NDJSON/
//! WebSocket subscription framing is bound by a later issue. No dedup or reconnect logic exists
//! here -- `logs` has no cursor to resume from.

use openengine_cluster_protocol::{LogsParams, LogsResult};
use openengine_cluster_server::logs::{LogEventStream, LogsHandle};
use openengine_cluster_server::{BackendError, ClusterBackend, Dispatcher};

/// Typed in-process `logs` client. Wraps a [`Dispatcher`] directly since NDJSON/WebSocket
/// subscription framing is bound by a later issue.
pub struct LogsClient<B> {
    dispatcher: Dispatcher<B>,
}

impl<B> LogsClient<B>
where
    B: ClusterBackend,
{
    #[must_use]
    pub const fn new(dispatcher: Dispatcher<B>) -> Self {
        Self { dispatcher }
    }

    pub async fn logs(
        &self,
        params: LogsParams,
    ) -> Result<(LogsResult, LogEventStream, LogsHandle), BackendError> {
        self.dispatcher.logs(params).await
    }
}
