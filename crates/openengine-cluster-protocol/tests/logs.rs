use openengine_cluster_protocol::{
    BoundedLogMessage, BoundedLogTarget, LogEventNotification, LogLevel, LogRecord,
    LogsClosedNotification, LogsParams, LogsResult, ServerCapabilities, SubscriptionCloseReason,
    SubscriptionId, MAX_LOG_EVENT_ENCODED_BYTES, MAX_LOG_MESSAGE_BYTES, MAX_LOG_TARGET_BYTES,
};
use serde_json::json;

fn sample_record() -> LogRecord {
    LogRecord {
        level: LogLevel::Info,
        target: BoundedLogTarget::new("worker-dispatch").unwrap(),
        message: BoundedLogMessage::new("dispatch started").unwrap(),
    }
}

#[test]
fn logs_params_round_trip_as_empty_and_reject_unknown_fields() {
    let params: LogsParams = serde_json::from_value(json!({})).unwrap();
    assert_eq!(params, LogsParams::default());
    assert_eq!(serde_json::to_value(&params).unwrap(), json!({}));

    assert!(serde_json::from_value::<LogsParams>(json!({ "runId": "run-1" })).is_err());
    assert!(serde_json::from_value::<LogsParams>(json!({ "fromCursor": "cursor-1" })).is_err());
    assert!(serde_json::from_value::<LogsParams>(json!({ "unexpected": 1 })).is_err());
}

#[test]
fn logs_result_round_trips_and_carries_only_a_subscription_id() {
    let result = LogsResult {
        subscription_id: SubscriptionId::new("sub-1"),
    };
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({ "subscriptionId": "sub-1" })
    );
    let round_tripped: LogsResult =
        serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
    assert_eq!(round_tripped, result);

    assert!(
        serde_json::from_value::<LogsResult>(json!({
            "subscriptionId": "sub-1",
            "runId": "run-1"
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<LogsResult>(json!({
            "subscriptionId": "sub-1",
            "atCursor": "cursor-1"
        }))
        .is_err()
    );
}

#[test]
fn log_record_round_trips_and_rejects_unknown_fields() {
    let record = sample_record();
    let value = serde_json::to_value(&record).unwrap();
    assert_eq!(
        value,
        json!({
            "level": "info",
            "target": "worker-dispatch",
            "message": "dispatch started"
        })
    );
    let round_tripped: LogRecord = serde_json::from_value(value).unwrap();
    assert_eq!(round_tripped, record);

    assert!(
        serde_json::from_value::<LogRecord>(json!({
            "level": "info",
            "target": "worker-dispatch",
            "message": "dispatch started",
            "runId": "run-1"
        }))
        .is_err()
    );
}

#[test]
fn log_event_notification_round_trips_and_carries_only_subscription_id_and_record() {
    let notification = LogEventNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        record: sample_record(),
    };
    let value = serde_json::to_value(&notification).unwrap();
    assert_eq!(
        value,
        json!({
            "subscriptionId": "sub-1",
            "record": {
                "level": "info",
                "target": "worker-dispatch",
                "message": "dispatch started"
            }
        })
    );
    let round_tripped: LogEventNotification = serde_json::from_value(value).unwrap();
    assert_eq!(round_tripped, notification);

    let mut malformed = serde_json::to_value(&notification).unwrap();
    malformed["cursor"] = json!("cursor-1");
    assert!(serde_json::from_value::<LogEventNotification>(malformed).is_err());
}

#[test]
fn logs_closed_notification_round_trips_and_carries_no_cursor() {
    let done = LogsClosedNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        reason: SubscriptionCloseReason::Done,
    };
    assert_eq!(
        serde_json::to_value(&done).unwrap(),
        json!({ "subscriptionId": "sub-1", "reason": "done" })
    );
    let round_tripped: LogsClosedNotification =
        serde_json::from_value(serde_json::to_value(&done).unwrap()).unwrap();
    assert_eq!(round_tripped, done);

    assert!(
        serde_json::from_value::<LogsClosedNotification>(json!({
            "subscriptionId": "sub-1",
            "reason": "done",
            "lastDeliveredCursor": "cursor-7"
        }))
        .is_err()
    );
}

#[test]
fn bounded_log_target_enforces_byte_length_not_char_count() {
    assert!(BoundedLogTarget::new("").is_err());

    let exact = "a".repeat(MAX_LOG_TARGET_BYTES);
    assert!(BoundedLogTarget::new(exact).is_ok());

    let over = "a".repeat(MAX_LOG_TARGET_BYTES + 1);
    assert!(BoundedLogTarget::new(over).is_err());

    // 65 two-byte UTF-8 characters is 130 bytes but only 65 chars: a char-counting bound would
    // wrongly accept this.
    let multi_byte_over = "\u{00e9}".repeat(65);
    assert_eq!(multi_byte_over.chars().count(), 65);
    assert_eq!(multi_byte_over.len(), 130);
    assert!(BoundedLogTarget::new(multi_byte_over).is_err());

    assert!(BoundedLogTarget::new("has\ncontrol").is_err());
}

#[test]
fn bounded_log_message_enforces_byte_length_not_char_count() {
    assert!(BoundedLogMessage::new("").is_ok());

    let exact = "a".repeat(MAX_LOG_MESSAGE_BYTES);
    assert!(BoundedLogMessage::new(exact).is_ok());

    let over = "a".repeat(MAX_LOG_MESSAGE_BYTES + 1);
    assert!(BoundedLogMessage::new(over).is_err());

    let multi_byte_over = "\u{00e9}".repeat(MAX_LOG_MESSAGE_BYTES / 2 + 1);
    assert!(multi_byte_over.chars().count() <= MAX_LOG_MESSAGE_BYTES);
    assert!(multi_byte_over.len() > MAX_LOG_MESSAGE_BYTES);
    assert!(BoundedLogMessage::new(multi_byte_over).is_err());

    assert!(BoundedLogMessage::new("has\tcontrol").is_err());
}

#[test]
fn bounded_log_message_redacted_marker_is_itself_valid() {
    let redacted = BoundedLogMessage::redacted();
    assert!(redacted.as_str().len() <= MAX_LOG_MESSAGE_BYTES);
    assert!(!redacted.as_str().chars().any(char::is_control));
}

#[test]
fn log_event_notification_validate_rejects_an_oversized_encoding() {
    let within_bounds = LogEventNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        record: sample_record(),
    };
    assert!(within_bounds.validate().is_ok());

    // `SubscriptionId` is not itself bounded; a pathologically long one is what actually drives
    // the encoded event over `MAX_LOG_EVENT_ENCODED_BYTES`, since every `LogRecord` field is
    // already bounded well under that ceiling on its own.
    let oversized = LogEventNotification {
        subscription_id: SubscriptionId::new("s".repeat(MAX_LOG_EVENT_ENCODED_BYTES)),
        record: sample_record(),
    };
    assert!(oversized.validate().is_err());
    assert!(serde_json::to_string(&oversized).is_err());
}

#[test]
fn server_capabilities_logs_defaults_to_false_and_round_trips() {
    let value: ServerCapabilities = serde_json::from_value(json!({})).unwrap();
    assert!(!value.logs);

    let enabled = ServerCapabilities {
        logs: true,
        ..ServerCapabilities::default()
    };
    let json = serde_json::to_value(&enabled).unwrap();
    assert_eq!(json["logs"], json!(true));
    let round_tripped: ServerCapabilities = serde_json::from_value(json).unwrap();
    assert_eq!(round_tripped, enabled);

    let schema = serde_json::to_value(schemars::schema_for!(ServerCapabilities)).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    assert!(validator.is_valid(&json!({ "graphProfiles": [], "logs": true })));
    assert!(validator.is_valid(&json!({ "graphProfiles": [], "logs": false })));
    assert!(validator.is_valid(&json!({ "graphProfiles": [] })));
}
