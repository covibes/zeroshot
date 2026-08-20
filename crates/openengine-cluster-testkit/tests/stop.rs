use openengine_cluster_protocol::{DispatchState, GetParams, Phase, StopMode, INVALID_PHASE};
use openengine_cluster_server::lifecycle::{LifecycleEvent, TurnId, VerifiedCompletion};
use openengine_cluster_testkit::lifecycle::stop;
use serde_json::json;

#[path = "admission_support/mod.rs"]
mod admission_support;
#[path = "lifecycle_support/mod.rs"]
mod lifecycle_support;
use admission_support::rpc_code;
use lifecycle_support::running;

#[tokio::test]
async fn stop_drain_waits_for_all_in_flight_and_finishes_exactly_once() {
    let (client, store) = running().await;
    let first = store
        .acquire_dispatch(TurnId::new("first"))
        .await
        .assert_value();
    let second = store
        .acquire_dispatch(TurnId::new("second"))
        .await
        .assert_value();

    let acknowledged = client
        .stop(stop(StopMode::Drain, 1, "drain"))
        .await
        .assert_value();
    assert_eq!(acknowledged.phase, Phase::Running);
    assert_eq!(
        acknowledged.operational.dispatch_state,
        DispatchState::Draining
    );
    assert_eq!(acknowledged.operational.in_flight, 2);
    assert!(
        store
            .acquire_dispatch(TurnId::new("blocked"))
            .await
            .is_err()
    );

    let first_result = store
        .complete_dispatch(VerifiedCompletion {
            lease_id: first.lease_id,
            output: json!("first-output"),
        })
        .await
        .assert_value();
    assert!(!first_result.terminalized);
    let second_result = store
        .complete_dispatch(VerifiedCompletion {
            lease_id: second.lease_id,
            output: json!("second-output"),
        })
        .await
        .assert_value();
    assert!(second_result.terminalized);

    let finished = client.get(GetParams::default()).await.assert_value();
    assert_eq!(finished.status.phase, Phase::Finished);
    assert_eq!(
        finished.status.operational.assert_value().dispatch_state,
        DispatchState::Stopped
    );
    let before_replay = store.inspect().await;
    let replay = client
        .stop(stop(StopMode::Drain, 1, "drain"))
        .await
        .assert_value();
    assert!(replay.deduped);
    assert_eq!(store.inspect().await, before_replay);

    let events = &before_replay.lifecycle.records;
    assert_eq!(
        events
            .iter()
            .filter(|record| matches!(record.event, LifecycleEvent::Finished { .. }))
            .count(),
        1
    );
    assert!(matches!(
        events.last().assert_value().event,
        LifecycleEvent::Finished {
            mode: StopMode::Drain
        }
    ));
    assert_eq!(before_replay.lifecycle.verified_turns.len(), 2);
    assert!(before_replay.lifecycle.void_turns.is_empty());
}

#[tokio::test]
async fn stop_force_cancels_and_voids_without_fabricating_verified_output() {
    let (client, store) = running().await;
    let first = store
        .acquire_dispatch(TurnId::new("first"))
        .await
        .assert_value();
    let second = store
        .acquire_dispatch(TurnId::new("second"))
        .await
        .assert_value();
    let late_lease = first.lease_id.clone();

    let receipt = client
        .stop(stop(StopMode::Force, 1, "force"))
        .await
        .assert_value();
    assert_eq!(receipt.phase, Phase::Finished);
    assert_eq!(receipt.effective_mode, StopMode::Force);
    assert!(first.cancellation.is_cancelled());
    assert!(second.cancellation.is_cancelled());
    assert!(
        store
            .complete_dispatch(VerifiedCompletion {
                lease_id: late_lease,
                output: json!("must-not-land"),
            })
            .await
            .is_err()
    );

    let effects = store.inspect().await;
    assert!(effects.lifecycle.verified_turns.is_empty());
    assert_eq!(effects.lifecycle.void_turns.len(), 2);
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
        effects.lifecycle.records.last().assert_value().event,
        LifecycleEvent::Finished {
            mode: StopMode::Force
        }
    ));
}

#[tokio::test]
async fn force_escalates_drain_and_drain_never_weakens_force() {
    let (client, store) = running().await;
    let permit = store
        .acquire_dispatch(TurnId::new("turn"))
        .await
        .assert_value();
    client
        .stop(stop(StopMode::Drain, 1, "drain"))
        .await
        .assert_value();
    let force = client
        .stop(stop(StopMode::Force, 1, "force"))
        .await
        .assert_value();
    assert_eq!(force.effective_mode, StopMode::Force);
    assert_eq!(force.operational.stop_mode, Some(StopMode::Force));
    assert!(permit.cancellation.is_cancelled());
    assert_eq!(
        rpc_code(
            client
                .stop(stop(StopMode::Drain, 1, "late-drain"))
                .await
                .assert_error()
        ),
        INVALID_PHASE
    );
    let effects = store.inspect().await;
    assert_eq!(
        effects.lifecycle.operational.assert_value().stop_mode,
        Some(StopMode::Force)
    );
    assert!(matches!(
        effects.lifecycle.records.last().assert_value().event,
        LifecycleEvent::Finished {
            mode: StopMode::Force
        }
    ));
}

#[tokio::test]
async fn rejected_cancelled_completion_voids_and_terminalizes_atomically() {
    let (client, store) = running().await;
    let permit = store
        .acquire_dispatch(TurnId::new("cancelled-drain"))
        .await
        .assert_value();
    client
        .stop(stop(StopMode::Drain, 1, "cancelled-drain-stop"))
        .await
        .assert_value();
    assert!(store.cancel_dispatch_for_test(&permit.lease_id).await);

    assert!(
        store
            .complete_dispatch(VerifiedCompletion {
                lease_id: permit.lease_id,
                output: json!("must-not-land"),
            })
            .await
            .is_err()
    );

    let effects = store.inspect().await;
    assert_eq!(effects.control.phase, Phase::Finished);
    assert!(effects.active_turns.is_empty());
    assert!(effects.lifecycle.verified_turns.is_empty());
    assert_eq!(effects.lifecycle.void_turns.len(), 1);
    assert_eq!(effects.lifecycle.operational.assert_value().in_flight, 0);
    assert_eq!(
        effects
            .lifecycle
            .records
            .iter()
            .filter(|record| matches!(record.event, LifecycleEvent::Finished { .. }))
            .count(),
        1
    );
}

use openengine_cluster_testkit::assertions::{AssertError, AssertValue};
