use openengine_cluster_protocol::{
    ArtifactRef, CompiledGraphIr, GraphDiagnostic, GraphSpec, StructuralBounds,
};
use openengine_cluster_testkit::artifacts::generate_artifacts;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

fn json_artifact(
    artifacts: &[openengine_cluster_testkit::artifacts::Artifact],
    suffix: &str,
) -> Value {
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.relative_path.ends_with(suffix))
        .assert_value_with(&format!("missing artifact {suffix}"));
    serde_json::from_slice(&artifact.bytes).assert_value()
}

fn component_schema(graph_schema: &Value, name: &str) -> Value {
    json!({
        "$schema": graph_schema.assert_key("$schema"),
        "$ref": format!("#/$defs/{name}"),
        "$defs": graph_schema.assert_key("$defs")
    })
}

const RUST_REJECTION_MARKERS: &[(&str, &str)] = &[
    ("payload type `union`", "UNSAFE_PAYLOAD_KIND"),
    ("payload type `reference`", "UNSAFE_PAYLOAD_KIND"),
    ("payload type `custom`", "UNSAFE_PAYLOAD_KIND"),
    (
        "unknown field `regex` in payload type `string`",
        "UNSAFE_PAYLOAD_CONSTRAINT",
    ),
    ("enum set must not be empty", "EMPTY_ENUM"),
    (
        "enum set must not contain duplicate values",
        "DUPLICATE_ENUM",
    ),
    ("stable reference ", "INVALID_STABLE_REF"),
    ("type ID is invalid", "INVALID_STABLE_REF"),
    (
        "unknown field `script`, expected `value` or `labels`",
        "EXECUTABLE_GUARD",
    ),
    (
        "unknown field `regex`, expected `value` or `labels`",
        "EXECUTABLE_GUARD",
    ),
    (
        "expected internally tagged enum DataSelector",
        "STRING_SELECTOR",
    ),
    ("unknown field `command`", "FORBIDDEN_WORKER_FIELD"),
    ("unknown field `endpoint`", "FORBIDDEN_WORKER_FIELD"),
    ("unknown field `credential`", "FORBIDDEN_WORKER_FIELD"),
    (
        "expected `openengine.graph.full/v1` or `openengine.graph.single-worker/v1`",
        "UNKNOWN_PROFILE",
    ),
    (
        "expected one of `step`, `verifier`, `seq`, `choice`, `par`, `loop`, `map`, `succeed`, `fail`",
        "UNKNOWN_NODE",
    ),
    ("unknown field `bytes`", "FORBIDDEN_ARTIFACT_FIELD"),
    ("unknown field `signedUrl`", "FORBIDDEN_ARTIFACT_FIELD"),
    (
        "value must be at most 256 non-control characters",
        "INVALID_ARTIFACT_VALUE",
    ),
    (
        "integer is outside the JavaScript-safe range",
        "INVALID_BOUND",
    ),
    ("exceeds the maximum length of 128", "INVALID_IDENTIFIER"),
];

type SchemaClassifier = (fn(&Map<String, Value>) -> bool, &'static str);

fn classify_contract_rejection(rust_error: &str) -> Option<&'static str> {
    RUST_REJECTION_MARKERS
        .iter()
        .find_map(|(marker, code)| rust_error.contains(marker).then_some(*code))
}

fn any_object(value: &Value, predicate: fn(&Map<String, Value>) -> bool) -> bool {
    match value {
        Value::Object(object) => {
            predicate(object) || object.values().any(|value| any_object(value, predicate))
        }
        Value::Array(values) => values.iter().any(|value| any_object(value, predicate)),
        _ => false,
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

fn valid_stable_ref(value: &str) -> bool {
    value.len() <= 256
        && value.rsplit_once('@').is_some_and(|(name, version)| {
            !name.is_empty()
                && name
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
                })
                && !version.is_empty()
                && !version.starts_with('0')
                && version.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn classify_artifact_schema(schema_name: &str, document: &Value) -> Option<&'static str> {
    (schema_name == "artifact")
        .then(|| {
            [
                (
                    document
                        .get("typeId")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !valid_stable_ref(value)),
                    "INVALID_STABLE_REF",
                ),
                (
                    ["bytes", "signedUrl"]
                        .iter()
                        .any(|field| document.get(field).is_some()),
                    "FORBIDDEN_ARTIFACT_FIELD",
                ),
                (
                    ["artifactId", "mediaType"].iter().any(|field| {
                        document
                            .get(field)
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                value.is_empty()
                                    || value.chars().count() > 256
                                    || value.chars().any(char::is_control)
                            })
                    }),
                    "INVALID_ARTIFACT_VALUE",
                ),
            ]
            .into_iter()
            .find_map(|(matches, code)| matches.then_some(code))
        })
        .flatten()
}

fn classify_bounds_schema(schema_name: &str, document: &Value) -> Option<&'static str> {
    let bounds = document.get("bounds")?;
    let zero_scalar = ["maxNodeExecutions", "peakConcurrency"]
        .iter()
        .any(|field| bounds.get(field).and_then(Value::as_u64) == Some(0));
    let zero_attempt = bounds
        .get("attemptsPerNode")
        .and_then(Value::as_object)
        .is_some_and(|attempts| attempts.values().any(|value| value.as_u64() == Some(0)));
    (schema_name == "compiled-ir" && (zero_scalar || zero_attempt)).then_some("INVALID_BOUND")
}

fn has_invalid_worker_ref(object: &Map<String, Value>) -> bool {
    object
        .get("worker")
        .and_then(Value::as_str)
        .is_some_and(|value| !valid_stable_ref(value))
}

fn classify_graph_header_schema(document: &Value) -> Option<&'static str> {
    let unknown_profile = document
        .get("profile")
        .and_then(Value::as_str)
        .is_some_and(|profile| {
            !matches!(
                profile,
                "openengine.graph.full/v1" | "openengine.graph.single-worker/v1"
            )
        });
    let invalid_ref = document
        .pointer("/policy/policy")
        .and_then(Value::as_str)
        .is_some_and(|value| !valid_stable_ref(value))
        || any_object(document, has_invalid_worker_ref);
    let unknown_node = document
        .pointer("/root/kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| {
            !matches!(
                kind,
                "step"
                    | "verifier"
                    | "seq"
                    | "choice"
                    | "par"
                    | "loop"
                    | "map"
                    | "succeed"
                    | "fail"
            )
        });
    [
        (unknown_profile, "UNKNOWN_PROFILE"),
        (invalid_ref, "INVALID_STABLE_REF"),
        (unknown_node, "UNKNOWN_NODE"),
    ]
    .into_iter()
    .find_map(|(matches, code)| matches.then_some(code))
}

fn unsafe_payload_kind(object: &Map<String, Value>) -> bool {
    matches!(
        object.get("kind").and_then(Value::as_str),
        Some("union" | "reference" | "custom")
    )
}

fn unsafe_payload_constraint(object: &Map<String, Value>) -> bool {
    object.get("kind").and_then(Value::as_str) == Some("string") && object.contains_key("regex")
}

fn empty_enum(object: &Map<String, Value>) -> bool {
    object.get("kind").and_then(Value::as_str) == Some("enum")
        && object
            .get("values")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
}

fn duplicate_enum(object: &Map<String, Value>) -> bool {
    object.get("kind").and_then(Value::as_str) == Some("enum")
        && object
            .get("values")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                values
                    .iter()
                    .enumerate()
                    .any(|(index, value)| values.assert_slice_to(index).contains(value))
            })
}

fn classify_payload_schema(document: &Value) -> Option<&'static str> {
    let classifiers: &[SchemaClassifier] = &[
        (unsafe_payload_kind, "UNSAFE_PAYLOAD_KIND"),
        (unsafe_payload_constraint, "UNSAFE_PAYLOAD_CONSTRAINT"),
        (empty_enum, "EMPTY_ENUM"),
        (duplicate_enum, "DUPLICATE_ENUM"),
    ];
    classifiers
        .iter()
        .find_map(|(predicate, code)| any_object(document, *predicate).then_some(*code))
}

fn executable_guard(object: &Map<String, Value>) -> bool {
    matches!(
        object.get("kind").and_then(Value::as_str),
        Some("in" | "all" | "any" | "not" | "k_of_n" | "k_of_map")
    ) && (object.contains_key("script") || object.contains_key("regex"))
}

fn string_selector(object: &Map<String, Value>) -> bool {
    object.get("over").is_some_and(Value::is_string)
}

fn forbidden_worker_field(object: &Map<String, Value>) -> bool {
    matches!(
        object.get("kind").and_then(Value::as_str),
        Some("step" | "verifier")
    ) && ["command", "endpoint", "credential"]
        .iter()
        .any(|field| object.contains_key(*field))
}

fn classify_control_schema(document: &Value) -> Option<&'static str> {
    let classifiers: &[SchemaClassifier] = &[
        (executable_guard, "EXECUTABLE_GUARD"),
        (string_selector, "STRING_SELECTOR"),
        (forbidden_worker_field, "FORBIDDEN_WORKER_FIELD"),
    ];
    classifiers
        .iter()
        .find_map(|(predicate, code)| any_object(document, *predicate).then_some(*code))
}

fn invalid_identifier_map(object: &Map<String, Value>) -> bool {
    ["fields", "signals", "attemptsPerNode"]
        .iter()
        .filter_map(|field| object.get(*field).and_then(Value::as_object))
        .any(|map| map.keys().any(|key| !valid_identifier(key)))
}

fn classify_schema_rejection(schema_name: &str, document: &Value) -> Option<&'static str> {
    [
        classify_artifact_schema(schema_name, document),
        classify_bounds_schema(schema_name, document),
        classify_graph_header_schema(document),
        classify_payload_schema(document),
        classify_control_schema(document),
        any_object(document, invalid_identifier_map).then_some("INVALID_IDENTIFIER"),
    ]
    .into_iter()
    .flatten()
    .next()
}

fn rust_rejection(schema_name: &str, document: &Value) -> String {
    match schema_name {
        "graph" => serde_json::from_value::<GraphSpec>(document.clone())
            .assert_error()
            .to_string(),
        "compiled-ir" => serde_json::from_value::<CompiledGraphIr>(document.clone())
            .assert_error()
            .to_string(),
        "artifact" => serde_json::from_value::<ArtifactRef>(document.clone())
            .assert_error()
            .to_string(),
        other => None::<String>.assert_value_with(&format!("unknown fixture schema {other}")),
    }
}

#[tokio::test]
async fn positive_fixtures_round_trip_through_rust_and_generated_schemas() {
    let artifacts = generate_artifacts().await;
    let graph_schema = json_artifact(&artifacts, "/graph.schema.json");
    let compiled_schema = json_artifact(&artifacts, "/compiled-ir.schema.json");
    let graph_validator = jsonschema::validator_for(&graph_schema).assert_value();
    let compiled_validator = jsonschema::validator_for(&compiled_schema).assert_value();

    for suffix in [
        "/positive/full-all-nodes.json",
        "/positive/single-worker.json",
    ] {
        let value = json_artifact(&artifacts, suffix);
        let parsed: GraphSpec = serde_json::from_value(value.clone()).assert_value();
        assert_eq!(serde_json::to_value(parsed).assert_value(), value);
        assert!(graph_validator.is_valid(&value), "schema rejected {suffix}");
    }

    let compiled = json_artifact(&artifacts, "/positive/compiled-ir.json");
    let parsed: CompiledGraphIr = serde_json::from_value(compiled.clone()).assert_value();
    assert_eq!(serde_json::to_value(parsed).assert_value(), compiled);
    assert!(compiled_validator.is_valid(&compiled));

    for (suffix, component) in [
        ("/positive/diagnostic.json", "GraphDiagnostic"),
        ("/positive/artifact-ref.json", "ArtifactRef"),
    ] {
        let value = json_artifact(&artifacts, suffix);
        match component {
            "GraphDiagnostic" => {
                let parsed: GraphDiagnostic = serde_json::from_value(value.clone()).assert_value();
                assert_eq!(serde_json::to_value(parsed).assert_value(), value);
            }
            "ArtifactRef" => {
                let parsed: ArtifactRef = serde_json::from_value(value.clone()).assert_value();
                assert_eq!(serde_json::to_value(parsed).assert_value(), value);
            }
            other => assert!(
                matches!(other, "GraphDiagnostic" | "ArtifactRef"),
                "unknown component {other}"
            ),
        }
        let schema = component_schema(&graph_schema, component);
        assert!(
            jsonschema::validator_for(&schema)
                .assert_value()
                .is_valid(&value)
        );
    }

    let bounds = compiled.assert_key("bounds").clone();
    serde_json::from_value::<StructuralBounds>(bounds.clone()).assert_value();
    let bounds_schema = component_schema(&graph_schema, "StructuralBounds");
    assert!(
        jsonschema::validator_for(&bounds_schema)
            .assert_value()
            .is_valid(&bounds)
    );
}

#[tokio::test]
async fn every_negative_fixture_is_rejected_with_its_committed_stable_code() {
    let artifacts = generate_artifacts().await;
    let graph_schema = json_artifact(&artifacts, "/graph.schema.json");
    let compiled_schema = json_artifact(&artifacts, "/compiled-ir.schema.json");
    let artifact_schema = component_schema(&graph_schema, "ArtifactRef");
    let validators = [
        (
            "graph",
            jsonschema::validator_for(&graph_schema).assert_value(),
        ),
        (
            "compiled-ir",
            jsonschema::validator_for(&compiled_schema).assert_value(),
        ),
        (
            "artifact",
            jsonschema::validator_for(&artifact_schema).assert_value(),
        ),
    ];
    let mut rejected = Vec::new();

    for artifact in artifacts
        .iter()
        .filter(|artifact| artifact.relative_path.contains("/fixtures/graph/negative/"))
    {
        let fixture: Value = serde_json::from_slice(&artifact.bytes).assert_value();
        let code = fixture
            .assert_key("expectedCode")
            .as_str()
            .assert_value()
            .to_owned();
        assert!(
            code.bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte == b'_'),
            "unstable diagnostic code in {}",
            artifact.relative_path
        );
        let schema_name = fixture.assert_key("schema").as_str().assert_value();
        let document = fixture.assert_key("document");
        let rust_error = rust_rejection(schema_name, document);
        let validator = validators
            .iter()
            .find(|(name, _)| *name == schema_name)
            .map(|(_, validator)| validator)
            .assert_value();
        assert!(
            !validator.is_valid(document),
            "JSON Schema accepted {}",
            artifact.relative_path
        );
        assert!(
            validator.iter_errors(document).next().is_some(),
            "schema produced no rejection for {}",
            artifact.relative_path
        );
        assert_eq!(
            classify_contract_rejection(&rust_error),
            Some(code.as_str()),
            "wrong Rust rejection code for {}: {rust_error}",
            artifact.relative_path
        );
        assert_eq!(
            classify_schema_rejection(schema_name, document),
            Some(code.as_str()),
            "wrong schema rejection code for {}",
            artifact.relative_path
        );
        rejected.push((artifact.relative_path.clone(), code));
    }

    assert_eq!(rejected.len(), 27);
}

#[path = "graph_fixtures/canonical.rs"]
mod canonical;

use openengine_cluster_testkit::assertions::{AssertError, AssertSlice, AssertValue, JsonAt};
