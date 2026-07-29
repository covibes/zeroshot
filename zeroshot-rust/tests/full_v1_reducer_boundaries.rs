use openengine_cluster_protocol::{CompiledGraphIr, PositiveInteger, WorkerOutcome};
use openengine_cluster_server::admission::VerifiedGraph;
use serde_json::{json, Value};
use zeroshot_engine::cluster_ledger::store::Position;
use zeroshot_engine::cluster_ledger::{ExecutionId, NodeInstanceId, RunSequence, StructuralOccurrence};
use zeroshot_engine::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, FullV1Reducer, ReducerError, ReductionInput,
    TerminalProjection,
};

fn verified(root: Value, attempts: Value) -> VerifiedGraph {
    VerifiedGraph {
        compiled_ir: serde_json::from_value::<CompiledGraphIr>(json!({
            "profile":"openengine.graph.full/v1",
            "initialInput":{"kind":"record","fields":{}},
            "policy":{"policy":"policy.test@1","default":"deny"},
            "root":root,
            "bounds":{
                "maxNodeExecutions":65536,"peakConcurrency":1024,"attemptsPerNode":attempts,
                "termination":{"kind":"acyclic","order":["root"]}
            }
        })).unwrap(),
        diagnostics: Vec::new(),
    }
}

fn step(name: &str, attempts: u64) -> Value {
    json!({
        "kind":"step","name":name,"worker":"worker.test@1",
        "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":attempts
    })
}

fn verifier(name: &str, attempts: u64) -> Value {
    json!({
        "kind":"verifier","name":name,"worker":"worker.verify@1",
        "input":{"kind":"null"},"output":{"kind":"record","fields":{}},
        "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":attempts,
        "signals":{"verdict":["accepted","rejected"]},"diagnostic":{"kind":"record","fields":{}}
    })
}

fn succeed(name: &str) -> Value {
    json!({"kind":"succeed","name":name,"output":{"kind":"null"},"bindings":[]})
}

fn seq(children: Vec<Value>) -> Value {
    json!({
        "kind":"seq","name":"root","state":{"kind":"record","fields":{}},
        "children":children,"promotedStatePaths":[]
    })
}

fn execution(
    id: u64,
    node_instance: u64,
    node: &str,
    indices: Vec<u64>,
    attempt: u64,
    settled_at: u64,
    outcome: WorkerOutcome,
) -> DurableExecution {
    DurableExecution {
        dispatch_position: Position::new(settled_at - 1).unwrap(),
        node_instance: NodeInstanceId::new(node_instance).unwrap(),
        execution: ExecutionId::new(id).unwrap(),
        occurrence: StructuralOccurrence { node: node.parse().unwrap(), map_indices: indices },
        attempt: PositiveInteger::new(attempt).unwrap(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: Position::new(settled_at).unwrap(),
            outcome,
        },
    }
}

fn success() -> WorkerOutcome {
    WorkerOutcome::Verified { output: json!({}), artifacts: Vec::new() }
}

fn verdict(label: &str) -> WorkerOutcome {
    WorkerOutcome::Verifier {
        output: json!({}),
        signals: [("verdict".parse().unwrap(), label.parse().unwrap())]
            .into_iter()
            .collect(),
        diagnostic: json!({}),
        artifacts: Vec::new(),
    }
}

fn input<'a>(initial: &'a Value, executions: &'a [DurableExecution]) -> ReductionInput<'a> {
    ReductionInput {
        run: RunSequence::new(1).unwrap(),
        initial_input: initial,
        executions,
        next_node_instance: executions.iter().map(|item| item.node_instance.get()).max().unwrap_or(0) + 1,
        next_execution: executions.iter().map(|item| item.execution.get()).max().unwrap_or(0) + 1,
    }
}

#[test]
fn exact_map_limit_dispatches_every_item_but_overflow_prunes_all_identities() {
    let map = json!({
        "kind":"map","name":"mapped","state":{"kind":"record","fields":{}},
        "body":step("item_work",1),"over":{"source":"state","path":["items"]},
        "maxItems":2,"promotedStatePaths":[]
    });
    let graph = verified(seq(vec![map, succeed("done")]), json!({"item_work":1}));
    let at_limit = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2]}), &[]))
        .unwrap();
    assert_eq!(
        at_limit.decisions.iter().filter(|decision| matches!(decision, Decision::Dispatch { .. })).count(),
        2
    );
    let overflow = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2,3]}), &[]))
        .unwrap();
    assert!(!overflow.decisions.iter().any(|decision| matches!(decision, Decision::Dispatch { .. })));
    assert!(overflow.terminal.is_some());
}

#[test]
fn attempt_ceiling_terminalizes_authored_reentry_without_automatic_retry() {
    let loop_node = json!({
        "kind":"loop","name":"bounded","state":{"kind":"record","fields":{}},
        "body":verifier("check",1),
        "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
        "maxIterations":2,"promotedStatePaths":[]
    });
    let graph = verified(seq(vec![loop_node, succeed("done")]), json!({"check":1}));
    let history = [execution(1,1,"check",vec![],1,2,verdict("rejected"))];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &history))
        .unwrap();
    assert_eq!(
        reduction.terminal,
        Some(TerminalProjection::Failed { reason: "attempts_exhausted".to_owned() })
    );
    assert!(!reduction.decisions.iter().any(|decision| matches!(decision, Decision::Dispatch { .. })));
}

#[test]
fn loop_exhaustion_is_a_routable_group_control_not_an_implicit_retry_or_failure() {
    let loop_node = json!({
        "kind":"loop","name":"bounded","state":{"kind":"record","fields":{}},
        "body":verifier("check",2),
        "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
        "maxIterations":2,"promotedStatePaths":[]
    });
    let route = json!({
        "kind":"choice","name":"after_loop","state":{"kind":"record","fields":{}},
        "branches":[{
            "when":{"kind":"in","value":{"name":"bounded","source":"group","field":"terminated"},"labels":["exhausted"]},
            "node":succeed("exhausted")
        }],
        "otherwise":{"kind":"fail","name":"unexpected","reason":"unexpected"},
        "promotedStatePaths":[]
    });
    let graph = verified(seq(vec![loop_node, route]), json!({"check":2}));
    let history = [
        execution(1,1,"check",vec![],1,2,verdict("rejected")),
        execution(2,1,"check",vec![],2,4,verdict("rejected")),
    ];
    assert!(matches!(
        FullV1Reducer::new(&graph).reduce(input(&json!({}), &history)).unwrap().terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}

#[test]
fn equal_position_parallel_ties_are_broken_by_authored_branch_position() {
    let par = json!({
        "kind":"par","name":"race","state":{"kind":"record","fields":{}},
        "branches":[step("left",1),step("right",1)],"promotedStatePaths":[],"join":{"kind":"any"}
    });
    let graph = verified(seq(vec![par,succeed("done")]), json!({"left":1,"right":1}));
    let history = [
        execution(2,2,"right",vec![],1,5,success()),
        execution(1,1,"left",vec![],1,5,success()),
    ];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &history))
        .unwrap();
    let continued = reduction.decisions.iter().filter_map(|decision| match decision {
        Decision::Continue { node } => Some(node.as_str()),
        _ => None,
    }).collect::<Vec<_>>();
    assert!(continued.contains(&"left"));
    assert!(!continued.contains(&"right"));
}

#[test]
fn duplicate_gap_and_cross_occurrence_identity_histories_fail_closed() {
    let graph = verified(seq(vec![step("work",2),succeed("done")]), json!({"work":2}));
    let duplicate = [
        execution(1,1,"work",vec![],1,2,success()),
        execution(1,1,"work",vec![],2,4,success()),
    ];
    assert_eq!(
        FullV1Reducer::new(&graph).reduce(input(&json!({}), &duplicate)).unwrap_err(),
        ReducerError::InconsistentHistory
    );
    let gap = [execution(2,1,"work",vec![],2,4,success())];
    assert_eq!(
        FullV1Reducer::new(&graph).reduce(input(&json!({}), &gap)).unwrap_err(),
        ReducerError::InconsistentHistory
    );
    let crossed = [
        execution(1,1,"work",vec![],1,2,success()),
        execution(2,2,"work",vec![],2,4,success()),
    ];
    assert_eq!(
        FullV1Reducer::new(&graph).reduce(input(&json!({}), &crossed)).unwrap_err(),
        ReducerError::InconsistentHistory
    );
}

#[test]
fn nested_map_item_attempt_counters_are_independent() {
    let map = json!({
        "kind":"map","name":"outer","state":{"kind":"record","fields":{}},
        "over":{"source":"state","path":["items"]},"maxItems":2,"promotedStatePaths":[],
        "body":{
            "kind":"loop","name":"per_item_loop","state":{"kind":"record","fields":{}},
            "body":verifier("check",2),
            "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
            "maxIterations":2,"promotedStatePaths":[]
        }
    });
    let graph = verified(seq(vec![map,succeed("done")]), json!({"check":2}));
    let history = [
        execution(1,1,"check",vec![0],1,2,verdict("rejected")),
        execution(2,2,"check",vec![1],1,3,verdict("accepted")),
    ];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2]}), &history))
        .unwrap();
    assert!(reduction.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Dispatch { occurrence, node_instance, attempt, .. }
            if occurrence.map_indices == [0] && node_instance.get() == 1 && attempt.get() == 2
    )));
}

#[test]
fn unreachable_quorum_and_first_no_satisfier_expose_failure_controls() {
    let failed_parallel = json!({
        "kind":"par","name":"join","state":{"kind":"record","fields":{}},
        "branches":[
            {"kind":"fail","name":"left_failed","reason":"left_failed"},
            {"kind":"fail","name":"right_failed","reason":"right_failed"}
        ],
        "promotedStatePaths":[],"join":{"kind":"quorum","count":1}
    });
    let joined_route = json!({
        "kind":"choice","name":"joined_route","state":{"kind":"record","fields":{}},
        "branches":[{
            "when":{"kind":"in","value":{"name":"join","source":"group","field":"joined"},"labels":["quorum_unreachable"]},
            "node":succeed("recovered")
        }],
        "otherwise":{"kind":"fail","name":"not_recovered","reason":"not_recovered"},
        "promotedStatePaths":[]
    });
    let graph = verified(seq(vec![failed_parallel, joined_route]), json!({}));
    assert!(matches!(
        FullV1Reducer::new(&graph).reduce(input(&json!({}), &[])).unwrap().terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));

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
        "otherwise":{"kind":"fail","name":"unexpected_winner","reason":"unexpected_winner"},
        "promotedStatePaths":[]
    });
    let graph = verified(seq(vec![first, raced_route]), json!({"a":1,"b":1}));
    let history = [
        execution(1,1,"a",vec![],1,2,verdict("rejected")),
        execution(2,2,"b",vec![],1,3,verdict("rejected")),
    ];
    assert!(matches!(
        FullV1Reducer::new(&graph).reduce(input(&json!({}), &history)).unwrap().terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}
