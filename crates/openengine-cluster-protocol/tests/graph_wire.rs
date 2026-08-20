#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/json_insert.rs"]
mod json_insert;

#[path = "support/json_mut.rs"]
mod json_mut;

use assert_value::AssertValue;
use openengine_cluster_testkit::assertions::AssertError;
use openengine_cluster_protocol::{
    FieldName, FieldPath, GraphDiagnostic, GraphProfile, GraphSpec, Join, NodeInstructions,
    NodeName, PolicyRef, PositiveInteger, WorkerErrorCode, WorkerRef, FULL_GRAPH_PROFILE,
    LEGACY_ZEROSHOT_WORKER, MAX_NODE_INSTRUCTIONS_BYTES, SINGLE_WORKER_GRAPH_PROFILE,
};
use serde_json::{json, Value};

fn record_type() -> Value {
    json!({
        "kind": "record",
        "fields": {
            "items": { "type": { "kind": "array", "items": { "kind": "integer" } }, "required": true },
            "status": { "type": { "kind": "enum", "values": ["accepted", "rejected"] }, "required": false }
        }
    })
}

#[derive(Clone, Copy)]
enum GuardKind {
    In,
    All,
    Any,
    Not,
    KOfN,
    KOfMap,
}

fn guard(kind: GuardKind) -> Value {
    let selector = json!({ "name": "verify", "source": "signal", "field": "verdict" });
    match kind {
        GuardKind::In => json!({ "kind": "in", "value": selector, "labels": ["accepted"] }),
        GuardKind::All => json!({ "kind": "all", "guards": [guard(GuardKind::In)] }),
        GuardKind::Any => json!({ "kind": "any", "guards": [guard(GuardKind::In)] }),
        GuardKind::Not => json!({ "kind": "not", "guard": guard(GuardKind::In) }),
        GuardKind::KOfN => json!({
            "kind": "k_of_n", "count": 1, "values": [selector], "labels": ["accepted"]
        }),
        GuardKind::KOfMap => json!({
            "kind": "k_of_map", "count": 1, "value": selector, "labels": ["accepted"]
        }),
    }
}

fn succeed(name: &str) -> Value {
    json!({
        "kind": "succeed",
        "name": name,
        "output": record_type(),
        "bindings": [{
            "target": ["items"],
            "value": { "source": "state", "path": ["items"] }
        }]
    })
}

fn full_graph() -> Value {
    let step = json!({
        "kind": "step",
        "name": "work",
        "worker": LEGACY_ZEROSHOT_WORKER,
        "instructions": "Implement the requested change.\nRun focused checks.",
        "input": record_type(),
        "output": { "kind": "string" },
        "inputBindings": [{
            "target": ["items"],
            "value": { "source": "item", "path": ["value"] }
        }],
        "writeBindings": [{
            "value": { "node": "work", "channel": "out", "path": ["value"] },
            "target": ["result"]
        }],
        "timeoutMs": 1000,
        "attempts": 2
    });
    let verifier = json!({
        "kind": "verifier",
        "name": "verify",
        "worker": "worker.validator@2",
        "instructions": "Independently verify the result.",
        "input": { "kind": "null" },
        "output": { "kind": "boolean" },
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": 500,
        "attempts": 1,
        "signals": { "verdict": ["accepted", "rejected"] },
        "diagnostic": { "kind": "number" }
    });
    json!({
        "profile": FULL_GRAPH_PROFILE,
        "initialInput": record_type(),
        "policy": { "policy": "policy.default@1", "default": "deny" },
        "root": {
            "kind": "seq",
            "name": "root",
            "state": record_type(),
            "children": [
                step,
                verifier,
                {
                    "kind": "choice", "name": "choose", "state": record_type(),
                    "branches": [{ "when": guard(GuardKind::All), "node": succeed("chosen") }],
                    "otherwise": { "kind": "fail", "name": "rejected", "reason": "rejected" },
                    "promotedStatePaths": [["status"]]
                },
                {
                    "kind": "par", "name": "parallel", "state": record_type(),
                    "branches": [succeed("left"), succeed("right")],
                    "promotedStatePaths": [], "join": { "kind": "quorum", "count": 1 }
                },
                {
                    "kind": "loop", "name": "repeat", "state": record_type(),
                    "body": succeed("loopBody"), "until": guard(GuardKind::Not),
                    "maxIterations": 3, "promotedStatePaths": []
                },
                {
                    "kind": "map", "name": "each", "state": record_type(),
                    "body": succeed("mapBody"),
                    "over": { "source": "state", "path": ["items"] },
                    "maxItems": 10, "promotedStatePaths": []
                }
            ],
            "promotedStatePaths": [["items"]]
        }
    })
}

#[test]
fn every_graph_node_and_both_profiles_round_trip_deterministically() {
    let value = full_graph();
    let graph: GraphSpec = serde_json::from_value(value.clone()).assert_value();
    assert_eq!(serde_json::to_value(&graph).assert_value(), value);

    let mut single = full_graph();
    *json_mut::json_at_mut(&mut single, "/profile") = json!(SINGLE_WORKER_GRAPH_PROFILE);
    let single: GraphSpec = serde_json::from_value(single).assert_value();
    assert_eq!(single.profile, GraphProfile::SingleWorker);

    for join in [
        json!({"kind":"all"}),
        json!({"kind":"any"}),
        json!({"kind":"quorum","count":2}),
        json!({"kind":"first","when":guard(GuardKind::In)}),
    ] {
        let parsed: Join = serde_json::from_value(join.clone()).assert_value();
        assert_eq!(serde_json::to_value(parsed).assert_value(), join);
    }
    assert!(serde_json::from_value::<Join>(json!({"kind":"all","count":1})).is_err());
    for kind in [
        GuardKind::In,
        GuardKind::All,
        GuardKind::Any,
        GuardKind::Not,
        GuardKind::KOfN,
        GuardKind::KOfMap,
    ] {
        serde_json::from_value::<openengine_cluster_protocol::Guard>(guard(kind)).assert_value();
    }
}

#[test]
fn bounded_loop_may_omit_an_exit_guard() {
    let mut value = full_graph();
    value
        .pointer_mut("/root/children/4")
        .assert_value()
        .as_object_mut()
        .assert_value()
        .remove("until");
    let graph: GraphSpec = serde_json::from_value(value.clone()).assert_value();
    assert_eq!(serde_json::to_value(graph).assert_value(), value);
}

#[test]
fn structured_contract_rejects_executable_or_secret_bearing_extensions() {
    for (object_pointer, key, value) in [
        ("/root/children/0", "command", json!("rm -rf /")),
        ("/root/children/0", "endpoint", json!("https://worker")),
        ("/root/children/0", "credential", json!("secret")),
        ("/policy", "script", json!("allow()")),
    ] {
        let mut graph = full_graph();
        json_insert::json_insert(&mut graph, object_pointer, key, value);
        assert!(
            serde_json::from_value::<GraphSpec>(graph).is_err(),
            "accepted {key}"
        );
    }

    let mut graph = full_graph();
    json_insert::json_insert(
        &mut graph,
        "/root/children/2/branches/0",
        "when",
        json!({"kind":"in","script":"return true"}),
    );
    assert!(serde_json::from_value::<GraphSpec>(graph).is_err());

    let mut graph = full_graph();
    *json_mut::json_at_mut(&mut graph, "/root/children/5/over") = json!("$.items[*]");
    assert!(serde_json::from_value::<GraphSpec>(graph).is_err());

    for pointer in ["/profile", "/root/kind"] {
        let mut graph = full_graph();
        *graph.pointer_mut(pointer).assert_value() = json!("unknown");
        assert!(serde_json::from_value::<GraphSpec>(graph).is_err());
    }
}

#[test]
fn identifiers_references_paths_and_positive_counts_validate_on_construction_and_wire_input() {
    assert!(NodeName::new("node.valid-1").is_ok());
    assert!(NodeName::new("bad name").is_err());
    assert!(FieldName::new("").is_err());
    assert!(FieldPath::new(vec![]).is_err());
    assert!(WorkerRef::new(LEGACY_ZEROSHOT_WORKER).is_ok());
    assert!(WorkerRef::new("worker").is_err());
    assert!(WorkerRef::new("worker@").is_err());
    assert!(PolicyRef::new("policy@0").is_err());
    assert!(PolicyRef::new("policy@").is_err());
    assert!(PositiveInteger::new(0).is_err());

    for (pointer, value) in [
        ("/root/children/0/worker", "worker@"),
        ("/policy/policy", "policy@"),
    ] {
        let mut graph = full_graph();
        *graph.pointer_mut(pointer).assert_value() = json!(value);
        assert!(serde_json::from_value::<GraphSpec>(graph.clone()).is_err());
        let schema = serde_json::to_value(schemars::schema_for!(GraphSpec)).assert_value();
        assert!(
            !jsonschema::validator_for(&schema)
                .assert_value()
                .is_valid(&graph)
        );
    }

    let mut graph = full_graph();
    *json_mut::json_at_mut(&mut graph, "/root/children/0/timeoutMs") = json!(0);
    assert!(
        serde_json::from_value::<GraphSpec>(graph)
            .assert_error()
            .to_string()
            .contains("integer must be at least 1")
    );

    let mut graph = full_graph();
    *json_mut::json_at_mut(&mut graph, "/root/children/0/timeoutMs") =
        serde_json::from_str("1.0").assert_value();
    assert!(
        serde_json::from_value::<GraphSpec>(graph.clone()).is_ok(),
        "Rust must accept the same integral JSON numbers as JSON Schema"
    );
    let schema = serde_json::to_value(schemars::schema_for!(GraphSpec)).assert_value();
    assert!(
        jsonschema::validator_for(&schema)
            .assert_value()
            .is_valid(&graph)
    );
}

#[test]
fn node_instructions_are_nonempty_bounded_and_schema_validated() {
    assert!(NodeInstructions::new("Implement the change.\nRun tests.").is_ok());
    assert!(NodeInstructions::new(" \n\t ").is_err());
    assert!(NodeInstructions::new("contains\0nul").is_err());
    assert!(NodeInstructions::new("a".repeat(MAX_NODE_INSTRUCTIONS_BYTES + 1)).is_err());

    let schema = serde_json::to_value(schemars::schema_for!(GraphSpec)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();
    assert!(validator.is_valid(&full_graph()));
    for invalid in [
        json!(" \n\t "),
        json!("contains\0nul"),
        json!("a".repeat(MAX_NODE_INSTRUCTIONS_BYTES + 1)),
    ] {
        let mut graph = full_graph();
        *json_mut::json_at_mut(&mut graph, "/root/children/0/instructions") = invalid;
        assert!(serde_json::from_value::<GraphSpec>(graph.clone()).is_err());
        assert!(!validator.is_valid(&graph));
    }
}

#[test]
fn identifier_keyed_maps_enforce_wire_identifier_bounds_in_rust_and_schema() {
    let schema = serde_json::to_value(schemars::schema_for!(GraphSpec)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();
    let overlength = "a".repeat(129);

    for pointer in ["/initialInput/fields", "/root/children/1/signals"] {
        let mut graph = full_graph();
        let map = graph
            .pointer_mut(pointer)
            .assert_value()
            .as_object_mut()
            .assert_value();
        let value = map.values().next().cloned().assert_value();
        map.insert(overlength.clone(), value);
        assert!(
            serde_json::from_value::<GraphSpec>(graph.clone()).is_err(),
            "Rust accepted overlength key at {pointer}"
        );
        assert!(
            !validator.is_valid(&graph),
            "schema accepted overlength key at {pointer}"
        );
    }
}

#[test]
fn authored_fail_nodes_cannot_use_the_reserved_unhandled_reason() {
    let value = json!({"kind":"fail", "name":"sink", "reason":"unhandled"});
    assert!(serde_json::from_value::<openengine_cluster_protocol::GraphNode>(value).is_err());
}

#[test]
fn payload_constraints_and_worker_error_codes_are_closed() {
    let payload = json!({"kind":"string", "regex":".*"});
    assert!(serde_json::from_value::<openengine_cluster_protocol::PayloadType>(payload).is_err());
    let schema = serde_json::to_value(schemars::schema_for!(GraphSpec)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();
    let mut graph = full_graph();
    *json_mut::json_at_mut(&mut graph, "/initialInput") = json!({"kind":"string", "regex":".*"});
    assert!(!validator.is_valid(&graph));
    let mut graph = full_graph();
    json_insert::json_insert(
        &mut graph,
        "/root/children/3/join",
        "unexpected",
        json!(true),
    );
    assert!(!validator.is_valid(&graph));

    for (code, expected) in [
        (WorkerErrorCode::Timeout, "timeout"),
        (WorkerErrorCode::Crash, "crash"),
        (WorkerErrorCode::Malformed, "malformed"),
        (WorkerErrorCode::Refusal, "refusal"),
    ] {
        assert_eq!(serde_json::to_value(code).assert_value(), json!(expected));
    }
    assert!(serde_json::from_value::<WorkerErrorCode>(json!("policy_denied")).is_err());
}

#[test]
fn diagnostic_indices_have_matching_u32_bounds_in_rust_and_schema() {
    let diagnostic = |index: serde_json::Value| {
        json!({
            "severity": "error",
            "code": "invalid_graph_shape",
            "message": "invalid index",
            "path": [{"kind": "index", "index": index}],
            "relatedNodes": []
        })
    };
    let schema = serde_json::to_value(schemars::schema_for!(GraphDiagnostic)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();

    for value in [
        json!(0),
        serde_json::from_str("0.0").assert_value(),
        json!(4_294_967_295_u64),
        serde_json::from_str("4294967295.0").assert_value(),
    ] {
        let value = diagnostic(value);
        assert!(
            serde_json::from_value::<GraphDiagnostic>(value.clone()).is_ok(),
            "Rust rejected valid diagnostic index {value}"
        );
        assert!(
            validator.is_valid(&value),
            "schema rejected valid diagnostic index {value}"
        );
    }

    for value in [
        json!(-1),
        serde_json::from_str("1.5").assert_value(),
        json!(4_294_967_296_u64),
        serde_json::from_str("4294967296.0").assert_value(),
    ] {
        let value = diagnostic(value);
        assert!(
            serde_json::from_value::<GraphDiagnostic>(value.clone()).is_err(),
            "Rust accepted invalid diagnostic index {value}"
        );
        assert!(
            !validator.is_valid(&value),
            "schema accepted invalid diagnostic index {value}"
        );
    }
}
