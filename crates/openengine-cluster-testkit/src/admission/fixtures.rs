//! Small graph, compiled-IR, and diagnostic admission fixtures.

use crate::fixture::*;

use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    CompiledGraphIr, DiagnosticSeverity, GraphDiagnostic, GraphDiagnosticCode, GraphSpec, NodeName,
    NonEmptyVec, PositiveInteger, StructuralBounds, TerminationWitness,
};
use serde_json::{json, Value};

#[must_use]
pub fn graph_fixture(name: &str, initial_input: Value) -> GraphSpec {
    serde_json::from_value(json!({
        "profile": "openengine.graph.single-worker/v1",
        "initialInput": initial_input,
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "step", "name": name, "worker": "legacy.zeroshot.ship@1",
            "input": { "kind": "null" }, "output": { "kind": "null" },
            "inputBindings": [], "writeBindings": [], "timeoutMs": 1000, "attempts": 1
        }
    }))
    .assert_value_with("test fixture graph must be valid contract syntax")
}

#[must_use]
pub fn compiled_from_graph_fixture(graph: &GraphSpec) -> CompiledGraphIr {
    let node = graph.root.name().clone();
    CompiledGraphIr {
        profile: graph.profile,
        initial_input: graph.initial_input.clone(),
        policy: graph.policy.clone(),
        root: graph.root.clone(),
        bounds: StructuralBounds {
            termination: TerminationWitness::Acyclic {
                order: NonEmptyVec::new(vec![node.clone()])
                    .assert_value_with("fixture has one named node"),
            },
            max_node_executions: PositiveInteger::new(1).assert_value_with("one is positive"),
            peak_concurrency: PositiveInteger::new(1).assert_value_with("one is positive"),
            attempts_per_node: BTreeMap::from([(
                node,
                PositiveInteger::new(1).assert_value_with("one is positive"),
            )]),
        },
    }
}

#[must_use]
pub fn diagnostic_fixture(message: &str) -> GraphDiagnostic {
    GraphDiagnostic {
        severity: DiagnosticSeverity::Error,
        code: GraphDiagnosticCode::InvalidGraphShape,
        message: message.to_owned(),
        path: vec![],
        related_nodes: Vec::<NodeName>::new(),
    }
}
