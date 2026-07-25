//! Cross-transport equivalence: the WebSocket binding from #651 must reproduce the exact same
//! watch transcript (cursor progression and event algebra) as the in-process `Dispatcher::watch`
//! passthrough from #647 and the NDJSON binding from #745 (see `protocol_ndjson.rs`), while
//! sharing its connection with ordinary unary traffic and honoring `subscription/cancel`. Also
//! proves two independently-authorized WebSocket connections sharing one backend (AC3) preserve
//! CAS/idempotency and cannot observe each other's injected `ConnectionContext`, since
//! `ConnectionContext` is constructed once per connection and never derived from protocol params.

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{ClusterClient, WatchSubscriptionClient, WebSocketTransport};
use openengine_cluster_protocol::{GetParams, StopMode, WatchParams};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::watch::fixtures::{await_websocket_shutdown, spawn_websocket};
use openengine_cluster_server::{ClusterBackend, ConnectionContext, Dispatcher};
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

/// Wires `backend` to a fresh [`openengine_cluster_server::websocket::serve_websocket`] task over
/// an in-memory duplex pipe pair, injecting `peer_label` into that connection's
/// [`ConnectionContext`] -- unlike [`spawn_websocket`], which always uses
/// [`Dispatcher::new`]/[`ConnectionContext::default`], this uses
/// [`Dispatcher::from_shared`] so multiple independently-authorized connections can share one
/// backend, exactly as AC3 requires.
async fn spawn_websocket_with_shared_backend<B>(
    backend: Arc<B>,
    peer_label: &str,
) -> (
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
    tokio::task::JoinHandle<std::io::Result<()>>,
)
where
    B: ClusterBackend,
{
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let dispatcher = Dispatcher::from_shared(
        backend,
        ConnectionContext {
            peer_label: Some(peer_label.to_owned()),
            ..ConnectionContext::default()
        },
    );
    let server = tokio::spawn(async move {
        let ws = tokio_tungstenite::accept_async_with_config(
            server_io,
            Some(openengine_cluster_server::websocket::websocket_config()),
        )
        .await
        .expect("server handshake must succeed");
        openengine_cluster_server::websocket::serve_websocket(dispatcher, ws).await
    });
    let (client, _response) =
        tokio_tungstenite::client_async("ws://localhost/websocket", client_io)
            .await
            .expect("client handshake must succeed");
    (client, server)
}

#[tokio::test]
async fn two_websocket_connections_share_one_backend_with_isolated_context_and_shared_idempotency()
{
    let graph = graph_fixture("worker", serde_json::json!({"kind":"null"}));
    let verifier = Arc::new(ScriptedVerifier::new(vec![ScriptedOutcome::approve(
        compiled_from_graph_fixture(&graph),
        vec![],
    )]));
    let store = Arc::new(InMemoryAdmissionStore::default());
    let backend = Arc::new(AdmissionCoordinator::from_shared(verifier, store));

    let (conn_a, server_a) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "connection-a").await;
    let (conn_b, server_b) =
        spawn_websocket_with_shared_backend(Arc::clone(&backend), "connection-b").await;

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

    // AC3: connection B replays the exact same idempotency key/params and dedups against A's
    // commit, proving CAS/idempotency state is shared across independently-authorized connections
    // on one backend rather than partitioned per connection.
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

    // AC3: both connections observe the same committed spec via `get`, independent of which
    // connection created it -- `ConnectionContext` carries no route/tenant field that could
    // partition visibility between them.
    let get_a = client_a.get(GetParams::default()).await.unwrap();
    let get_b = client_b.get(GetParams::default()).await.unwrap();
    assert_eq!(get_a.spec, Some(graph.clone()));
    assert_eq!(get_a, get_b);

    drop(transport_a);
    drop(transport_b);
    await_websocket_shutdown(server_a).await;
    await_websocket_shutdown(server_b).await;
}
