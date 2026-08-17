use async_trait::async_trait;
use openengine_cluster_protocol::{
    GraphDiagnostic, GraphDiagnosticCode, GraphSpec, WorkerDescriptor, WorkerRef,
};
use openengine_cluster_server::admission::{GraphVerifier, VerificationError};
use openengine_cluster_server::graph_verifier::{
    ProductionGraphVerifier, FULL_V1_MAX_ATTEMPTS_PER_NODE, FULL_V1_MAX_GRAPH_DEPTH,
    FULL_V1_MAX_GRAPH_NODES, FULL_V1_MAX_GUARD_ASSIGNMENTS, FULL_V1_MAX_GUARD_NODES,
    FULL_V1_MAX_LOOP_ENTRIES, FULL_V1_MAX_LOOP_ITERATIONS, FULL_V1_MAX_MAP_ITEMS,
    FULL_V1_MAX_NODE_EXECUTIONS, FULL_V1_MAX_PEAK_CONCURRENCY,
};
use openengine_cluster_server::worker_registry::{WorkerRegistry, WorkerRegistryError};
use serde_json::{json, Value};

#[derive(Clone, Copy)]
struct PermissiveRegistry;

#[async_trait]
impl WorkerRegistry for PermissiveRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        let verifier_contract = match worker.as_str() {
            "worker.wide-verify@1" => json!({
                "signals": {
                    "left": enum_labels("left", 253),
                    "right": enum_labels("right", 259)
                },
                "diagnostic": {"kind":"null"}
            }),
            worker if worker.contains("verify") => json!({
                "signals":{"verdict":["accepted","rejected"]},
                "diagnostic":{"kind":"null"}
            }),
            _ => Value::Null,
        };
        serde_json::from_value(json!({
            "worker": worker.as_str(),
            "graphProfiles": ["openengine.graph.full/v1"],
            "binding": { "protocol": "acp", "version": "1", "profile": "openengine.worker.acp/v1" },
            "contract": {
                "input": {"kind":"null"}, "output": {"kind":"null"},
                "verifier": verifier_contract,
                "errors": ["timeout", "crash", "malformed", "refusal"]
            },
            "capabilityPolicy": { "autonomy": "strict", "permissionPolicy": "policy.strict@1" },
            "artifactProfile": {
                "allowedTypeIds": ["openengine.result@1"],
                "allowedMediaTypes": ["application/json"],
                "minimumRedaction": "internal"
            },
            "credentialRequirements": []
        }))
        .map_err(|_| WorkerRegistryError::NotFound {
            worker: worker.clone(),
        })
    }
}

fn enum_labels(prefix: &str, count: usize) -> Vec<String> {
    (0..count)
        .map(|index| format!("{prefix}_{index}"))
        .collect()
}

fn null_step(name: &str, attempts: u64) -> Value {
    json!({
        "kind":"step", "name":name, "worker":"worker.null@1",
        "input":{"kind":"null"}, "output":{"kind":"null"},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1, "attempts":attempts
    })
}

fn null_verifier(name: &str) -> Value {
    json!({
        "kind":"verifier", "name":name, "worker":"worker.verify@1",
        "input":{"kind":"null"}, "output":{"kind":"null"},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1, "attempts":1,
        "signals":{"verdict":["accepted","rejected"]}, "diagnostic":{"kind":"null"}
    })
}

fn succeed(name: &str) -> Value {
    json!({"kind":"succeed","name":name,"output":{"kind":"null"},"bindings":[]})
}

fn state() -> Value {
    json!({
        "kind":"record",
        "fields":{"items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}}
    })
}

fn graph(children: Vec<Value>) -> GraphSpec {
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":state(),
        "policy":{"policy":"policy.strict@1","default":"deny"},
        "root":{"kind":"seq","name":"root","state":state(),"children":children,"promotedStatePaths":[]}
    }))
    .assert_value()
}

async fn verify(
    graph: &GraphSpec,
) -> Result<openengine_cluster_server::admission::VerifiedGraph, VerificationError> {
    ProductionGraphVerifier::new(PermissiveRegistry)
        .verify(graph)
        .await
}

fn diagnostics(error: VerificationError) -> Vec<GraphDiagnostic> {
    match error {
        VerificationError::Rejected { diagnostics } => Some(diagnostics),
        _ => None,
    }
    .assert_value()
}

fn has_ceiling(error: VerificationError, field: &str) -> bool {
    diagnostics(error).iter().any(|diagnostic| {
        diagnostic.code == GraphDiagnosticCode::CeilingExceeded
            && serde_json::to_string(&diagnostic.path)
                .assert_value()
                .contains(&format!("\"name\":\"{field}\""))
    })
}

fn assert_ceiling(error: VerificationError) {
    assert!(
        diagnostics(error)
            .iter()
            .any(|diagnostic| diagnostic.code == GraphDiagnosticCode::CeilingExceeded)
    );
}

#[tokio::test]
async fn attempts_accept_exact_limit_and_reject_plus_one() {
    let exact = graph(vec![
        null_step("work", FULL_V1_MAX_ATTEMPTS_PER_NODE),
        succeed("done"),
    ]);
    verify(&exact).await.assert_value();

    let plus_one = graph(vec![
        null_step("work", FULL_V1_MAX_ATTEMPTS_PER_NODE + 1),
        succeed("done"),
    ]);
    assert!(has_ceiling(
        verify(&plus_one).await.assert_error(),
        "attempts"
    ));
}

#[tokio::test]
async fn loop_and_map_authored_bounds_accept_exact_limits_and_reject_plus_one() {
    let loop_node = |iterations| {
        json!({
            "kind":"loop","name":"repeat","state":state(),
            "body":null_verifier("loopVerify"),
            "until":{"kind":"in","value":{"name":"loopVerify","source":"signal","field":"verdict"},"labels":["accepted"]},
            "maxIterations":iterations,"promotedStatePaths":[]
        })
    };
    verify(&graph(vec![
        loop_node(FULL_V1_MAX_LOOP_ITERATIONS),
        succeed("done"),
    ]))
    .await
    .assert_value();
    assert!(has_ceiling(
        verify(&graph(vec![
            loop_node(FULL_V1_MAX_LOOP_ITERATIONS + 1),
            succeed("done"),
        ]))
        .await
        .assert_error(),
        "maxIterations"
    ));

    let map_node = |items| {
        json!({
            "kind":"map","name":"each","state":state(),"body":null_step("mapped",1),
            "over":{"source":"state","path":["items"]},"maxItems":items,"promotedStatePaths":[]
        })
    };
    verify(&graph(vec![
        map_node(FULL_V1_MAX_MAP_ITEMS),
        succeed("done"),
    ]))
    .await
    .assert_value();
    assert!(has_ceiling(
        verify(&graph(vec![
            map_node(FULL_V1_MAX_MAP_ITEMS + 1),
            succeed("done"),
        ]))
        .await
        .assert_error(),
        "maxItems"
    ));
}

fn nested_node(depth: u64) -> Value {
    let mut node = null_step("deepWork", 1);
    for current in (2..depth).rev() {
        node = json!({
            "kind":"seq","name":format!("level{current}"),"state":state(),
            "children":[node],"promotedStatePaths":[]
        });
    }
    node
}

#[tokio::test]
async fn graph_depth_accepts_exact_limit_and_rejects_plus_one_at_node_path() {
    verify(&graph(vec![
        nested_node(FULL_V1_MAX_GRAPH_DEPTH),
        succeed("done"),
    ]))
    .await
    .assert_value();
    let error = verify(&graph(vec![
        nested_node(FULL_V1_MAX_GRAPH_DEPTH + 1),
        succeed("done"),
    ]))
    .await
    .assert_error();
    assert_ceiling(error);
}

#[tokio::test]
async fn graph_node_count_accepts_exact_limit_and_rejects_plus_one() {
    let children = |total: u64| {
        let mut children = (0..(total - 2))
            .map(|index| null_step(&format!("work{index}"), 1))
            .collect::<Vec<_>>();
        children.push(succeed("done"));
        children
    };
    verify(&graph(children(FULL_V1_MAX_GRAPH_NODES)))
        .await
        .assert_value();
    let error = verify(&graph(children(FULL_V1_MAX_GRAPH_NODES + 1)))
        .await
        .assert_error();
    assert_ceiling(error);
}

fn signal_guard() -> Value {
    json!({
        "kind":"in",
        "value":{"name":"verify","source":"signal","field":"verdict"},
        "labels":["accepted"]
    })
}

fn choice_with_guard(guard: Value) -> Value {
    json!({
        "kind":"choice","name":"choose","state":state(),
        "branches":[{"when":guard,"node":succeed("selected")}],
        "otherwise":{"kind":"fail","name":"other","reason":"other"},
        "promotedStatePaths":[]
    })
}

#[tokio::test]
async fn guard_node_count_accepts_exact_limit_and_rejects_plus_one() {
    let guard = |leaf_count: u64| {
        json!({
            "kind":"all",
            "guards":(0..leaf_count).map(|_| signal_guard()).collect::<Vec<_>>()
        })
    };
    verify(&graph(vec![
        null_verifier("verify"),
        choice_with_guard(guard(FULL_V1_MAX_GUARD_NODES - 1)),
    ]))
    .await
    .assert_value();
    let error = verify(&graph(vec![
        null_verifier("verify"),
        choice_with_guard(guard(FULL_V1_MAX_GUARD_NODES)),
    ]))
    .await
    .assert_error();
    assert_ceiling(error);
}

fn joined_group(index: u64) -> Value {
    json!({
        "kind":"par","name":format!("group{index}"),"state":state(),
        "branches":[null_step(&format!("groupWork{index}"),1)],
        "promotedStatePaths":[],"join":{"kind":"all"}
    })
}

fn group_assignment_choice(groups: u64) -> Value {
    let guards = (0..groups)
        .map(|index| {
            json!({
                "kind":"in",
                "value":{"name":format!("group{index}"),"source":"group","field":"joined"},
                "labels":["reached"]
            })
        })
        .collect::<Vec<_>>();
    json!({
        "kind":"choice","name":"choose","state":state(),
        "branches":[{
            "when":{"kind":"all","guards":guards},
            "node":{"kind":"succeed","name":"done","output":{"kind":"null"},"bindings":[]}
        }],
        "promotedStatePaths":[]
    })
}

#[tokio::test]
async fn finite_guard_space_accepts_exact_assignment_limit_and_rejects_next_dimension() {
    assert_eq!(FULL_V1_MAX_GUARD_ASSIGNMENTS, 2_u64.pow(16));
    let graph_with_groups = |groups: u64| {
        let mut children = (0..groups).map(joined_group).collect::<Vec<_>>();
        children.push(group_assignment_choice(groups));
        graph(children)
    };
    verify(&graph_with_groups(16)).await.assert_value();
    let error = verify(&graph_with_groups(17)).await.assert_error();
    assert_ceiling(error);
}

#[tokio::test]
async fn ceiling_compliant_map_aggregate_does_not_exhaust_the_call_stack() {
    let left_labels = enum_labels("left", 253);
    let right_labels = enum_labels("right", 259);
    let per_item_outcomes = left_labels.len() * right_labels.len() + 4;
    let aggregate_assignments = per_item_outcomes + 1;
    assert_eq!(per_item_outcomes, 65_531);
    assert_eq!(aggregate_assignments, 65_532);
    assert!(aggregate_assignments as u64 <= FULL_V1_MAX_GUARD_ASSIGNMENTS);

    let graph = graph(vec![
        json!({
            "kind":"map","name":"wideMap","state":state(),
            "over":{"source":"state","path":["items"]},"maxItems":1,
            "body":{
                "kind":"verifier","name":"wideVerify","worker":"worker.wide-verify@1",
                "input":{"kind":"null"},"output":{"kind":"null"},
                "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
                "signals":{"left":left_labels,"right":right_labels},
                "diagnostic":{"kind":"null"}
            },
            "promotedStatePaths":[]
        }),
        choice_with_guard(json!({
            "kind":"all",
            "guards":[
                {
                    "kind":"k_of_map","count":1,
                    "value":{"name":"wideVerify","source":"signal","field":"left"},
                    "labels":["left_0"]
                },
                {
                    "kind":"k_of_map","count":1,
                    "value":{"name":"wideVerify","source":"signal","field":"right"},
                    "labels":["right_0"]
                }
            ]
        })),
    ]);

    verify(&graph).await.assert_value();
}

#[tokio::test]
async fn signal_product_is_rejected_before_materializing_over_limit_assignments() {
    let left_labels = enum_labels("left", 4_096);
    let right_labels = enum_labels("right", 4_096);
    let graph = graph(vec![
        json!({
            "kind":"verifier","name":"wideVerify","worker":"worker.wide-verify@1",
            "input":{"kind":"null"},"output":{"kind":"null"},
            "inputBindings":[],"writeBindings":[],"timeoutMs":1,"attempts":1,
            "signals":{"left":left_labels,"right":right_labels},
            "diagnostic":{"kind":"null"}
        }),
        choice_with_guard(json!({
            "kind":"all",
            "guards":[
                {
                    "kind":"in",
                    "value":{
                        "name":"wideVerify",
                        "source":"signal",
                        "field":"left"
                    },
                    "labels":["left_0"]
                },
                {
                    "kind":"in",
                    "value":{
                        "name":"wideVerify",
                        "source":"signal",
                        "field":"right"
                    },
                    "labels":["right_0"]
                }
            ]
        })),
    ]);

    let error = verify(&graph).await.assert_error();
    assert_ceiling(error);
}

fn exact_fold_map() -> Value {
    json!({
        "kind":"map","name":"outerMap","state":state(),
        "over":{"source":"state","path":["items"]},"maxItems":1024,
        "body":{
            "kind":"loop","name":"innerLoop","state":state(),
            "body":null_verifier("foldVerify"),
            "until":{"kind":"in","value":{"name":"foldVerify","source":"signal","field":"verdict"},"labels":["accepted"]},
            "maxIterations":64,"promotedStatePaths":[]
        },
        "promotedStatePaths":[]
    })
}

#[tokio::test]
async fn checked_folds_accept_exact_execution_loop_entry_and_concurrency_limits() {
    let verified = verify(&graph(vec![exact_fold_map(), succeed("done")]))
        .await
        .assert_value();
    assert_eq!(
        verified.compiled_ir.bounds.max_node_executions.get(),
        FULL_V1_MAX_NODE_EXECUTIONS
    );
    assert_eq!(
        verified.compiled_ir.bounds.peak_concurrency.get(),
        FULL_V1_MAX_PEAK_CONCURRENCY
    );
    let max_iterations = match verified.compiled_ir.bounds.termination {
        openengine_cluster_protocol::TerminationWitness::Bounded { max_iterations, .. } => {
            Some(max_iterations)
        }
        openengine_cluster_protocol::TerminationWitness::Acyclic { .. } => None,
    }
    .assert_value();
    assert_eq!(max_iterations.get(), FULL_V1_MAX_LOOP_ENTRIES);
}

#[tokio::test]
async fn checked_execution_and_loop_entry_additions_reject_limit_plus_one() {
    let execution_error = verify(&graph(vec![
        exact_fold_map(),
        null_step("oneMoreExecution", 1),
        succeed("done"),
    ]))
    .await
    .assert_error();
    assert!(has_ceiling(execution_error, "children"));

    let extra_loop = json!({
        "kind":"loop","name":"oneMoreLoop","state":state(),
        "body":null_verifier("extraVerify"),
        "until":{"kind":"in","value":{"name":"extraVerify","source":"signal","field":"verdict"},"labels":["accepted"]},
        "maxIterations":1,"promotedStatePaths":[]
    });
    let loop_error = verify(&graph(vec![exact_fold_map(), extra_loop, succeed("done")]))
        .await
        .assert_error();
    assert!(has_ceiling(loop_error, "children"));
}

#[tokio::test]
async fn parallel_concurrency_rejects_limit_plus_one_at_combining_branches() {
    let wide_map = json!({
        "kind":"map","name":"wide","state":state(),"body":null_step("wideWork",1),
        "over":{"source":"state","path":["items"]},"maxItems":FULL_V1_MAX_MAP_ITEMS,
        "promotedStatePaths":[]
    });
    let parallel = json!({
        "kind":"par","name":"parallel","state":state(),
        "branches":[wide_map,null_step("oneMore",1)],
        "promotedStatePaths":[],"join":{"kind":"all"}
    });
    let error = verify(&graph(vec![parallel, succeed("done")]))
        .await
        .assert_error();
    assert!(has_ceiling(error, "branches"));
}
#[path = "support/assert_value.rs"]
mod assert_value;
use assert_value::AssertValue;
#[path = "support/assert_error.rs"]
mod assert_error;
use assert_error::AssertError;
