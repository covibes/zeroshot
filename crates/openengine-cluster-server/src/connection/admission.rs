//! Bounded per-connection request admission.

use std::collections::HashSet;
use std::sync::Arc;

use openengine_cluster_protocol::{DomainErrorData, RequestId, APPLICATION_ERROR, INVALID_REQUEST};
use parking_lot::Mutex;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};

use super::serialize_error;
use crate::SERVER_BUSY;

/// Maximum concurrent backend dispatch/subscription tasks per connection. Shared verbatim with
/// the sibling `websocket` transport module.
pub(crate) const MAX_CONNECTION_TASKS: usize = 256;
const DUPLICATE_REQUEST_ID: &str = "DUPLICATE_REQUEST_ID";

pub(crate) type InFlightIds = Arc<Mutex<HashSet<RequestId>>>;

/// Registers `id` as in flight, or reports that it was already in flight.
pub(crate) async fn reject_duplicate(
    in_flight_ids: &InFlightIds,
    outbound_tx: &mpsc::Sender<String>,
    id: RequestId,
) -> bool {
    let inserted = in_flight_ids.lock().insert(id.clone());
    if inserted {
        return false;
    }
    let _ = outbound_tx
        .send(serialize_error(
            Some(id),
            INVALID_REQUEST,
            "Invalid Request",
            Some(DomainErrorData::new(DUPLICATE_REQUEST_ID)),
        ))
        .await;
    true
}

/// Acquires one task slot. Excess requests receive a deterministic application error;
/// notifications have no JSON-RPC response and are dropped.
pub(crate) async fn acquire_task_slot(
    task_slots: &Arc<Semaphore>,
    outbound_tx: &mpsc::Sender<String>,
    id: Option<RequestId>,
) -> Option<OwnedSemaphorePermit> {
    match Arc::clone(task_slots).try_acquire_owned() {
        Ok(permit) => Some(permit),
        Err(_) => {
            if let Some(id) = id {
                let _ = outbound_tx
                    .send(serialize_error(
                        Some(id),
                        APPLICATION_ERROR,
                        "Server busy",
                        Some(DomainErrorData::new(SERVER_BUSY)),
                    ))
                    .await;
            }
            None
        }
    }
}
