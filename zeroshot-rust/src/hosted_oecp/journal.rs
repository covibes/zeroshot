use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use openengine_cluster_protocol::{Cursor, RunId, WatchEvent};
use openengine_cluster_server::admission::StoreError;
use openengine_cluster_server::watch::{
    ObservationStore, PublicEventRecord, ReplayPageRequest, ResolvedSubscription, SubscribeRequest,
};
use tokio::sync::mpsc;

pub const MAX_JOURNAL_EVENTS: usize = 16;
pub const MAX_JOURNAL_EVENT_BYTES: usize = 16 * 1024;
pub const MAX_JOURNAL_SUBSCRIBERS: usize = 32;
pub const MAX_LIVE_QUEUE_CAPACITY: usize = 64;

#[derive(Default)]
struct JournalHistory(Vec<PublicEventRecord>);

impl JournalHistory {
    fn is_full(&self) -> bool {
        self.0.len() >= MAX_JOURNAL_EVENTS
    }

    fn push(&mut self, record: PublicEventRecord) {
        self.0.push(record);
    }

    fn first_cursor(&self) -> Option<Cursor> {
        self.0.first().map(|record| record.cursor.clone())
    }

    fn last_cursor(&self) -> Option<Cursor> {
        self.0.last().map(|record| record.cursor.clone())
    }

    fn contains(&self, cursor: &Cursor) -> bool {
        self.0.iter().any(|record| &record.cursor == cursor)
    }

    fn position(&self, cursor: &Cursor) -> Result<usize, StoreError> {
        self.0
            .iter()
            .position(|record| &record.cursor == cursor)
            .ok_or_else(|| self.gone())
    }

    fn gone(&self) -> StoreError {
        StoreError::RunGone {
            tombstoned_at: self.first_cursor(),
        }
    }

    fn page(
        &self,
        after: Option<&Cursor>,
        through: &Cursor,
        limit: usize,
    ) -> Result<Vec<PublicEventRecord>, StoreError> {
        let through = self.position(through)?;
        let start = after.map_or(Ok(0), |cursor| self.position(cursor).map(|index| index + 1))?;
        if start > through {
            return Ok(Vec::new());
        }
        Ok(self.0[start..=through]
            .iter()
            .take(limit.min(MAX_JOURNAL_EVENTS))
            .cloned()
            .collect())
    }
}

struct LiveSubscriber {
    sender: mpsc::Sender<PublicEventRecord>,
    overflowed: Arc<AtomicBool>,
}

impl LiveSubscriber {
    fn deliver(&self, record: &PublicEventRecord) -> bool {
        match self.sender.try_send(record.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.overflowed.store(true, Ordering::Release);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    fn is_open(&self) -> bool {
        !self.sender.is_closed()
    }
}

#[derive(Default)]
struct JournalState {
    sequence: u64,
    run_id: Option<RunId>,
    history: JournalHistory,
    live: Vec<LiveSubscriber>,
    closed: bool,
}

impl JournalState {
    fn ensure_publishable(&self, run_id: &RunId) -> Result<(), StoreError> {
        if self.closed || self.history.is_full() {
            return Err(StoreError::Internal(
                "hosted journal no longer accepts events".to_owned(),
            ));
        }
        if self
            .run_id
            .as_ref()
            .is_some_and(|current| current != run_id)
        {
            return Err(StoreError::RunConflict {
                current: self.run_id.clone(),
            });
        }
        Ok(())
    }

    fn fan_out(&mut self, record: &PublicEventRecord) {
        self.live.retain(|subscriber| subscriber.deliver(record));
    }

    fn validate_subscription(&mut self, request: &SubscribeRequest) -> Result<(), StoreError> {
        if self.closed {
            return Err(StoreError::RunGone {
                tombstoned_at: self.history.last_cursor(),
            });
        }
        if request
            .run_id
            .as_ref()
            .is_some_and(|requested| self.run_id.as_ref() != Some(requested))
        {
            return Err(StoreError::UnknownRun);
        }
        if request
            .from_cursor
            .as_ref()
            .is_some_and(|cursor| !self.history.contains(cursor))
        {
            return Err(self.history.gone());
        }
        self.live.retain(LiveSubscriber::is_open);
        if self.live.len() >= MAX_JOURNAL_SUBSCRIBERS {
            return Err(StoreError::Internal(
                "hosted journal subscriber capacity is exhausted".to_owned(),
            ));
        }
        Ok(())
    }
}

pub struct EventJournal {
    state: Mutex<JournalState>,
}

impl EventJournal {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Mutex::new(JournalState::default()),
        }
    }

    pub fn publish_with(
        &self,
        run_id: RunId,
        event: impl FnOnce(&Cursor) -> WatchEvent,
    ) -> Result<Cursor, StoreError> {
        let mut state = self.lock();
        state.ensure_publishable(&run_id)?;
        let sequence = state.sequence.checked_add(1).ok_or_else(|| {
            StoreError::Internal("hosted journal cursor space exhausted".to_owned())
        })?;
        let cursor = Cursor::new(format!("hosted-event-{sequence:016x}"));
        let event = event(&cursor);
        ensure_event_bound(&event)?;
        let record = PublicEventRecord {
            run_id: run_id.clone(),
            cursor: cursor.clone(),
            event,
        };
        state.sequence = sequence;
        state.run_id = Some(run_id);
        state.history.push(record.clone());
        state.fan_out(&record);
        Ok(cursor)
    }

    pub fn close(&self) {
        let mut state = self.lock();
        state.closed = true;
        state.live.clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JournalState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for EventJournal {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ObservationStore for EventJournal {
    async fn subscribe(
        &self,
        request: SubscribeRequest,
        queue_capacity: usize,
    ) -> Result<ResolvedSubscription, StoreError> {
        let mut state = self.lock();
        state.validate_subscription(&request)?;
        let replay_through = state.history.last_cursor();
        let capacity = queue_capacity.clamp(1, MAX_LIVE_QUEUE_CAPACITY);
        let (sender, receiver) = mpsc::channel(capacity);
        let overflowed = Arc::new(AtomicBool::new(false));
        state.live.push(LiveSubscriber {
            sender,
            overflowed: Arc::clone(&overflowed),
        });
        Ok(ResolvedSubscription {
            receiver,
            overflowed,
            resume_after: request.from_cursor,
            run_id: state.run_id.clone(),
            replay_through: replay_through.clone(),
            at_cursor: replay_through,
        })
    }

    async fn replay_page(
        &self,
        request: ReplayPageRequest<'_>,
    ) -> Result<Vec<PublicEventRecord>, StoreError> {
        let state = self.lock();
        if state.run_id.as_ref() != Some(request.run_id) {
            return Err(StoreError::UnknownRun);
        }
        state
            .history
            .page(request.after, request.through, request.limit)
    }
}

fn ensure_event_bound(event: &WatchEvent) -> Result<(), StoreError> {
    let event_bytes = serde_json::to_vec(event)
        .map_err(|_| StoreError::Internal("public event serialization failed".to_owned()))?;
    if event_bytes.len() > MAX_JOURNAL_EVENT_BYTES {
        Err(StoreError::Internal(
            "public event exceeded the hosted journal bound".to_owned(),
        ))
    } else {
        Ok(())
    }
}
