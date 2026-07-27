use openengine_cluster_protocol::{DeleteParams, Generation, IdempotencyKey, RunId};
use serde_json::json;

#[test]
fn delete_wire_is_closed_and_carries_no_provider_or_config_fields() {
    let delete: DeleteParams = serde_json::from_value(json!({
        "ifGeneration":7,
        "ifRunId":"run-1",
        "idempotencyKey":"delete-1"
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(delete).unwrap(),
        json!({
            "ifGeneration":7,
            "ifRunId":"run-1",
            "idempotencyKey":"delete-1"
        })
    );

    for invalid in [
        json!({"idempotencyKey":"missing-generation","ifRunId":"run-1"}),
        json!({"ifGeneration":1,"ifRunId":"run-1"}),
        json!({"ifGeneration":1,"idempotencyKey":"turn","ifRunId":"run-1","turnId":"turn-1"}),
        json!({"ifGeneration":1,"idempotencyKey":"provider","provider":"claude"}),
        json!({"ifGeneration":1,"idempotencyKey":"config","config":{}}),
        json!({"ifGeneration":1,"idempotencyKey":"source","source":"github"}),
        json!({"ifGeneration":1,"idempotencyKey":"session","session":"session-1"}),
        json!({"ifGeneration":1,"idempotencyKey":"workspace","workspacePath":"/tmp"}),
        json!({"ifGeneration":1,"idempotencyKey":"graph","graph":{}}),
        json!({"ifGeneration":1,"idempotencyKey":"mode","mode":"force"}),
        json!({"ifGeneration":1,"idempotencyKey":"replacement","replacementInput":null}),
    ] {
        assert!(
            serde_json::from_value::<DeleteParams>(invalid.clone()).is_err(),
            "schema accepted {invalid}"
        );
    }
}

#[test]
fn delete_if_run_id_is_omitted_when_absent_and_round_trips_when_present() {
    let without_run_id: DeleteParams = serde_json::from_value(json!({
        "ifGeneration":0,
        "idempotencyKey":"no-run-id"
    }))
    .unwrap();
    assert!(without_run_id.if_run_id.is_none());
    assert_eq!(
        serde_json::to_value(without_run_id).unwrap(),
        json!({
            "ifGeneration":0,
            "idempotencyKey":"no-run-id"
        })
    );

    let with_null_run_id: DeleteParams = serde_json::from_value(json!({
        "ifGeneration":0,
        "idempotencyKey":"null-run-id",
        "ifRunId":null
    }))
    .unwrap();
    assert!(with_null_run_id.if_run_id.is_none());

    let with_run_id: DeleteParams = serde_json::from_value(json!({
        "ifGeneration":1,
        "idempotencyKey":"with-run-id",
        "ifRunId":"run-1"
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(with_run_id).unwrap(),
        json!({
            "ifGeneration":1,
            "idempotencyKey":"with-run-id",
            "ifRunId":"run-1"
        })
    );
}

#[test]
fn delete_constructors_remain_typed() {
    let delete = DeleteParams {
        if_generation: Generation::new(1).unwrap(),
        if_run_id: Some(RunId::new("run-1")),
        idempotency_key: IdempotencyKey::new("delete").unwrap(),
    };
    assert_eq!(delete.if_generation, Generation::new(1).unwrap());
    assert_eq!(delete.if_run_id, Some(RunId::new("run-1")));
}

#[test]
fn delete_schema_field_names_are_closed() {
    let params_schema = serde_json::to_value(schemars::schema_for!(DeleteParams)).unwrap();
    let properties = params_schema["properties"].as_object().unwrap();
    for forbidden in [
        "turnId",
        "executionId",
        "session",
        "workspacePath",
        "provider",
        "config",
        "source",
        "replacementInput",
    ] {
        assert!(
            !properties.contains_key(forbidden),
            "DeleteParams schema unexpectedly exposes {forbidden}"
        );
    }

    let result_schema = serde_json::to_value(schemars::schema_for!(
        openengine_cluster_protocol::DeleteResult
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
            "DeleteResult schema unexpectedly exposes {forbidden}"
        );
    }
}

#[test]
fn delete_result_round_trips() {
    let finalized = json!({
        "deleted":true,
        "phase":"empty",
        "deduped":false
    });
    let result: openengine_cluster_protocol::DeleteResult =
        serde_json::from_value(finalized.clone()).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), finalized);

    let pending = json!({
        "deleted":false,
        "phase":"deleting",
        "generation":1,
        "runId":"run-1",
        "atCursor":"cursor-3",
        "deduped":false
    });
    let result: openengine_cluster_protocol::DeleteResult =
        serde_json::from_value(pending.clone()).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), pending);
}
