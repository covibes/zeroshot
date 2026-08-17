use openengine_cluster_protocol::{ApplyParams, Generation, GraphSpec, IdempotencyKey};

pub fn committed(
    graph: GraphSpec,
    input: serde_json::Value,
    generation: u64,
    key: &str,
) -> ApplyParams {
    ApplyParams {
        graph,
        input: Some(input),
        dry_run: false,
        if_generation: Some(Generation::new(generation).assert_value()),
        idempotency_key: Some(IdempotencyKey::new(key).assert_value()),
    }
}

use openengine_cluster_testkit::assertions::AssertValue;
