//! Generates the `ClusterBackend` wrapper used only to test that an oversized/unencodable
//! subscription event ends its own subscription without panicking the server task. `logs` and
//! `agent_attach` need byte-for-byte the same "delegate `initialize`/`get` to a fixture backend,
//! override only the capability under test to mint a pathologically large subscription id" shape,
//! so it is generated once via this macro (mirroring
//! `openengine_cluster_client::ndjson_subscription::impl_ndjson_event_subscription`'s
//! generate-once-per-capability approach) rather than hand-copied per capability. Used by
//! `tests/logs.rs` and `tests/agent_attach.rs`.
macro_rules! oversized_id_backend {
    (
        name: $name:ident,
        inner: $inner_ty:ty,
        method: $method:ident,
        params: $params_ty:ty,
        result: $result_ty:ty,
        stream: $stream_ty:ty,
        handle: $handle_ty:ty,
        body: |$self_:ident, $params_ident:ident, $queue_capacity_ident:ident| $body:block,
    ) => {
        struct $name {
            inner: $inner_ty,
        }

        #[async_trait::async_trait]
        impl openengine_cluster_server::ClusterBackend for $name {
            async fn initialize(
                &self,
                context: &openengine_cluster_server::ConnectionContext,
                params: openengine_cluster_protocol::InitializeParams,
            ) -> Result<
                openengine_cluster_protocol::InitializeResult,
                openengine_cluster_server::BackendError,
            > {
                self.inner.initialize(context, params).await
            }

            async fn get(
                &self,
                context: &openengine_cluster_server::ConnectionContext,
                params: openengine_cluster_protocol::GetParams,
            ) -> Result<
                openengine_cluster_protocol::GetResult,
                openengine_cluster_server::BackendError,
            > {
                self.inner.get(context, params).await
            }

            async fn $method(
                &$self_,
                _context: &openengine_cluster_server::ConnectionContext,
                $params_ident: $params_ty,
                $queue_capacity_ident: usize,
            ) -> Result<
                ($result_ty, $stream_ty, $handle_ty),
                openengine_cluster_server::BackendError,
            >
            $body
        }
    };
}

pub(crate) use oversized_id_backend;
