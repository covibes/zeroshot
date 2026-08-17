#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/slice.rs"]
mod slice;

#[path = "support/json_mut.rs"]
mod json_mut;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    admission_fingerprint, diff_compiled_graphs, CanonicalError, CompiledGraphIr, GraphIdentity,
};
use serde_json::{json, Value};

#[test]
fn attempts_per_node_keys_obey_node_name_bounds_in_rust_and_schema() {
    let mut value = serde_json::to_value(ir(&["a"], &["one"])).assert_value();
    let attempts = json_mut::json_at_mut(&mut value, "/bounds/attemptsPerNode")
        .as_object_mut()
        .assert_value();
    attempts.clear();
    attempts.insert("a".repeat(129), json!(1));
    assert!(serde_json::from_value::<CompiledGraphIr>(value.clone()).is_err());
    let schema = serde_json::to_value(schemars::schema_for!(CompiledGraphIr)).assert_value();
    assert!(
        !jsonschema::validator_for(&schema)
            .assert_value()
            .is_valid(&value)
    );
}

fn ir(par_order: &[&str], seq_order: &[&str]) -> CompiledGraphIr {
    let terminal = |name: &str| {
        json!({
            "kind":"succeed", "name":name, "output":{"kind":"null"}, "bindings":[]
        })
    };
    let value = json!({
        "profile":"openengine.graph.full/v1",
        "initialInput":{"kind":"record","fields":{}},
        "policy":{"policy":"policy.default@1","default":"deny"},
        "root":{
            "kind":"seq", "name":"root", "state":{"kind":"record","fields":{}},
            "children":[
                {
                    "kind":"par", "name":"parallel", "state":{"kind":"record","fields":{}},
                    "branches":par_order.iter().map(|name| terminal(name)).collect::<Vec<Value>>(),
                    "promotedStatePaths":[],
                    "join":{"kind":"first","when":{"kind":"all","guards":[
                        {"kind":"in","value":{"name":"verify","source":"signal","field":"verdict"},"labels":["accepted"]},
                        {"kind":"all","guards":[{"kind":"in","value":{"name":"verify","source":"error","field":null},"labels":["refusal"]}]}
                    ]}}
                },
                {
                    "kind":"seq", "name":"ordered", "state":{"kind":"record","fields":{}},
                    "children":seq_order.iter().map(|name| terminal(name)).collect::<Vec<Value>>(),
                    "promotedStatePaths":[]
                }
            ],
            "promotedStatePaths":[]
        },
        "bounds":{
            "termination":{"kind":"acyclic","order":["root","parallel","ordered"]},
            "maxNodeExecutions":8,
            "peakConcurrency":2,
            "attemptsPerNode":{"ordered":1,"parallel":1}
        }
    });
    serde_json::from_value(value).assert_value()
}

#[test]
fn canonical_ir_ignores_set_parallel_and_commutative_guard_order() {
    let left = ir(&["b", "a"], &["one", "two"]);
    let right = ir(&["a", "b"], &["one", "two"]);
    assert_eq!(
        left.canonical_bytes().assert_value(),
        right.canonical_bytes().assert_value()
    );
    assert_eq!(
        left.identity().assert_value(),
        right.identity().assert_value()
    );

    let mut guard_reordered = serde_json::to_value(&left).assert_value();
    json_mut::json_at_mut(&mut guard_reordered, "/root/children/0/join/when/guards")
        .as_array_mut()
        .assert_value()
        .reverse();
    let guard_reordered: CompiledGraphIr = serde_json::from_value(guard_reordered).assert_value();
    assert_eq!(
        left.identity().assert_value(),
        guard_reordered.identity().assert_value()
    );
}

#[test]
fn canonical_ir_recursively_sorts_every_object_key() {
    let bytes = ir(&["a", "b"], &["one", "two"])
        .canonical_bytes()
        .assert_value();
    let text = String::from_utf8(bytes).assert_value();
    assert!(
        text.starts_with("{\"bounds\":"),
        "top-level keys were not sorted: {text}"
    );
    assert!(
        text.contains("\"attemptsPerNode\":{\"ordered\":1,\"parallel\":1}"),
        "nested map keys were not sorted: {text}"
    );
    assert!(
        text.contains(
            "{\"bindings\":[],\"kind\":\"succeed\",\"name\":\"a\",\"output\":{\"kind\":\"null\"}}"
        ),
        "nested struct keys were not sorted: {text}"
    );
}

#[test]
fn canonical_identity_changes_when_semantic_sequence_or_contract_changes() {
    let baseline = ir(&["a", "b"], &["one", "two"]);
    let reordered = ir(&["a", "b"], &["two", "one"]);
    assert_ne!(
        baseline.identity().assert_value(),
        reordered.identity().assert_value()
    );

    let mut changed = baseline.clone();
    changed.policy.policy = "policy.changed@2".parse().assert_value();
    assert_ne!(
        baseline.identity().assert_value(),
        changed.identity().assert_value()
    );

    changed = baseline.clone();
    changed.bounds.peak_concurrency =
        openengine_cluster_protocol::PositiveInteger::new(3).assert_value();
    assert_ne!(
        baseline.identity().assert_value(),
        changed.identity().assert_value()
    );

    let mut changed_value = serde_json::to_value(&baseline).assert_value();
    *json_mut::json_at_mut(&mut changed_value, "/initialInput") = json!({"kind":"string"});
    let changed_type: CompiledGraphIr = serde_json::from_value(changed_value).assert_value();
    assert_ne!(
        baseline.identity().assert_value(),
        changed_type.identity().assert_value()
    );

    let mut changed_value = serde_json::to_value(&baseline).assert_value();
    *json_mut::json_at_mut(&mut changed_value, "/root/children/0/branches/0/bindings") = json!([{
        "target":["value"], "value":{"source":"state","path":["value"]}
    }]);
    let changed_binding: CompiledGraphIr = serde_json::from_value(changed_value).assert_value();
    assert_ne!(
        baseline.identity().assert_value(),
        changed_binding.identity().assert_value()
    );

    assert_ne!(
        step_ir("worker.impl@1", false).identity().assert_value(),
        step_ir("worker.impl@2", false).identity().assert_value()
    );
}

#[test]
fn graph_identity_is_sha256_and_round_trip_safe() {
    let identity = ir(&["a", "b"], &["one", "two"]).identity().assert_value();
    assert_eq!(identity.as_str().len(), 64);
    assert!(
        identity
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    let parsed: GraphIdentity = identity.to_string().parse().assert_value();
    assert_eq!(parsed, identity);
    assert!("A".repeat(64).parse::<GraphIdentity>().is_err());
}

fn step_ir(worker: &str, reverse_bindings: bool) -> CompiledGraphIr {
    let mut bindings = vec![
        json!({"target":["a"],"value":{"source":"state","path":["a"]}}),
        json!({"target":["b"],"value":{"source":"state","path":["b"]}}),
    ];
    if reverse_bindings {
        bindings.reverse();
    }
    serde_json::from_value(json!({
        "profile":"openengine.graph.single-worker/v1",
        "initialInput":{"kind":"record","fields":{}},
        "policy":{"policy":"policy.default@1","default":"deny"},
        "root":{
            "kind":"step","name":"work","worker":worker,
            "input":{"kind":"record","fields":{}},"output":{"kind":"null"},
            "inputBindings":bindings,"writeBindings":[],"timeoutMs":1000,"attempts":1
        },
        "bounds":{
            "termination":{"kind":"acyclic","order":["work"]},
            "maxNodeExecutions":1,"peakConcurrency":1,"attemptsPerNode":{"work":1}
        }
    }))
    .assert_value()
}

#[test]
fn canonical_ir_sorts_bindings_but_preserves_binding_content() {
    assert_eq!(
        step_ir("worker.impl@1", false).identity().assert_value(),
        step_ir("worker.impl@1", true).identity().assert_value()
    );
}

#[test]
fn canonical_ir_preserves_duplicate_binding_and_selector_multiplicity() {
    let baseline = step_ir("worker.impl@1", false);

    let mut duplicate_input = serde_json::to_value(&baseline).assert_value();
    let inputs = json_mut::json_at_mut(&mut duplicate_input, "/root/inputBindings")
        .as_array_mut()
        .assert_value();
    let first_input = slice::slice_at(inputs, 0).clone();
    inputs.push(first_input);
    let duplicate_input: CompiledGraphIr = serde_json::from_value(duplicate_input).assert_value();
    assert_ne!(
        baseline.identity().assert_value(),
        duplicate_input.identity().assert_value()
    );

    let write = json!({
        "value":{"node":"work","channel":"out","path":["value"]},
        "target":["value"]
    });
    let mut one_write = serde_json::to_value(&baseline).assert_value();
    *json_mut::json_at_mut(&mut one_write, "/root/writeBindings") = json!([write.clone()]);
    let one_write: CompiledGraphIr = serde_json::from_value(one_write).assert_value();
    let mut duplicate_write = serde_json::to_value(&one_write).assert_value();
    *json_mut::json_at_mut(&mut duplicate_write, "/root/writeBindings") =
        json!([write.clone(), write]);
    let duplicate_write: CompiledGraphIr = serde_json::from_value(duplicate_write).assert_value();
    assert_ne!(
        one_write.identity().assert_value(),
        duplicate_write.identity().assert_value()
    );

    let succeed_value = json!({
        "profile":"openengine.graph.single-worker/v1",
        "initialInput":{"kind":"record","fields":{}},
        "policy":{"policy":"policy.default@1","default":"deny"},
        "root":{
            "kind":"succeed","name":"done","output":{"kind":"string"},
            "bindings":[{
                "target":["value"],"value":{"source":"state","path":["value"]}
            }]
        },
        "bounds":{
            "termination":{"kind":"acyclic","order":["done"]},
            "maxNodeExecutions":1,"peakConcurrency":1,"attemptsPerNode":{"done":1}
        }
    });
    let succeed: CompiledGraphIr = serde_json::from_value(succeed_value.clone()).assert_value();
    let mut duplicate_succeed = succeed_value;
    let bindings = json_mut::json_at_mut(&mut duplicate_succeed, "/root/bindings")
        .as_array_mut()
        .assert_value();
    let first_binding = slice::slice_at(bindings, 0).clone();
    bindings.push(first_binding);
    let duplicate_succeed: CompiledGraphIr =
        serde_json::from_value(duplicate_succeed).assert_value();
    assert_ne!(
        succeed.identity().assert_value(),
        duplicate_succeed.identity().assert_value()
    );

    let selector = json!({"name":"verify","source":"signal","field":"verdict"});
    let mut one_selector = serde_json::to_value(ir(&["a", "b"], &["one", "two"])).assert_value();
    *json_mut::json_at_mut(&mut one_selector, "/root/children/0/join/when") = json!({
        "kind":"k_of_n","count":1,"values":[selector.clone()],"labels":["accepted"]
    });
    let one_selector: CompiledGraphIr = serde_json::from_value(one_selector).assert_value();
    let mut duplicate_selector = serde_json::to_value(&one_selector).assert_value();
    *json_mut::json_at_mut(&mut duplicate_selector, "/root/children/0/join/when/values") =
        json!([selector.clone(), selector]);
    let duplicate_selector: CompiledGraphIr =
        serde_json::from_value(duplicate_selector).assert_value();
    assert_ne!(
        one_selector.identity().assert_value(),
        duplicate_selector.identity().assert_value()
    );
}

#[test]
fn admission_fingerprint_sorts_json_keys_and_binds_the_method() {
    let left = admission_fingerprint(
        "apply",
        &json!({"input":{"z":1,"a":[true,null]},"dryRun":false}),
    )
    .assert_value();
    let reordered = admission_fingerprint(
        "apply",
        &json!({"dryRun":false,"input":{"a":[true,null],"z":1}}),
    )
    .assert_value();
    assert_eq!(left, reordered);
    assert_ne!(
        left,
        admission_fingerprint(
            "plan",
            &json!({"dryRun":false,"input":{"a":[true,null],"z":1}})
        )
        .assert_value()
    );
}

#[test]
fn compiled_node_diff_is_sorted_and_rejects_duplicate_names() {
    let baseline = ir(&["a", "b"], &["one", "two"]);
    let created = diff_compiled_graphs(None, &baseline).assert_value();
    let created_names: Vec<_> = created.added.iter().map(|name| name.as_str()).collect();
    assert_eq!(
        created_names,
        ["a", "b", "one", "ordered", "parallel", "root", "two"]
    );

    let mut duplicate = serde_json::to_value(&baseline).assert_value();
    *json_mut::json_at_mut(&mut duplicate, "/root/children/1/children/1/name") = json!("one");
    let duplicate: CompiledGraphIr = serde_json::from_value(duplicate).assert_value();
    assert!(matches!(
        diff_compiled_graphs(None, &duplicate),
        Err(CanonicalError::DuplicateNodeName(name)) if name.as_str() == "one"
    ));
}
