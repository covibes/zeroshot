use super::*;

#[tokio::test]
async fn unreachable_quorum_and_first_no_satisfier_expose_failure_controls() {
    assert_unreachable_quorum_control().await;
    assert_no_satisfier_control().await;
}

async fn assert_unreachable_quorum_control() {
    let conditional_failure = json!({
        "kind":"seq","name":"conditional_failure","state":{"kind":"record","fields":{}},
        "children":[
            verifier("branch_check",1),
            {
                "kind":"choice","name":"branch_route","state":{"kind":"record","fields":{}},
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{"name":"branch_check","source":"signal","field":"verdict"},
                        "labels":["rejected"]
                    },
                    "node":{"kind":"fail","name":"left_failed","reason":"left_failed"}
                }],
                "otherwise":step("fallback",1),
                "promotedStatePaths":[]
            }
        ],
        "promotedStatePaths":[]
    });
    let failed_parallel = json!({
        "kind":"par","name":"join","state":{"kind":"record","fields":{}},
        "branches":[
            conditional_failure,
            step("available",1)
        ],
        "promotedStatePaths":[],"join":{"kind":"quorum","count":2}
    });
    let joined_route = json!({
        "kind":"choice","name":"joined_route","state":{"kind":"record","fields":{}},
        "branches":[{
            "when":{
                "kind":"in",
                "value":{"name":"join","source":"group","field":"joined"},
                "labels":["quorum_unreachable"]
            },
            "node":succeed("recovered")
        }],
        "otherwise":{"kind":"fail","name":"not_recovered","reason":"not_recovered"},
        "promotedStatePaths":[]
    });
    let graph = verified(
        seq(vec![failed_parallel, joined_route]),
        json!({"branch_check":1,"fallback":1,"available":1}),
    )
    .await;
    let available = [
        execution(
            ExecutionSpec::new(1, 1, "branch_check").settled_at(2),
            verdict("rejected"),
        ),
        execution(
            ExecutionSpec::new(2, 2, "available").settled_at(3),
            success(),
        ),
    ];
    assert!(matches!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &available))
            .assert_value()
            .terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}

use openengine_cluster_testkit::assertions::{AssertValue};

async fn assert_no_satisfier_control() {
    let first = json!({
        "kind":"par","name":"first","state":{"kind":"record","fields":{}},
        "branches":[verifier("a",1),verifier("b",1)],"promotedStatePaths":[],
        "join":{"kind":"first","when":{
            "kind":"k_of_n","count":1,
            "values":[
                {"name":"a","source":"signal","field":"verdict"},
                {"name":"b","source":"signal","field":"verdict"}
            ],
            "labels":["accepted"]
        }}
    });
    let raced_route = json!({
        "kind":"choice","name":"raced_route","state":{"kind":"record","fields":{}},
        "branches":[{
            "when":{"kind":"in","value":{"name":"first","source":"group","field":"raced"},"labels":["no_satisfier"]},
            "node":succeed("no_winner")
        }],
        "promotedStatePaths":[]
    });
    let graph = verified(seq(vec![first, raced_route]), json!({"a":1,"b":1})).await;
    let history = [
        execution(
            ExecutionSpec::new(1, 1, "a").settled_at(2),
            verdict("rejected"),
        ),
        execution(
            ExecutionSpec::new(2, 2, "b").settled_at(3),
            verdict("rejected"),
        ),
    ];
    assert!(matches!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &history))
            .assert_value()
            .terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}
