use openengine_cluster_protocol::{Generation, IdempotencyKey, ResubmitParams, RunId};
use serde_json::json;

#[test]
fn resubmit_wire_is_closed_and_carries_no_provider_or_config_fields() {
    let resubmit: ResubmitParams = serde_json::from_value(json!({
        "ifGeneration":7,
        "ifRunId":"run-1",
        "idempotencyKey":"resubmit-1"
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(resubmit).unwrap(),
        json!({
            "ifGeneration":7,
            "ifRunId":"run-1",
            "idempotencyKey":"resubmit-1"
        })
    );

    for invalid in [
        json!({"idempotencyKey":"missing-generation","ifRunId":"run-1"}),
        json!({"ifGeneration":1,"idempotencyKey":"missing-run"}),
        json!({"ifGeneration":1,"ifRunId":"run-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"turn","turnId":"turn-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"provider","provider":"claude"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"config","config":{}}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"source","source":"github"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"session","session":"session-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"workspace","workspacePath":"/tmp"}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"graph","graph":{}}),
        json!({"ifGeneration":1,"ifRunId":"run-1","idempotencyKey":"mode","mode":"force"}),
    ] {
        assert!(
            serde_json::from_value::<ResubmitParams>(invalid.clone()).is_err(),
            "schema accepted {invalid}"
        );
    }
}

#[test]
fn resubmit_replacement_input_is_omitted_when_absent_and_round_trips_when_present() {
    let without_replacement: ResubmitParams = serde_json::from_value(json!({
        "ifGeneration":1,
        "ifRunId":"run-1",
        "idempotencyKey":"no-replacement"
    }))
    .unwrap();
    assert!(without_replacement.replacement_input.is_none());
    assert_eq!(
        serde_json::to_value(without_replacement).unwrap(),
        json!({
            "ifGeneration":1,
            "ifRunId":"run-1",
            "idempotencyKey":"no-replacement"
        })
    );

    let with_null_replacement: ResubmitParams = serde_json::from_value(json!({
        "ifGeneration":1,
        "ifRunId":"run-1",
        "idempotencyKey":"null-replacement",
        "replacementInput":null
    }))
    .unwrap();
    assert_eq!(
        with_null_replacement.replacement_input,
        Some(serde_json::Value::Null)
    );

    let with_replacement: ResubmitParams = serde_json::from_value(json!({
        "ifGeneration":1,
        "ifRunId":"run-1",
        "idempotencyKey":"with-replacement",
        "replacementInput":{"kind":"updated"}
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(with_replacement).unwrap(),
        json!({
            "ifGeneration":1,
            "ifRunId":"run-1",
            "idempotencyKey":"with-replacement",
            "replacementInput":{"kind":"updated"}
        })
    );
}

#[test]
fn resubmit_constructors_remain_typed() {
    let resubmit = ResubmitParams {
        if_generation: Generation::new(1).unwrap(),
        if_run_id: RunId::new("run-1"),
        idempotency_key: IdempotencyKey::new("resubmit").unwrap(),
        replacement_input: None,
    };
    assert_eq!(resubmit.if_generation, Generation::new(1).unwrap());
    assert_eq!(resubmit.if_run_id, RunId::new("run-1"));
}

#[test]
fn resubmit_schema_field_names_are_closed() {
    let params_schema = serde_json::to_value(schemars::schema_for!(ResubmitParams)).unwrap();
    let properties = params_schema["properties"].as_object().unwrap();
    for forbidden in [
        "turnId",
        "executionId",
        "session",
        "workspacePath",
        "provider",
        "config",
        "source",
    ] {
        assert!(
            !properties.contains_key(forbidden),
            "ResubmitParams schema unexpectedly exposes {forbidden}"
        );
    }

    let result_schema = serde_json::to_value(schemars::schema_for!(
        openengine_cluster_protocol::ResubmitResult
    ))
    .unwrap();
    let properties = result_schema["properties"].as_object().unwrap();
    for forbidden in [
        "turnId",
        "executionId",
        "session",
        "workspacePath",
        "provider",
        "config",
        "source",
    ] {
        assert!(
            !properties.contains_key(forbidden),
            "ResubmitResult schema unexpectedly exposes {forbidden}"
        );
    }
}

#[test]
fn resubmit_result_round_trips() {
    let value = json!({
        "generation":1,
        "priorRunId":"run-1",
        "runId":"run-2",
        "phase":"running",
        "operational":{
            "labels":{},"logLevel":"info","dispatchState":"active","inFlight":0
        },
        "atCursor":"cursor-3",
        "deduped":false
    });
    let result: openengine_cluster_protocol::ResubmitResult =
        serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), value);
}
