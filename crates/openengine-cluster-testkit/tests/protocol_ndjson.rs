//! Cross-transport equivalence: the NDJSON stdio binding from #745 must reproduce the exact same
//! watch transcript (cursor progression and event algebra) as the in-process `Dispatcher::watch`
//! passthrough from #647, while sharing its connection with ordinary unary traffic and honoring
//! `subscription/cancel`. Reuses the same `CARGO_BIN_EXE_openengine-cluster-stdio` subprocess and
//! two-instance comparison pattern as `protocol_v1.rs`'s
//! `admission_transcript_matches_in_process_and_stdio`.

use std::time::Duration;

use openengine_cluster_client::{ClusterClient, NdjsonTransport, NdjsonWatchClient};
use openengine_cluster_protocol::{GetParams, StopMode, WatchParams};
use openengine_cluster_testkit::admission::graph_fixture;
use openengine_cluster_testkit::lifecycle::stop;
use serde_json::Value;

#[path = "admission_support/committed.rs"]
mod committed_support;
use committed_support::committed;

#[path = "stdio_subprocess_support/mod.rs"]
mod stdio_subprocess_support;

#[path = "protocol_transcript_support/mod.rs"]
mod protocol_transcript_support;
use protocol_transcript_support::{
    assert_cancel_probe_leak_model, assert_transcripts_match, collect_transcript,
    in_process_side_transcript,
};

#[tokio::test]
async fn ndjson_watch_transcript_matches_in_process_and_shares_its_connection() {
    let graph = graph_fixture("worker", serde_json::json!({"kind":"null"}));

    let in_process_events = in_process_side_transcript(&graph).await;

    // NDJSON side, against a fresh subprocess wired the same way (see
    // `openengine-cluster-testkit/src/bin/openengine-cluster-stdio.rs`).
    let (subprocess, stdin, stdout) = stdio_subprocess_support::spawn();
    let transport = NdjsonTransport::new(stdout, stdin);
    let ndjson_client = ClusterClient::new(&transport);
    ndjson_client.initialize().await.assert_value();
    let ndjson_watch = NdjsonWatchClient::new(&transport);

    let (_parked, mut ndjson_stream) = ndjson_watch
        .watch(WatchParams::default())
        .await
        .assert_value();

    // AC: `subscription/cancel` releases only the cancelled subscription. A second, still-parked
    // subscription is cancelled immediately; it must observe nothing further even though it would
    // otherwise park-attach to the very run committed below.
    let (_parked, cancel_probe) = ndjson_watch
        .watch(WatchParams::default())
        .await
        .assert_value();
    cancel_probe.cancel().await.assert_value();
    tokio::time::sleep(Duration::from_millis(50)).await;

    let apply_result = ndjson_client
        .apply(committed(
            graph.clone(),
            Value::Null,
            0,
            "ndjson-wire-create",
        ))
        .await
        .assert_value();
    let generation = apply_result.generation.assert_value().get();
    // AC: a unary request completes correctly while the watch subscription is actively
    // streaming on the same connection.
    let get_result = ndjson_client.get(GetParams::default()).await.assert_value();
    assert_eq!(get_result.spec, Some(graph.clone()));
    ndjson_client
        .stop(stop(StopMode::Drain, generation, "ndjson-wire-stop"))
        .await
        .assert_value();
    let ndjson_events = collect_transcript!(ndjson_stream);

    assert_transcripts_match(&in_process_events, &ndjson_events);
    assert_cancel_probe_leak_model(cancel_probe, &ndjson_events.assert_at(0).cursor).await;

    drop(ndjson_stream);
    drop(transport);
    subprocess.join().await;
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
