//! Cross-transport equivalence: the WebSocket binding from #651 must reproduce the exact same
//! watch transcript (cursor progression and event algebra) as the in-process `Dispatcher::watch`
//! passthrough from #647 and the NDJSON binding from #745 (see `protocol_ndjson.rs`), while
//! sharing its connection with ordinary unary traffic and honoring `subscription/cancel`. Also
//! proves independently accepted WebSocket connections receive stable injected identities while
//! tenant sharing or isolation remains exactly the shared backend's decision.

use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{ClusterClient, WatchSubscriptionClient, WebSocketTransport};
use openengine_cluster_protocol::{
    ApplyParams, ApplyResult, GetParams, GetResult, InitializeParams, InitializeResult, StopMode,
    WatchParams,
};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::identity::{
    BindingAttributes, ConnectionBinding, ConnectionIdentity, ConnectionIdentityConfig,
    PrincipalId, StaticConnectionIdentityResolver, SystemConnectionTime, TenantId,
};
use openengine_cluster_server::watch::fixtures::{await_websocket_shutdown, spawn_websocket};
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, graph_fixture, InMemoryAdmissionStore, ScriptedOutcome,
    ScriptedVerifier,
};
use openengine_cluster_testkit::lifecycle::stop;
use serde_json::Value;

#[path = "admission_support/committed.rs"]
mod committed_support;
use committed_support::committed;

#[path = "protocol_transcript_support/mod.rs"]
mod protocol_transcript_support;
use protocol_transcript_support::{
    assert_cancel_probe_leak_model, assert_transcripts_match, collect_transcript,
    in_process_side_transcript,
};

#[tokio::test]
async fn websocket_watch_transcript_matches_in_process_and_shares_its_connection() {
    let graph = graph_fixture("worker", serde_json::json!({"kind":"null"}));

    let in_process_events = in_process_side_transcript(&graph).await;

    // WebSocket side, against a fresh in-process duplex-backed `serve_websocket` connection wired
    // the same way as `protocol_ndjson.rs`'s subprocess-backed NDJSON side.
    let verifier = Arc::new(ScriptedVerifier::new(vec![ScriptedOutcome::approve(
        compiled_from_graph_fixture(&graph),
        vec![],
    )]));
    let store = Arc::new(InMemoryAdmissionStore::default());
    let backend = AdmissionCoordinator::from_shared(verifier, store);
    let (ws, server) = spawn_websocket(backend).await;

    let transport = WebSocketTransport::new(ws);
    let ws_client = ClusterClient::new(&transport);
    ws_client.initialize().await.unwrap();
    let ws_watch = WatchSubscriptionClient::new(&transport);

    let (_parked, mut ws_stream) = ws_watch.watch(WatchParams::default()).await.unwrap();

    // AC: `subscription/cancel` releases only the cancelled subscription. A second, still-parked
    // subscription is cancelled immediately; it must observe nothing further even though it would
    // otherwise park-attach to the very run committed below.
    let (_parked, cancel_probe) = ws_watch.watch(WatchParams::default()).await.unwrap();
    cancel_probe.cancel().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    let apply_result = ws_client
        .apply(committed(
            graph.clone(),
            Value::Null,
            0,
            "websocket-wire-create",
        ))
        .await
        .unwrap();
    let generation = apply_result.generation.unwrap().get();
    // AC: a unary request completes correctly while the watch subscription is actively
    // streaming on the same connection.
    let get_result = ws_client.get(GetParams::default()).await.unwrap();
    assert_eq!(get_result.spec, Some(graph.clone()));
    ws_client
        .stop(stop(StopMode::Drain, generation, "websocket-wire-stop"))
        .await
        .unwrap();
    let ws_events = collect_transcript!(ws_stream);

    assert_transcripts_match(&in_process_events, &ws_events);
    assert_cancel_probe_leak_model(cancel_probe, &ws_events[0].cursor).await;

    drop(ws_stream);
    drop(transport);
    await_websocket_shutdown(server).await;
}

/// Wires a shared backend to one accepted WebSocket connection. The binding resolves the supplied
/// tenant exactly once before it decodes a frame; sharing or partitioning remains backend-owned.
async fn spawn_websocket_with_shared_backend<B>(
    backend: Arc<B>,
    tenant: &str,
) -> (
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
    tokio::task::JoinHandle<std::io::Result<()>>,
)
where
    B: ClusterBackend,
{
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let identity = ConnectionIdentity::new(ConnectionIdentityConfig {
        principal: PrincipalId::new(format!("principal-for-{tenant}")),
        tenant: TenantId::new(tenant.to_owned()),
        issued_at_ms: Some(1),
        expires_at_ms: u64::MAX,
        binding_attributes: BindingAttributes::default(),
    });
    let binding = ConnectionBinding::new(
        backend,
        StaticConnectionIdentityResolver::new(identity),
        SystemConnectionTime,
        Default::default(),
    );
    let server = tokio::spawn(async move {
        let ws = tokio_tungstenite::accept_async_with_config(
            server_io,
            Some(openengine_cluster_server::websocket::websocket_config()),
        )
        .await
        .expect("server handshake must succeed");
        openengine_cluster_server::websocket::serve_websocket(binding, ws).await
    });
    let (client, _response) =
        tokio_tungstenite::client_async("ws://localhost/websocket", client_io)
            .await
            .expect("client handshake must succeed");
    (client, server)
}

#[tokio::test]
async fn same_tenant_connections_share_backend_cas_and_idempotency() {
    let graph = graph_fixture("worker", serde_json::json!({"kind":"null"}));
    let verifier = Arc::new(ScriptedVerifier::new(vec![ScriptedOutcome::approve(
        compiled_from_graph_fixture(&graph),
        vec![],
    )]));
    let store = Arc::new(InMemoryAdmissionStore::default());
    let backend = Arc::new(AdmissionCoordinator::from_shared(verifier, store));

    let (conn_a, server_a) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "tenant-shared").await;
    let (conn_b, server_b) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "tenant-shared").await;

    let transport_a = WebSocketTransport::new(conn_a);
    let transport_b = WebSocketTransport::new(conn_b);
    let client_a = ClusterClient::new(&transport_a);
    let client_b = ClusterClient::new(&transport_b);

    client_a.initialize().await.unwrap();
    client_b.initialize().await.unwrap();

    // Connection A commits the run.
    let apply_a = client_a
        .apply(committed(
            graph.clone(),
            Value::Null,
            0,
            "shared-backend-create",
        ))
        .await
        .unwrap();
    assert!(!apply_a.deduped);

    // The backend shares one CAS/idempotency domain for this tenant across both connections.
    let apply_b = client_b
        .apply(committed(
            graph.clone(),
            Value::Null,
            0,
            "shared-backend-create",
        ))
        .await
        .unwrap();
    assert!(apply_b.deduped);
    assert_eq!(apply_b.generation, apply_a.generation);
    assert_eq!(apply_b.run_id, apply_a.run_id);

    // Identity is stable per connection, while state ownership remains with the shared backend.
    let get_a = client_a.get(GetParams::default()).await.unwrap();
    let get_b = client_b.get(GetParams::default()).await.unwrap();
    assert_eq!(get_a.spec, Some(graph.clone()));
    assert_eq!(get_a, get_b);

    drop(transport_a);
    drop(transport_b);
    await_websocket_shutdown(server_a).await;
    await_websocket_shutdown(server_b).await;
}

type FixtureCoordinator = AdmissionCoordinator<ScriptedVerifier, InMemoryAdmissionStore>;

struct TenantPartitioningBackend {
    tenant_a: FixtureCoordinator,
    tenant_b: FixtureCoordinator,
}

impl TenantPartitioningBackend {
    fn select(&self, context: &ConnectionContext) -> &FixtureCoordinator {
        match context.identity().tenant().as_str() {
            "tenant-a" => &self.tenant_a,
            "tenant-b" => &self.tenant_b,
            tenant => panic!("unexpected fixture tenant {tenant}"),
        }
    }
}

#[async_trait]
impl ClusterBackend for TenantPartitioningBackend {
    async fn initialize(
        &self,
        context: &ConnectionContext,
        params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        self.select(context).initialize(context, params).await
    }

    async fn apply(
        &self,
        context: &ConnectionContext,
        params: ApplyParams,
    ) -> Result<ApplyResult, BackendError> {
        self.select(context).apply(context, params).await
    }

    async fn get(
        &self,
        context: &ConnectionContext,
        params: GetParams,
    ) -> Result<GetResult, BackendError> {
        self.select(context).get(context, params).await
    }
}

#[tokio::test]
async fn distinct_tenants_share_state_when_backend_does_not_partition() {
    let graph = graph_fixture("worker", serde_json::json!({"kind":"null"}));
    let verifier = Arc::new(ScriptedVerifier::new(vec![ScriptedOutcome::approve(
        compiled_from_graph_fixture(&graph),
        vec![],
    )]));
    let store = Arc::new(InMemoryAdmissionStore::default());
    let backend = Arc::new(AdmissionCoordinator::from_shared(verifier, store));
    let (conn_a, server_a) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "tenant-a").await;
    let (conn_b, server_b) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "tenant-b").await;
    let transport_a = WebSocketTransport::new(conn_a);
    let transport_b = WebSocketTransport::new(conn_b);
    let client_a = ClusterClient::new(&transport_a);
    let client_b = ClusterClient::new(&transport_b);
    client_a.initialize().await.unwrap();
    client_b.initialize().await.unwrap();

    let first = client_a
        .apply(committed(
            graph.clone(),
            Value::Null,
            0,
            "non-partitioning-key",
        ))
        .await
        .unwrap();
    let second = client_b
        .apply(committed(
            graph.clone(),
            Value::Null,
            0,
            "non-partitioning-key",
        ))
        .await
        .unwrap();
    assert!(!first.deduped);
    assert!(second.deduped);
    assert_eq!(
        client_b.get(GetParams::default()).await.unwrap().spec,
        Some(graph)
    );

    drop(transport_a);
    drop(transport_b);
    await_websocket_shutdown(server_a).await;
    await_websocket_shutdown(server_b).await;
}

#[tokio::test]
async fn distinct_tenants_are_isolated_only_when_backend_partitions() {
    let graph_a = graph_fixture("worker-a", serde_json::json!({"kind":"null"}));
    let graph_b = graph_fixture("worker-b", serde_json::json!({"kind":"null"}));
    let backend = Arc::new(TenantPartitioningBackend {
        tenant_a: AdmissionCoordinator::new(
            ScriptedVerifier::new(vec![ScriptedOutcome::approve(
                compiled_from_graph_fixture(&graph_a),
                vec![],
            )]),
            InMemoryAdmissionStore::default(),
        ),
        tenant_b: AdmissionCoordinator::new(
            ScriptedVerifier::new(vec![ScriptedOutcome::approve(
                compiled_from_graph_fixture(&graph_b),
                vec![],
            )]),
            InMemoryAdmissionStore::default(),
        ),
    });
    let (conn_a, server_a) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "tenant-a").await;
    let (conn_b, server_b) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "tenant-b").await;
    let transport_a = WebSocketTransport::new(conn_a);
    let transport_b = WebSocketTransport::new(conn_b);
    let client_a = ClusterClient::new(&transport_a);
    let client_b = ClusterClient::new(&transport_b);
    client_a.initialize().await.unwrap();
    client_b.initialize().await.unwrap();

    let first = client_a
        .apply(committed(graph_a.clone(), Value::Null, 0, "same-key"))
        .await
        .unwrap();
    assert!(!first.deduped);
    assert_eq!(client_b.get(GetParams::default()).await.unwrap().spec, None);

    let second = client_b
        .apply(committed(graph_b.clone(), Value::Null, 0, "same-key"))
        .await
        .unwrap();
    assert!(!second.deduped);
    assert_eq!(
        client_a.get(GetParams::default()).await.unwrap().spec,
        Some(graph_a)
    );
    assert_eq!(
        client_b.get(GetParams::default()).await.unwrap().spec,
        Some(graph_b)
    );

    drop(transport_a);
    drop(transport_b);
    await_websocket_shutdown(server_a).await;
    await_websocket_shutdown(server_b).await;
}
