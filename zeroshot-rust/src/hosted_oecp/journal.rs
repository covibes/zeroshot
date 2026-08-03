use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use async_trait::async_trait;
use openengine_cluster_protocol::{Cursor, RunId, WatchEvent};
use openengine_cluster_server::{
    admission::StoreError,
    watch::{
        ObservationStore, PublicEventRecord, ReplayPageRequest, ResolvedSubscription,
        SubscribeRequest,
    },
};
use tokio::sync::{mpsc, Mutex};

#[derive(Default)]
struct JournalState {
    run_id: Option<RunId>,
    history: Vec<PublicEventRecord>,
    live: Vec<LiveSubscriber>,
}

struct LiveSubscriber {
    sender: mpsc::Sender<PublicEventRecord>,
    overflowed: Arc<AtomicBool>,
}

impl LiveSubscriber {
    fn deliver(self, record: &PublicEventRecord) -> Option<Self> {
        match self.sender.try_send(record.clone()) {
            Ok(()) => Some(self),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.overflowed.store(true, Ordering::Release);
                None
            }
            Err(mpsc::error::TrySendError::Closed(_)) => None,
        }
    }
}

impl JournalState {
    fn broadcast(&mut self, record: &PublicEventRecord) {
        self.live = std::mem::take(&mut self.live)
            .into_iter()
            .filter_map(|subscriber| subscriber.deliver(record))
            .collect();
    }

    fn subscribe(
        &mut self,
        request: SubscribeRequest,
        queue_capacity: usize,
    ) -> ResolvedSubscription {
        let replay_through = self.history.last().map(|record| record.cursor.clone());
        let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
        let overflowed = Arc::new(AtomicBool::new(false));
        self.live.push(LiveSubscriber {
            sender,
            overflowed: Arc::clone(&overflowed),
        });
        ResolvedSubscription {
            run_id: self.run_id.clone(),
            at_cursor: replay_through.clone(),
            resume_after: request.from_cursor,
            replay_through,
            receiver,
            overflowed,
        }
    }
}

pub struct EventJournal {
    sequence: AtomicU64,
    state: Mutex<JournalState>,
}

impl EventJournal {
    #[must_use]
    pub fn new() -> Self {
        Self {
            sequence: AtomicU64::new(1),
            state: Mutex::new(JournalState::default()),
        }
    }

    pub async fn publish(&self, run_id: RunId, event: WatchEvent) -> Cursor {
        let cursor = Cursor::new(format!(
            "event-{}",
            self.sequence.fetch_add(1, Ordering::Relaxed)
        ));
        let record = PublicEventRecord {
            run_id: run_id.clone(),
            cursor: cursor.clone(),
            event,
        };
        let mut state = self.state.lock().await;
        state.run_id = Some(run_id);
        state.history.push(record.clone());
        state.broadcast(&record);
        cursor
    }
}

#[async_trait]
impl ObservationStore for EventJournal {
    async fn subscribe(
        &self,
        request: SubscribeRequest,
        queue_capacity: usize,
    ) -> Result<ResolvedSubscription, StoreError> {
        let mut state = self.state.lock().await;
        if let (Some(requested), Some(current)) = (&request.run_id, &state.run_id) {
            if requested != current {
                return Err(StoreError::UnknownRun);
            }
        }
        Ok(state.subscribe(request, queue_capacity))
    }

    async fn replay_page(
        &self,
        request: ReplayPageRequest<'_>,
    ) -> Result<Vec<PublicEventRecord>, StoreError> {
        let state = self.state.lock().await;
        if state.run_id.as_ref() != Some(request.run_id) {
            return Err(StoreError::UnknownRun);
        }
        Ok(replay_window(
            &state.history,
            request.after,
            request.through,
            request.limit,
        ))
    }
}

fn replay_window(
    history: &[PublicEventRecord],
    after: Option<&Cursor>,
    through: &Cursor,
    limit: usize,
) -> Vec<PublicEventRecord> {
    let start = after
        .and_then(|cursor| history.iter().position(|record| &record.cursor == cursor))
        .map_or(0, |index| index + 1);
    let remaining = &history[start..];
    let through_end = remaining
        .iter()
        .position(|record| &record.cursor == through)
        .map_or(remaining.len(), |index| index + 1);
    remaining[..through_end.min(limit.max(1))].to_vec()
}
