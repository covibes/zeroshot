//! Typed graph construction behind the native-v2 built-in template catalog.

use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    ChoiceBranch, ControlSelector, ControlSource, EnumLabel, FieldName, FieldPath, GraphNode,
    GraphSpec, Guard, Join, LoopNode, NodeInstructions, NodeName, NonEmptyEnumSet, NonEmptyVec,
    ParNode, PayloadType, PositiveInteger, StepNode, SucceedNode, VerifierNode, WorkerErrorCode,
    WorkerRef,
};

use crate::native_v2_contract::{GIT_DELIVERY_MERGE_WORKER_REF, GIT_DELIVERY_PR_WORKER_REF};
use crate::native_v2_delivery::contract::{delivery_result_schema, delivery_signal_labels};
use crate::native_v2_delivery::{
    DeliveryMode, DELIVERY_CI_FAILED_LABEL, DELIVERY_CONFLICT_LABEL, DELIVERY_MERGED_LABEL,
    DELIVERY_SIGNAL_FIELD,
};

#[path = "native_v2_templates/catalog.rs"]
mod catalog;
pub use catalog::{BuiltinGraphTemplate, TemplateDelivery};
pub(crate) use catalog::BuiltinTemplateError;
#[path = "native_v2_templates/values.rs"]
mod values;
use values::*;

#[cfg(test)]
#[path = "native_v2_templates/tests.rs"]
mod tests;

const NODE_TIMEOUT_MS: u64 = 60 * 60 * 1_000;
const REVIEW_ITERATIONS: u64 = 10;
const DELIVERY_ITERATIONS: u64 = 10;
const TASK_FIELD: &str = "task";
const ACCEPTANCE_FEEDBACK_FIELD: &str = "acceptanceFeedback";
const CODE_FEEDBACK_FIELD: &str = "codeFeedback";
const DIAGNOSTIC_MESSAGE_FIELD: &str = "message";
const VERDICT_FIELD: &str = "verdict";
const ACCEPTED_LABEL: &str = "accepted";
const REJECTED_LABEL: &str = "rejected";
const DELIVERY_NODE: &str = "deliver";

fn single_worker_graph() -> Result<GraphSpec, BuiltinTemplateError> {
    let state = task_type()?;
    let worker = task_worker(
        "builtin.agent.worker@1",
        "Complete the requested task in the shared workspace. Follow repository guidance, make \
         focused changes, and run the relevant checks.",
    )?;
    let route = choice(
        "worker_result",
        state.clone(),
        vec![ChoiceBranch {
            when: executable_error_guard("worker")?,
            node: fail("worker_failed", "worker_failed")?,
        }],
        Some(succeed_null("done")?),
    )?;
    graph(
        state.clone(),
        sequence("run", state, vec![worker, route], Vec::new())?,
    )
}

fn software_change_graph(delivery: TemplateDelivery) -> Result<GraphSpec, BuiltinTemplateError> {
    let state = software_state(delivery)?;
    let worker = task_worker(
        "builtin.agent.software-worker@1",
        "Implement the requested software change fully in the shared workspace. Follow the \
         repository's guidance, keep the change focused, and run relevant checks.",
    )?;
    let worker_route = initial_worker_route(state.clone(), delivery)?;
    graph(
        software_input_type()?,
        sequence("run", state, vec![worker, worker_route], Vec::new())?,
    )
}

fn initial_worker_route(
    state: PayloadType,
    delivery: TemplateDelivery,
) -> Result<GraphNode, BuiltinTemplateError> {
    choice(
        "worker_result",
        state.clone(),
        vec![ChoiceBranch {
            when: executable_error_guard("worker")?,
            node: fail("worker_failed", "worker_failed")?,
        }],
        Some(review_loop(state, delivery)?),
    )
}

fn task_worker(
    worker: &str,
    authored_instructions: &str,
) -> Result<GraphNode, BuiltinTemplateError> {
    Ok(GraphNode::Step(StepNode {
        name: node_name("worker")?,
        worker: worker_ref(worker)?,
        instructions: Some(instructions(authored_instructions)?),
        input: task_type()?,
        output: PayloadType::Null,
        input_bindings: vec![state_input(TASK_FIELD, TASK_FIELD)?],
        write_bindings: Vec::new(),
        timeout_ms: positive(NODE_TIMEOUT_MS)?,
        attempts: positive(1)?,
    }))
}

fn review_loop(
    state: PayloadType,
    delivery: TemplateDelivery,
) -> Result<GraphNode, BuiltinTemplateError> {
    let parallel = parallel_reviewers(state.clone())?;
    let route = review_route(state.clone(), delivery)?;
    let feedback_paths = feedback_paths()?;
    let body = sequence(
        "review_iteration",
        state.clone(),
        vec![parallel, route],
        feedback_paths.clone(),
    )?;
    let loop_node = GraphNode::Loop(LoopNode {
        name: node_name("review_loop")?,
        state: state.clone(),
        body: Box::new(body),
        until: accepted_reviews_guard()?,
        max_iterations: positive(REVIEW_ITERATIONS)?,
        promoted_state_paths: feedback_paths,
    });
    sequence(
        "reviews",
        state,
        vec![loop_node, fail("reviews_exhausted", "reviews_exhausted")?],
        Vec::new(),
    )
}

fn parallel_reviewers(state: PayloadType) -> Result<GraphNode, BuiltinTemplateError> {
    let acceptance = review_verifier(
        "acceptance",
        "builtin.agent.acceptance-verifier@1",
        "Verify the change independently against the user's request and observable behavior. Do \
         not edit files. Accept only with concrete evidence; otherwise return actionable feedback.",
        ACCEPTANCE_FEEDBACK_FIELD,
    )?;
    let code = review_verifier(
        "code",
        "builtin.agent.code-verifier@1",
        "Review the change independently for correctness, safety, integration, and substantive \
         maintainability. Do not edit files or reject for style-only preferences. Return \
         actionable feedback when rejecting.",
        CODE_FEEDBACK_FIELD,
    )?;
    Ok(GraphNode::Par(ParNode {
        name: node_name("parallel_reviews")?,
        state,
        branches: non_empty(vec![acceptance, code])?,
        promoted_state_paths: feedback_paths()?,
        join: Join::All {},
    }))
}

fn review_verifier(
    name: &str,
    worker: &str,
    authored_instructions: &str,
    feedback_target: &str,
) -> Result<GraphNode, BuiltinTemplateError> {
    let signals = BTreeMap::from([(field_name(VERDICT_FIELD)?, verdict_labels()?)]);
    Ok(GraphNode::Verifier(VerifierNode {
        name: node_name(name)?,
        worker: worker_ref(worker)?,
        input: task_type()?,
        output: PayloadType::Null,
        input_bindings: vec![state_input(TASK_FIELD, TASK_FIELD)?],
        write_bindings: vec![diagnostic_write(name, feedback_target)?],
        timeout_ms: positive(NODE_TIMEOUT_MS)?,
        attempts: positive(1)?,
        signals,
        diagnostic: diagnostic_type()?,
        instructions: Some(instructions(authored_instructions)?),
    }))
}

fn review_route(
    state: PayloadType,
    delivery: TemplateDelivery,
) -> Result<GraphNode, BuiltinTemplateError> {
    choice(
        "review_result",
        state.clone(),
        vec![
            ChoiceBranch {
                when: any_executable_error_guard(&["acceptance", "code"])?,
                node: fail("review_failed", "review_failed")?,
            },
            ChoiceBranch {
                when: accepted_reviews_guard()?,
                node: accepted_change(state, delivery)?,
            },
        ],
        Some(review_repair()?),
    )
}

fn review_repair() -> Result<GraphNode, BuiltinTemplateError> {
    Ok(GraphNode::Step(StepNode {
        name: node_name("review_repair")?,
        worker: worker_ref("builtin.agent.review-repair@1")?,
        instructions: Some(instructions(
            "Address both verifier diagnostics in the shared workspace without weakening the \
             requested behavior. Run the relevant checks before returning.",
        )?),
        input: review_repair_input_type()?,
        output: PayloadType::Null,
        input_bindings: vec![
            state_input(TASK_FIELD, TASK_FIELD)?,
            state_input(ACCEPTANCE_FEEDBACK_FIELD, ACCEPTANCE_FEEDBACK_FIELD)?,
            state_input(CODE_FEEDBACK_FIELD, CODE_FEEDBACK_FIELD)?,
        ],
        write_bindings: Vec::new(),
        timeout_ms: positive(NODE_TIMEOUT_MS)?,
        attempts: positive(1)?,
    }))
}

fn accepted_change(
    state: PayloadType,
    delivery: TemplateDelivery,
) -> Result<GraphNode, BuiltinTemplateError> {
    match delivery {
        TemplateDelivery::None => succeed_null("done"),
        TemplateDelivery::PullRequest => pull_request_delivery(state),
        TemplateDelivery::Merge => merge_delivery(state),
    }
}

fn pull_request_delivery(state: PayloadType) -> Result<GraphNode, BuiltinTemplateError> {
    let mode = DeliveryMode::PullRequest;
    let route = choice(
        "delivery_result",
        state.clone(),
        vec![ChoiceBranch {
            when: executable_error_guard(DELIVERY_NODE)?,
            node: fail("delivery_failed", "delivery_failed")?,
        }],
        Some(delivery_success("done", mode)?),
    )?;
    sequence(
        "pull_request_delivery",
        state,
        vec![delivery_node(mode)?, route],
        Vec::new(),
    )
}

fn merge_delivery(state: PayloadType) -> Result<GraphNode, BuiltinTemplateError> {
    let mode = DeliveryMode::Merge;
    let route = choice(
        "delivery_result",
        state.clone(),
        vec![
            ChoiceBranch {
                when: executable_error_guard(DELIVERY_NODE)?,
                node: fail("delivery_failed", "delivery_failed")?,
            },
            ChoiceBranch {
                when: delivery_signal_guard(&[DELIVERY_CI_FAILED_LABEL, DELIVERY_CONFLICT_LABEL])?,
                node: delivery_repair()?,
            },
        ],
        Some(delivery_success("done", mode)?),
    )?;
    let body = sequence(
        "delivery_attempt",
        state.clone(),
        vec![delivery_node(mode)?, route],
        Vec::new(),
    )?;
    let loop_node = GraphNode::Loop(LoopNode {
        name: node_name("delivery_loop")?,
        state: state.clone(),
        body: Box::new(body),
        until: delivery_signal_guard(&[DELIVERY_MERGED_LABEL])?,
        max_iterations: positive(DELIVERY_ITERATIONS)?,
        promoted_state_paths: Vec::new(),
    });
    sequence(
        "merge_delivery",
        state,
        vec![loop_node, fail("delivery_exhausted", "delivery_exhausted")?],
        Vec::new(),
    )
}

fn delivery_repair() -> Result<GraphNode, BuiltinTemplateError> {
    Ok(GraphNode::Step(StepNode {
        name: node_name("delivery_repair")?,
        worker: worker_ref("builtin.agent.delivery-repair@1")?,
        instructions: Some(instructions(
            "Resolve the reported CI failure or merge conflict in the shared workspace. Preserve \
             the requested behavior and verifier-approved change, then run the relevant checks.",
        )?),
        input: delivery_repair_input_type()?,
        output: PayloadType::Null,
        input_bindings: vec![
            state_input(TASK_FIELD, TASK_FIELD)?,
            state_input("outcome", "outcome")?,
        ],
        write_bindings: Vec::new(),
        timeout_ms: positive(NODE_TIMEOUT_MS)?,
        attempts: positive(1)?,
    }))
}

fn delivery_node(mode: DeliveryMode) -> Result<GraphNode, BuiltinTemplateError> {
    let output = static_value(delivery_result_schema(mode))?;
    let write_bindings = output_fields(&output)?
        .into_iter()
        .map(|field| output_write(DELIVERY_NODE, &field, &field))
        .collect::<Result<Vec<_>, _>>()?;
    let signals = BTreeMap::from([(
        field_name(DELIVERY_SIGNAL_FIELD)?,
        static_value(delivery_signal_labels(mode))?,
    )]);
    Ok(GraphNode::Verifier(VerifierNode {
        name: node_name(DELIVERY_NODE)?,
        worker: worker_ref(delivery_worker(mode))?,
        input: PayloadType::Null,
        output,
        input_bindings: Vec::new(),
        write_bindings,
        timeout_ms: positive(NODE_TIMEOUT_MS)?,
        attempts: positive(1)?,
        signals,
        diagnostic: PayloadType::String,
        instructions: None,
    }))
}

fn delivery_success(name: &str, mode: DeliveryMode) -> Result<GraphNode, BuiltinTemplateError> {
    let output = static_value(delivery_result_schema(mode))?;
    let bindings = output_fields(&output)?
        .into_iter()
        .map(|field| state_input(&field, &field))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(GraphNode::Succeed(SucceedNode {
        name: node_name(name)?,
        output,
        bindings,
    }))
}

fn accepted_reviews_guard() -> Result<Guard, BuiltinTemplateError> {
    Ok(Guard::All {
        guards: non_empty(vec![
            signal_guard("acceptance", VERDICT_FIELD, &[ACCEPTED_LABEL])?,
            signal_guard("code", VERDICT_FIELD, &[ACCEPTED_LABEL])?,
        ])?,
    })
}

fn delivery_signal_guard(labels: &[&str]) -> Result<Guard, BuiltinTemplateError> {
    signal_guard(DELIVERY_NODE, DELIVERY_SIGNAL_FIELD, labels)
}

fn signal_guard(node: &str, field: &str, labels: &[&str]) -> Result<Guard, BuiltinTemplateError> {
    Ok(Guard::In {
        value: ControlSelector {
            name: node_name(node)?,
            source: ControlSource::Signal,
            field: Some(field_name(field)?),
        },
        labels: enum_labels(labels)?,
    })
}

fn executable_error_guard(node: &str) -> Result<Guard, BuiltinTemplateError> {
    Ok(Guard::In {
        value: ControlSelector {
            name: node_name(node)?,
            source: ControlSource::Error,
            field: None,
        },
        labels: enum_labels(&[
            WorkerErrorCode::Timeout.as_str(),
            WorkerErrorCode::Crash.as_str(),
            WorkerErrorCode::Malformed.as_str(),
            WorkerErrorCode::Refusal.as_str(),
        ])?,
    })
}

fn any_executable_error_guard(nodes: &[&str]) -> Result<Guard, BuiltinTemplateError> {
    let guards = nodes
        .iter()
        .map(|name| executable_error_guard(name))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Guard::Any {
        guards: non_empty(guards)?,
    })
}

fn feedback_paths() -> Result<Vec<FieldPath>, BuiltinTemplateError> {
    Ok(vec![
        field_path(ACCEPTANCE_FEEDBACK_FIELD)?,
        field_path(CODE_FEEDBACK_FIELD)?,
    ])
}

fn verdict_labels() -> Result<NonEmptyEnumSet, BuiltinTemplateError> {
    enum_labels(&[ACCEPTED_LABEL, REJECTED_LABEL])
}

fn delivery_mode(delivery: TemplateDelivery) -> Option<DeliveryMode> {
    match delivery {
        TemplateDelivery::None => None,
        TemplateDelivery::PullRequest => Some(DeliveryMode::PullRequest),
        TemplateDelivery::Merge => Some(DeliveryMode::Merge),
    }
}

fn delivery_worker(mode: DeliveryMode) -> &'static str {
    match mode {
        DeliveryMode::PullRequest => GIT_DELIVERY_PR_WORKER_REF,
        DeliveryMode::Merge => GIT_DELIVERY_MERGE_WORKER_REF,
    }
}

fn node_name(value: &str) -> Result<NodeName, BuiltinTemplateError> {
    static_value(NodeName::new(value))
}

fn field_name(value: &str) -> Result<FieldName, BuiltinTemplateError> {
    static_value(FieldName::new(value))
}

fn enum_label(value: &str) -> Result<EnumLabel, BuiltinTemplateError> {
    static_value(EnumLabel::new(value))
}

fn field_path(value: &str) -> Result<FieldPath, BuiltinTemplateError> {
    static_value(FieldPath::new(vec![field_name(value)?]))
}

fn worker_ref(value: &str) -> Result<WorkerRef, BuiltinTemplateError> {
    static_value(WorkerRef::new(value))
}

fn instructions(value: &str) -> Result<NodeInstructions, BuiltinTemplateError> {
    static_value(NodeInstructions::new(value))
}

fn positive(value: u64) -> Result<PositiveInteger, BuiltinTemplateError> {
    static_value(PositiveInteger::new(value))
}

fn enum_labels(values: &[&str]) -> Result<NonEmptyEnumSet, BuiltinTemplateError> {
    let labels = values
        .iter()
        .map(|value| enum_label(value))
        .collect::<Result<Vec<_>, _>>()?;
    static_value(NonEmptyEnumSet::new(labels))
}

fn non_empty<T>(values: Vec<T>) -> Result<NonEmptyVec<T>, BuiltinTemplateError> {
    static_value(NonEmptyVec::new(values))
}

fn static_value<T, E>(value: Result<T, E>) -> Result<T, BuiltinTemplateError> {
    value.map_err(|_| BuiltinTemplateError::InvalidStaticContract)
}
