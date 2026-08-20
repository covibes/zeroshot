use super::*;

#[tokio::test]
async fn exhaustive_determinism_across_inputs_positions_permutations_and_environment_hints() {
    let graph = determinism_graph().await;
    for seed in -2_i64..=2 {
        assert_deterministic_seed(&graph, seed);
    }
}

async fn determinism_graph() -> VerifiedGraph {
    let state = json!({
        "kind":"record",
        "fields":{
            "seed":{"type":{"kind":"integer"},"required":true},
            "result":{"type":{"kind":"integer"},"required":true}
        }
    });
    let parallel = json!({
        "kind":"par","name":"property_race","state":state.clone(),
        "branches":[
            promoted_integer_step("property_left", "result"),
            promoted_integer_step("property_right", "result")
        ],
        "promotedStatePaths":[["result"]],"join":{"kind":"any"}
    });
    let terminal = json!({
        "kind":"succeed","name":"property_done",
        "output":{"kind":"record","fields":{
            "result":{"type":{"kind":"integer"},"required":true}
        }},
        "bindings":[{
            "target":["result"],"value":{"source":"state","path":["result"]}
        }]
    });
    let mut root = sequence("property_root", vec![parallel, terminal]);
    *root.get_mut("state").assert_value() = state;
    verified(root, json!({"property_left":1,"property_right":1})).await
}

fn assert_deterministic_seed(graph: &VerifiedGraph, seed: i64) {
    let initial_input = json!({"seed":seed,"result":0});
    let left_value = seed * 10 + 1;
    let right_value = seed * 10 + 2;
    let mut observed_left = false;
    let mut observed_right = false;
    for left_position in 2_u64..=5 {
        for right_position in 2_u64..=5 {
            if left_position == right_position {
                continue;
            }
            let left = settled(
                SettledSpec::new(1, 1, "property_left").position(left_position),
                success(left_value),
            );
            let right = settled(
                SettledSpec::new(2, 2, "property_right").position(right_position),
                success(right_value),
            );
            let expected = if left_position < right_position {
                observed_left = true;
                left_value
            } else {
                observed_right = true;
                right_value
            };
            assert_deterministic_permutations(graph, &initial_input, [left, right], expected);
        }
    }
    assert!(observed_left && observed_right);
}

fn assert_deterministic_permutations(
    graph: &VerifiedGraph,
    initial_input: &Value,
    executions: [DurableExecution; 2],
    expected: i64,
) {
    let [left, right] = executions;
    let histories = [vec![left.clone(), right.clone()], vec![right, left]];
    let mut baseline = None;
    for history in histories {
        for capacity_hint in [1_usize, 2, 16] {
            for timing_hint in [0_u64, 1, 1_000] {
                assert!(capacity_hint > 0);
                let _irrelevant_timing = timing_hint;
                let reduction = reduce(graph, initial_input, &history);
                assert_eq!(
                    reduction.terminal,
                    Some(TerminalProjection::Succeeded {
                        output: json!({"result":expected})
                    })
                );
                let bytes = (
                    reduction.canonical_decision_bytes().assert_value(),
                    reduction.canonical_decision_bytes().assert_value(),
                );
                if let Some(expected_bytes) = &baseline {
                    assert_eq!(&bytes, expected_bytes);
                } else {
                    baseline = Some(bytes);
                }
            }
        }
    }
}

use openengine_cluster_testkit::assertions::{AssertValue};
