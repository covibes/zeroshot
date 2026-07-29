use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphSpec, PositiveInteger, WorkerDescriptor, WorkerOutcome, WorkerRef,
};
use openengine_cluster_server::admission::{GraphVerifier, VerifiedGraph};
use openengine_cluster_server::graph_verifier::ProductionGraphVerifier;
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde_json::{json, Value};
use zeroshot_engine::cluster_ledger::store::Position;
use zeroshot_engine::cluster_ledger::{ExecutionId, NodeInstanceId, RunSequence, StructuralOccurrence};
use zeroshot_engine::full_v1_reducer::{
    Decision, DurableExecution, DurableExecutionState, FullV1Reducer, ReducerError, ReductionInput,
    TerminalProjection,
};

struct TestWorkers;

#[async_trait]
impl WorkerRegistry for TestWorkers {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        let verifier = (worker.as_str() == "worker.verify@1").then(|| {
            json!({
                "signals":{"verdict":["accepted","rejected"]},
                "diagnostic":{"kind":"record","fields":{}}
            })
        });
        serde_json::from_value(json!({
            "worker":worker.as_str(),
            "graphProfiles":["openengine.graph.full/v1"],
            "binding":{"protocol":"acp","version":"1","profile":"openengine.worker.acp/v1"},
            "contract":{
                "input":{"kind":"null"},
                "output":{"kind":"record","fields":{}},
                "verifier":verifier,
                "errors":["timeout","crash","malformed","refusal"]
            },
            "capabilityPolicy":{"autonomy":"strict","permissionPolicy":"policy.strict@1"},
            "artifactProfile":{
                "allowedTypeIds":["openengine.result@1"],
                "allowedMediaTypes":["application/json"],
                "minimumRedaction":"internal"
            },
            "credentialRequirements":[]
        }))
        .map_err(|_| WorkerRegistryError::NotFound {
            worker: worker.clone(),
        })
    }
}

async fn verified(root: Value, _attempts: Value) -> VerifiedGraph {
    let initial_input = root.get("state").cloned().unwrap_or_else(boundary_state);
    let graph: GraphSpec = serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":initial_input,
        "policy":{"policy":"policy.test@1","default":"deny"},
        "root":root
    }))
    .unwrap();
    ProductionGraphVerifier::new(TestWorkers)
        .verify(&graph)
        .await
        .unwrap()
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

fn boundary_state() -> Value {
    json!({
        "kind":"record",
        "fields":{
            "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
        }
    })
}

fn seq(children: Vec<Value>) -> Value {
    json!({
        "kind":"seq","name":"root","state":boundary_state(),
        "children":children,"promotedStatePaths":[]
    })
}

struct ExecutionSpec<'a> {
    id: u64,
    run: u64,
    node_instance: u64,
    node: &'a str,
    indices: Vec<u64>,
    attempt: u64,
    settled_at: u64,
}

impl<'a> ExecutionSpec<'a> {
    fn new(id: u64, node_instance: u64, node: &'a str) -> Self {
        Self {
            id,
            run: 1,
            node_instance,
            node,
            indices: Vec::new(),
            attempt: 1,
            settled_at: 1,
        }
    }

    fn run(mut self, run: u64) -> Self {
        self.run = run;
        self
    }

    fn indices(mut self, indices: Vec<u64>) -> Self {
        self.indices = indices;
        self
    }

    fn attempt(mut self, attempt: u64) -> Self {
        self.attempt = attempt;
        self
    }

    fn settled_at(mut self, settled_at: u64) -> Self {
        self.settled_at = settled_at;
        self
    }
}

fn execution(spec: ExecutionSpec<'_>, outcome: WorkerOutcome) -> DurableExecution {
    DurableExecution {
        run: RunSequence::new(spec.run).unwrap(),
        dispatch_position: Position::new(spec.settled_at - 1).unwrap(),
        node_instance: NodeInstanceId::new(spec.node_instance).unwrap(),
        execution: ExecutionId::new(spec.id).unwrap(),
        occurrence: StructuralOccurrence {
            node: spec.node.parse().unwrap(),
            map_indices: spec.indices,
        },
        attempt: PositiveInteger::new(spec.attempt).unwrap(),
        input: Value::Null,
        state: DurableExecutionState::Settled {
            position: Position::new(spec.settled_at).unwrap(),
            outcome,
        },
    }
}

fn success() -> WorkerOutcome {
    WorkerOutcome::Verified {
        output: json!({}),
        artifacts: Vec::new(),
    }
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
        next_node_instance: executions
            .iter()
            .map(|item| item.node_instance.get())
            .max()
            .unwrap_or(0)
            + 1,
        next_execution: executions
            .iter()
            .map(|item| item.execution.get())
            .max()
            .unwrap_or(0)
            + 1,
    }
}

#[tokio::test]
async fn exact_map_limit_dispatches_every_item_but_overflow_prunes_all_identities() {
    let map = json!({
        "kind":"map","name":"mapped","state":boundary_state(),
        "body":step("item_work",1),"over":{"source":"state","path":["items"]},
        "maxItems":2,"promotedStatePaths":[]
    });
    let graph = verified(seq(vec![map, succeed("done")]), json!({"item_work":1})).await;
    let at_limit = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2]}), &[]))
        .unwrap();
    assert_eq!(
        at_limit
            .decisions
            .iter()
            .filter(|decision| matches!(decision, Decision::Dispatch { .. }))
            .count(),
        2
    );
    let overflow = FullV1Reducer::new(&graph)
        .reduce(input(&json!({"items":[1,2,3]}), &[]))
        .unwrap();
    assert!(
        !overflow
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Dispatch { .. }))
    );
    assert!(overflow.terminal.is_some());
}

#[tokio::test]
async fn attempt_ceiling_terminalizes_authored_reentry_without_automatic_retry() {
    let loop_node = json!({
        "kind":"loop","name":"bounded","state":{"kind":"record","fields":{}},
        "body":verifier("check",1),
        "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
        "maxIterations":2,"promotedStatePaths":[]
    });
    let graph = verified(seq(vec![loop_node, succeed("done")]), json!({"check":1})).await;
    let history = [execution(
        ExecutionSpec::new(1, 1, "check").settled_at(2),
        verdict("rejected"),
    )];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &history))
        .unwrap();
    assert_eq!(
        reduction.terminal,
        Some(TerminalProjection::Failed {
            reason: "attempts_exhausted".to_owned()
        })
    );
    assert!(
        !reduction
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Dispatch { .. }))
    );
}

#[tokio::test]
async fn loop_exhaustion_is_a_routable_group_control_not_an_implicit_retry_or_failure() {
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
    let graph = verified(seq(vec![loop_node, route]), json!({"check":2})).await;
    let history = [
        execution(
            ExecutionSpec::new(1, 1, "check").settled_at(2),
            verdict("rejected"),
        ),
        execution(
            ExecutionSpec::new(2, 1, "check").attempt(2).settled_at(4),
            verdict("rejected"),
        ),
    ];
    assert!(matches!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &history))
            .unwrap()
            .terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}

#[tokio::test]
async fn equal_position_parallel_ties_are_broken_by_authored_branch_position() {
    let par = json!({
        "kind":"par","name":"race","state":{"kind":"record","fields":{}},
        "branches":[step("left",1),step("right",1)],"promotedStatePaths":[],"join":{"kind":"any"}
    });
    let graph = verified(seq(vec![par, succeed("done")]), json!({"left":1,"right":1})).await;
    let history = [
        execution(ExecutionSpec::new(2, 2, "right").settled_at(5), success()),
        execution(ExecutionSpec::new(1, 1, "left").settled_at(5), success()),
    ];
    let reduction = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &history))
        .unwrap();
    let continued = reduction
        .decisions
        .iter()
        .filter_map(|decision| match decision {
            Decision::Continue { node } => Some(node.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(continued.contains(&"left"));
    assert!(!continued.contains(&"right"));
}

#[tokio::test]
async fn earlier_ledger_position_wins_first_independent_of_authored_and_history_order() {
    let first = json!({
        "kind":"par","name":"position_first","state":boundary_state(),
        "branches":[verifier("authored_first",1),verifier("settled_first",1)],
        "promotedStatePaths":[],
        "join":{"kind":"first","when":{
            "kind":"k_of_n","count":1,
            "values":[
                {"name":"authored_first","source":"signal","field":"verdict"},
                {"name":"settled_first","source":"signal","field":"verdict"}
            ],
            "labels":["accepted"]
        }}
    });
    let graph = verified(
        seq(vec![first, succeed("position_done")]),
        json!({"authored_first":1,"settled_first":1}),
    )
    .await;
    let authored = execution(
        ExecutionSpec::new(1, 1, "authored_first").settled_at(10),
        verdict("accepted"),
    );
    let earlier = execution(
        ExecutionSpec::new(2, 2, "settled_first").settled_at(3),
        verdict("accepted"),
    );
    let first_order = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &[authored.clone(), earlier.clone()]))
        .unwrap();
    let reversed_order = FullV1Reducer::new(&graph)
        .reduce(input(&json!({}), &[earlier, authored]))
        .unwrap();
    assert!(first_order.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Continue { node } if node.as_str() == "settled_first"
    )));
    assert!(!first_order.decisions.iter().any(|decision| matches!(
        decision,
        Decision::Continue { node } if node.as_str() == "authored_first"
    )));
    assert_eq!(
        first_order.canonical_decision_bytes().unwrap(),
        reversed_order.canonical_decision_bytes().unwrap()
    );
}

#[tokio::test]
async fn voided_executions_require_authored_parallel_or_map_loser_ownership() {
    let sequential = verified(
        seq(vec![step("ordinary_work", 1), succeed("ordinary_done")]),
        json!({"ordinary_work":1}),
    )
    .await;
    let mut unowned = execution(
        ExecutionSpec::new(1, 1, "ordinary_work").settled_at(2),
        success(),
    );
    unowned.state = DurableExecutionState::Voided {
        position: Position::new(5).unwrap(),
    };
    assert_eq!(
        FullV1Reducer::new(&sequential)
            .reduce(input(&json!({}), std::slice::from_ref(&unowned)))
            .unwrap_err(),
        ReducerError::InconsistentHistory
    );

    let parallel = verified(
        seq(vec![
            json!({
                "kind":"par","name":"owned_race","state":boundary_state(),
                "branches":[step("owned_loser",1),step("owned_winner",1)],
                "promotedStatePaths":[],"join":{"kind":"any"}
            }),
            succeed("owned_done"),
        ]),
        json!({"owned_loser":1,"owned_winner":1}),
    )
    .await;
    let mut owned = execution(
        ExecutionSpec::new(1, 1, "owned_loser").settled_at(2),
        success(),
    );
    owned.state = DurableExecutionState::Voided {
        position: Position::new(5).unwrap(),
    };
    let winner = execution(
        ExecutionSpec::new(2, 2, "owned_winner").settled_at(3),
        success(),
    );
    let reduction = FullV1Reducer::new(&parallel)
        .reduce(input(&json!({}), &[owned, winner]))
        .unwrap();
    assert!(reduction.terminal.is_some());
    assert!(
        !reduction
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::VoidLoser { .. }))
    );
}

#[tokio::test]
async fn duplicate_gap_and_cross_occurrence_identity_histories_fail_closed() {
    let graph = verified(
        seq(vec![step("work", 2), succeed("done")]),
        json!({"work":2}),
    )
    .await;
    let duplicate = [
        execution(ExecutionSpec::new(1, 1, "work").settled_at(2), success()),
        execution(
            ExecutionSpec::new(1, 1, "work").attempt(2).settled_at(4),
            success(),
        ),
    ];
    assert_eq!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &duplicate))
            .unwrap_err(),
        ReducerError::InconsistentHistory
    );
    let gap = [execution(
        ExecutionSpec::new(2, 1, "work").attempt(2).settled_at(4),
        success(),
    )];
    assert_eq!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &gap))
            .unwrap_err(),
        ReducerError::InconsistentHistory
    );
    let crossed = [
        execution(ExecutionSpec::new(1, 1, "work").settled_at(2), success()),
        execution(
            ExecutionSpec::new(2, 2, "work").attempt(2).settled_at(4),
            success(),
        ),
    ];
    assert_eq!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &crossed))
            .unwrap_err(),
        ReducerError::InconsistentHistory
    );
    for rejected in [
        execution(ExecutionSpec::new(1, 1, "ghost").settled_at(2), success()),
        execution(
            ExecutionSpec::new(1, 1, "work")
                .indices(vec![0])
                .settled_at(2),
            success(),
        ),
        execution(
            ExecutionSpec::new(1, 1, "work").run(2).settled_at(2),
            success(),
        ),
    ] {
        assert_eq!(
            FullV1Reducer::new(&graph)
                .reduce(input(&json!({}), std::slice::from_ref(&rejected)))
                .unwrap_err(),
            ReducerError::InconsistentHistory
        );
    }
    let mut mismatched_input = execution(ExecutionSpec::new(1, 1, "work").settled_at(2), success());
    mismatched_input.input = json!({"not":"the bound null input"});
    assert_eq!(
        FullV1Reducer::new(&graph)
            .reduce(input(&json!({}), &[mismatched_input]))
            .unwrap_err(),
        ReducerError::InconsistentHistory
    );

    let alias_graph = verified(
        seq(vec![
            json!({
                "kind":"par","name":"all","state":boundary_state(),
                "branches":[step("left",1),step("right",1)],
                "promotedStatePaths":[],"join":{"kind":"all"}
            }),
            succeed("alias_done"),
        ]),
        json!({"left":1,"right":1}),
    )
    .await;
    let aliases = [
        execution(ExecutionSpec::new(1, 1, "left").settled_at(2), success()),
        execution(ExecutionSpec::new(2, 1, "right").settled_at(3), success()),
    ];
    assert_eq!(
        FullV1Reducer::new(&alias_graph)
            .reduce(input(&json!({}), &aliases))
            .unwrap_err(),
        ReducerError::InconsistentHistory
    );
}

#[tokio::test]
async fn nested_map_item_attempt_counters_are_independent() {
    let map = json!({
        "kind":"map","name":"outer","state":boundary_state(),
        "over":{"source":"state","path":["items"]},"maxItems":2,"promotedStatePaths":[],
        "body":{
            "kind":"loop","name":"per_item_loop","state":{"kind":"record","fields":{}},
            "body":verifier("check",2),
            "until":{"kind":"in","value":{"name":"check","source":"signal","field":"verdict"},"labels":["accepted"]},
            "maxIterations":2,"promotedStatePaths":[]
        }
    });
    let graph = verified(seq(vec![map, succeed("done")]), json!({"check":2})).await;
    let history = [
        execution(
            ExecutionSpec::new(1, 1, "check")
                .indices(vec![0])
                .settled_at(2),
            verdict("rejected"),
        ),
        execution(
            ExecutionSpec::new(2, 2, "check")
                .indices(vec![1])
                .settled_at(3),
            verdict("accepted"),
        ),
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

#[tokio::test]
async fn unreachable_quorum_and_first_no_satisfier_expose_failure_controls() {
    let conditional_failure = json!({
        "kind":"seq","name":"conditional_failure","state":{"kind":"record","fields":{}},
        "children":[
            verifier("branch_check",1),
            {
                "kind":"choice","name":"branch_route","state":{"kind":"record","fields":{}},
                "branches":[{
                    "when":{"kind":"in","value":{"name":"branch_check","source":"signal","field":"verdict"},"labels":["rejected"]},
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
            "when":{"kind":"in","value":{"name":"join","source":"group","field":"joined"},"labels":["quorum_unreachable"]},
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
            .unwrap()
            .terminal,
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
            .unwrap()
            .terminal,
        Some(TerminalProjection::Succeeded { .. })
    ));
}
