use super::*;
use crate::execution::SessionScope;
use crate::native_v2_contract::{CodexProvider, ClaudeProvider};
use openengine_cluster_protocol::IdempotencyKey;
use serde_json::{json, Value};

fn null_verifier(name: &str, worker: &str) -> Value {
    json!({
        "kind":"verifier", "name":name, "worker":worker,
        "input":{"kind":"null"}, "output":{"kind":"null"},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1000, "attempts":1,
        "signals":{"verdict":["accepted","rejected"]}, "diagnostic":{"kind":"null"}
    })
}

fn null_step(name: &str, worker: &str) -> Value {
    json!({
        "kind":"step", "name":name, "worker":worker,
        "input":{"kind":"null"}, "output":{"kind":"null"},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1000, "attempts":1
    })
}

fn succeed(name: &str) -> Value {
    json!({"kind":"succeed","name":name,"output":{"kind":"null"},"bindings":[]})
}

fn graph(children: Vec<Value>) -> GraphSpec {
    serde_json::from_value(json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"record","fields":{
            "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
        }},
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":{"kind":"seq","name":"root","state":{"kind":"record","fields":{
            "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
        }},"children":children,"promotedStatePaths":[]}
    }))
    .assert_value()
}

fn binding(model: &str, effort: Option<ReasoningEffort>) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: crate::worker_catalog::ModelId::new(model).assert_value(),
        effort,
        session_scope: SessionScope::Execution,
        env: BTreeSet::new(),
    }
}

fn submission(graph: GraphSpec, nodes: BTreeMap<NodeName, NodeRuntimeBinding>) -> RunSubmission {
    RunSubmission {
        graph,
        initial_input: json!({"items":[null]}),
        runtime: RuntimePlan::Claude {
            provider: ClaudeProvider::Anthropic,
            nodes,
        },
        ship: false,
        submission_key: IdempotencyKey::new("admission-test").assert_value(),
    }
}

fn named(name: &str) -> NodeName {
    NodeName::new(name).assert_value()
}

#[tokio::test]
async fn admits_authored_loop_and_parallel_verifiers_and_defaults_effort_to_max() {
    let graph = graph(vec![
        json!({
            "kind":"loop","name":"retry","state":{"kind":"record","fields":{
                "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
            }},
            "body":null_verifier("loopVerify", "verify.same@1"),
            "until":{
                "kind":"in",
                "value":{"name":"loopVerify","source":"signal","field":"verdict"},
                "labels":["accepted"]
            },
            "maxIterations":2,"promotedStatePaths":[]
        }),
        json!({
            "kind":"par","name":"checks","state":{"kind":"record","fields":{
                "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
            }},
            "branches":[
                null_verifier("left", "verify.same@1"),
                null_verifier("right", "verify.same@1")
            ],
            "promotedStatePaths":[],"join":{"kind":"all"}
        }),
        succeed("done"),
    ]);
    let nodes = ["loopVerify", "left", "right"]
        .map(|name| (named(name), binding("claude-sonnet-5", None)))
        .into_iter()
        .collect();

    let admitted = NativeV2Admission
        .admit(submission(graph, nodes))
        .await
        .assert_value();

    for binding in admitted.runtime.nodes().values() {
        let effort = match binding {
            NodeRuntimeBinding::Agent { effort, .. } => Some(effort),
            NodeRuntimeBinding::GitDelivery { .. } => None,
        };
        let effort = effort.assert_value_with("fixture has only agent bindings");
        assert_eq!(*effort, Some(ReasoningEffort::Max));
    }
}

#[tokio::test]
async fn rejects_non_full_profile_and_invalid_actual_input() {
    let base = graph(vec![succeed("done")]);
    let mut wrong_profile = base.clone();
    wrong_profile.profile = GraphProfile::SingleWorker;
    assert_eq!(
        NativeV2Admission
            .admit(submission(wrong_profile, BTreeMap::new()))
            .await,
        Err(NativeV2AdmissionError::UnsupportedGraphProfile)
    );

    let mut invalid = submission(base, BTreeMap::new());
    invalid.initial_input = json!({"items":"not-an-array"});
    assert!(matches!(
        NativeV2Admission.admit(invalid).await,
        Err(NativeV2AdmissionError::InitialInput(_))
    ));
}

#[tokio::test]
async fn rejects_non_single_attempts_and_runtime_coverage_errors() {
    let mut value = null_step("work", "agent.work@1");
    *value.get_mut("attempts").assert_value() = json!(2);
    let attempts_graph = graph(vec![value, succeed("done")]);
    let nodes = BTreeMap::from([(named("work"), binding("claude-sonnet-5", None))]);
    assert!(matches!(
        NativeV2Admission
            .admit(submission(attempts_graph, nodes))
            .await,
        Err(NativeV2AdmissionError::Attempts { .. })
    ));

    let graph = graph(vec![null_step("work", "agent.work@1"), succeed("done")]);
    assert!(matches!(
        NativeV2Admission
            .admit(submission(graph.clone(), BTreeMap::new()))
            .await,
        Err(NativeV2AdmissionError::MissingRuntimeBinding { .. })
    ));
    let nodes = BTreeMap::from([
        (named("work"), binding("claude-sonnet-5", None)),
        (named("ghost"), binding("claude-sonnet-5", None)),
    ]);
    assert!(matches!(
        NativeV2Admission.admit(submission(graph, nodes)).await,
        Err(NativeV2AdmissionError::UnexpectedRuntimeBinding { .. })
    ));
}

#[tokio::test]
async fn rejects_inconsistent_worker_reuse() {
    let graph = graph(vec![
        null_step("first", "agent.shared@1"),
        null_verifier("second", "agent.shared@1"),
        succeed("done"),
    ]);
    let nodes = BTreeMap::from([
        (named("first"), binding("claude-sonnet-5", None)),
        (named("second"), binding("claude-sonnet-5", None)),
    ]);
    assert!(matches!(
        NativeV2Admission.admit(submission(graph, nodes)).await,
        Err(NativeV2AdmissionError::InconsistentWorkerReuse { .. })
    ));
}

#[tokio::test]
async fn enforces_delivery_shape_and_ship_authorization() {
    let step_graph = graph(vec![
        null_step("deliver", "git.delivery@1"),
        succeed("done"),
    ]);
    let mut request = submission(
        step_graph,
        BTreeMap::from([(
            named("deliver"),
            NodeRuntimeBinding::GitDelivery {
                env: BTreeSet::new(),
            },
        )]),
    );
    request.ship = true;
    assert!(matches!(
        NativeV2Admission.admit(request).await,
        Err(NativeV2AdmissionError::DeliveryMustBeVerifier { .. })
    ));

    let delivery_graph = graph(vec![
        null_verifier("deliver", "git.delivery@1"),
        succeed("done"),
    ]);
    let delivery = BTreeMap::from([(
        named("deliver"),
        NodeRuntimeBinding::GitDelivery {
            env: BTreeSet::new(),
        },
    )]);
    assert!(matches!(
        NativeV2Admission
            .admit(submission(delivery_graph, delivery))
            .await,
        Err(NativeV2AdmissionError::DeliveryRequiresShipping { .. })
    ));

    let mut no_delivery = submission(graph(vec![succeed("done")]), BTreeMap::new());
    no_delivery.ship = true;
    assert_eq!(
        NativeV2Admission.admit(no_delivery).await,
        Err(NativeV2AdmissionError::ShippingDeliveryCount { found: 0 })
    );
}

#[tokio::test]
async fn enforces_harness_model_and_effort_catalog() {
    let graph = graph(vec![null_step("work", "agent.work@1"), succeed("done")]);
    let codex_wrong_model = RunSubmission {
        graph: graph.clone(),
        initial_input: json!({"items":[null]}),
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            nodes: BTreeMap::from([(
                named("work"),
                binding("claude-sonnet-5", Some(ReasoningEffort::Max)),
            )]),
        },
        ship: false,
        submission_key: IdempotencyKey::new("codex-model").assert_value(),
    };
    assert!(matches!(
        NativeV2Admission.admit(codex_wrong_model).await,
        Err(NativeV2AdmissionError::UnsupportedModel { .. })
    ));

    let haiku_effort = submission(
        graph,
        BTreeMap::from([(
            named("work"),
            binding("claude-haiku-4-5", Some(ReasoningEffort::Low)),
        )]),
    );
    assert!(matches!(
        NativeV2Admission.admit(haiku_effort).await,
        Err(NativeV2AdmissionError::UnsupportedEffort { .. })
    ));
}

#[tokio::test]
async fn rejects_parallel_writers_mixed_parallelism_and_writer_maps() {
    let par = |left, right| {
        graph(vec![
            json!({
                "kind":"par","name":"parallel","state":{"kind":"record","fields":{
                    "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
                }},"branches":[left,right],"promotedStatePaths":[],"join":{"kind":"all"}
            }),
            succeed("done"),
        ])
    };
    let workers = par(
        null_step("left", "agent.left@1"),
        null_step("right", "agent.right@1"),
    );
    let nodes = BTreeMap::from([
        (named("left"), binding("claude-sonnet-5", None)),
        (named("right"), binding("claude-sonnet-5", None)),
    ]);
    assert!(matches!(
        NativeV2Admission.admit(submission(workers, nodes)).await,
        Err(NativeV2AdmissionError::ConcurrentWriter { .. })
    ));

    let mixed = par(
        null_step("writer", "agent.writer@1"),
        null_verifier("reader", "verify.reader@1"),
    );
    let nodes = BTreeMap::from([
        (named("writer"), binding("claude-sonnet-5", None)),
        (named("reader"), binding("claude-sonnet-5", None)),
    ]);
    assert!(matches!(
        NativeV2Admission.admit(submission(mixed, nodes)).await,
        Err(NativeV2AdmissionError::ConcurrentWriter { .. })
    ));

    let delivery_parallel = par(
        null_verifier("deliver", "git.delivery@1"),
        null_verifier("reader", "verify.reader@1"),
    );
    let mut delivery_request = submission(
        delivery_parallel,
        BTreeMap::from([
            (
                named("deliver"),
                NodeRuntimeBinding::GitDelivery {
                    env: BTreeSet::new(),
                },
            ),
            (named("reader"), binding("claude-sonnet-5", None)),
        ]),
    );
    delivery_request.ship = true;
    assert!(matches!(
        NativeV2Admission.admit(delivery_request).await,
        Err(NativeV2AdmissionError::ConcurrentWriter { .. })
    ));

    let mapped = graph(vec![
        json!({
            "kind":"map","name":"each","state":{"kind":"record","fields":{
                "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
            }},"body":null_step("mapped", "agent.mapped@1"),
            "over":{"source":"state","path":["items"]},"maxItems":2,"promotedStatePaths":[]
        }),
        succeed("done"),
    ]);
    let nodes = BTreeMap::from([(named("mapped"), binding("claude-sonnet-5", None))]);
    assert!(matches!(
        NativeV2Admission.admit(submission(mapped, nodes)).await,
        Err(NativeV2AdmissionError::ConcurrentMapWriter { .. })
    ));
}

#[tokio::test]
async fn delegates_remaining_graph_language_errors_to_production_verifier() {
    let graph = graph(vec![
        json!({
            "kind":"loop","name":"never","state":{"kind":"record","fields":{
                "items":{"type":{"kind":"array","items":{"kind":"null"}},"required":true}
            }},"body":null_verifier("verify", "verify.loop@1"),
            "until":{"kind":"all","guards":[
                {"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]},
                {"kind":"not","guard":{
                    "kind":"in",
                    "value":{"name":"verify","source":"signal","field":"verdict"},
                    "labels":["accepted"]
                }}
            ]},"maxIterations":2,"promotedStatePaths":[]
        }),
        succeed("done"),
    ]);
    let nodes = BTreeMap::from([(named("verify"), binding("claude-sonnet-5", None))]);
    assert!(matches!(
        NativeV2Admission.admit(submission(graph, nodes)).await,
        Err(NativeV2AdmissionError::GraphVerification(
            VerificationError::Rejected { .. }
        ))
    ));
}

use openengine_cluster_testkit::assertions::{AssertValue};
