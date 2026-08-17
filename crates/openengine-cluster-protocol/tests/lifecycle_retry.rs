#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/schema.rs"]
mod schema;

#[path = "support/json_read.rs"]
mod json_read;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    Generation, IdempotencyKey, NoRetryableFrontierReason, RetryParams, TurnFailureKind,
};
use serde_json::json;

#[test]
fn retry_wire_is_closed_and_carries_no_execution_selector() {
    let retry: RetryParams = serde_json::from_value(json!({
        "ifGeneration":7,
        "idempotencyKey":"retry-1"
    }))
    .assert_value();
    assert_eq!(
        serde_json::to_value(retry).assert_value(),
        json!({
            "ifGeneration":7,
            "idempotencyKey":"retry-1"
        })
    );

    for invalid in [
        json!({"idempotencyKey":"missing-generation"}),
        json!({"ifGeneration":1}),
        json!({"ifGeneration":1,"idempotencyKey":"turn","turnId":"turn-1"}),
        json!({"ifGeneration":1,"idempotencyKey":"execution","executionId":"exec-1"}),
        json!({"ifGeneration":1,"idempotencyKey":"session","session":"session-1"}),
        json!({"ifGeneration":1,"idempotencyKey":"workspace","workspacePath":"/tmp"}),
        json!({"ifGeneration":1,"idempotencyKey":"provider","provider":"claude"}),
        json!({"ifGeneration":1,"idempotencyKey":"graph","graph":{}}),
        json!({"ifGeneration":1,"idempotencyKey":"input","input":null}),
        json!({"ifGeneration":1,"idempotencyKey":"mode","mode":"force"}),
    ] {
        assert!(
            serde_json::from_value::<RetryParams>(invalid.clone()).is_err(),
            "schema accepted {invalid}"
        );
    }
}

#[test]
fn no_retryable_frontier_reasons_are_closed_wire_values() {
    for (reason, wire) in [
        (NoRetryableFrontierReason::Exhausted, "exhausted"),
        (NoRetryableFrontierReason::Success, "success"),
        (NoRetryableFrontierReason::Active, "active"),
        (NoRetryableFrontierReason::Consumed, "consumed"),
    ] {
        assert_eq!(serde_json::to_value(reason).assert_value(), json!(wire));
        assert_eq!(
            serde_json::from_value::<NoRetryableFrontierReason>(json!(wire)).assert_value(),
            reason
        );
    }
    assert!(serde_json::from_value::<NoRetryableFrontierReason>(json!("unknown")).is_err());
}

#[test]
fn retry_constructors_remain_typed() {
    let retry = RetryParams {
        if_generation: Generation::new(1).assert_value(),
        idempotency_key: IdempotencyKey::new("retry").assert_value(),
    };
    assert_eq!(retry.if_generation, Generation::new(1).assert_value());
    assert_eq!(TurnFailureKind::Timeout, TurnFailureKind::Timeout);
    assert_ne!(TurnFailureKind::Timeout, TurnFailureKind::Crash);
}

#[test]
fn retry_schema_field_names_are_closed() {
    const PRIVATE_FIELDS: &[&str] = &["executionId", "session", "workspacePath", "provider"];
    schema::assert_schema_omits::<RetryParams>("RetryParams", PRIVATE_FIELDS);
    schema::assert_schema_omits::<openengine_cluster_protocol::RetryResult>(
        "RetryResult",
        PRIVATE_FIELDS,
    );
}

#[test]
fn retry_result_round_trips() {
    let value = json!({
        "generation":1,
        "runId":"run-1",
        "phase":"running",
        "retriedTurnId":"turn-1",
        "retryTurnId":"turn-2",
        "operational":{
            "labels":{},"logLevel":"info","dispatchState":"active","inFlight":0
        },
        "atCursor":"cursor-1",
        "deduped":false
    });
    let result: openengine_cluster_protocol::RetryResult =
        serde_json::from_value(value.clone()).assert_value();
    assert_eq!(serde_json::to_value(result).assert_value(), value);
}
