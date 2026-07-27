//! Unit-level `ObservationStore`/`WatchEventStream` contract tests against a minimal fixture
//! store, independent of the testkit's `InMemoryAdmissionStore`.

use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, GetParams, GetResult, InitializeParams, InitializeResult, RunId,
    ServerCapabilities, SubscriptionCloseReason, WatchEvent, WatchParams, INVALID_PHASE,
};
use openengine_cluster_server::watch::fixtures::{FixtureBackend, FixtureStore};
use openengine_cluster_server::watch::WatchStreamItem;
use openengine_cluster_server::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};

/// Every test below either doesn't care about the exact overflow point or drives it through this
/// fixed capacity directly against the backend; only [`queue_overflow_closes_with_slow_consumer_and_the_last_delivered_cursor`]
/// needs a capacity of exactly `1`, which it selects at [`FixtureStore::new`].
const AMPLE_CAPACITY: usize = 8;

struct BareBackend;

#[async_trait]
impl ClusterBackend for BareBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Ok(GetResult {
            spec: None,
            status: ClusterStatus::empty(),
            at_cursor: None,
        })
    }
}

#[tokio::test]
async fn default_watch_is_unsupported_unless_the_backend_overrides_it() {
    let dispatcher = Dispatcher::new(BareBackend, ConnectionContext::default());
    let Err(error) = dispatcher.watch(WatchParams::default()).await else {
        panic!("expected the default watch implementation to be unsupported");
    };
    assert_eq!(error.code, INVALID_PHASE);
}

#[tokio::test]
async fn watch_replays_seeded_history_then_switches_to_live_delivery() {
    let run_id = RunId::new("run-1");
    let store = Arc::new(FixtureStore::new(
        run_id.clone(),
        vec![WatchEvent::Bookmark, WatchEvent::Bookmark],
        AMPLE_CAPACITY,
    ));
    let dispatcher = Dispatcher::new(
        FixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );

    let (result, mut stream, _handle) = dispatcher.watch(WatchParams::default()).await.unwrap();
    assert_eq!(result.run_id, Some(run_id.clone()));
    assert_eq!(result.at_cursor, Some(Cursor::new("cursor-2")));

    let first = stream.next().await.unwrap();
    let WatchStreamItem::Record(record) = first else {
        panic!("expected a replayed record");
    };
    assert_eq!(record.cursor, Cursor::new("cursor-1"));

    let second = stream.next().await.unwrap();
    let WatchStreamItem::Record(record) = second else {
        panic!("expected a replayed record");
    };
    assert_eq!(record.cursor, Cursor::new("cursor-2"));

    store.publish(WatchEvent::Bookmark).await;
    let live = stream.next().await.unwrap();
    let WatchStreamItem::Record(record) = live else {
        panic!("expected a live record");
    };
    assert_eq!(record.cursor, Cursor::new("cursor-3"));
}

#[tokio::test]
async fn dropping_the_handle_cancels_without_delivering_more_events() {
    let run_id = RunId::new("run-1");
    let store = Arc::new(FixtureStore::new(
        run_id,
        vec![WatchEvent::Bookmark, WatchEvent::Bookmark],
        AMPLE_CAPACITY,
    ));
    let dispatcher = Dispatcher::new(
        FixtureBackend::new(Arc::clone(&store)),
        ConnectionContext::default(),
    );

    let (_result, mut stream, handle) = dispatcher.watch(WatchParams::default()).await.unwrap();
    drop(handle);
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn queue_overflow_closes_with_slow_consumer_and_the_last_delivered_cursor() {
    let run_id = RunId::new("run-1");
    let store = Arc::new(FixtureStore::new(run_id.clone(), Vec::new(), 1));
    let context = ConnectionContext::default();
    let backend = FixtureBackend::new(Arc::clone(&store));
    let (result, mut stream, _handle) = backend
        .watch(&context, WatchParams::default(), AMPLE_CAPACITY)
        .await
        .unwrap();
    assert_eq!(result.run_id, Some(run_id));
    assert_eq!(result.at_cursor, None);

    store.publish(WatchEvent::Bookmark).await;
    store.publish(WatchEvent::Bookmark).await;

    let first = stream.next().await.unwrap();
    let WatchStreamItem::Record(record) = first else {
        panic!("expected the first buffered record");
    };
    assert_eq!(record.cursor, Cursor::new("cursor-1"));

    let closed = stream.next().await.unwrap();
    assert_eq!(
        closed,
        WatchStreamItem::Closed {
            reason: SubscriptionCloseReason::SlowConsumer,
            last_delivered_cursor: Some(Cursor::new("cursor-1")),
        }
    );
}
