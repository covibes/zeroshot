use super::*;
use openengine_cluster_testkit::assertions::{AssertValue, JsonAt};

const LIVE_TIMEOUT_MS: u64 = 10 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LiveScenario {
    PullRequest,
    OutputCorrection,
    ComplexMerge,
    CiRepair,
    DirectMerge,
}

impl LiveScenario {
    pub(crate) fn from_environment() -> Self {
        match std::env::var("ZEROSHOT_NATIVE_V2_LIVE_SCENARIO").as_deref() {
            Ok("pr") => Self::PullRequest,
            Ok("output-correction") => Self::OutputCorrection,
            Ok("complex-merge") => Self::ComplexMerge,
            Ok("ci-repair") => Self::CiRepair,
            Ok("direct-merge") => Self::DirectMerge,
            _ => None::<Self>.assert_value_with(
                "ZEROSHOT_NATIVE_V2_LIVE_SCENARIO must be pr, output-correction, \
                 complex-merge, ci-repair, or direct-merge",
            ),
        }
    }

    pub(crate) const fn mode(self) -> &'static str {
        match self {
            Self::PullRequest | Self::OutputCorrection => "pr",
            Self::ComplexMerge | Self::CiRepair | Self::DirectMerge => "merge",
        }
    }

    pub(crate) const fn expected_outcome(self) -> &'static str {
        match self {
            Self::PullRequest | Self::OutputCorrection => "opened",
            Self::ComplexMerge | Self::CiRepair | Self::DirectMerge => "merged",
        }
    }

    fn instruction(self, lane: LiveLane) -> String {
        let proof = format!("{}-{self:?}", lane.sentinel()).to_lowercase();
        match self {
            Self::PullRequest => format!(
                "Create provider-proof-{proof}.txt containing exactly {proof}. Run npm test. \
                 Return the JSON literal null as your complete final response."
            ),
            Self::OutputCorrection => format!(
                "Create provider-proof-{proof}.txt containing exactly {proof}. Run npm test. On \
                 your first final response return exactly NOT_JSON. After the controller rejects \
                 it mechanically, correct the same session by returning the JSON literal null."
            ),
            Self::ComplexMerge => format!(
                "Implement a small, production-quality validation helper in a new uniquely named \
                 module containing {proof}, add focused node:test coverage, and run npm test. \
                 Worker nodes return null. Parallel verifiers inspect the change and run tests. \
                 The reused loop_check verifier must return verdict rejected on its first \
                 invocation, then run npm test and return accepted on its second invocation."
            ),
            Self::CiRepair => format!(
                "The builder must add a small module and focused test containing {proof}, but \
                 intentionally leave the implementation failing that new test so GitHub CI \
                 rejects the first delivery. The repair node must run npm test, fix the \
                 implementation without weakening tests, and return null after all tests pass."
            ),
            Self::DirectMerge => format!(
                "Add a small, production-quality module and focused node:test coverage containing \
                 {proof}. Run npm test and return the JSON literal null."
            ),
        }
    }
}

pub(crate) fn write_live_fixture_files(
    root: &TempRoot,
    lane: LiveLane,
    scenario: LiveScenario,
) -> (PathBuf, PathBuf, PathBuf) {
    let runtime = root.path("live-runtime.json");
    let graph = root.path("live-graph.json");
    let input = root.path("live-input.json");
    std::fs::write(
        &runtime,
        serde_json::to_vec(&live_runtime(lane, scenario)).assert_value(),
    )
    .assert_value();
    std::fs::write(
        &graph,
        serde_json::to_vec(&live_graph(scenario)).assert_value(),
    )
    .assert_value();
    std::fs::write(
        &input,
        serde_json::to_vec(&live_initial_input(scenario, lane)).assert_value(),
    )
    .assert_value();
    (runtime, graph, input)
}

fn live_runtime(lane: LiveLane, scenario: LiveScenario) -> serde_json::Value {
    let agent = |scope| {
        json!({
            "kind":"agent",
            "model":lane.model(),
            "effort":"max",
            "sessionScope":scope,
            "env":[lane.credential_name()]
        })
    };
    let delivery = json!({"kind":"git_delivery","env":[GITHUB_TOKEN_ENV]});
    let nodes = match scenario {
        LiveScenario::PullRequest | LiveScenario::OutputCorrection | LiveScenario::DirectMerge => {
            json!({"worker":agent("execution"), "deliver":delivery})
        }
        LiveScenario::ComplexMerge => json!({
            "worker":agent("execution"),
            "left":agent("execution"),
            "right":agent("execution"),
            "loop_check":agent("node_instance"),
            "deliver":delivery
        }),
        LiveScenario::CiRepair => json!({
            "builder":agent("execution"),
            "repair":agent("execution"),
            "deliver":delivery
        }),
    };
    json!({
        "harness":lane.harness(),
        "provider":lane.provider(),
        "size":"medium",
        "nodes":nodes
    })
}

fn live_graph(scenario: LiveScenario) -> serde_json::Value {
    match scenario {
        LiveScenario::PullRequest | LiveScenario::OutputCorrection => {
            live_provider_graph(LIVE_TIMEOUT_MS)
        }
        LiveScenario::ComplexMerge => complex_merge_graph(),
        LiveScenario::CiRepair => ci_repair_graph(),
        LiveScenario::DirectMerge => direct_merge_graph(),
    }
}

fn instruction_input() -> serde_json::Value {
    json!({"kind":"record","fields":{
        "instruction":{"type":{"kind":"string"},"required":true}
    }})
}

fn instruction_binding() -> serde_json::Value {
    instruction_binding_from("instruction")
}

fn instruction_binding_from(field: &str) -> serde_json::Value {
    json!({
        "target":["instruction"],
        "value":{"source":"state","path":[field]}
    })
}

fn worker_node(name: &str) -> serde_json::Value {
    worker_node_with_binding(name, instruction_binding())
}

fn worker_node_with_state_instruction(name: &str, field: &str) -> serde_json::Value {
    worker_node_with_binding(name, instruction_binding_from(field))
}

fn worker_node_with_binding(name: &str, binding: serde_json::Value) -> serde_json::Value {
    json!({
        "kind":"step","name":name,"worker":format!("agent.{name}@1"),
        "instructions":format!("Execute the {name} role using the input."),
        "input":instruction_input(),"output":{"kind":"null"},
        "inputBindings":[binding],"writeBindings":[],
        "timeoutMs":LIVE_TIMEOUT_MS,"attempts":1
    })
}

fn verifier_node(name: &str) -> serde_json::Value {
    json!({
        "kind":"verifier","name":name,"worker":format!("agent.{name}@1"),
        "instructions":format!("Verify the {name} role using the input."),
        "input":instruction_input(),"output":{"kind":"null"},
        "inputBindings":[instruction_binding()],"writeBindings":[],
        "timeoutMs":LIVE_TIMEOUT_MS,"attempts":1,
        "signals":{"verdict":["accepted","rejected"]},
        "diagnostic":{"kind":"null"}
    })
}

fn terminal_node(name: &str, mode: &str) -> serde_json::Value {
    json!({
        "kind":"succeed","name":name,"output":delivery_result_schema(mode),
        "bindings":delivery_terminal_bindings()
    })
}

fn merge_delivery_node() -> serde_json::Value {
    delivery_node(
        "builtin.git-delivery.merge@1",
        json!(["merged", "conflict", "ci_failed"]),
        LIVE_TIMEOUT_MS,
        "merge",
    )
}

fn complex_merge_graph() -> serde_json::Value {
    let state = delivery_state_schema("merge");
    let parallel_verifiers = json!({
        "kind":"par","name":"parallel_verifiers","state":state,
        "branches":[verifier_node("left"),verifier_node("right")],
        "join":{"kind":"all"},"promotedStatePaths":[]
    });
    let review_loop = json!({
        "kind":"loop","name":"review_loop","state":state,
        "body":{"kind":"seq","name":"loop_body","state":state,
            "children":[verifier_node("loop_check")],"promotedStatePaths":[]},
        "until":verdict_guard("loop_check", json!(["accepted"])),
        "maxIterations":3,"promotedStatePaths":[]
    });
    let root = json!({
        "kind":"seq","name":"root","state":state,"children":[
            worker_node("worker"),
            parallel_verifiers,
            review_loop,
            merge_delivery_node(),
            terminal_node("done", "merge")
        ],"promotedStatePaths":[]
    });
    native_v2_graph(state, root)
}

fn ci_repair_graph() -> serde_json::Value {
    let state = ci_repair_state_schema();
    let promoted = delivery_field_paths();
    let route = json!({
        "kind":"choice","name":"delivery_route","state":state,"branches":[{
            "when":delivery_guard(json!(["ci_failed","conflict"])),
            "node":worker_node_with_state_instruction("repair", "repairInstruction")
        }],"otherwise":terminal_node("merged", "merge"),"promotedStatePaths":[]
    });
    let delivery_loop = json!({
        "kind":"loop","name":"delivery_loop","state":state,
        "body":{"kind":"seq","name":"delivery_attempt","state":state,
            "children":[merge_delivery_node(),route],"promotedStatePaths":promoted},
        "until":delivery_guard(json!(["merged"])),
        "maxIterations":3,"promotedStatePaths":promoted
    });
    let root = json!({
        "kind":"seq","name":"root","state":state,"children":[
            worker_node_with_state_instruction("builder", "builderInstruction"),
            delivery_loop,
            terminal_node("done", "merge")
        ],"promotedStatePaths":[]
    });
    native_v2_graph(state, root)
}

fn verdict_guard(name: &str, labels: serde_json::Value) -> serde_json::Value {
    json!({
        "kind":"in","value":{"name":name,"source":"signal","field":"verdict"},
        "labels":labels
    })
}

fn delivery_guard(labels: serde_json::Value) -> serde_json::Value {
    json!({
        "kind":"in","value":{"name":"deliver","source":"signal","field":"delivery"},
        "labels":labels
    })
}

fn ci_repair_state_schema() -> serde_json::Value {
    let mut state = delivery_state_schema("merge");
    let fields = state
        .assert_key_mut("fields")
        .as_object_mut()
        .assert_value();
    for name in ["builderInstruction", "repairInstruction"] {
        fields.insert(
            name.to_owned(),
            json!({"type":{"kind":"string"},"required":true}),
        );
    }
    state
}

fn live_initial_input(scenario: LiveScenario, lane: LiveLane) -> serde_json::Value {
    let mut input = delivery_initial_input(&scenario.instruction(lane), scenario.mode());
    if scenario == LiveScenario::CiRepair {
        let (builder, repair) = ci_repair_instructions(lane);
        let fields = input.as_object_mut().assert_value();
        fields.insert("builderInstruction".to_owned(), json!(builder));
        fields.insert("repairInstruction".to_owned(), json!(repair));
    }
    input
}

fn ci_repair_instructions(lane: LiveLane) -> (String, String) {
    let proof = format!("{}-ci-repair", lane.sentinel()).to_lowercase();
    let module = format!("src/{proof}.js");
    let test = format!("test/{proof}.test.js");
    (
        format!(
            "Controlled delivery-repair acceptance task. Create {module} exporting addOne(value), \
             implemented deliberately as `return value`. Create {test} with a focused node:test \
             assertion that addOne(1) equals 2. Preserve that deliberately failing implementation \
             exactly; the required outcome of this node is a real failing test for CI to report. \
             Return the JSON literal null."
        ),
        format!(
            "GitHub CI rejected the current delivery. Run npm test, fix the implementation in \
             {module} without weakening or removing {test}, rerun npm test, and return the JSON \
             literal null only after all tests pass."
        ),
    )
}

fn direct_merge_graph() -> serde_json::Value {
    let state = delivery_state_schema("merge");
    let root = json!({
        "kind":"seq","name":"root","state":state,"children":[
            worker_node("worker"),merge_delivery_node(),terminal_node("done", "merge")
        ],"promotedStatePaths":[]
    });
    native_v2_graph(state, root)
}

#[tokio::test]
async fn live_scenarios_are_admissible_full_graphs() {
    let lanes = [
        LiveLane::CodexOpenAi,
        LiveLane::CodexOpenRouter,
        LiveLane::ClaudeAnthropic,
        LiveLane::ClaudeOpenRouter,
    ];
    for scenario in [
        LiveScenario::PullRequest,
        LiveScenario::OutputCorrection,
        LiveScenario::ComplexMerge,
        LiveScenario::CiRepair,
        LiveScenario::DirectMerge,
    ] {
        let graph = live_graph(scenario);
        let graph: openengine_cluster_protocol::GraphSpec =
            serde_json::from_value(graph).assert_value_with(&format!("{scenario:?} graph shape"));
        for lane in lanes {
            let initial_input = live_initial_input(scenario, lane);
            let runtime: RuntimePlan = serde_json::from_value(live_runtime(lane, scenario))
                .assert_value_with(&format!("{lane:?}/{scenario:?} runtime"));
            let admission = NativeV2Admission
                .validate_intent(
                    &TargetRunIntent {
                        title: RunTitle::new("Live matrix admission").assert_value(),
                        graph: graph.clone(),
                        initial_input: initial_input.clone(),
                        runtime,
                        branch: None,
                        submission_key: IdempotencyKey::new(format!("live-{lane:?}-{scenario:?}"))
                            .assert_value(),
                    },
                    DeliveryPolicy::Required,
                )
                .await;
            assert!(
                admission.is_ok(),
                "{lane:?}/{scenario:?} admission failed: {admission:?}"
            );
        }
    }
}
