use crate::fixture::*;

use serde_json::{json, Value};

pub(crate) fn diagnostic_fixture() -> Value {
    json!({
        "severity": "error", "code": "write_conflict", "message": "two writes target state.result",
        "path": [
            { "kind": "node", "name": "parallel" },
            { "kind": "field", "name": "writeBindings" },
            { "kind": "index", "index": 1 }
        ],
        "relatedNodes": ["left", "right"]
    })
}

type NegativeFixture = (&'static str, &'static str, &'static str, Value);

pub(crate) fn negative_graph_fixtures(
    full: Value,
    compiled: Value,
    artifact: Value,
) -> Vec<NegativeFixture> {
    let mut zero_bound = compiled.clone();
    *zero_bound
        .assert_key_mut("bounds")
        .assert_key_mut("peakConcurrency") = json!(0);
    let mut fixtures = payload_fixtures(&full);
    fixtures.extend(reference_fixtures(&full, &artifact));
    fixtures.extend(identifier_key_fixtures(&full, &compiled));
    fixtures.extend(control_fixtures(&full));
    fixtures.extend(worker_and_variant_fixtures(&full));
    fixtures.extend(artifact_fixtures(&artifact));
    fixtures.push(("zero-bound", "INVALID_BOUND", "compiled-ir", zero_bound));
    fixtures
}

fn mutated(full: &Value, pointer: &str, value: Value) -> Value {
    let mut graph = full.clone();
    *graph
        .pointer_mut(pointer)
        .assert_value_with("fixture pointer exists") = value;
    graph
}

fn extended(full: &Value, pointer: &str, key: &str, value: Value) -> Value {
    let mut graph = full.clone();
    graph
        .pointer_mut(pointer)
        .assert_value_with("fixture pointer exists")
        .as_object_mut()
        .assert_value_with("fixture target is an object")
        .insert(key.to_owned(), value);
    graph
}

fn payload_fixtures(full: &Value) -> Vec<NegativeFixture> {
    vec![
        (
            "payload-union",
            "UNSAFE_PAYLOAD_KIND",
            "graph",
            mutated(full, "/initialInput", json!({"kind":"union","anyOf":[]})),
        ),
        (
            "payload-reference",
            "UNSAFE_PAYLOAD_KIND",
            "graph",
            mutated(
                full,
                "/initialInput",
                json!({"kind":"reference","ref":"type@1"}),
            ),
        ),
        (
            "payload-custom",
            "UNSAFE_PAYLOAD_KIND",
            "graph",
            mutated(full, "/initialInput", json!({"kind":"custom","schema":{}})),
        ),
        (
            "payload-regex",
            "UNSAFE_PAYLOAD_CONSTRAINT",
            "graph",
            mutated(full, "/initialInput", json!({"kind":"string","regex":".*"})),
        ),
        (
            "empty-enum",
            "EMPTY_ENUM",
            "graph",
            mutated(full, "/initialInput", json!({"kind":"enum","values":[]})),
        ),
        (
            "duplicate-enum",
            "DUPLICATE_ENUM",
            "graph",
            mutated(
                full,
                "/initialInput",
                json!({"kind":"enum","values":["a","a"]}),
            ),
        ),
    ]
}

fn reference_fixtures(full: &Value, artifact: &Value) -> Vec<NegativeFixture> {
    vec![
        (
            "malformed-worker-ref",
            "INVALID_STABLE_REF",
            "graph",
            mutated(full, "/root/children/0/worker", json!("worker")),
        ),
        (
            "malformed-policy-ref",
            "INVALID_STABLE_REF",
            "graph",
            mutated(full, "/policy/policy", json!("policy@0")),
        ),
        (
            "empty-worker-version",
            "INVALID_STABLE_REF",
            "graph",
            mutated(full, "/root/children/0/worker", json!("worker@")),
        ),
        (
            "empty-policy-version",
            "INVALID_STABLE_REF",
            "graph",
            mutated(full, "/policy/policy", json!("policy@")),
        ),
        (
            "empty-type-version",
            "INVALID_STABLE_REF",
            "artifact",
            mutated(artifact, "/typeId", json!("openengine.result@")),
        ),
    ]
}

fn identifier_key_fixtures(full: &Value, compiled: &Value) -> Vec<NegativeFixture> {
    let key = "a".repeat(129);
    vec![
        (
            "overlength-record-field",
            "INVALID_IDENTIFIER",
            "graph",
            extended(
                full,
                "/initialInput/fields",
                &key,
                json!({ "type": { "kind": "null" }, "required": true }),
            ),
        ),
        (
            "overlength-signal-name",
            "INVALID_IDENTIFIER",
            "graph",
            extended(full, "/root/children/1/signals", &key, json!(["accepted"])),
        ),
        (
            "overlength-attempt-node",
            "INVALID_IDENTIFIER",
            "compiled-ir",
            extended(compiled, "/bounds/attemptsPerNode", &key, json!(1)),
        ),
    ]
}

fn control_fixtures(full: &Value) -> Vec<NegativeFixture> {
    vec![
        (
            "script-guard",
            "EXECUTABLE_GUARD",
            "graph",
            extended(
                full,
                "/root/children/2/branches/0/when",
                "script",
                json!("return true"),
            ),
        ),
        (
            "regex-guard",
            "EXECUTABLE_GUARD",
            "graph",
            extended(
                full,
                "/root/children/2/branches/0/when",
                "regex",
                json!(".*"),
            ),
        ),
        (
            "string-selector",
            "STRING_SELECTOR",
            "graph",
            mutated(full, "/root/children/8/over", json!("$.items[*]")),
        ),
    ]
}

fn worker_and_variant_fixtures(full: &Value) -> Vec<NegativeFixture> {
    vec![
        (
            "worker-command",
            "FORBIDDEN_WORKER_FIELD",
            "graph",
            extended(full, "/root/children/0", "command", json!("run")),
        ),
        (
            "worker-endpoint",
            "FORBIDDEN_WORKER_FIELD",
            "graph",
            extended(
                full,
                "/root/children/0",
                "endpoint",
                json!("https://worker"),
            ),
        ),
        (
            "worker-credential",
            "FORBIDDEN_WORKER_FIELD",
            "graph",
            extended(full, "/root/children/0", "credential", json!("secret")),
        ),
        (
            "unknown-profile",
            "UNKNOWN_PROFILE",
            "graph",
            mutated(full, "/profile", json!("openengine.graph.unknown/v1")),
        ),
        (
            "unknown-node",
            "UNKNOWN_NODE",
            "graph",
            mutated(full, "/root/kind", json!("exec")),
        ),
    ]
}

fn artifact_fixtures(artifact: &Value) -> Vec<NegativeFixture> {
    let mut fixtures = [
        ("artifact-bytes", "bytes"),
        ("artifact-signed-url", "signedUrl"),
    ]
    .into_iter()
    .map(|(name, field)| {
        let mut document = artifact.clone();
        document
            .as_object_mut()
            .assert_value_with("artifact fixture must be an object")
            .insert(field.to_owned(), json!("forbidden"));
        (name, "FORBIDDEN_ARTIFACT_FIELD", "artifact", document)
    })
    .collect::<Vec<_>>();
    fixtures.push((
        "artifact-control-character",
        "INVALID_ARTIFACT_VALUE",
        "artifact",
        mutated(artifact, "/artifactId", json!("bad\nvalue")),
    ));
    fixtures.push((
        "artifact-overlength",
        "INVALID_ARTIFACT_VALUE",
        "artifact",
        mutated(artifact, "/mediaType", json!("é".repeat(257))),
    ));
    fixtures
}
