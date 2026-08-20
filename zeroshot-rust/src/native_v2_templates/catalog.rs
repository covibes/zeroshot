//! Public built-in template selection and local materialization seams.

use openengine_cluster_protocol::{GraphSpec, NodeName};
use serde_json::Value;
use thiserror::Error;

use crate::native_v2_contract::{DeclaredEnvironment, EnvironmentVariableName, NodeRuntimeBinding};
use crate::native_v2_delivery::GITHUB_TOKEN_ENV;

use super::{
    node_name, single_worker_graph, software_change_graph, static_value, ACCEPTANCE_FEEDBACK_FIELD,
    CODE_FEEDBACK_FIELD, DELIVERY_FEEDBACK_FIELD, DELIVERY_NODE,
};

/// The deliberately small set of built-in graph templates.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BuiltinGraphTemplate {
    SingleWorker,
    SoftwareChange,
}

impl BuiltinGraphTemplate {
    pub(crate) const ALL: [Self; 2] = [Self::SingleWorker, Self::SoftwareChange];

    #[must_use]
    pub(crate) const fn all() -> &'static [Self] {
        &Self::ALL
    }

    #[must_use]
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::SingleWorker => "single-worker",
            Self::SoftwareChange => "software-change",
        }
    }

    #[must_use]
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "single-worker" => Some(Self::SingleWorker),
            "software-change" => Some(Self::SoftwareChange),
            _ => None,
        }
    }

    pub(crate) fn materialize(
        self,
        delivery: TemplateDelivery,
    ) -> Result<GraphSpec, BuiltinTemplateError> {
        self.validate_delivery(delivery)?;
        match self {
            Self::SingleWorker => single_worker_graph(),
            Self::SoftwareChange => software_change_graph(delivery),
        }
    }

    pub(crate) fn delivery_runtime_binding(
        self,
        delivery: TemplateDelivery,
    ) -> Result<Option<(NodeName, NodeRuntimeBinding)>, BuiltinTemplateError> {
        self.validate_delivery(delivery)?;
        if delivery == TemplateDelivery::None {
            return Ok(None);
        }
        let environment_name = static_value(EnvironmentVariableName::new(GITHUB_TOKEN_ENV))?;
        let env = static_value(DeclaredEnvironment::new([environment_name]))?;
        Ok(Some((
            node_name(DELIVERY_NODE)?,
            NodeRuntimeBinding::GitDelivery { env },
        )))
    }

    /// Adds template-owned state fields while preserving the user-authored task value.
    pub(crate) fn materialize_input(self, mut input: Value) -> Result<Value, BuiltinTemplateError> {
        if self == Self::SoftwareChange {
            let object = input
                .as_object_mut()
                .ok_or(BuiltinTemplateError::InputMustBeObject)?;
            object.insert(
                ACCEPTANCE_FEEDBACK_FIELD.to_owned(),
                Value::String(String::new()),
            );
            object.insert(CODE_FEEDBACK_FIELD.to_owned(), Value::String(String::new()));
            object.insert(
                DELIVERY_FEEDBACK_FIELD.to_owned(),
                Value::String(String::new()),
            );
        }
        Ok(input)
    }

    fn validate_delivery(self, delivery: TemplateDelivery) -> Result<(), BuiltinTemplateError> {
        if self == Self::SingleWorker && delivery != TemplateDelivery::None {
            Err(BuiltinTemplateError::UnsupportedDelivery {
                template: self.name(),
                delivery,
            })
        } else {
            Ok(())
        }
    }
}

/// Closed delivery materialization for the software-change template.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TemplateDelivery {
    None,
    PullRequest,
    Merge,
}

impl TemplateDelivery {
    #[must_use]
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::PullRequest => "pull_request",
            Self::Merge => "merge",
        }
    }
}

impl std::fmt::Display for TemplateDelivery {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.name())
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub(crate) enum BuiltinTemplateError {
    #[error("template {template} does not support delivery mode {delivery}")]
    UnsupportedDelivery {
        template: &'static str,
        delivery: TemplateDelivery,
    },
    #[error("a built-in graph template contains an invalid static contract")]
    InvalidStaticContract,
    #[error("built-in template input must be a JSON object")]
    InputMustBeObject,
}
