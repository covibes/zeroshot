use std::collections::BTreeMap;

use openengine_cluster_protocol::{
    GraphSpec, NodeName, NonEmptyVec, PositiveInteger, StructuralBounds, TerminationWitness,
};
use serde_json::json;

use super::{VerificationError, finalize_verified_with_invariant_probe};

#[test]
fn post_validation_invariant_failure_is_internal() -> Result<(), Box<dyn std::error::Error>> {
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"null"},
        "policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{
            "kind":"seq","name":"duplicate","state":{"kind":"null"},
            "children":[
                {"kind":"step","name":"duplicate","worker":"worker@1","input":{"kind":"null"},"output":{"kind":"null"},"inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1},
                {"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
            ],
            "promotedStatePaths":[]
        }
    }))?;
    let one = PositiveInteger::new(1)?;
    let duplicate = NodeName::new("duplicate")?;
    let bounds = StructuralBounds {
        termination: TerminationWitness::Acyclic {
            order: NonEmptyVec::new(vec![duplicate.clone()])?,
        },
        max_node_executions: one,
        peak_concurrency: one,
        attempts_per_node: BTreeMap::from([(duplicate, one)]),
    };

    assert_eq!(
        finalize_verified_with_invariant_probe(&graph, bounds, true),
        Err(VerificationError::Internal(
            "injected post-validation invariant failure".to_owned()
        ))
    );
    Ok(())
}
