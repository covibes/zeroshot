use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;

use super::*;

fn worker_contract() -> NodeResponseContract {
    NodeResponseContract::Worker {
        output: serde_json::from_value(json!({
            "kind": "record",
            "fields": {
                "answer": { "type": { "kind": "integer" }, "required": true }
            }
        }))
        .assert_value(),
    }
}

#[test]
fn agent_response_reports_mechanical_json_and_payload_errors() {
    let contract = worker_contract();
    let malformed = contract
        .parse_agent_response("not json")
        .err()
        .assert_value();
    assert!(
        malformed
            .to_string()
            .starts_with("final response is not valid JSON:")
    );

    assert_eq!(
        contract.parse_agent_response(r#"{"answer":"wrong"}"#),
        Err(NodeResponseError::new(
            "output $.answer must be a integer".to_owned()
        ))
    );
    assert!(matches!(
        contract.parse_agent_response(r#"{"answer":42}"#).assert_value(),
        WorkerOutcome::Verified { output, .. } if output == json!({"answer": 42})
    ));
}

#[test]
fn provider_schema_closes_the_transport_and_preserves_optional_fields() {
    let contract = NodeResponseContract::Worker {
        output: serde_json::from_value(json!({
            "kind": "record",
            "fields": {
                "answer": { "type": { "kind": "integer" }, "required": true },
                "notes": {
                    "type": {
                        "kind": "array",
                        "items": { "kind": "enum", "values": ["ripe", "fresh"] }
                    },
                    "required": false
                }
            }
        }))
        .assert_value(),
    };

    assert_eq!(
        contract.provider_schema(ProviderSchemaDialect::Standard),
        json!({
            "type": "object",
            "properties": {
                "response": {
                    "type": "object",
                    "properties": {
                        "answer": { "type": "integer" },
                        "notes": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": ["fresh", "ripe"]
                            }
                        }
                    },
                    "required": ["answer"],
                    "additionalProperties": false
                }
            },
            "required": ["response"],
            "additionalProperties": false
        })
    );
}

#[test]
fn provider_schema_covers_every_payload_kind_and_the_verifier_shape() {
    for (payload, expected) in [
        (PayloadType::Null, json!({"type":"null"})),
        (PayloadType::Boolean, json!({"type":"boolean"})),
        (PayloadType::Integer, json!({"type":"integer"})),
        (PayloadType::Number, json!({"type":"number"})),
        (PayloadType::String, json!({"type":"string"})),
    ] {
        let contract = NodeResponseContract::Worker { output: payload };
        assert_eq!(
            contract
                .provider_schema(ProviderSchemaDialect::Standard)
                .pointer("/properties/response")
                .assert_value(),
            &expected
        );
    }

    let verifier = NodeResponseContract::Verifier {
        output: PayloadType::Null,
        signals: BTreeMap::from([(
            FieldName::new("verdict").assert_value(),
            NonEmptyEnumSet::new(vec![
                EnumLabel::new("rejected").assert_value(),
                EnumLabel::new("accepted").assert_value(),
            ])
            .assert_value(),
        )]),
        diagnostic: PayloadType::Boolean,
    };
    let schema = verifier.provider_schema(ProviderSchemaDialect::Standard);
    let response = schema.pointer("/properties/response").assert_value();
    assert_eq!(
        response.pointer("/required").assert_value(),
        &json!(["diagnostic", "output", "signals"])
    );
    assert_eq!(
        response.pointer("/properties/output").assert_value(),
        &json!({"type":"null"})
    );
    assert_eq!(
        response
            .pointer("/properties/signals/properties/verdict")
            .assert_value(),
        &json!({"type":"string", "enum":["accepted", "rejected"]})
    );
    assert_eq!(
        response.pointer("/properties/diagnostic").assert_value(),
        &json!({"type":"boolean"})
    );
}

#[test]
fn openai_schema_requires_every_field_and_normalizes_optional_nulls() {
    let contract = NodeResponseContract::Worker {
        output: serde_json::from_value(json!({
            "kind": "record",
            "fields": {
                "required": { "type": { "kind": "boolean" }, "required": true },
                "optional": { "type": { "kind": "string" }, "required": false }
            }
        }))
        .assert_value(),
    };

    let schema = contract.provider_schema(ProviderSchemaDialect::OpenAiStrict);
    assert_eq!(
        schema
            .pointer("/properties/response/required")
            .assert_value(),
        &json!(["optional", "required"])
    );
    assert_eq!(
        schema
            .pointer("/properties/response/properties/optional")
            .assert_value(),
        &json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] })
    );
    assert!(matches!(
        resolve_agent_response_with_dialect(
            &contract,
            r#"{"response":{"required":true,"optional":null}}"#,
            ProviderSchemaDialect::OpenAiStrict,
        )
        .assert_value(),
        AgentResponse::Complete(WorkerOutcome::Verified { output, .. })
            if output == json!({"required": true})
    ));
}

#[test]
fn openai_normalizes_optional_nulls_recursively() {
    let contract = NodeResponseContract::Worker {
        output: serde_json::from_value(json!({
            "kind": "record",
            "fields": {
                "items": {
                    "type": {
                        "kind": "array",
                        "items": {
                            "kind": "record",
                            "fields": {
                                "note": { "type": { "kind": "string" }, "required": false }
                            }
                        }
                    },
                    "required": true
                }
            }
        }))
        .assert_value(),
    };

    assert!(matches!(
        resolve_agent_response_with_dialect(
            &contract,
            r#"{"response":{"items":[{"note":null},{"note":"kept"}]}}"#,
            ProviderSchemaDialect::OpenAiStrict,
        )
        .assert_value(),
        AgentResponse::Complete(WorkerOutcome::Verified { output, .. })
            if output == json!({"items": [{}, {"note": "kept"}]})
    ));
}

#[test]
fn openai_preserves_optional_null_payloads() {
    let contract = NodeResponseContract::Worker {
        output: serde_json::from_value(json!({
            "kind": "record",
            "fields": {
                "nothing": { "type": { "kind": "null" }, "required": false }
            }
        }))
        .assert_value(),
    };

    let schema = contract.provider_schema(ProviderSchemaDialect::OpenAiStrict);
    assert_eq!(
        schema
            .pointer("/properties/response/properties/nothing")
            .assert_value(),
        &json!({ "type": "null" })
    );
    assert!(matches!(
        resolve_agent_response_with_dialect(
            &contract,
            r#"{"response":{"nothing":null}}"#,
            ProviderSchemaDialect::OpenAiStrict,
        )
        .assert_value(),
        AgentResponse::Complete(WorkerOutcome::Verified { output, .. })
            if output == json!({"nothing": null})
    ));
}

#[test]
fn provider_envelope_is_unwrapped_before_authoritative_validation() {
    let contract = worker_contract();
    assert!(matches!(
        resolve_agent_response(&contract, r#"{"response":{"answer":42}}"#).assert_value(),
        AgentResponse::Complete(WorkerOutcome::Verified { output, .. })
            if output == json!({"answer": 42})
    ));
    assert!(matches!(
        resolve_agent_response(&contract, r#"{"answer":42}"#).assert_value(),
        AgentResponse::Correction(_)
    ));
    assert!(matches!(
        resolve_agent_response(&contract, r#"{"response":{"answer":42},"extra":true}"#)
            .assert_value(),
        AgentResponse::Correction(_)
    ));
}
