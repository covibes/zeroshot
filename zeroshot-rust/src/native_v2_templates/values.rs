//! Typed payload, state, binding, and basic graph-node constructors for built-in templates.

use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    ChoiceBranch, ChoiceNode, DataSelector, FailNode, FailReason, FieldName, FieldPath, GraphNode,
    GraphProfile, GraphSpec, InputBinding, NodeOutputChannel, NodeOutputSelector, PayloadType,
    PolicyBinding, PolicyDefault, PolicyRef, RecordField, SeqNode, SucceedNode, WriteBinding,
};

use crate::native_v2_delivery::contract::{delivery_result_schema, delivery_signal_labels};
use crate::native_v2_delivery::DeliveryMode;

use super::{
    delivery_mode, enum_label, field_name, field_path, node_name, non_empty, static_value,
    BuiltinTemplateError, TemplateDelivery, ACCEPTANCE_FEEDBACK_FIELD, CODE_FEEDBACK_FIELD,
    DIAGNOSTIC_MESSAGE_FIELD, TASK_FIELD,
};

pub(super) fn graph(
    initial_input: PayloadType,
    root: GraphNode,
) -> Result<GraphSpec, BuiltinTemplateError> {
    Ok(GraphSpec {
        profile: GraphProfile::Full,
        initial_input,
        policy: PolicyBinding {
            policy: static_value(PolicyRef::new("policy.native-v2@1"))?,
            default: PolicyDefault::Deny,
        },
        root,
    })
}

pub(super) fn sequence(
    name: &str,
    state: PayloadType,
    children: Vec<GraphNode>,
    promoted_state_paths: Vec<FieldPath>,
) -> Result<GraphNode, BuiltinTemplateError> {
    Ok(GraphNode::Seq(SeqNode {
        name: node_name(name)?,
        state,
        children: non_empty(children)?,
        promoted_state_paths,
    }))
}

pub(super) fn choice(
    name: &str,
    state: PayloadType,
    branches: Vec<ChoiceBranch>,
    otherwise: Option<GraphNode>,
) -> Result<GraphNode, BuiltinTemplateError> {
    Ok(GraphNode::Choice(ChoiceNode {
        name: node_name(name)?,
        state,
        branches: non_empty(branches)?,
        otherwise: otherwise.map(Box::new),
        promoted_state_paths: Vec::new(),
    }))
}

pub(super) fn succeed_null(name: &str) -> Result<GraphNode, BuiltinTemplateError> {
    Ok(GraphNode::Succeed(SucceedNode {
        name: node_name(name)?,
        output: PayloadType::Null,
        bindings: Vec::new(),
    }))
}

pub(super) fn fail(name: &str, reason: &str) -> Result<GraphNode, BuiltinTemplateError> {
    let reason = static_value(FailReason::new(enum_label(reason)?))?;
    Ok(GraphNode::Fail(FailNode {
        name: node_name(name)?,
        reason,
    }))
}

pub(super) fn task_type() -> Result<PayloadType, BuiltinTemplateError> {
    record_type(vec![(TASK_FIELD, PayloadType::String, true)])
}

pub(super) fn diagnostic_type() -> Result<PayloadType, BuiltinTemplateError> {
    record_type(vec![(DIAGNOSTIC_MESSAGE_FIELD, PayloadType::String, true)])
}

pub(super) fn review_repair_input_type() -> Result<PayloadType, BuiltinTemplateError> {
    record_type(vec![
        (TASK_FIELD, PayloadType::String, true),
        (ACCEPTANCE_FEEDBACK_FIELD, PayloadType::String, true),
        (CODE_FEEDBACK_FIELD, PayloadType::String, true),
    ])
}

pub(super) fn software_input_type() -> Result<PayloadType, BuiltinTemplateError> {
    review_repair_input_type()
}

pub(super) fn delivery_repair_input_type() -> Result<PayloadType, BuiltinTemplateError> {
    record_type(vec![
        (TASK_FIELD, PayloadType::String, true),
        (
            "outcome",
            PayloadType::Enum {
                values: static_value(delivery_signal_labels(DeliveryMode::Merge))?,
            },
            true,
        ),
    ])
}

pub(super) fn software_state(
    delivery: TemplateDelivery,
) -> Result<PayloadType, BuiltinTemplateError> {
    let mut fields = BTreeMap::from([
        (field_name(TASK_FIELD)?, required(PayloadType::String)),
        (
            field_name(ACCEPTANCE_FEEDBACK_FIELD)?,
            required(PayloadType::String),
        ),
        (
            field_name(CODE_FEEDBACK_FIELD)?,
            required(PayloadType::String),
        ),
    ]);
    if let Some(mode) = delivery_mode(delivery) {
        let output = static_value(delivery_result_schema(mode))?;
        for (name, field) in record_fields(output)? {
            fields.insert(name, optional(field.value_type));
        }
    }
    Ok(PayloadType::Record { fields })
}

fn record_type(
    fields: Vec<(&str, PayloadType, bool)>,
) -> Result<PayloadType, BuiltinTemplateError> {
    let fields = fields
        .into_iter()
        .map(|(name, value_type, required)| {
            Ok((
                field_name(name)?,
                RecordField {
                    value_type,
                    required,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, BuiltinTemplateError>>()?;
    Ok(PayloadType::Record { fields })
}

fn record_fields(
    payload: PayloadType,
) -> Result<BTreeMap<FieldName, RecordField>, BuiltinTemplateError> {
    match payload {
        PayloadType::Record { fields } => Ok(fields),
        _ => Err(BuiltinTemplateError::InvalidStaticContract),
    }
}

pub(super) fn output_fields(payload: &PayloadType) -> Result<Vec<String>, BuiltinTemplateError> {
    match payload {
        PayloadType::Record { fields } => {
            Ok(fields.keys().map(|name| name.as_str().to_owned()).collect())
        }
        _ => Err(BuiltinTemplateError::InvalidStaticContract),
    }
}

fn required(value_type: PayloadType) -> RecordField {
    RecordField {
        value_type,
        required: true,
    }
}

fn optional(value_type: PayloadType) -> RecordField {
    RecordField {
        value_type,
        required: false,
    }
}

pub(super) fn state_input(
    target: &str,
    source: &str,
) -> Result<InputBinding, BuiltinTemplateError> {
    Ok(InputBinding {
        target: field_path(target)?,
        value: DataSelector::State {
            path: field_path(source)?,
        },
    })
}

pub(super) fn diagnostic_write(
    node: &str,
    target: &str,
) -> Result<WriteBinding, BuiltinTemplateError> {
    write_binding(
        node,
        NodeOutputChannel::Diagnostic,
        DIAGNOSTIC_MESSAGE_FIELD,
        target,
    )
}

pub(super) fn output_write(
    node: &str,
    source: &str,
    target: &str,
) -> Result<WriteBinding, BuiltinTemplateError> {
    write_binding(node, NodeOutputChannel::Out, source, target)
}

fn write_binding(
    node: &str,
    channel: NodeOutputChannel,
    source: &str,
    target: &str,
) -> Result<WriteBinding, BuiltinTemplateError> {
    Ok(WriteBinding {
        value: NodeOutputSelector {
            node: node_name(node)?,
            channel,
            path: field_path(source)?,
        },
        target: field_path(target)?,
    })
}
