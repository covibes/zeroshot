use std::collections::BTreeMap;

use async_trait::async_trait;
use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, ArtifactRef, GraphSpec,
    WorkerDescriptor, WorkerOutcome, WorkerProtocolBinding, WorkerRef, BUILTIN_PROFILE,
    BUILTIN_VERSION, LEGACY_ZEROSHOT_WORKER, RUNTIME_WORKER_ERRORS,
};
use openengine_cluster_server::worker_registry::{
    check_graph_workers, WorkerCompatibilityCode, WorkerRegistry, WorkerRegistryError,
};
use openengine_cluster_testkit::worker_artifacts::{worker_fixture_artifacts, worker_schema};
use openengine_cluster_testkit::worker_profiles::{
    normalize_mock_a2a_1_0, normalize_mock_acp_v1, MockA2a1_0Result, MockAcpV1Result,
};
use serde_json::{json, Map, Value};

struct MemoryRegistry(BTreeMap<String, Value>);

#[async_trait]
impl WorkerRegistry for MemoryRegistry {
    async fn resolve(&self, worker: &WorkerRef) -> Result<WorkerDescriptor, WorkerRegistryError> {
        let Some(document) = self.0.get(worker.as_str()) else {
            return Err(WorkerRegistryError::NotFound {
                worker: worker.clone(),
            });
        };
        Ok(serde_json::from_value(document.clone())
            .assert_value_with("generated registry descriptor must deserialize"))
    }
}

fn fixture_value(suffix: &str) -> Value {
    let artifact = worker_fixture_artifacts()
        .into_iter()
        .find(|artifact| artifact.relative_path.ends_with(suffix))
        .assert_value_with(&format!("missing generated worker fixture {suffix}"));
    serde_json::from_slice(&artifact.bytes).assert_value()
}

fn component_schema(root: &Value, name: &str) -> Value {
    json!({
        "$schema": root.assert_key("$schema"),
        "$ref": format!("#/$defs/{name}"),
        "$defs": root.assert_key("$defs")
    })
}

fn mock_descriptor(protocol: &str) -> WorkerDescriptor {
    let binding = match protocol {
        "acp" => WorkerProtocolBinding::acp_v1(),
        "a2a" => WorkerProtocolBinding::a2a_1_0(),
        other => {
            assert!(matches!(other, "acp" | "a2a"), "unknown protocol {other}");
            WorkerProtocolBinding::acp_v1()
        }
    };
    serde_json::from_value(json!({
        "worker": format!("mock.{protocol}@1"),
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": binding,
        "contract": {
            "input": { "kind": "string" },
            "output": { "kind": "string" },
            "verifier": null,
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
    .assert_value()
}

fn forbidden_durable_key(value: &Value) -> Option<&str> {
    const FORBIDDEN: &[&str] = &[
        "command",
        "endpoint",
        "credentialValue",
        "token",
        "bearerToken",
        "apiToken",
        "signedUrl",
        "bytes",
        "path",
        "callback",
        "url",
    ];
    match value {
        Value::Object(object) => object.iter().find_map(|(key, value)| {
            FORBIDDEN
                .contains(&key.as_str())
                .then_some(key.as_str())
                .or_else(|| forbidden_durable_key(value))
        }),
        Value::Array(values) => values.iter().find_map(forbidden_durable_key),
        _ => None,
    }
}

#[test]
fn positive_vectors_round_trip_through_their_committed_contracts() {
    let schema = worker_schema();
    let descriptor_validator = jsonschema::validator_for(&schema).assert_value();
    for suffix in [
        "/positive/acp-v1.json",
        "/positive/a2a-1.0.json",
        "/positive/legacy-zeroshot-ship-v1.json",
        "/positive/builtin-v1.json",
    ] {
        let value = fixture_value(suffix);
        let parsed: WorkerDescriptor = serde_json::from_value(value.clone()).assert_value();
        assert_eq!(serde_json::to_value(parsed).assert_value(), value);
        assert!(
            descriptor_validator.is_valid(&value),
            "schema rejected {suffix}"
        );
        assert_eq!(
            forbidden_durable_key(&value),
            None,
            "secret field in {suffix}"
        );
    }

    let outcome_schema = component_schema(&schema, "WorkerOutcome");
    let outcome_validator = jsonschema::validator_for(&outcome_schema).assert_value();
    let policy = fixture_value("/positive/policy-refusal.json");
    let parsed: WorkerOutcome = serde_json::from_value(policy.clone()).assert_value();
    assert_eq!(parsed, WorkerOutcome::policy_refusal());
    assert_eq!(serde_json::to_value(parsed).assert_value(), policy);
    assert!(outcome_validator.is_valid(&policy));
    assert_eq!(forbidden_durable_key(&policy), None);

    let receipt = fixture_value("/positive/artifact-receipt.json");
    let parsed: ArtifactRef = serde_json::from_value(receipt.clone()).assert_value();
    assert_eq!(serde_json::to_value(parsed).assert_value(), receipt);
    let receipt_schema = serde_json::to_value(schemars::schema_for!(ArtifactRef)).assert_value();
    assert!(
        jsonschema::validator_for(&receipt_schema)
            .assert_value()
            .is_valid(&receipt)
    );
    assert_eq!(forbidden_durable_key(&receipt), None);

    for (suffix, expected_profile, expected_version, normalized) in [
        (
            "/mock/acp-input-request.json",
            "openengine.worker.acp/v1",
            "1",
            normalize_mock_acp_v1(&mock_descriptor("acp"), MockAcpV1Result::InputRequest),
        ),
        (
            "/mock/a2a-auth-required.json",
            "openengine.worker.a2a/1.0",
            "1.0",
            normalize_mock_a2a_1_0(&mock_descriptor("a2a"), MockA2a1_0Result::AuthRequired),
        ),
    ] {
        let value = fixture_value(suffix);
        assert_eq!(value.assert_key("profile"), expected_profile);
        assert_eq!(value.assert_key("version"), expected_version);
        let committed: WorkerOutcome =
            serde_json::from_value(value.assert_key("normalized").clone()).assert_value();
        assert_eq!(committed, normalized, "normalization drift in {suffix}");
        assert_eq!(
            &serde_json::to_value(committed).assert_value(),
            value.assert_key("normalized")
        );
        assert!(outcome_validator.is_valid(value.assert_key("normalized")));
        assert_eq!(
            forbidden_durable_key(&value),
            None,
            "secret field in {suffix}"
        );
    }
}

const RUST_REJECTION_MARKERS: &[(&str, &str)] = &[
    (
        "unsupported worker protocol version/profile binding",
        "UNSUPPORTED_WORKER_BINDING",
    ),
    ("graph profiles must not be empty", "EMPTY_GRAPH_PROFILES"),
    (
        "graph profiles must not contain duplicates",
        "DUPLICATE_GRAPH_PROFILES",
    ),
    ("unknown variant `unknown`", "UNKNOWN_WORKER_ERROR"),
    (
        "artifact type IDs must not be empty",
        "EMPTY_ARTIFACT_TYPES",
    ),
    (
        "worker errors must contain timeout, crash, malformed, and refusal",
        "INCOMPLETE_WORKER_ERRORS",
    ),
    (
        "credential handles must not contain duplicates",
        "DUPLICATE_CREDENTIAL_REQUIREMENTS",
    ),
    (
        "legacy.zeroshot.ship@1 must use its pinned binding",
        "INVALID_LEGACY_BINDING",
    ),
    (
        "must not declare credential requirements",
        "INVALID_BUILTIN_BINDING",
    ),
    ("unknown field", "FORBIDDEN_FIELD"),
];

fn classify_rust_descriptor_rejection(error: &str) -> Option<&'static str> {
    RUST_REJECTION_MARKERS
        .iter()
        .find_map(|(marker, code)| error.contains(marker).then_some(*code))
}

fn duplicate(values: &[Value]) -> bool {
    values
        .iter()
        .enumerate()
        .any(|(index, value)| values.assert_slice_to(index).contains(value))
}

fn forbidden_descriptor_field(object: &Map<String, Value>) -> bool {
    [
        "command",
        "endpoint",
        "credentialValue",
        "bearerToken",
        "apiToken",
        "signedUrl",
        "bytes",
        "path",
        "callback",
    ]
    .iter()
    .any(|field| object.contains_key(*field))
}

fn classify_schema_descriptor_rejection(document: &Value) -> Option<&'static str> {
    [
        document
            .as_object()
            .is_some_and(forbidden_descriptor_field)
            .then_some("FORBIDDEN_FIELD"),
        classify_binding_rejection(document),
        classify_graph_profile_rejection(document),
        classify_error_set_rejection(document),
        classify_artifact_profile_rejection(document),
        classify_credential_rejection(document),
        classify_legacy_rejection(document),
        classify_builtin_rejection(document),
    ]
    .into_iter()
    .flatten()
    .next()
}

fn classify_binding_rejection(document: &Value) -> Option<&'static str> {
    let binding = &document.assert_key("binding");
    let expected_binding = match binding.assert_key("protocol").as_str()? {
        "acp" => ("1", "openengine.worker.acp/v1"),
        "a2a" => ("1.0", "openengine.worker.a2a/1.0"),
        "legacy_zeroshot" => ("1", "legacy.zeroshot.ship/v1"),
        "builtin" => (BUILTIN_VERSION, BUILTIN_PROFILE),
        _ => return Some("UNSUPPORTED_WORKER_BINDING"),
    };
    if binding.assert_key("version") != expected_binding.0
        || binding.assert_key("profile") != expected_binding.1
    {
        return Some("UNSUPPORTED_WORKER_BINDING");
    }
    None
}

fn classify_graph_profile_rejection(document: &Value) -> Option<&'static str> {
    let graph_profiles = document.assert_key("graphProfiles").as_array()?;
    if graph_profiles.is_empty() {
        return Some("EMPTY_GRAPH_PROFILES");
    }
    if duplicate(graph_profiles) {
        return Some("DUPLICATE_GRAPH_PROFILES");
    }
    None
}

fn classify_error_set_rejection(document: &Value) -> Option<&'static str> {
    const ALLOWED: &[&str] = &["timeout", "crash", "malformed", "refusal"];
    let errors = document
        .assert_key("contract")
        .assert_key("errors")
        .as_array()?;
    if errors
        .iter()
        .any(|error| !error.as_str().is_some_and(|code| ALLOWED.contains(&code)))
    {
        return Some("UNKNOWN_WORKER_ERROR");
    }
    if errors.len() != RUNTIME_WORKER_ERRORS.len() || duplicate(errors) {
        return Some("INCOMPLETE_WORKER_ERRORS");
    }
    None
}

fn classify_artifact_profile_rejection(document: &Value) -> Option<&'static str> {
    if document
        .assert_key("artifactProfile")
        .assert_key("allowedTypeIds")
        .as_array()
        .is_some_and(Vec::is_empty)
    {
        return Some("EMPTY_ARTIFACT_TYPES");
    }
    None
}

fn classify_credential_rejection(document: &Value) -> Option<&'static str> {
    if document
        .assert_key("credentialRequirements")
        .as_array()
        .is_some_and(|values| duplicate(values))
    {
        return Some("DUPLICATE_CREDENTIAL_REQUIREMENTS");
    }
    None
}

fn classify_legacy_rejection(document: &Value) -> Option<&'static str> {
    let binding = &document.assert_key("binding");
    let legacy_identity = document.assert_key("worker") == LEGACY_ZEROSHOT_WORKER;
    let legacy_protocol = binding.assert_key("protocol") == "legacy_zeroshot";
    if legacy_identity || legacy_protocol {
        let expected_input =
            serde_json::to_value(legacy_ship_request_payload_type().assert_value()).assert_value();
        let expected_output =
            serde_json::to_value(legacy_ship_result_payload_type().assert_value()).assert_value();
        let expected_errors = serde_json::to_value(RUNTIME_WORKER_ERRORS).assert_value();
        let valid = [
            legacy_identity,
            legacy_protocol,
            document.assert_key("graphProfiles") == &json!(["openengine.graph.single-worker/v1"]),
            document.assert_key("contract").assert_key("input") == &expected_input,
            document.assert_key("contract").assert_key("output") == &expected_output,
            document
                .assert_key("contract")
                .assert_key("verifier")
                .is_null(),
            document.assert_key("contract").assert_key("errors") == &expected_errors,
        ]
        .into_iter()
        .all(std::convert::identity);
        if !valid {
            return Some("INVALID_LEGACY_BINDING");
        }
    }
    None
}

fn classify_builtin_rejection(document: &Value) -> Option<&'static str> {
    let is_builtin = document.assert_key("binding").assert_key("protocol") == "builtin";
    let has_credentials = document
        .assert_key("credentialRequirements")
        .as_array()
        .is_some_and(|values| !values.is_empty());
    (is_builtin && has_credentials).then_some("INVALID_BUILTIN_BINDING")
}

#[test]
fn descriptor_and_outcome_negative_vectors_have_exact_rejection_codes() {
    let schema = worker_schema();
    let descriptor_validator = jsonschema::validator_for(&schema).assert_value();
    let outcome_schema = component_schema(&schema, "WorkerOutcome");
    let outcome_validator = jsonschema::validator_for(&outcome_schema).assert_value();
    let mut descriptor_count = 0;
    let mut outcome_count = 0;

    for artifact in worker_fixture_artifacts()
        .into_iter()
        .filter(|artifact| artifact.relative_path.contains("/negative/"))
    {
        let fixture: Value = serde_json::from_slice(&artifact.bytes).assert_value();
        let expected = fixture.assert_key("expectedCode").as_str().assert_value();
        assert!(
            expected
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
        );
        match fixture.assert_key("fixtureKind").as_str().assert_value() {
            "descriptor" => {
                let document = fixture.assert_key("document");
                let rust_error = serde_json::from_value::<WorkerDescriptor>(document.clone())
                    .assert_error()
                    .to_string();
                assert!(!descriptor_validator.is_valid(document));
                assert_eq!(
                    classify_rust_descriptor_rejection(&rust_error),
                    Some(expected),
                    "wrong Rust code for {}: {rust_error}",
                    artifact.relative_path
                );
                assert_eq!(
                    classify_schema_descriptor_rejection(document),
                    Some(expected),
                    "wrong schema code for {}",
                    artifact.relative_path
                );
                descriptor_count += 1;
            }
            "outcome" => {
                let document = fixture.assert_key("document");
                let rust_error = serde_json::from_value::<WorkerOutcome>(document.clone())
                    .assert_error()
                    .to_string();
                assert!(rust_error.contains("code and failure reason are inconsistent"));
                assert_eq!(expected, "INVALID_FAILURE_PAIR");
                assert!(!outcome_validator.is_valid(document));
                outcome_count += 1;
            }
            "compatibility" => {}
            kind => None::<()>.assert_value_with(&format!("unknown worker fixture kind {kind}")),
        }
    }
    assert_eq!(descriptor_count, 22);
    assert_eq!(outcome_count, 3);
}

fn compatibility_code(code: WorkerCompatibilityCode) -> &'static str {
    const CODES: [&str; 10] = [
        "REGISTRY",
        "DESCRIPTOR_CONTRACT",
        "DESCRIPTOR_IDENTITY",
        "GRAPH_PROFILE",
        "INPUT",
        "OUTPUT",
        "VERIFIER_CONTRACT",
        "SIGNAL_FIELD",
        "SIGNAL_LABELS",
        "DIAGNOSTIC",
    ];
    CODES.get(code as usize).copied().unwrap_or("DIAGNOSTIC")
}

#[tokio::test]
async fn compatibility_vectors_execute_every_committed_variance_failure() {
    let mut count = 0;
    for artifact in worker_fixture_artifacts()
        .into_iter()
        .filter(|artifact| artifact.relative_path.contains("/negative/compatibility-"))
    {
        let fixture: Value = serde_json::from_slice(&artifact.bytes).assert_value();
        assert_eq!(fixture.assert_key("fixtureKind"), "compatibility");
        let graph: GraphSpec =
            serde_json::from_value(fixture.assert_key("graph").clone()).assert_value();
        assert_eq!(
            &serde_json::to_value(&graph).assert_value(),
            fixture.assert_key("graph")
        );
        let mut registry = BTreeMap::new();
        for entry in fixture.assert_key("registry").as_array().assert_value() {
            let descriptor: WorkerDescriptor =
                serde_json::from_value(entry.assert_key("descriptor").clone()).assert_value();
            assert_eq!(
                &serde_json::to_value(&descriptor).assert_value(),
                entry.assert_key("descriptor")
            );
            registry.insert(
                entry
                    .assert_key("requestedWorker")
                    .as_str()
                    .assert_value()
                    .to_owned(),
                entry.assert_key("descriptor").clone(),
            );
        }
        let diagnostics = check_graph_workers(&graph, &MemoryRegistry(registry))
            .await
            .assert_error();
        assert_eq!(
            diagnostics.len(),
            1,
            "extra failures in {}",
            artifact.relative_path
        );
        assert_eq!(
            compatibility_code(diagnostics.assert_at(0).code),
            fixture.assert_key("expectedCode"),
            "wrong compatibility code in {}",
            artifact.relative_path
        );
        count += 1;
    }
    assert_eq!(count, 6);
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertError, AssertSlice, AssertValue, JsonAt};
