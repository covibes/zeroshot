use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use openengine_cluster_server::graph_verifier::FULL_V1_MAX_NODE_EXECUTIONS;

use crate::execution::process::HostedProcessPool;

#[derive(Clone)]
pub(super) struct ActiveRunProcessPools {
    seed: HostedProcessPool,
    occupied: Arc<Mutex<BTreeSet<u32>>>,
}

impl ActiveRunProcessPools {
    pub(super) fn new(seed: HostedProcessPool) -> Result<Self, IdentityLeaseUnavailable> {
        seed.active_run_slot(0, FULL_V1_MAX_NODE_EXECUTIONS)
            .map_err(|_| IdentityLeaseUnavailable)?;
        Ok(Self {
            seed,
            occupied: Arc::new(Mutex::new(BTreeSet::new())),
        })
    }

    pub(super) fn acquire(&self) -> Result<ActiveRunProcessPool, IdentityLeaseUnavailable> {
        let mut occupied = self.occupied.lock().map_err(|_| IdentityLeaseUnavailable)?;
        let mut slot = 0_u32;
        for current in occupied.iter().copied() {
            if current != slot {
                break;
            }
            slot = slot.checked_add(1).ok_or(IdentityLeaseUnavailable)?;
        }
        let process_pool = self
            .seed
            .active_run_slot(slot, FULL_V1_MAX_NODE_EXECUTIONS)
            .map_err(|_| IdentityLeaseUnavailable)?;
        occupied.insert(slot);
        Ok(ActiveRunProcessPool {
            slot,
            process_pool,
            occupied: self.occupied.clone(),
        })
    }
}

pub(super) struct ActiveRunProcessPool {
    slot: u32,
    process_pool: HostedProcessPool,
    occupied: Arc<Mutex<BTreeSet<u32>>>,
}

impl ActiveRunProcessPool {
    pub(super) const fn process_pool(&self) -> HostedProcessPool {
        self.process_pool
    }
}

impl Drop for ActiveRunProcessPool {
    fn drop(&mut self) {
        let mut occupied = self
            .occupied
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        occupied.remove(&self.slot);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct IdentityLeaseUnavailable;

#[cfg(test)]
mod tests {
    use openengine_cluster_testkit::assertions::AssertValue;

    use crate::execution::process::{HostedProcessPool, HostedProcessScope};

    use super::ActiveRunProcessPools;

    #[test]
    fn active_leases_are_disjoint_and_the_released_slot_is_reused() {
        let pools = ActiveRunProcessPools::new(
            HostedProcessPool::new(10_002, 10_002, 20_000, 20_000).assert_value(),
        )
        .assert_value();
        let first = pools.acquire().assert_value();
        let second = pools.acquire().assert_value();
        let first_uid = writer_uid(first.process_pool());
        let second_uid = writer_uid(second.process_pool());
        assert_ne!(first_uid, second_uid);

        drop(first);
        let replacement = pools.acquire().assert_value();
        assert_eq!(writer_uid(replacement.process_pool()), first_uid);
        assert_eq!(writer_uid(second.process_pool()), second_uid);
    }

    #[test]
    fn exhausted_identity_space_rejects_the_lease() {
        assert!(
            ActiveRunProcessPools::new(
                HostedProcessPool::new(10_002, 10_002, u32::MAX - 1, 20_000).assert_value(),
            )
            .is_err()
        );
    }

    fn writer_uid(pool: HostedProcessPool) -> u32 {
        pool.identity(HostedProcessScope::Writer)
            .assert_value()
            .uid()
    }
}
