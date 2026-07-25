//! Minimal single-run `ObservationStore`/`ClusterBackend` fixture for exercising the watch port
//! contract independent of `openengine-cluster-testkit`'s production-shaped
//! `InMemoryAdmissionStore`. Shared by this crate's own integration tests and by
//! `openengine-cluster-client`'s reconnect tests so both exercise identical
//! subscribe/replay/overflow semantics against one implementation. Also bundles [`spawn_ndjson`]/
//! [`spawn_websocket`] connection harnesses reused across this crate, the client crate, and the
//! testkit crate's own wire-transport tests.

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, Cursor, GetParams, GetResult, InitializeParams, InitializeResult, RunId,
    ServerCapabilities, SubscriptionId, WatchEvent, WatchParams, WatchResult,
};
use tokio::io::DuplexStream;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;

use super::{
    subscribe_and_stream, ObservationStore, PublicEventRecord, ReplayPageRequest,
    ResolvedSubscription, SubscribeRequest, WatchEventStream, WatchHandle,
};
use crate::admission::StoreError;
use crate::stdio::serve_ndjson;
use crate::websocket::{serve_websocket, websocket_config};
use crate::{BackendError, ClusterBackend, ConnectionContext, Dispatcher};

/// Wires `backend` to a fresh [`serve_ndjson`] task over an in-memory duplex pipe pair, returning
/// the pipe's client-facing write/read halves and the server task's join handle. Shared by this
/// crate's own NDJSON multiplexing tests and by `openengine-cluster-client`'s NDJSON reconnect and
/// cancel tests so both drive the exact same wiring against [`FixtureBackend`].
pub fn spawn_ndjson<B>(backend: B) -> (DuplexStream, DuplexStream, JoinHandle<io::Result<()>>)
where
    B: ClusterBackend,
{
    let (client_write, server_read) = tokio::io::duplex(1 << 16);
    let (server_write, client_read) = tokio::io::duplex(1 << 16);
    let dispatcher = Dispatcher::new(backend, ConnectionContext::default());
    let server = tokio::spawn(serve_ndjson(
        dispatcher,
        server_read,
        server_write,
        tokio::io::sink(),
    ));
    (client_write, client_read, server)
}

/// Awaits a [`spawn_ndjson`] server task's join handle within a short bound, panicking with a
/// descriptive message if it hangs, panicked, or returned an error. Shared by this crate's own
/// and `openengine-cluster-client`'s NDJSON tests for asserting deterministic shutdown.
pub async fn await_ndjson_shutdown(server: JoinHandle<io::Result<()>>) {
    tokio::time::timeout(std::time::Duration::from_secs(2), server)
        .await
        .expect("serve_ndjson task did not terminate within the timeout")
        .expect("serve_ndjson task panicked")
        .expect("serve_ndjson task returned an error");
}

/// Wires `backend` to a fresh [`serve_websocket`] task over an in-memory duplex pipe pair,
/// returning the pipe's already-handshaken client-facing [`WebSocketStream`] and the server task's
/// join handle. Shared by this crate's own WebSocket framing tests and by
/// `openengine-cluster-client`'s and `openengine-cluster-testkit`'s WebSocket transport tests so
/// all three drive the exact same wiring, mirroring [`spawn_ndjson`]'s role for the NDJSON
/// binding.
pub async fn spawn_websocket<B>(
    backend: B,
) -> (WebSocketStream<DuplexStream>, JoinHandle<io::Result<()>>)
where
    B: ClusterBackend,
{
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let dispatcher = Dispatcher::new(backend, ConnectionContext::default());
    let server = tokio::spawn(async move {
        let ws = tokio_tungstenite::accept_async_with_config(server_io, Some(websocket_config()))
            .await
            .expect("server handshake must succeed");
        serve_websocket(dispatcher, ws).await
    });
    let (client, _response) =
        tokio_tungstenite::client_async("ws://localhost/websocket", client_io)
            .await
            .expect("client handshake must succeed");
    (client, server)
}

/// Awaits a [`spawn_websocket`] server task's join handle within a short bound, panicking with a
/// descriptive message if it hangs, panicked, or returned an error. Shared by this crate's own and
/// `openengine-cluster-client`'s/`openengine-cluster-testkit`'s WebSocket tests for asserting
/// deterministic shutdown, mirroring [`await_ndjson_shutdown`].
pub async fn await_websocket_shutdown(server: JoinHandle<io::Result<()>>) {
    tokio::time::timeout(std::time::Duration::from_secs(2), server)
        .await
        .expect("serve_websocket task did not terminate within the timeout")
        .expect("serve_websocket task panicked")
        .expect("serve_websocket task returned an error");
}

#[derive(Default)]
struct FixtureState {
    history: Vec<PublicEventRecord>,
    live: Vec<(mpsc::Sender<PublicEventRecord>, Arc<AtomicBool>)>,
}

/// A single run's durable history plus live subscriber fan-out. Every subscription registered
/// against this store is bounded by `capacity` (fixed at construction), irrespective of the
/// `queue_capacity` a caller passes to [`ObservationStore::subscribe`] — this lets a test force a
/// deterministic overflow regardless of which layer (a production `Dispatcher`'s hardcoded
/// default, or an explicit direct backend call) established the subscription.
pub struct FixtureStore {
    run_id: RunId,
    capacity: usize,
    state: Mutex<FixtureState>,
}

impl FixtureStore {
    #[must_use]
    pub fn new(run_id: RunId, seed: Vec<WatchEvent>, capacity: usize) -> Self {
        let history = seed
            .into_iter()
            .enumerate()
            .map(|(index, event)| PublicEventRecord {
                run_id: run_id.clone(),
                cursor: Cursor::new(format!("cursor-{}", index + 1)),
                event,
            })
            .collect();
        Self {
            run_id,
            capacity: capacity.max(1),
            state: Mutex::new(FixtureState {
                history,
                live: Vec::new(),
            }),
        }
    }

    pub async fn publish(&self, event: WatchEvent) -> Cursor {
        let mut state = self.state.lock().await;
        let cursor = Cursor::new(format!("cursor-{}", state.history.len() + 1));
        let record = PublicEventRecord {
            run_id: self.run_id.clone(),
            cursor: cursor.clone(),
            event,
        };
        state.history.push(record.clone());
        fan_out(&mut state, &record);
        cursor
    }

    /// Redelivers the last recorded event to every live subscriber without allocating a new
    /// cursor, simulating a legal at-least-once physical retry.
    pub async fn republish_last(&self) {
        let mut state = self.state.lock().await;
        let Some(record) = state.history.last().cloned() else {
            return;
        };
        fan_out(&mut state, &record);
    }

    pub async fn history_cursors(&self) -> Vec<Cursor> {
        self.state
            .lock()
            .await
            .history
            .iter()
            .map(|record| record.cursor.clone())
            .collect()
    }
}

fn fan_out(state: &mut FixtureState, record: &PublicEventRecord) {
    state.live.retain(
        |(sender, overflowed)| match sender.try_send(record.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                overflowed.store(true, Ordering::Release);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        },
    );
}

#[async_trait]
impl ObservationStore for FixtureStore {
    async fn subscribe(
        &self,
        request: SubscribeRequest,
        _queue_capacity: usize,
    ) -> Result<ResolvedSubscription, StoreError> {
        if let Some(run_id) = &request.run_id {
            if run_id != &self.run_id {
                return Err(StoreError::UnknownRun);
            }
        }
        let mut state = self.state.lock().await;
        let replay_through = state.history.last().map(|record| record.cursor.clone());
        let (sender, receiver) = mpsc::channel(self.capacity);
        let overflowed = Arc::new(AtomicBool::new(false));
        state.live.push((sender, Arc::clone(&overflowed)));
        Ok(ResolvedSubscription {
            run_id: Some(self.run_id.clone()),
            at_cursor: replay_through.clone(),
            resume_after: request.from_cursor,
            replay_through,
            receiver,
            overflowed,
        })
    }

    async fn replay_page(
        &self,
        request: ReplayPageRequest<'_>,
    ) -> Result<Vec<PublicEventRecord>, StoreError> {
        if request.run_id != &self.run_id {
            return Err(StoreError::UnknownRun);
        }
        let state = self.state.lock().await;
        let start = match request.after {
            Some(after) => state
                .history
                .iter()
                .position(|record| &record.cursor == after)
                .map_or(0, |index| index + 1),
            None => 0,
        };
        let mut page = Vec::new();
        for record in state.history.iter().skip(start) {
            let reached_through = &record.cursor == request.through;
            page.push(record.clone());
            if page.len() >= request.limit || reached_through {
                break;
            }
        }
        Ok(page)
    }
}

/// Wraps a [`FixtureStore`] as a minimal [`ClusterBackend`]; `initialize`/`get` return an empty
/// status since these fixtures exist only to exercise `watch`.
pub struct FixtureBackend {
    pub store: Arc<FixtureStore>,
    next_subscription_id: AtomicU64,
}

impl FixtureBackend {
    #[must_use]
    pub fn new(store: Arc<FixtureStore>) -> Self {
        Self {
            store,
            next_subscription_id: AtomicU64::new(1),
        }
    }
}

#[async_trait]
impl ClusterBackend for FixtureBackend {
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

    async fn watch(
        &self,
        _context: &ConnectionContext,
        params: WatchParams,
        queue_capacity: usize,
    ) -> Result<(WatchResult, WatchEventStream, WatchHandle), BackendError> {
        let store: Arc<dyn ObservationStore> = Arc::clone(&self.store) as Arc<dyn ObservationStore>;
        let subscription_id = SubscriptionId::new(format!(
            "sub-{}",
            self.next_subscription_id.fetch_add(1, Ordering::Relaxed)
        ));
        subscribe_and_stream(
            &store,
            super::SubscribeAndStreamRequest {
                subscription_id,
                params,
                queue_capacity,
            },
            |_| BackendError::application("NOT_FOUND", "run not found", None),
        )
        .await
    }
}
