//! Shared cross-transport watch-transcript scenario used identically by `protocol_ndjson.rs` (the
//! NDJSON binding from #745) and `protocol_websocket.rs` (the WebSocket binding from #651) to
//! prove each wire binding reproduces the exact same watch transcript (cursor progression and
//! event algebra) as the in-process `Dispatcher::watch` passthrough from #647, while sharing its
//! connection with ordinary unary traffic and honoring `subscription/cancel`.

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_client::{
    ClusterClient, EventOrClosed, InProcessTransport, SubscriptionTransport, WatchClient,
    WatchSubscriptionEventStream,
};
use openengine_cluster_protocol::{Cursor, GetParams, GraphSpec, StopMode, WatchParams};
use openengine_cluster_server::admission::AdmissionCoordinator;
use openengine_cluster_server::watch::PublicEventRecord;
use openengine_cluster_server::{ConnectionContext, Dispatcher};
use openengine_cluster_testkit::admission::{
    compiled_from_graph_fixture, InMemoryAdmissionStore, ScriptedOutcome, ScriptedVerifier,
};
use openengine_cluster_testkit::lifecycle::stop;
use serde_json::Value;

use crate::committed_support::committed;

/// Collects [`EventOrClosed`]s from `stream` until (and including) `Finished`, panicking if the
/// stream closes first. Uses fully-qualified paths (rather than relying on this module's own
/// `use` imports) since `macro_rules!` item-path resolution follows the invocation site, and this
/// macro is invoked from sibling test-binary crates via `pub(crate) use`.
macro_rules! collect_transcript {
    ($stream:expr) => {{
        let mut events = Vec::new();
        loop {
            match $stream.next().await.expect("stream ended before Finished") {
                ::openengine_cluster_client::EventOrClosed::Event(record) => {
                    let finished = matches!(
                        record.event,
                        ::openengine_cluster_protocol::WatchEvent::Finished { .. }
                    );
                    events.push(record);
                    if finished {
                        break;
                    }
                }
                ::openengine_cluster_client::EventOrClosed::Closed { reason, .. } => {
                    panic!("stream closed ({reason:?}) before the Finished event was observed")
                }
            }
        }
        events
    }};
}
pub(crate) use collect_transcript;

/// Runs one apply/get/stop lifecycle against a fresh in-process backend while a `watch`
/// subscription streams on the same dispatcher, returning its collected transcript.
pub async fn in_process_side_transcript(graph: &GraphSpec) -> Vec<PublicEventRecord> {
    let compiled = compiled_from_graph_fixture(graph);
    let verifier = Arc::new(ScriptedVerifier::new(vec![ScriptedOutcome::approve(
        compiled,
        vec![],
    )]));
    let store = Arc::new(InMemoryAdmissionStore::default());
    let backend = AdmissionCoordinator::from_shared(verifier, store);
    let dispatcher = Dispatcher::new(backend, ConnectionContext::default());
    let in_process_client = ClusterClient::new(InProcessTransport::new(dispatcher.clone()));
    in_process_client.initialize().await.unwrap();
    let in_process_watch = WatchClient::new(dispatcher);

    let (_parked, mut in_process_stream, _handle) = in_process_watch
        .watch(WatchParams::default())
        .await
        .unwrap();

    let apply_result = in_process_client
        .apply(committed(
            graph.clone(),
            Value::Null,
            0,
            "in-process-create",
        ))
        .await
        .unwrap();
    let generation = apply_result.generation.unwrap().get();
    // AC: a unary request completes correctly while the watch subscription is actively
    // streaming on the same connection.
    let get_result = in_process_client.get(GetParams::default()).await.unwrap();
    assert_eq!(get_result.spec, Some(graph.clone()));
    in_process_client
        .stop(stop(StopMode::Drain, generation, "in-process-stop"))
        .await
        .unwrap();
    collect_transcript!(in_process_stream)
}

pub fn assert_transcripts_match(in_process: &[PublicEventRecord], wire: &[PublicEventRecord]) {
    assert_eq!(in_process.len(), wire.len());
    for (in_process, wire) in in_process.iter().zip(wire.iter()) {
        assert_eq!(in_process.cursor, wire.cursor);
        assert_eq!(in_process.event, wire.event);
    }
}

/// Asserts the at-most-one-post-cancel-leak model for a subscription cancelled before its run was
/// ever committed to: the server-side subscription task may already have been parked awaiting the
/// next live event at the moment cancellation was processed, so at most one further event (the
/// commit's own first event, immediately following cancellation) may still leak through before it
/// observes cancellation on its next poll and stops for good. Generic over any
/// [`SubscriptionTransport`]-backed [`WatchSubscriptionEventStream`] (NDJSON's
/// `NdjsonReconnectingEventStream` alias and WebSocket's binding both are this exact generic type),
/// so both wire bindings share this exact scenario logic rather than duplicating it per transport.
pub async fn assert_cancel_probe_leak_model<'a, T>(
    mut cancel_probe: WatchSubscriptionEventStream<'a, T>,
    first_committed_cursor: &Cursor,
) where
    T: SubscriptionTransport,
{
    let mut leaked = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(300), cancel_probe.next()).await {
            Ok(Some(EventOrClosed::Event(record))) => leaked.push(record),
            Ok(Some(other)) => panic!("unexpected notification after cancel: {other:?}"),
            Ok(None) | Err(_) => break,
        }
    }
    assert!(
        leaked.len() <= 1,
        "cancelled probe subscription received more than one post-cancel event: {leaked:?}"
    );
    if let Some(record) = leaked.first() {
        assert_eq!(
            record.cursor, *first_committed_cursor,
            "cancellation failed to stop delivery before the run's first committed event"
        );
    }
}
