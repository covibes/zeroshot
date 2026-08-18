use super::*;

pub(crate) fn write_fixture_files(root: &TempRoot) -> (PathBuf, PathBuf, PathBuf) {
    let runtime = root.path("runtime.json");
    let graph = root.path("graph.json");
    let input = root.path("input.json");
    std::fs::write(
        &runtime,
        serde_json::to_vec(&json!({
            "harness":"codex",
            "provider":"openai",
            "size":"standard",
            "nodes":{
                "worker":{
                    "kind":"agent",
                    "model":"gpt-5.6",
                    "effort":"max",
                    "sessionScope":"execution",
                    "env":[]
                },
                "deliver":{"kind":"git_delivery","env":[]}
            }
        }))
        .assert_value(),
    )
    .assert_value();
    std::fs::write(
        &graph,
        serde_json::to_vec(&minimal_graph(10_000)).assert_value(),
    )
    .assert_value();
    std::fs::write(
        &input,
        serde_json::to_vec(&delivery_initial_input(
            "exercise the blocking worker",
            "pr",
        ))
        .assert_value(),
    )
    .assert_value();
    (runtime, graph, input)
}

pub(crate) fn write_delivery_fixture_files(root: &TempRoot) -> (PathBuf, PathBuf, PathBuf) {
    let runtime = root.path("delivery-runtime.json");
    let graph = root.path("delivery-graph.json");
    let input = root.path("delivery-input.json");
    let runtime_value = json!({
        "harness":"codex",
        "provider":"openai",
        "size":"standard",
        "nodes":{
            "deliver":{"kind":"git_delivery","env":[GITHUB_TOKEN_ENV]},
            "repair":{
                "kind":"agent","model":"gpt-5.6","effort":"max",
                "sessionScope":"execution","env":[]
            }
        }
    });
    std::fs::write(&runtime, serde_json::to_vec(&runtime_value).assert_value()).assert_value();
    std::fs::write(
        &graph,
        serde_json::to_vec(&merge_delivery_graph()).assert_value(),
    )
    .assert_value();
    std::fs::write(
        &input,
        serde_json::to_vec(&delivery_initial_input(
            "repair failed CI when requested",
            "merge",
        ))
        .assert_value(),
    )
    .assert_value();
    (runtime, graph, input)
}

pub(crate) fn minimal_graph(timeout_ms: u64) -> serde_json::Value {
    pr_delivery_graph(timeout_ms, false)
}

pub(crate) fn live_provider_graph(timeout_ms: u64) -> serde_json::Value {
    pr_delivery_graph(timeout_ms, true)
}

fn pr_delivery_graph(timeout_ms: u64, worker_errors_are_terminal: bool) -> serde_json::Value {
    let state = delivery_state_schema("pr");
    let worker = json!({
        "kind":"step",
        "name":"worker",
        "worker":"agent.worker@1",
        "input":{"kind":"record","fields":{
            "instruction":{"type":{"kind":"string"},"required":true}
        }},
        "output":{"kind":"null"},
        "inputBindings":[{
            "target":["instruction"],
            "value":{"source":"state","path":["instruction"]}
        }],
        "writeBindings":[],
        "timeoutMs":timeout_ms,
        "attempts":1
    });
    let delivery = delivery_node(
        "builtin.git-delivery.pr@1",
        json!(["opened"]),
        timeout_ms,
        "pr",
    );
    let done = json!({
        "kind":"succeed",
        "name":"done",
        "output":delivery_result_schema("pr"),
        "bindings":delivery_terminal_bindings()
    });
    let children = if worker_errors_are_terminal {
        vec![
            worker,
            json!({
                "kind":"choice",
                "name":"worker_route",
                "state":state,
                "branches":[{
                    "when":{
                        "kind":"in",
                        "value":{"name":"worker","source":"error","field":null},
                        "labels":["timeout","crash","malformed","refusal"]
                    },
                    "node":{
                        "kind":"fail",
                        "name":"worker_failed",
                        "reason":"worker_failed"
                    }
                }],
                "otherwise":{
                    "kind":"seq",
                    "name":"worker_succeeded",
                    "state":state,
                    "children":[delivery, done],
                    "promotedStatePaths":[]
                },
                "promotedStatePaths":[]
            }),
        ]
    } else {
        vec![worker, delivery, done]
    };
    let root = json!({
        "kind":"seq",
        "name":"root",
        "state":state,
        "children":children,
        "promotedStatePaths":[]
    });
    native_v2_graph(state, root)
}

fn merge_delivery_graph() -> serde_json::Value {
    let state = delivery_state_schema("merge");
    let promoted = delivery_field_paths();
    let root = json!({"kind":"seq","name":"root","state":state,"children":[
            {"kind":"loop","name":"delivery_loop","state":state,
             "body":{"kind":"seq","name":"delivery_attempt","state":state,"children":[
                delivery_node(
                    "builtin.git-delivery.merge@1",
                    json!(["merged","conflict","ci_failed"]),
                    10_000,
                    "merge"
                ),
                {"kind":"choice","name":"delivery_route","state":state,"branches":[{
                    "when":{"kind":"in","value":{
                        "name":"deliver","source":"signal","field":"delivery"
                    },"labels":["ci_failed","conflict"]},
                    "node":{"kind":"step","name":"repair","worker":"agent.repair@1",
                        "input":{"kind":"null"},"output":{"kind":"null"},
                        "inputBindings":[],"writeBindings":[],"timeoutMs":10_000,"attempts":1}
                }],
                "otherwise":{"kind":"succeed","name":"merged",
                    "output":delivery_result_schema("merge"),
                    "bindings":delivery_terminal_bindings()},
                "promotedStatePaths":[]}
             ],"promotedStatePaths":promoted},
             "until":{"kind":"in","value":{
                "name":"deliver","source":"signal","field":"delivery"
             },"labels":["merged"]},
             "maxIterations":3,"promotedStatePaths":promoted},
            {"kind":"succeed","name":"done","output":delivery_result_schema("merge"),
                "bindings":delivery_terminal_bindings()}
        ],"promotedStatePaths":[]});
    native_v2_graph(state, root)
}

pub(crate) fn native_v2_graph(
    initial_input: serde_json::Value,
    root: serde_json::Value,
) -> serde_json::Value {
    json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":initial_input,
        "policy":{"policy":"policy.native-v2@1","default":"deny"},
        "root":root
    })
}

pub(crate) fn delivery_node(
    worker: &str,
    labels: serde_json::Value,
    timeout_ms: u64,
    mode: &str,
) -> serde_json::Value {
    json!({
        "kind":"verifier","name":"deliver","worker":worker,
        "input":{"kind":"null"},"output":delivery_result_schema(mode),
        "inputBindings":[],"writeBindings":delivery_write_bindings(),
        "timeoutMs":timeout_ms,"attempts":1,
        "signals":{"delivery":labels},"diagnostic":{"kind":"string"}
    })
}

pub(crate) fn delivery_result_schema(mode: &str) -> serde_json::Value {
    let outcomes = match mode {
        "pr" => Some(json!(["opened"])),
        "merge" => Some(json!(["merged", "conflict", "ci_failed"])),
        _ => None,
    }
    .assert_value_with("fixture delivery mode is closed");
    json!({
        "kind":"record",
        "fields":{
            "version":{"type":{"kind":"enum","values":["v1"]},"required":true},
            "mode":{"type":{"kind":"enum","values":[mode]},"required":true},
            "outcome":{"type":{"kind":"enum","values":outcomes},"required":true},
            "repository":{"type":{"kind":"string"},"required":true},
            "targetBranch":{"type":{"kind":"string"},"required":true},
            "headRevision":{"type":{"kind":"string"},"required":true},
            "pullRequestId":{"type":{"kind":"string"},"required":true}
        }
    })
}

pub(crate) fn delivery_state_schema(mode: &str) -> serde_json::Value {
    let mut schema = delivery_result_schema(mode);
    schema
        .assert_key_mut("fields")
        .as_object_mut()
        .assert_value_with("delivery schema fields")
        .insert(
            "instruction".to_owned(),
            json!({"type":{"kind":"string"},"required":true}),
        );
    schema
}

pub(crate) fn delivery_initial_input(instruction: &str, mode: &str) -> serde_json::Value {
    let outcome = match mode {
        "pr" => Some("opened"),
        "merge" => Some("conflict"),
        _ => None,
    }
    .assert_value_with("fixture delivery mode is closed");
    json!({
        "instruction":instruction,
        "version":"v1",
        "mode":mode,
        "outcome":outcome,
        "repository":"placeholder/repository",
        "targetBranch":"main",
        "headRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pullRequestId":"pending"
    })
}

fn delivery_fields() -> [&'static str; 7] {
    [
        "version",
        "mode",
        "outcome",
        "repository",
        "targetBranch",
        "headRevision",
        "pullRequestId",
    ]
}

pub(crate) fn delivery_field_paths() -> Vec<serde_json::Value> {
    delivery_fields()
        .into_iter()
        .map(|field| json!([field]))
        .collect()
}

fn delivery_write_bindings() -> Vec<serde_json::Value> {
    delivery_fields()
        .into_iter()
        .map(|field| {
            json!({
                "value":{"node":"deliver","channel":"out","path":[field]},
                "target":[field]
            })
        })
        .collect()
}

pub(crate) fn delivery_terminal_bindings() -> Vec<serde_json::Value> {
    delivery_fields()
        .into_iter()
        .map(|field| {
            json!({
                "target":[field],
                "value":{"source":"state","path":[field]}
            })
        })
        .collect()
}

pub(crate) fn live_hosting_config(root: &TempRoot, lane: LiveLane) -> ProductionHostingConfig {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "the production live lane requires a root supervisor"
    );
    let credential = std::env::var(lane.credential_name())
        .assert_value_with(&format!("{} is required", lane.credential_name()));
    assert!(!credential.is_empty(), "provider credential is empty");
    let credential_name =
        EnvironmentVariableName::new(lane.credential_name()).assert_value_with("credential name");
    let github_credential = std::env::var(GITHUB_TOKEN_ENV)
        .assert_value_with("GH_TOKEN is required for the live delivery lane");
    assert!(!github_credential.is_empty(), "GitHub credential is empty");
    let controller_environment = BTreeMap::from([
        (credential_name, credential),
        (
            EnvironmentVariableName::new(GITHUB_TOKEN_ENV).assert_value_with("GitHub token name"),
            github_credential,
        ),
    ]);
    let codex_executable = if lane.uses_codex() {
        PathBuf::from(
            std::env::var_os("ZEROSHOT_NATIVE_V2_CODEX_EXECUTABLE").assert_value_with(
                "ZEROSHOT_NATIVE_V2_CODEX_EXECUTABLE is required for a Codex live lane",
            ),
        )
    } else {
        PathBuf::from("/usr/bin/false")
    };
    let (claude_executable, claude_prefix_arguments) = if lane.uses_codex() {
        ("/usr/bin/false".to_owned(), Vec::new())
    } else {
        (
            std::env::var("ZEROSHOT_NATIVE_V2_CLAUDE_EXECUTABLE")
                .unwrap_or_else(|_| "/usr/bin/npx".to_owned()),
            vec![
                "-y".to_owned(),
                "@anthropic-ai/claude-code@2.1.233".to_owned(),
            ],
        )
    };
    ProductionHostingConfig {
        storage_root: root.path("live-target"),
        controller_environment,
        codex_executable,
        claude_executable,
        claude_prefix_arguments,
        claude_process_environment: ClaudeProcessEnvironment::default(),
        executable_search_path: std::env::var("ZEROSHOT_NATIVE_V2_LIVE_PATH")
            .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_owned()),
        git_program: PathBuf::from("/usr/bin/git"),
        gh_program: PathBuf::from("/usr/bin/gh"),
        process_pool: HostedProcessPool::new(10_002, 10_002, 20_000, 20_000)
            .assert_value_with("production process pool"),
        claude_turn_timeout: Duration::from_secs(10 * 60),
    }
}

#[path = "cli_fixture.rs"]
mod cli;
pub(crate) use cli::*;

#[test]
fn live_provider_graph_routes_worker_errors_before_delivery() {
    let graph = live_provider_graph(600_000);
    let root_children = graph
        .assert_key("root")
        .assert_key("children")
        .as_array()
        .assert_value();
    assert_eq!(root_children.len(), 2);
    assert_eq!(root_children.assert_at(0).assert_key("name"), "worker");

    let route = root_children.assert_at(1);
    assert_eq!(route.assert_key("kind"), "choice");
    let branch = route
        .assert_key("branches")
        .as_array()
        .assert_value()
        .assert_at(0);
    assert_eq!(
        branch.assert_key("when").assert_key("labels"),
        &json!(["timeout", "crash", "malformed", "refusal"])
    );
    assert_eq!(
        branch.assert_key("node"),
        &json!({"kind":"fail","name":"worker_failed","reason":"worker_failed"})
    );

    let success_children = route
        .assert_key("otherwise")
        .assert_key("children")
        .as_array()
        .assert_value();
    assert_eq!(success_children.len(), 2);
    assert_eq!(success_children.assert_at(0).assert_key("name"), "deliver");
    assert_eq!(success_children.assert_at(1).assert_key("name"), "done");
    let _: openengine_cluster_protocol::GraphSpec = serde_json::from_value(graph).assert_value();
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue, JsonAt};
