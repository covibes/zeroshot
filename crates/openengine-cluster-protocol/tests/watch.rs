use openengine_cluster_protocol::{
    ClusterStatus, Cursor, EventNotification, Generation, NodeAddress, NodeName, Phase,
    PositiveInteger, RunId, StopMode, SubscriptionCancelParams, SubscriptionClosedNotification,
    SubscriptionCloseReason, SubscriptionId, WatchEvent, WatchParams, WatchResult, WorkerErrorCode,
    WorkerFailureReason, WorkerOutcome,
};
use serde_json::json;

fn status(cursor: &str) -> ClusterStatus {
    ClusterStatus {
        phase: Phase::Running,
        observed_generation: Some(Generation::new(1).unwrap()),
        current_run_id: Some(RunId::new("run-1")),
        at_cursor: Some(Cursor::new(cursor)),
        operational: None,
    }
}

#[test]
fn watch_params_are_closed_and_optional() {
    let params: WatchParams = serde_json::from_value(json!({})).unwrap();
    assert_eq!(params, WatchParams::default());

    let params: WatchParams = serde_json::from_value(json!({
        "runId": "run-1",
        "fromCursor": "cursor-1"
    }))
    .unwrap();
    assert_eq!(params.run_id, Some(RunId::new("run-1")));
    assert_eq!(params.from_cursor, Some(Cursor::new("cursor-1")));
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({ "runId": "run-1", "fromCursor": "cursor-1" })
    );

    assert!(serde_json::from_value::<WatchParams>(json!({ "unexpected": 1 })).is_err());
}

#[test]
fn watch_result_round_trips_and_allows_null_parked_fields() {
    let result = WatchResult {
        subscription_id: SubscriptionId::new("sub-1"),
        run_id: None,
        at_cursor: None,
    };
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({ "subscriptionId": "sub-1", "runId": null, "atCursor": null })
    );
    let round_tripped: WatchResult =
        serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
    assert_eq!(round_tripped, result);
}

#[test]
fn node_address_round_trips_and_rejects_unknown_fields() {
    let address = NodeAddress {
        node: NodeName::new("work").unwrap(),
        attempt: PositiveInteger::new(1).unwrap(),
    };
    assert_eq!(
        serde_json::to_value(&address).unwrap(),
        json!({ "node": "work", "attempt": 1 })
    );
    assert!(
        serde_json::from_value::<NodeAddress>(json!({
            "node": "work",
            "attempt": 1,
            "extra": true
        }))
        .is_err()
    );
}

#[test]
fn watch_event_phase_round_trips_with_optional_admission() {
    let event = WatchEvent::Phase {
        status: status("cursor-1"),
        admission: None,
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["type"], json!("phase"));
    assert!(value.get("admission").is_none());
    let round_tripped: WatchEvent = serde_json::from_value(value).unwrap();
    assert_eq!(round_tripped, event);
}

#[test]
fn watch_event_bookmark_has_no_payload_fields() {
    let event = WatchEvent::Bookmark;
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        json!({ "type": "bookmark" })
    );
}

#[test]
fn watch_event_finished_round_trips_with_optional_stop_mode() {
    let event = WatchEvent::Finished {
        final_status: status("cursor-9"),
        stop_mode: Some(StopMode::Drain),
    };
    let round_tripped: WatchEvent =
        serde_json::from_value(serde_json::to_value(&event).unwrap()).unwrap();
    assert_eq!(round_tripped, event);
}

#[test]
fn watch_event_node_begin_and_end_round_trip() {
    let node = NodeAddress {
        node: NodeName::new("work").unwrap(),
        attempt: PositiveInteger::new(1).unwrap(),
    };
    let begin = WatchEvent::NodeBegin {
        node: node.clone(),
        input: json!({ "text": "hi" }),
    };
    let round_tripped: WatchEvent =
        serde_json::from_value(serde_json::to_value(&begin).unwrap()).unwrap();
    assert_eq!(round_tripped, begin);

    let end = WatchEvent::NodeEnd {
        node,
        outcome: WorkerOutcome::Verified {
            output: json!({ "text": "done" }),
            artifacts: vec![],
        },
    };
    let round_tripped: WatchEvent =
        serde_json::from_value(serde_json::to_value(&end).unwrap()).unwrap();
    assert_eq!(round_tripped, end);

    let error_end = WatchEvent::NodeEnd {
        node: NodeAddress {
            node: NodeName::new("work").unwrap(),
            attempt: PositiveInteger::new(2).unwrap(),
        },
        outcome: WorkerOutcome::declared_failure(WorkerErrorCode::Timeout),
    };
    assert_eq!(
        error_end.clone(),
        serde_json::from_value(serde_json::to_value(&error_end).unwrap()).unwrap()
    );
    if let WatchEvent::NodeEnd { outcome, .. } = &error_end {
        assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Timeout));
    }
    let _ = WorkerFailureReason::DeclaredFailure;
}

#[test]
fn event_notification_is_closed_and_carries_a_typed_event() {
    let notification = EventNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        run_id: RunId::new("run-1"),
        cursor: Cursor::new("cursor-1"),
        event: WatchEvent::Bookmark,
    };
    let value = serde_json::to_value(&notification).unwrap();
    assert_eq!(
        value,
        json!({
            "subscriptionId": "sub-1",
            "runId": "run-1",
            "cursor": "cursor-1",
            "event": { "type": "bookmark" }
        })
    );
    let round_tripped: EventNotification = serde_json::from_value(value).unwrap();
    assert_eq!(round_tripped, notification);

    let mut malformed = serde_json::to_value(&notification).unwrap();
    malformed["extra"] = json!(true);
    assert!(serde_json::from_value::<EventNotification>(malformed).is_err());
}

#[test]
fn subscription_cancel_params_round_trip_and_are_closed() {
    let params = SubscriptionCancelParams {
        subscription_id: SubscriptionId::new("sub-1"),
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({ "subscriptionId": "sub-1" })
    );
    assert!(
        serde_json::from_value::<SubscriptionCancelParams>(json!({
            "subscriptionId": "sub-1",
            "extra": 1
        }))
        .is_err()
    );
}

#[test]
fn subscription_close_reason_uses_mixed_case_wire_values() {
    assert_eq!(
        serde_json::to_value(SubscriptionCloseReason::Done).unwrap(),
        json!("done")
    );
    assert_eq!(
        serde_json::to_value(SubscriptionCloseReason::SlowConsumer).unwrap(),
        json!("SLOW_CONSUMER")
    );
    assert!(serde_json::from_value::<SubscriptionCloseReason>(json!("SlowConsumer")).is_err());
}

#[test]
fn subscription_closed_notification_round_trips_with_optional_cursor() {
    let done = SubscriptionClosedNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        reason: SubscriptionCloseReason::Done,
        last_delivered_cursor: None,
    };
    let value = serde_json::to_value(&done).unwrap();
    assert!(value.get("lastDeliveredCursor").is_none());
    assert_eq!(
        serde_json::from_value::<SubscriptionClosedNotification>(value).unwrap(),
        done
    );

    let overflow = SubscriptionClosedNotification {
        subscription_id: SubscriptionId::new("sub-2"),
        reason: SubscriptionCloseReason::SlowConsumer,
        last_delivered_cursor: Some(Cursor::new("cursor-7")),
    };
    let value = serde_json::to_value(&overflow).unwrap();
    assert_eq!(value["lastDeliveredCursor"], json!("cursor-7"));
    assert_eq!(
        serde_json::from_value::<SubscriptionClosedNotification>(value).unwrap(),
        overflow
    );
}
