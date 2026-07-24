//! Unit-level `LogStore`/`LogEventStream` contract tests against a minimal fixture store,
//! independent of the testkit's `InMemoryAdmissionStore`.

use std::sync::Arc;
use std::time::Duration;

use openengine_cluster_protocol::{
    BoundedLogTarget, BoundedLogMessage, LogLevel, LogRecord, LogsParams, SubscriptionCloseReason,
    SubscriptionId, INVALID_PHASE, MAX_LOG_EVENT_ENCODED_BYTES,
};
use openengine_cluster_server::logs::fixtures::{LogsFixtureBackend, LogsFixtureStore};
use openengine_cluster_server::logs::{subscribe_and_stream_logs, LogStore, LogStreamItem};
use openengine_cluster_server::watch::fixtures::{await_ndjson_shutdown, spawn_ndjson};
use openengine_cluster_server::{ClusterBackend, ConnectionContext, Dispatcher};
use serde_json::json;
use tokio::io::BufReader;

#[path = "capability_default_support/mod.rs"]
mod capability_default_support;
#[path = "ndjson_test_support/mod.rs"]
mod ndjson_test_support;
#[path = "oversized_event_wire_support/mod.rs"]
mod oversized_event_wire_support;
#[path = "oversized_id_backend_support/mod.rs"]
mod oversized_id_backend_support;
use capability_default_support::bare_watch_dispatcher;
use oversized_event_wire_support::{
    assert_oversized_event_does_not_block_unary_responses, OversizedEventWire,
};
use oversized_id_backend_support::oversized_id_backend;

/// Every test below either doesn't care about the exact overflow point or drives it through this
/// fixed capacity directly against the backend; only
/// [`queue_overflow_closes_with_slow_consumer_and_carries_no_cursor`] needs a capacity of exactly
/// `1`, which it selects when calling `subscribe` directly.
const AMPLE_CAPACITY: usize = 8;

fn sample_log_record(message: &str) -> LogRecord {
    LogRecord {
        level: LogLevel::Info,
        target: BoundedLogTarget::new("worker-dispatch").expect("fixture target must be valid"),
        message: BoundedLogMessage::new(message).expect("fixture message must be valid"),
    }
}

#[tokio::test]
async fn default_logs_is_unsupported_unless_the_backend_overrides_it() {
    let dispatcher = bare_watch_dispatcher(AMPLE_CAPACITY);
    let Err(error) = dispatcher.logs(LogsParams::default()).await else {
        panic!("expected the default logs implementation to be unsupported");
    };
    assert_eq!(error.code, INVALID_PHASE);
}

#[tokio::test]
async fn logs_streams_only_future_records_no_replay() {
    let store = Arc::new(LogsFixtureStore::new());
    let dispatcher = Dispatcher::new(
        LogsFixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );

    // Published before the subscription is established: `logs` has no retained history, so this
    // must never be observed.
    store.publish(sample_log_record("before subscribing")).await;

    let (_result, mut stream, _handle) = dispatcher.logs(LogsParams::default()).await.unwrap();

    store.publish(sample_log_record("after subscribing")).await;
    let item = stream.next().await.unwrap();
    let LogStreamItem::Event(record) = item else {
        panic!("expected a live log record");
    };
    assert_eq!(record.message.as_str(), "after subscribing");
}

#[tokio::test]
async fn dropping_the_handle_cancels_without_delivering_more_events() {
    let store = Arc::new(LogsFixtureStore::new());
    let dispatcher = Dispatcher::new(
        LogsFixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );

    let (_result, mut stream, handle) = dispatcher.logs(LogsParams::default()).await.unwrap();
    drop(handle);
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn cancelling_wakes_an_already_pending_idle_next_call() {
    let store = Arc::new(LogsFixtureStore::new());
    let dispatcher = Dispatcher::new(
        LogsFixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );

    let (_result, mut stream, handle) = dispatcher.logs(LogsParams::default()).await.unwrap();
    let pending = tokio::spawn(async move { stream.next().await });

    // Give the spawned task time to actually park inside `receiver.recv().await` before
    // cancelling, so this exercises the already-pending-idle path rather than the
    // not-yet-blocked `consume_cancellation()` check at the top of `next()`.
    tokio::time::sleep(Duration::from_millis(50)).await;
    handle.cancel();

    let result = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .expect("cancellation must wake an already-pending idle next() call within 1s");
    assert_eq!(result.unwrap(), None);
}

#[tokio::test]
async fn queue_overflow_closes_with_slow_consumer_and_carries_no_cursor() {
    let store = Arc::new(LogsFixtureStore::new());
    let context = ConnectionContext::default();
    let backend = LogsFixtureBackend::new(Arc::clone(&store));
    let (_result, mut stream, _handle) = backend
        .logs(&context, LogsParams::default(), 1)
        .await
        .unwrap();

    store.publish(sample_log_record("first")).await;
    store.publish(sample_log_record("second")).await;

    let first = stream.next().await.unwrap();
    let LogStreamItem::Event(record) = first else {
        panic!("expected the first buffered record");
    };
    assert_eq!(record.message.as_str(), "first");

    let closed = stream.next().await.unwrap();
    assert_eq!(
        closed,
        LogStreamItem::Closed {
            reason: SubscriptionCloseReason::SlowConsumer,
        }
    );
}

// A `logs`-only backend whose subscription id is deliberately pathologically large -- large
// enough on its own to push `LogEventNotification`'s encoded size over
// `MAX_LOG_EVENT_ENCODED_BYTES`, even though every `LogRecord` field is already bounded well
// under that ceiling. Delegates `initialize`/`get` to a wrapped `LogsFixtureBackend` and
// overrides only `logs`.
oversized_id_backend! {
    name: OversizedIdLogsBackend,
    inner: LogsFixtureBackend,
    method: logs,
    params: LogsParams,
    result: openengine_cluster_protocol::LogsResult,
    stream: openengine_cluster_server::logs::LogEventStream,
    handle: openengine_cluster_server::logs::LogsHandle,
    body: |self, _params, queue_capacity| {
        let store: Arc<dyn LogStore> = Arc::clone(&self.inner.store) as Arc<dyn LogStore>;
        let subscription_id = SubscriptionId::new("s".repeat(MAX_LOG_EVENT_ENCODED_BYTES));
        Ok(subscribe_and_stream_logs(&store, subscription_id, queue_capacity).await)
    },
}

#[tokio::test]
async fn oversized_event_encoding_ends_only_that_subscription_without_panicking() {
    let store = Arc::new(LogsFixtureStore::new());
    let (mut write, read, server) = spawn_ndjson(OversizedIdLogsBackend {
        inner: LogsFixtureBackend::new(Arc::clone(&store)),
    });
    let mut read = BufReader::new(read);

    // Encodes to well over `MAX_LOG_EVENT_ENCODED_BYTES` purely because of the backend's
    // pathologically large subscription id; the notification loop must drop it silently instead
    // of panicking the server task.
    assert_oversized_event_does_not_block_unary_responses(
        OversizedEventWire {
            write: &mut write,
            read: &mut read,
        },
        "logs",
        json!({}),
        || store.publish(sample_log_record("won't fit")),
    )
    .await;

    drop(write);
    await_ndjson_shutdown(server).await;
}
