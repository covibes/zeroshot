use super::observation_support::*;
use openengine_cluster_protocol::{
    AgentAttachClosedNotification, AgentAttachEvent, AgentAttachEventNotification,
    AgentAttachParams, AgentAttachResult, BoundedAssistantOutput, ExecutionRef, ServerCapabilities,
    SubscriptionCloseReason, SubscriptionId, MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES,
    MAX_ASSISTANT_OUTPUT_BYTES, MAX_EXECUTION_REF_BYTES,
};
use serde_json::json;

fn sample_execution_ref() -> ExecutionRef {
    ExecutionRef::new("execution-1").assert_value()
}

#[test]
fn agent_attach_params_round_trips_and_rejects_unknown_fields() {
    let params = AgentAttachParams {
        execution: sample_execution_ref(),
    };
    assert_eq!(
        serde_json::to_value(&params).assert_value(),
        json!({ "execution": "execution-1" })
    );
    let round_tripped: AgentAttachParams =
        serde_json::from_value(serde_json::to_value(&params).assert_value()).assert_value();
    assert_eq!(round_tripped, params);

    assert!(serde_json::from_value::<AgentAttachParams>(json!({})).is_err());
    assert!(
        serde_json::from_value::<AgentAttachParams>(json!({
            "execution": "execution-1",
            "unexpected": 1
        }))
        .is_err()
    );
}

#[test]
fn agent_attach_result_round_trips_and_carries_only_a_subscription_id() {
    let result = AgentAttachResult {
        subscription_id: SubscriptionId::new("sub-1"),
    };
    assert_eq!(
        serde_json::to_value(&result).assert_value(),
        json!({ "subscriptionId": "sub-1" })
    );
    let round_tripped: AgentAttachResult =
        serde_json::from_value(serde_json::to_value(&result).assert_value()).assert_value();
    assert_eq!(round_tripped, result);

    assert!(
        serde_json::from_value::<AgentAttachResult>(json!({
            "subscriptionId": "sub-1",
            "runId": "run-1"
        }))
        .is_err()
    );
}

#[test]
fn agent_attach_event_round_trips_and_rejects_unknown_fields_for_every_variant() {
    let working = AgentAttachEvent::Working {};
    assert_eq!(
        serde_json::to_value(&working).assert_value(),
        json!({ "type": "working" })
    );
    assert_eq!(
        serde_json::from_value::<AgentAttachEvent>(json!({ "type": "working" })).assert_value(),
        working
    );

    let output = AgentAttachEvent::Output {
        text: BoundedAssistantOutput::new("hello").assert_value(),
    };
    assert_eq!(
        serde_json::to_value(&output).assert_value(),
        json!({ "type": "output", "text": "hello" })
    );
    assert_eq!(
        serde_json::from_value::<AgentAttachEvent>(json!({ "type": "output", "text": "hello" }))
            .assert_value(),
        output
    );

    let settled = AgentAttachEvent::Settled {};
    assert_eq!(
        serde_json::to_value(&settled).assert_value(),
        json!({ "type": "settled" })
    );
    assert_eq!(
        serde_json::from_value::<AgentAttachEvent>(json!({ "type": "settled" })).assert_value(),
        settled
    );

    assert!(
        serde_json::from_value::<AgentAttachEvent>(json!({
            "type": "working",
            "reasoning": "hidden"
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<AgentAttachEvent>(json!({
            "type": "output",
            "text": "hello",
            "tool": "shell"
        }))
        .is_err()
    );
    assert!(serde_json::from_value::<AgentAttachEvent>(json!({ "type": "reasoning" })).is_err());
    assert!(serde_json::from_value::<AgentAttachEvent>(json!({ "type": "tool_call" })).is_err());
    assert!(serde_json::from_value::<AgentAttachEvent>(json!({ "type": "usage" })).is_err());
    assert!(serde_json::from_value::<AgentAttachEvent>(json!({ "type": "session_id" })).is_err());
}

#[test]
fn agent_attach_event_notification_round_trips_and_carries_only_subscription_id_and_event() {
    let notification = AgentAttachEventNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        event: AgentAttachEvent::Output {
            text: BoundedAssistantOutput::new("chunk").assert_value(),
        },
    };
    wire::assert_wire_round_trip_and_rejects_inserted_field(
        &notification,
        json!({
            "subscriptionId": "sub-1",
            "event": { "type": "output", "text": "chunk" }
        }),
        "cursor",
        json!("cursor-1"),
    );
}

#[test]
fn agent_attach_closed_notification_round_trips_and_carries_no_cursor() {
    let done = AgentAttachClosedNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        reason: SubscriptionCloseReason::Done,
    };
    closed_notification::assert_done_closed_notification(&done);
}

#[test]
fn execution_ref_enforces_byte_length_not_char_count() {
    assert!(ExecutionRef::new("").is_err());

    let exact = "a".repeat(MAX_EXECUTION_REF_BYTES);
    assert!(ExecutionRef::new(exact).is_ok());

    let over = "a".repeat(MAX_EXECUTION_REF_BYTES + 1);
    assert!(ExecutionRef::new(over).is_err());

    // 65 two-byte UTF-8 characters is 130 bytes but only 65 chars: a char-counting bound would
    // wrongly accept this.
    let multi_byte_over = "\u{00e9}".repeat(65);
    assert_eq!(multi_byte_over.chars().count(), 65);
    assert_eq!(multi_byte_over.len(), 130);
    assert!(ExecutionRef::new(multi_byte_over).is_err());

    assert!(ExecutionRef::new("has\ncontrol").is_err());
}

#[test]
fn bounded_assistant_output_enforces_byte_length_not_char_count() {
    assert!(BoundedAssistantOutput::new("").is_ok());

    let exact = "a".repeat(MAX_ASSISTANT_OUTPUT_BYTES);
    assert!(BoundedAssistantOutput::new(exact).is_ok());

    let over = "a".repeat(MAX_ASSISTANT_OUTPUT_BYTES + 1);
    assert!(BoundedAssistantOutput::new(over).is_err());

    let multi_byte_over = "\u{00e9}".repeat(MAX_ASSISTANT_OUTPUT_BYTES / 2 + 1);
    assert!(multi_byte_over.chars().count() <= MAX_ASSISTANT_OUTPUT_BYTES);
    assert!(multi_byte_over.len() > MAX_ASSISTANT_OUTPUT_BYTES);
    assert!(BoundedAssistantOutput::new(multi_byte_over).is_err());

    assert!(BoundedAssistantOutput::new("has\tcontrol").is_err());
}

#[test]
fn bounded_assistant_output_redacted_marker_is_itself_valid() {
    let redacted = BoundedAssistantOutput::redacted();
    assert!(redacted.as_str().len() <= MAX_ASSISTANT_OUTPUT_BYTES);
    assert!(!redacted.as_str().chars().any(char::is_control));
}

#[test]
fn agent_attach_event_notification_validate_rejects_an_oversized_encoding() {
    let within_bounds = AgentAttachEventNotification {
        subscription_id: SubscriptionId::new("sub-1"),
        event: AgentAttachEvent::Working {},
    };
    assert!(within_bounds.validate().is_ok());

    // `SubscriptionId` is not itself bounded; a pathologically long one is what actually drives
    // the encoded event over `MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES`, since every other field is
    // already bounded well under that ceiling on its own.
    let oversized = AgentAttachEventNotification {
        subscription_id: SubscriptionId::new("s".repeat(MAX_AGENT_ATTACH_EVENT_ENCODED_BYTES)),
        event: AgentAttachEvent::Working {},
    };
    assert!(oversized.validate().is_err());
    assert!(serde_json::to_string(&oversized).is_err());
}

#[test]
fn server_capabilities_agent_attach_defaults_to_false_and_is_independent_of_logs() {
    let value: ServerCapabilities = serde_json::from_value(json!({})).assert_value();
    assert!(!value.agent_attach);
    assert!(!value.logs);

    let logs_only = ServerCapabilities {
        logs: true,
        ..ServerCapabilities::default()
    };
    assert!(!logs_only.agent_attach);

    let agent_attach_only = ServerCapabilities {
        agent_attach: true,
        ..ServerCapabilities::default()
    };
    assert!(!agent_attach_only.logs);

    let json = serde_json::to_value(&agent_attach_only).assert_value();
    assert_eq!(json_read::json_at(&json, "/agentAttach"), &json!(true));
    let round_tripped: ServerCapabilities = serde_json::from_value(json).assert_value();
    assert_eq!(round_tripped, agent_attach_only);

    capability::assert_boolean_capability_schema::<ServerCapabilities>("agentAttach");
}
