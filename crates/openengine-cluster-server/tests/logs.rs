//! Unit-level `LogStore`/`LogEventStream` contract tests against a minimal fixture store,
//! independent of the testkit's `InMemoryAdmissionStore`.

use std::sync::Arc;

use openengine_cluster_protocol::{
    BoundedLogTarget, BoundedLogMessage, LogLevel, LogRecord, LogsParams, SubscriptionCloseReason,
    INVALID_PHASE,
};
use openengine_cluster_server::logs::fixtures::{LogsFixtureBackend, LogsFixtureStore};
use openengine_cluster_server::logs::LogStreamItem;
use openengine_cluster_server::watch::fixtures::FixtureBackend as WatchFixtureBackend;
use openengine_cluster_server::watch::fixtures::FixtureStore as WatchFixtureStore;
use openengine_cluster_server::{ClusterBackend, ConnectionContext, Dispatcher};

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
    let store = Arc::new(WatchFixtureStore::new(
        openengine_cluster_protocol::RunId::new("run-1"),
        Vec::new(),
        AMPLE_CAPACITY,
    ));
    let dispatcher = Dispatcher::new(
        WatchFixtureBackend::new(store),
        ConnectionContext::default(),
    );
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
    let LogStreamItem::Record(record) = item else {
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
    let LogStreamItem::Record(record) = first else {
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
