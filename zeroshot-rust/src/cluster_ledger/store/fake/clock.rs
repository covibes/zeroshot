use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::super::{LedgerClock, StoreError};

#[derive(Clone, Debug)]
pub struct ManualLedgerClock {
    now_ms: Arc<AtomicU64>,
}

impl ManualLedgerClock {
    #[must_use]
    pub fn new(now_ms: u64) -> Self {
        Self {
            now_ms: Arc::new(AtomicU64::new(now_ms)),
        }
    }

    pub fn set(&self, now_ms: u64) {
        self.now_ms.store(now_ms, Ordering::Release);
    }

    pub fn advance(&self, delta_ms: u64) -> Result<u64, StoreError> {
        self.now_ms
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_add(delta_ms)
            })
            .map(|previous| previous + delta_ms)
            .map_err(|_| StoreError::PositionOverflow)
    }
}

impl LedgerClock for ManualLedgerClock {
    fn now_ms(&self) -> u64 {
        self.now_ms.load(Ordering::Acquire)
    }
}
