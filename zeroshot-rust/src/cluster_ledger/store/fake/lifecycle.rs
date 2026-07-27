use super::{FakeLedgerStore, FakeState, ManualLedgerClock};
use crate::cluster_ledger::store::{FailPoint, LedgerClock};
use std::sync::{Arc, Mutex};

impl FakeLedgerStore {
    #[must_use]
    pub fn new(clock: impl LedgerClock + 'static) -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeState::default())),
            clock: Arc::new(clock),
        }
    }

    #[must_use]
    pub fn with_shared_clock(clock: Arc<dyn LedgerClock>) -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeState::default())),
            clock,
        }
    }

    #[must_use]
    pub fn restart(&self) -> Self {
        self.clone()
    }

    pub fn fail_next(&self, point: FailPoint) {
        self.state
            .lock()
            .expect("fake ledger mutex must not be poisoned")
            .next_failpoint = Some(point);
    }
}

impl Default for FakeLedgerStore {
    fn default() -> Self {
        Self::new(ManualLedgerClock::new(0))
    }
}
