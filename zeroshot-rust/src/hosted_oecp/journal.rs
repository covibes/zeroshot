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
    live: Vec<(mpsc::Sender<PublicEventRecord>, Arc<AtomicBool>)>,
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
        let replay_through = state.history.last().map(|record| record.cursor.clone());
        let (sender, receiver) = mpsc::channel(queue_capacity.max(1));
        let overflowed = Arc::new(AtomicBool::new(false));
        state.live.push((sender, Arc::clone(&overflowed)));
        Ok(ResolvedSubscription {
            run_id: state.run_id.clone(),
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
        let state = self.state.lock().await;
        if state.run_id.as_ref() != Some(request.run_id) {
            return Err(StoreError::UnknownRun);
        }
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
            let reached_tail = &record.cursor == request.through;
            page.push(record.clone());
            if page.len() >= request.limit || reached_tail {
                break;
            }
        }
        Ok(page)
    }
}
