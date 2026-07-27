use rust_decimal::Decimal;
use serde_json::json;
use zeroshot_engine::cluster_ledger::ExecutionId;
use zeroshot_engine::execution::{
    CancelObservation, CompletionEvidence, DispatchFence, DispatchObservation, ExecutionCandidate,
    ExecutionCommand, ExecutionControl, ExecutionInput, ExecutionObservation, ExecutionResult,
    InlineExecutionInput, SessionScope, UsageObservation, UsageObservationSpec,
    MAX_EXECUTION_CANDIDATE_BYTES, MAX_EXECUTION_INLINE_BYTES,
};

#[path = "support/execution_contract.rs"]
mod execution_contract;

use execution_contract::{CommandSpec, agent_target, builtin_target, command_with_input};

fn command(input: ExecutionInput) -> ExecutionCommand {
    command_with_input(
        CommandSpec {
            execution: 11,
            fence: 3,
            recovery: "recovery-11",
            target: agent_target(true),
            scope: SessionScope::Execution,
        },
        input,
    )
}

#[test]
fn command_and_control_round_trip_deterministically() {
    let command = command(ExecutionInput::Inline(
        InlineExecutionInput::new("{\"ok\":true}").unwrap(),
    ));
    let encoded = serde_json::to_vec(&command).unwrap();
    assert_eq!(
        serde_json::from_slice::<ExecutionCommand>(&encoded).unwrap(),
        command
    );

    let control = command.control();
    let encoded = serde_json::to_vec(&control).unwrap();
    assert_eq!(
        serde_json::from_slice::<ExecutionControl>(&encoded).unwrap(),
        control
    );
}

#[test]
fn command_and_control_reject_unknown_fields_and_default_session_scope() {
    let command = command(ExecutionInput::Inline(
        InlineExecutionInput::new("{\"ok\":true}").unwrap(),
    ));
    let mut command_value = serde_json::to_value(&command).unwrap();
    command_value["unknown"] = json!(true);
    assert!(serde_json::from_value::<ExecutionCommand>(command_value).is_err());

    let mut control_value = serde_json::to_value(command.control()).unwrap();
    control_value
        .as_object_mut()
        .unwrap()
        .remove("sessionScope");
    let control = serde_json::from_value::<ExecutionControl>(control_value).unwrap();
    assert_eq!(control.session_scope(), SessionScope::Execution);
}

#[test]
fn inline_input_and_candidate_reject_limit_plus_one() {
    assert!(InlineExecutionInput::new("x".repeat(MAX_EXECUTION_INLINE_BYTES)).is_ok());
    assert!(InlineExecutionInput::new("x".repeat(MAX_EXECUTION_INLINE_BYTES + 1)).is_err());
    assert!(ExecutionCandidate::new("y".repeat(MAX_EXECUTION_CANDIDATE_BYTES)).is_ok());
    assert!(ExecutionCandidate::new("y".repeat(MAX_EXECUTION_CANDIDATE_BYTES + 1)).is_err());
}

#[test]
fn control_is_secret_free_and_input_free() {
    let command = command_with_input(
        CommandSpec {
            execution: 11,
            fence: 3,
            recovery: "recovery-11",
            target: builtin_target(),
            scope: SessionScope::NodeInstance,
        },
        ExecutionInput::Inline(InlineExecutionInput::new("/tmp/workspace/secret-token").unwrap()),
    );

    let encoded = String::from_utf8(serde_json::to_vec(&command.control()).unwrap()).unwrap();
    assert!(!encoded.contains("/tmp/workspace"));
    assert!(!encoded.contains("secret-token"));
    assert!(!encoded.contains("\"input\""));
    assert!(!encoded.contains("\"workspace\""));
}

#[test]
fn usage_distinguishes_missing_from_zero_and_rejects_negative_usd() {
    let missing = UsageObservation::new(UsageObservationSpec {
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_creation_tokens: None,
        vendor_cost_usd: None,
    })
    .unwrap();
    let zero = UsageObservation::new(UsageObservationSpec {
        input_tokens: Some(0),
        output_tokens: Some(0),
        cache_read_tokens: Some(0),
        cache_creation_tokens: Some(0),
        vendor_cost_usd: Some(Decimal::ZERO),
    })
    .unwrap();
    assert_ne!(
        serde_json::to_value(&missing).unwrap(),
        serde_json::to_value(&zero).unwrap()
    );
    assert!(
        UsageObservation::new(UsageObservationSpec {
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_creation_tokens: None,
            vendor_cost_usd: Some(Decimal::new(-1, 0)),
        })
        .is_err()
    );
}

#[test]
fn execution_result_serializes_candidate_and_usage() {
    let result = ExecutionResult::new(
        ExecutionCandidate::new("{\"candidate\":1}").unwrap(),
        zeroshot_engine::execution::CompletionEvidence::Success,
        Some(
            UsageObservation::new(UsageObservationSpec {
                input_tokens: Some(1),
                output_tokens: Some(2),
                cache_read_tokens: Some(0),
                cache_creation_tokens: Some(0),
                vendor_cost_usd: Some(Decimal::new(125, 2)),
            })
            .unwrap(),
        ),
    )
    .unwrap();
    let encoded = serde_json::to_value(result).unwrap();
    assert_eq!(encoded["candidate"], json!("{\"candidate\":1}"));
    assert_eq!(encoded["usage"]["vendorCostUsd"], json!("1.25"));
}

#[test]
fn reports_round_trip_and_controls_reject_invalid_deadlines() {
    let result = ExecutionResult::new(
        ExecutionCandidate::new("{\"candidate\":2}").unwrap(),
        CompletionEvidence::Fault(
            zeroshot_engine::fault::FaultFactory::new(
                &zeroshot_engine::observability::NoopObservationSink,
            )
            .create(zeroshot_engine::fault::ModuleEvidence::new(
                zeroshot_engine::fault::FaultModule::Worker,
                zeroshot_engine::fault::FaultContext::Execution,
                zeroshot_engine::fault::EvidenceClass::ProcessExited,
            )),
        ),
        None,
    )
    .unwrap();
    let dispatch = DispatchObservation::Completed {
        execution: ExecutionId::new(11).unwrap(),
        dispatch_fence: DispatchFence::new(3).unwrap(),
        result: result.clone(),
    };
    let inspect = ExecutionObservation::Completed {
        execution: ExecutionId::new(11).unwrap(),
        dispatch_fence: DispatchFence::new(3).unwrap(),
        result: result.clone(),
    };
    let cancel = CancelObservation::Completed {
        execution: ExecutionId::new(11).unwrap(),
        dispatch_fence: DispatchFence::new(3).unwrap(),
        result,
    };
    assert_eq!(
        serde_json::from_slice::<DispatchObservation>(&serde_json::to_vec(&dispatch).unwrap())
            .unwrap(),
        dispatch
    );
    assert_eq!(
        serde_json::from_slice::<ExecutionObservation>(&serde_json::to_vec(&inspect).unwrap())
            .unwrap(),
        inspect
    );
    assert_eq!(
        serde_json::from_slice::<CancelObservation>(&serde_json::to_vec(&cancel).unwrap()).unwrap(),
        cancel
    );

    let mut invalid = serde_json::to_value(
        command(ExecutionInput::Inline(
            InlineExecutionInput::new("{\"ok\":true}").unwrap(),
        ))
        .control(),
    )
    .unwrap();
    invalid["executionDeadlineMs"] = json!(0);
    assert!(serde_json::from_value::<ExecutionControl>(invalid).is_err());
}
