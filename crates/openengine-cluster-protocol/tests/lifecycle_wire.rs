#[path = "support/assert_value.rs"]
mod assert_value;

use assert_value::AssertValue;
use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    DispatchState, Generation, IdempotencyKey, Label, Labels, LogLevel, StopMode, StopParams,
    UpdateParams, MAX_LABELS,
};
use serde_json::json;

#[test]
fn update_wire_is_closed_non_empty_and_presence_sensitive() {
    let update: UpdateParams = serde_json::from_value(json!({
        "labels":{"z":"last","a":"first"},
        "logLevel":"debug",
        "suspended":true,
        "ifGeneration":7,
        "idempotencyKey":"update-1"
    }))
    .assert_value();
    assert_eq!(update.log_level, Some(LogLevel::Debug));
    assert_eq!(
        serde_json::to_value(update).assert_value(),
        json!({
            "labels":{"a":"first","z":"last"},
            "logLevel":"debug",
            "suspended":true,
            "ifGeneration":7,
            "idempotencyKey":"update-1"
        })
    );

    for invalid in [
        json!({"ifGeneration":1,"idempotencyKey":"empty"}),
        json!({"labels":null,"ifGeneration":1,"idempotencyKey":"null"}),
        json!({"graph":{},"ifGeneration":1,"idempotencyKey":"graph"}),
        json!({"input":null,"ifGeneration":1,"idempotencyKey":"input"}),
        json!({"policy":{},"ifGeneration":1,"idempotencyKey":"policy"}),
        json!({"worker":"x","ifGeneration":1,"idempotencyKey":"worker"}),
        json!({"logLevel":"verbose","ifGeneration":1,"idempotencyKey":"level"}),
    ] {
        assert!(serde_json::from_value::<UpdateParams>(invalid).is_err());
    }
}

#[test]
fn labels_are_bounded_and_stop_is_closed() {
    assert!(serde_json::from_value::<Labels>(json!({"":"value"})).is_err());
    assert!(serde_json::from_value::<Labels>(json!({"key":"\u{0000}"})).is_err());
    let too_many = (0..=MAX_LABELS)
        .map(|index| {
            (
                Label::new(format!("key-{index}")).assert_value(),
                Label::new("value").assert_value(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert!(Labels::new(too_many).is_err());

    let stop: StopParams = serde_json::from_value(json!({
        "mode":"force","ifGeneration":1,"idempotencyKey":"stop-1"
    }))
    .assert_value();
    assert_eq!(stop.mode, StopMode::Force);
    assert!(
        serde_json::from_value::<StopParams>(json!({
            "mode":"kill","ifGeneration":1,"idempotencyKey":"stop-2"
        }))
        .is_err()
    );
}

#[test]
fn lifecycle_constructors_remain_typed() {
    let update = UpdateParams {
        labels: None,
        log_level: None,
        suspended: Some(false),
        if_generation: Generation::new(1).assert_value(),
        idempotency_key: IdempotencyKey::new("resume").assert_value(),
    };
    assert!(update.validate().is_ok());
    assert_eq!(update.suspended, Some(false));
    assert_eq!(DispatchState::default(), DispatchState::Active);

    let empty = UpdateParams {
        labels: None,
        log_level: None,
        suspended: None,
        if_generation: Generation::new(1).assert_value(),
        idempotency_key: IdempotencyKey::new("empty").assert_value(),
    };
    assert_eq!(
        empty.validate(),
        Err("update requires at least one of labels, logLevel, or suspended")
    );
}

#[test]
fn update_schema_matches_non_null_runtime_controls() {
    let schema = serde_json::to_value(schemars::schema_for!(UpdateParams)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();
    assert!(validator.is_valid(&json!({
        "suspended":true,"ifGeneration":1,"idempotencyKey":"valid"
    })));
    for invalid in [
        json!({"ifGeneration":1,"idempotencyKey":"empty"}),
        json!({"labels":null,"ifGeneration":1,"idempotencyKey":"null-labels"}),
        json!({"logLevel":null,"ifGeneration":1,"idempotencyKey":"null-level"}),
        json!({"suspended":null,"ifGeneration":1,"idempotencyKey":"null-suspend"}),
    ] {
        assert!(!validator.is_valid(&invalid), "schema accepted {invalid}");
    }
}
