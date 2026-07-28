use std::sync::Arc;

use openengine_cluster_protocol::{DispatchState, StopMode, INVALID_PHASE};
use openengine_cluster_server::lifecycle::{LifecycleEvent, TurnId};
use openengine_cluster_testkit::lifecycle::{delete, stop, suspend};

#[path = "admission_support/mod.rs"]
mod admission_support;
#[path = "lifecycle_support/mod.rs"]
mod lifecycle_support;
use admission_support::rpc_code;
use lifecycle_support::running;

#[tokio::test]
async fn lifecycle_concurrent_first_use_and_drain_force_race_serialize() {
    let (client, store) = running().await;
    let client = Arc::new(client);

    let first = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.update(suspend(1, "race-update")).await })
    };
    let second = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.update(suspend(1, "race-update")).await })
    };
    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_ne!(first.deduped, second.deduped);
    assert_eq!(first.at_cursor, second.at_cursor);
    assert_eq!(
        store
            .inspect()
            .await
            .lifecycle
            .records
            .iter()
            .filter(|record| matches!(record.event, LifecycleEvent::Updated { .. }))
            .count(),
        1
    );

    client
        .update(openengine_cluster_testkit::lifecycle::resume(1, "resume"))
        .await
        .unwrap();
    store.acquire_dispatch(TurnId::new("turn")).await.unwrap();
    let drain = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.stop(stop(StopMode::Drain, 1, "race-drain")).await })
    };
    let force = {
        let client = Arc::clone(&client);
        tokio::spawn(async move { client.stop(stop(StopMode::Force, 1, "race-force")).await })
    };
    for result in [drain.await.unwrap(), force.await.unwrap()] {
        if let Err(error) = result {
            assert_eq!(rpc_code(error), INVALID_PHASE);
        }
    }
    let effects = store.inspect().await;
    assert_eq!(
        effects
            .lifecycle
            .operational
            .as_ref()
            .unwrap()
            .dispatch_state,
        DispatchState::Stopped
    );
    assert_eq!(
        effects.lifecycle.operational.as_ref().unwrap().stop_mode,
        Some(StopMode::Force)
    );
    assert_eq!(
        effects
            .lifecycle
            .records
            .iter()
            .filter(|record| matches!(record.event, LifecycleEvent::Finished { .. }))
            .count(),
        1
    );
    assert!(matches!(
        effects.lifecycle.records.last().unwrap().event,
        LifecycleEvent::Finished {
            mode: StopMode::Force
        }
    ));
}

#[tokio::test]
async fn delete_concurrent_competing_keys_serialize_exactly_one_winner() {
    let (client, store) = running().await;
    client
        .stop(stop(StopMode::Force, 1, "delete-race-fixture"))
        .await
        .expect("fixture force-stop reaches a terminal run");
    // Arms the cleanup fence so the winning delete holds `Deleting` instead of finalizing
    // immediately, which is what lets the loser observe a non-terminal phase (INVALID_PHASE)
    // rather than a reset-generation conflict.
    store.arm_pending_cleanup().await;
    let client = Arc::new(client);

    let first = {
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            client
                .delete(delete(1, Some("run-1"), "delete-race-a"))
                .await
        })
    };
    let second = {
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            client
                .delete(delete(1, Some("run-1"), "delete-race-b"))
                .await
        })
    };
    let first = first.await.unwrap();
    let second = second.await.unwrap();

    let results = [first, second];
    let winners = results.iter().filter(|result| result.is_ok()).count();
    assert_eq!(
        winners, 1,
        "exactly one competing delete call must win the fence"
    );
    for result in results {
        match result {
            Ok(result) => {
                assert!(!result.deleted);
                assert_eq!(result.phase, openengine_cluster_protocol::Phase::Deleting);
                assert!(!result.deduped);
            }
            Err(error) => assert_eq!(rpc_code(error), INVALID_PHASE),
        }
    }
}
