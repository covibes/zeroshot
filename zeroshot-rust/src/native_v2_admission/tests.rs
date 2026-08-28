use super::*;
use crate::native_v2_contract::{
    ClaudeProvider, CodexProvider, DeclaredEnvironment, EnvironmentVariableName, RunSize, RunTitle,
    GIT_DELIVERY_MERGE_WORKER_REF, GIT_DELIVERY_PR_WORKER_REF, SessionScope, ResolvedSource,
};
use crate::native_v2_delivery::DeliveryMode;
use crate::native_v2_delivery::contract::{delivery_result_schema, delivery_signal_labels};
use openengine_cluster_protocol::IdempotencyKey;
use serde_json::{json, Value};

fn null_verifier(name: &str, worker: &str) -> Value {
    let mut node = null_executable("verifier", name, worker);
    let fields = node.as_object_mut().assert_value_with("verifier fixture");
    fields.insert(
        "signals".to_owned(),
        json!({"verdict":["accepted","rejected"]}),
    );
    fields.insert("diagnostic".to_owned(), json!({"kind":"null"}));
    node
}

fn null_step(name: &str, worker: &str) -> Value {
    null_executable("step", name, worker)
}

fn null_executable(kind: &str, name: &str, worker: &str) -> Value {
    json!({
        "kind":kind, "name":name, "worker":worker,
        "instructions": authored_instructions(worker),
        "input":{"kind":"null"}, "output":{"kind":"null"},
        "inputBindings":[], "writeBindings":[], "timeoutMs":1000, "attempts":1
    })
}

fn authored_instructions(worker: &str) -> Value {
    if worker.starts_with("builtin.git-delivery") {
        Value::Null
    } else {
        json!("Exercise this agent node.")
    }
}

fn delivery_verifier(name: &str, mode: DeliveryMode) -> Value {
    let worker = match mode {
        DeliveryMode::PullRequest => GIT_DELIVERY_PR_WORKER_REF,
        DeliveryMode::Merge => GIT_DELIVERY_MERGE_WORKER_REF,
    };
    let output = delivery_result_schema(mode).assert_value();
    let labels = delivery_signal_labels(mode).assert_value();
    json!({
        "kind":"verifier", "name":name, "worker":worker,
        "input":{"kind":"null"},
        "output":output,
        "inputBindings":[], "writeBindings":[], "timeoutMs":1000, "attempts":1,
        "signals":{"delivery":labels},
        "diagnostic":crate::native_v2_delivery::delivery_diagnostic_schema().assert_value()
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
        env: DeclaredEnvironment::empty(),
    }
}

fn binding_with_environment(names: impl IntoIterator<Item = String>) -> NodeRuntimeBinding {
    NodeRuntimeBinding::Agent {
        model: crate::worker_catalog::ModelId::new("claude-sonnet-5").assert_value(),
        effort: None,
        session_scope: SessionScope::Execution,
        env: DeclaredEnvironment::new(
            names
                .into_iter()
                .map(|name| EnvironmentVariableName::new(name).assert_value()),
        )
        .assert_value(),
    }
}

fn delivery_binding() -> NodeRuntimeBinding {
    NodeRuntimeBinding::GitDelivery {
        env: DeclaredEnvironment::empty(),
    }
}

fn resolved_source() -> ResolvedSource {
    serde_json::from_str(
        r#"{
            "repository": "open-engine/zeroshot",
            "branch": "main",
            "revision": "0123456789abcdef0123456789abcdef01234567"
        }"#,
    )
    .assert_value()
}

fn submission(graph: GraphSpec, nodes: BTreeMap<NodeName, NodeRuntimeBinding>) -> RunSubmission {
    RunSubmission {
        title: RunTitle::new("Admission test").assert_value(),
        graph,
        initial_input: json!({"items":[null]}),
        runtime: RuntimePlan::Claude {
            provider: ClaudeProvider::Anthropic,
            size: RunSize::Medium,
            nodes,
        },
        source: resolved_source(),
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
async fn enforces_authored_instructions_by_runtime_role() {
    let mut agent = null_step("work", "agent.work@1");
    agent
        .as_object_mut()
        .assert_value_with("step fixture")
        .remove("instructions");
    let missing = graph(vec![agent, succeed("done")]);
    assert_eq!(
        NativeV2Admission
            .admit(submission(
                missing,
                BTreeMap::from([(named("work"), binding("claude-sonnet-5", None))]),
            ))
            .await,
        Err(NativeV2AdmissionError::MissingAgentInstructions {
            node: named("work")
        })
    );

    let mut delivery = delivery_verifier("deliver", DeliveryMode::PullRequest);
    delivery
        .as_object_mut()
        .assert_value_with("delivery fixture")
        .insert("instructions".to_owned(), json!("Open a pull request."));
    let authored_delivery = graph(vec![delivery, succeed("done")]);
    assert_eq!(
        NativeV2Admission
            .admit(submission(
                authored_delivery,
                BTreeMap::from([(named("deliver"), delivery_binding())]),
            ))
            .await,
        Err(NativeV2AdmissionError::DeliveryInstructionsForbidden {
            node: named("deliver")
        })
    );
}

#[tokio::test]
async fn rejects_run_wide_declared_environment_union_over_limit() {
    let graph = graph(vec![
        null_step("first", "agent.first@1"),
        null_step("second", "agent.second@1"),
        succeed("done"),
    ]);
    let nodes = BTreeMap::from([
        (
            named("first"),
            binding_with_environment((0..32).map(|index| format!("ENV_{index}"))),
        ),
        (
            named("second"),
            binding_with_environment((32..65).map(|index| format!("ENV_{index}"))),
        ),
    ]);

    assert_eq!(
        NativeV2Admission.admit(submission(graph, nodes)).await,
        Err(NativeV2AdmissionError::DeclaredEnvironmentTooLarge { found: 65 })
    );
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
async fn enforces_harness_model_and_effort_catalog() {
    let graph = graph(vec![null_step("work", "agent.work@1"), succeed("done")]);
    let codex_wrong_model = RunSubmission {
        title: RunTitle::new("Codex model validation").assert_value(),
        graph: graph.clone(),
        initial_input: json!({"items":[null]}),
        runtime: RuntimePlan::Codex {
            provider: CodexProvider::OpenAi,
            size: RunSize::Small,
            nodes: BTreeMap::from([(
                named("work"),
                binding("claude-sonnet-5", Some(ReasoningEffort::Max)),
            )]),
        },
        source: resolved_source(),
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
        delivery_verifier("deliver", DeliveryMode::PullRequest),
        null_verifier("reader", "verify.reader@1"),
    );
    let delivery_request = submission(
        delivery_parallel,
        BTreeMap::from([
            (named("deliver"), delivery_binding()),
            (named("reader"), binding("claude-sonnet-5", None)),
        ]),
    );
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

#[path = "tests/delivery.rs"]
mod delivery;
