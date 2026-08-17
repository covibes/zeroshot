//! Canonical compiled IR serialization and graph identities.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{GraphDiff, NodeName, PayloadType};
use crate::{
    ChoiceBranch, ChoiceNode, ControlSelector, GraphNode, GraphProfile, Guard, InputBinding, Join,
    LoopNode, MapNode, NonEmptyVec, ParNode, PolicyBinding, SeqNode, Sha256Digest,
    Sha256DigestError, StructuralBounds, WriteBinding,
};

/// Backend-produced, verified graph IR.
///
/// Constructing or serializing this value does not verify or admit a graph. Only a backend
/// verifier may promote graph syntax to admitted compiled IR.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompiledGraphIr {
    pub profile: GraphProfile,
    pub initial_input: PayloadType,
    pub policy: PolicyBinding,
    pub root: GraphNode,
    pub bounds: StructuralBounds,
}

impl CompiledGraphIr {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, CanonicalError> {
        let mut normalized = self.clone();
        normalize_node(&mut normalized.root)?;
        normalized.bounds.attempts_per_node =
            normalized.bounds.attempts_per_node.into_iter().collect();
        canonical_json_bytes(&normalized)
    }

    pub fn identity(&self) -> Result<GraphIdentity, CanonicalError> {
        let digest = Sha256::digest(self.canonical_bytes()?);
        Ok(GraphIdentity(Sha256Digest::from_digest(digest.as_ref())))
    }
}

#[derive(Debug, Error)]
pub enum CanonicalError {
    #[error("canonical IR serialization failed: {0}")]
    Serialize(serde_json::Error),
    #[error("canonical IR cannot contain floating-point values")]
    FloatingPoint,
    #[error("compiled graph contains duplicate node name {0}")]
    DuplicateNodeName(NodeName),
    #[error("canonical normalization violated the non-empty graph invariant")]
    EmptyAfterNormalization,
}

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
#[schemars(transparent)]
pub struct GraphIdentity(Sha256Digest);

impl GraphIdentity {
    pub fn new(value: impl Into<String>) -> Result<Self, Sha256DigestError> {
        Sha256Digest::new(value).map(Self)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Display for GraphIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for GraphIdentity {
    type Err = Sha256DigestError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
#[schemars(transparent)]
pub struct RequestFingerprint(Sha256Digest);

impl RequestFingerprint {
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Display for RequestFingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Hash a method and its validated parameters using recursively key-sorted JSON.
pub fn admission_fingerprint(
    method: &str,
    parameters: &serde_json::Value,
) -> Result<RequestFingerprint, CanonicalError> {
    let envelope = serde_json::json!({ "method": method, "params": parameters });
    let digest = Sha256::digest(canonical_value_bytes(&envelope)?);
    Ok(RequestFingerprint(Sha256Digest::from_digest(
        digest.as_ref(),
    )))
}

/// Canonical JSON bytes for validated request values.
pub fn canonical_value_bytes(value: &serde_json::Value) -> Result<Vec<u8>, CanonicalError> {
    let mut bytes = Vec::new();
    write_canonical_json(value, &mut bytes, true)?;
    Ok(bytes)
}

/// Compute a stable node-name diff between verified compiled graphs.
pub fn diff_compiled_graphs(
    current: Option<&CompiledGraphIr>,
    desired: &CompiledGraphIr,
) -> Result<GraphDiff, CanonicalError> {
    let current = current
        .map(node_fingerprints)
        .transpose()?
        .unwrap_or_default();
    let desired = node_fingerprints(desired)?;
    Ok(GraphDiff {
        added: desired
            .keys()
            .filter(|name| !current.contains_key(*name))
            .cloned()
            .collect(),
        removed: current
            .keys()
            .filter(|name| !desired.contains_key(*name))
            .cloned()
            .collect(),
        changed: desired
            .iter()
            .filter_map(|(name, bytes)| {
                current
                    .get(name)
                    .filter(|current| *current != bytes)
                    .map(|_| name.clone())
            })
            .collect(),
    })
}

fn node_fingerprints(
    graph: &CompiledGraphIr,
) -> Result<BTreeMap<NodeName, Vec<u8>>, CanonicalError> {
    let mut nodes = BTreeMap::new();
    collect_node_fingerprints(&graph.root, &mut nodes)?;
    Ok(nodes)
}

fn collect_node_fingerprints(
    node: &GraphNode,
    nodes: &mut BTreeMap<NodeName, Vec<u8>>,
) -> Result<(), CanonicalError> {
    let mut normalized = node.clone();
    normalize_node(&mut normalized)?;
    let name = node.name().clone();
    if nodes
        .insert(name.clone(), canonical_json_bytes(&normalized)?)
        .is_some()
    {
        return Err(CanonicalError::DuplicateNodeName(name));
    }
    match node {
        GraphNode::Seq(node) => {
            for child in node.children.as_slice() {
                collect_node_fingerprints(child, nodes)?;
            }
        }
        GraphNode::Choice(node) => {
            for branch in node.branches.as_slice() {
                collect_node_fingerprints(&branch.node, nodes)?;
            }
            if let Some(otherwise) = &node.otherwise {
                collect_node_fingerprints(otherwise, nodes)?;
            }
        }
        GraphNode::Par(node) => {
            for branch in node.branches.as_slice() {
                collect_node_fingerprints(branch, nodes)?;
            }
        }
        GraphNode::Loop(node) => collect_node_fingerprints(&node.body, nodes)?,
        GraphNode::Map(node) => collect_node_fingerprints(&node.body, nodes)?,
        GraphNode::Step(_)
        | GraphNode::Verifier(_)
        | GraphNode::Succeed(_)
        | GraphNode::Fail(_) => {}
    }
    Ok(())
}

fn take_sorted_by_canonical_json<T>(
    values: &mut Vec<T>,
) -> Result<Vec<(Vec<u8>, T)>, CanonicalError>
where
    T: Serialize,
{
    let mut keyed = values
        .drain(..)
        .map(|value| canonical_json_bytes(&value).map(|key| (key, value)))
        .collect::<Result<Vec<_>, _>>()?;
    keyed.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(keyed)
}

fn sort_by_canonical_json<T>(values: &mut Vec<T>) -> Result<(), CanonicalError>
where
    T: Serialize,
{
    let keyed = take_sorted_by_canonical_json(values)?;
    values.extend(keyed.into_iter().map(|(_, value)| value));
    Ok(())
}

fn sort_and_deduplicate_by_canonical_json<T>(values: &mut Vec<T>) -> Result<(), CanonicalError>
where
    T: Serialize,
{
    let mut keyed = take_sorted_by_canonical_json(values)?;
    keyed.dedup_by(|left, right| left.0 == right.0);
    values.extend(keyed.into_iter().map(|(_, value)| value));
    Ok(())
}

fn normalize_guard(guard: &mut Guard) -> Result<(), CanonicalError> {
    match guard {
        Guard::In { .. } | Guard::KOfMap { .. } => {}
        Guard::KOfN { values, .. } => normalize_selectors(values)?,
        Guard::Not { guard } => normalize_guard(guard)?,
        Guard::All { guards } => normalize_commutative_guards(guards, GuardOperation::All)?,
        Guard::Any { guards } => normalize_commutative_guards(guards, GuardOperation::Any)?,
    }
    Ok(())
}

fn normalize_selectors(values: &mut NonEmptyVec<ControlSelector>) -> Result<(), CanonicalError> {
    let mut selectors = values.clone().into_vec();
    sort_by_canonical_json(&mut selectors)?;
    *values = NonEmptyVec::new(selectors).map_err(|_| CanonicalError::EmptyAfterNormalization)?;
    Ok(())
}

#[derive(Clone, Copy)]
enum GuardOperation {
    All,
    Any,
}

fn normalize_commutative_guards(
    guards: &mut NonEmptyVec<Guard>,
    operation: GuardOperation,
) -> Result<(), CanonicalError> {
    let mut flattened = Vec::new();
    for mut value in guards.clone().into_vec() {
        normalize_guard(&mut value)?;
        match (operation, value) {
            (GuardOperation::All, Guard::All { guards })
            | (GuardOperation::Any, Guard::Any { guards }) => flattened.extend(guards.into_vec()),
            (_, value) => flattened.push(value),
        }
    }
    sort_and_deduplicate_by_canonical_json(&mut flattened)?;
    *guards = NonEmptyVec::new(flattened).map_err(|_| CanonicalError::EmptyAfterNormalization)?;
    Ok(())
}

fn canonical_json_bytes<T>(value: &T) -> Result<Vec<u8>, CanonicalError>
where
    T: Serialize,
{
    let value = serde_json::to_value(value).map_err(CanonicalError::Serialize)?;
    let mut bytes = Vec::new();
    write_canonical_json(&value, &mut bytes, false)?;
    Ok(bytes)
}

fn write_canonical_json(
    value: &serde_json::Value,
    output: &mut Vec<u8>,
    allow_floating_point: bool,
) -> Result<(), CanonicalError> {
    match value {
        serde_json::Value::Array(values) => {
            write_canonical_array(values, output, allow_floating_point)
        }
        serde_json::Value::Object(values) => {
            write_canonical_object(values, output, allow_floating_point)
        }
        serde_json::Value::Number(number) => {
            write_canonical_number(number, output, allow_floating_point)
        }
        value => serde_json::to_writer(output, value).map_err(CanonicalError::Serialize),
    }
}

fn write_canonical_number(
    number: &serde_json::Number,
    output: &mut Vec<u8>,
    allow_floating_point: bool,
) -> Result<(), CanonicalError> {
    if number.is_f64() && !allow_floating_point {
        return Err(CanonicalError::FloatingPoint);
    }
    serde_json::to_writer(output, number).map_err(CanonicalError::Serialize)
}

fn write_canonical_array(
    values: &[serde_json::Value],
    output: &mut Vec<u8>,
    allow_floating_point: bool,
) -> Result<(), CanonicalError> {
    output.push(b'[');
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            output.push(b',');
        }
        write_canonical_json(value, output, allow_floating_point)?;
    }
    output.push(b']');
    Ok(())
}

fn write_canonical_object(
    values: &serde_json::Map<String, serde_json::Value>,
    output: &mut Vec<u8>,
    allow_floating_point: bool,
) -> Result<(), CanonicalError> {
    output.push(b'{');
    let mut entries = values.iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index != 0 {
            output.push(b',');
        }
        serde_json::to_writer(&mut *output, key).map_err(CanonicalError::Serialize)?;
        output.push(b':');
        write_canonical_json(value, output, allow_floating_point)?;
    }
    output.push(b'}');
    Ok(())
}

fn normalize_node(node: &mut GraphNode) -> Result<(), CanonicalError> {
    match node {
        GraphNode::Step(node) => {
            normalize_worker_bindings(&mut node.input_bindings, &mut node.write_bindings)
        }
        GraphNode::Verifier(node) => {
            normalize_worker_bindings(&mut node.input_bindings, &mut node.write_bindings)
        }
        GraphNode::Seq(node) => normalize_sequence(node),
        GraphNode::Choice(node) => normalize_choice(node),
        GraphNode::Par(node) => normalize_parallel(node),
        GraphNode::Loop(node) => normalize_loop(node),
        GraphNode::Map(node) => normalize_map(node),
        GraphNode::Succeed(node) => sort_by_canonical_json(&mut node.bindings),
        GraphNode::Fail(_) => Ok(()),
    }
}

fn normalize_worker_bindings(
    input_bindings: &mut Vec<InputBinding>,
    write_bindings: &mut Vec<WriteBinding>,
) -> Result<(), CanonicalError> {
    sort_by_canonical_json(input_bindings)?;
    sort_by_canonical_json(write_bindings)
}

fn normalize_sequence(node: &mut SeqNode) -> Result<(), CanonicalError> {
    let mut children = node.children.clone().into_vec();
    for child in &mut children {
        normalize_node(child)?;
    }
    node.children =
        NonEmptyVec::new(children).map_err(|_| CanonicalError::EmptyAfterNormalization)?;
    sort_and_deduplicate_by_canonical_json(&mut node.promoted_state_paths)
}

fn normalize_choice(node: &mut ChoiceNode) -> Result<(), CanonicalError> {
    let mut branches = node.branches.clone().into_vec();
    for ChoiceBranch { when, node } in &mut branches {
        normalize_guard(when)?;
        normalize_node(node)?;
    }
    node.branches =
        NonEmptyVec::new(branches).map_err(|_| CanonicalError::EmptyAfterNormalization)?;
    if let Some(otherwise) = &mut node.otherwise {
        normalize_node(otherwise)?;
    }
    sort_and_deduplicate_by_canonical_json(&mut node.promoted_state_paths)
}

fn normalize_parallel(node: &mut ParNode) -> Result<(), CanonicalError> {
    let mut branches = node.branches.clone().into_vec();
    for branch in &mut branches {
        normalize_node(branch)?;
    }
    branches.sort_by(|left, right| left.name().cmp(right.name()));
    node.branches =
        NonEmptyVec::new(branches).map_err(|_| CanonicalError::EmptyAfterNormalization)?;
    sort_and_deduplicate_by_canonical_json(&mut node.promoted_state_paths)?;
    if let Join::First { when } = &mut node.join {
        normalize_guard(when)?;
    }
    Ok(())
}

fn normalize_loop(node: &mut LoopNode) -> Result<(), CanonicalError> {
    normalize_node(&mut node.body)?;
    normalize_guard(&mut node.until)?;
    sort_and_deduplicate_by_canonical_json(&mut node.promoted_state_paths)
}

fn normalize_map(node: &mut MapNode) -> Result<(), CanonicalError> {
    normalize_node(&mut node.body)?;
    sort_and_deduplicate_by_canonical_json(&mut node.promoted_state_paths)
}
