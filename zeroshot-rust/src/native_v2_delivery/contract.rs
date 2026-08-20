use openengine_cluster_protocol::{
    ContractValueError, EnumLabel, FieldName, NonEmptyEnumSet, PayloadType, RecordField,
};
use serde::Deserialize;
use serde_json::Value;

use crate::native_v2_runner::{NodeResponseContract, NodeRunnerError};

use super::{
    DELIVERY_CI_FAILED_LABEL, DELIVERY_CONFLICT_LABEL, DELIVERY_HEAD_REVISION_FIELD,
    DELIVERY_MERGED_LABEL, DELIVERY_MODE_FIELD, DELIVERY_OPENED_LABEL, DELIVERY_OUTCOME_FIELD,
    DELIVERY_PULL_REQUEST_ID_FIELD, DELIVERY_REPOSITORY_FIELD, DELIVERY_RESULT_VERSION,
    DELIVERY_SIGNAL_FIELD, DELIVERY_TARGET_BRANCH_FIELD, DELIVERY_VERSION_FIELD, DeliveryMode,
    DeliveryTarget, valid_review_id, valid_revision,
};

pub fn validate_delivery_contract(
    mode: DeliveryMode,
    response: &NodeResponseContract,
) -> Result<(), NodeRunnerError> {
    let NodeResponseContract::Verifier {
        output,
        signals,
        diagnostic,
    } = response
    else {
        return Err(NodeRunnerError::InvalidRole);
    };
    if !delivery_contract_matches(mode, output, signals, diagnostic)
        .map_err(|_| NodeRunnerError::Driver)?
    {
        return Err(NodeRunnerError::Driver);
    }
    Ok(())
}

fn delivery_contract_matches(
    mode: DeliveryMode,
    output: &PayloadType,
    signals: &std::collections::BTreeMap<FieldName, NonEmptyEnumSet>,
    diagnostic: &PayloadType,
) -> Result<bool, ContractValueError> {
    let expected_output = delivery_result_schema(mode)?;
    let expected_diagnostic = delivery_diagnostic_schema()?;
    let field = FieldName::new(DELIVERY_SIGNAL_FIELD)?;
    let expected_labels = delivery_signal_labels(mode)?;
    Ok(output == &expected_output
        && diagnostic == &expected_diagnostic
        && signals.len() == 1
        && signals.get(&field) == Some(&expected_labels))
}

pub(crate) fn delivery_diagnostic_schema() -> Result<PayloadType, ContractValueError> {
    Ok(PayloadType::Record {
        fields: [contract_field("message", PayloadType::String)?]
            .into_iter()
            .collect(),
    })
}

#[must_use]
pub fn is_matching_success_receipt(
    output: &Value,
    mode: DeliveryMode,
    target: &DeliveryTarget,
) -> bool {
    let Ok(result) = serde_json::from_value::<DeliveryResultWire>(output.clone()) else {
        return false;
    };
    result.version == DELIVERY_RESULT_VERSION
        && result.mode == mode.label()
        && result.outcome == mode.success_outcome()
        && receipt_matches_target(&result, target)
}

fn receipt_matches_target(result: &DeliveryResultWire, target: &DeliveryTarget) -> bool {
    result.repository == target.repository
        && result.target_branch == target.target_branch
        && valid_revision(&result.head_revision)
        && result.head_revision != target.base_revision
        && valid_review_id(&result.pull_request_id)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeliveryResultWire {
    version: String,
    mode: String,
    outcome: String,
    repository: String,
    target_branch: String,
    head_revision: String,
    pull_request_id: String,
}

pub(crate) fn delivery_result_schema(
    mode: DeliveryMode,
) -> Result<PayloadType, ContractValueError> {
    let mut fields = delivery_identity_fields()?;
    fields.extend(delivery_mode_fields(mode)?);
    Ok(PayloadType::Record {
        fields: fields.into_iter().collect(),
    })
}

fn delivery_identity_fields() -> Result<Vec<(FieldName, RecordField)>, ContractValueError> {
    Ok(vec![
        contract_field(
            DELIVERY_VERSION_FIELD,
            contract_enum(&[DELIVERY_RESULT_VERSION])?,
        )?,
        contract_field(DELIVERY_REPOSITORY_FIELD, PayloadType::String)?,
        contract_field(DELIVERY_TARGET_BRANCH_FIELD, PayloadType::String)?,
        contract_field(DELIVERY_HEAD_REVISION_FIELD, PayloadType::String)?,
        contract_field(DELIVERY_PULL_REQUEST_ID_FIELD, PayloadType::String)?,
    ])
}

fn delivery_mode_fields(
    mode: DeliveryMode,
) -> Result<Vec<(FieldName, RecordField)>, ContractValueError> {
    Ok(vec![
        contract_field(DELIVERY_MODE_FIELD, contract_enum(&[mode.label()])?)?,
        contract_field(
            DELIVERY_OUTCOME_FIELD,
            PayloadType::Enum {
                values: delivery_signal_labels(mode)?,
            },
        )?,
    ])
}

pub(crate) fn delivery_signal_labels(
    mode: DeliveryMode,
) -> Result<NonEmptyEnumSet, ContractValueError> {
    match mode {
        DeliveryMode::PullRequest => contract_labels(&[DELIVERY_OPENED_LABEL]),
        DeliveryMode::Merge => contract_labels(&[
            DELIVERY_MERGED_LABEL,
            DELIVERY_CONFLICT_LABEL,
            DELIVERY_CI_FAILED_LABEL,
        ]),
    }
}

fn contract_field(
    name: &str,
    value_type: PayloadType,
) -> Result<(FieldName, RecordField), ContractValueError> {
    Ok((
        FieldName::new(name)?,
        RecordField {
            value_type,
            required: true,
        },
    ))
}

fn contract_enum(values: &[&str]) -> Result<PayloadType, ContractValueError> {
    Ok(PayloadType::Enum {
        values: contract_labels(values)?,
    })
}

fn contract_labels(values: &[&str]) -> Result<NonEmptyEnumSet, ContractValueError> {
    let values = values
        .iter()
        .copied()
        .map(EnumLabel::new)
        .collect::<Result<Vec<_>, _>>()?;
    NonEmptyEnumSet::new(values)
}
