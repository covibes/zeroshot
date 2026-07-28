//! Deterministic generated worker schemas and test-only conformance vectors.

use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, LegacyShipRequest,
    LegacyShipResult, WorkerDescriptor, WorkerOutcome, BUILTIN_PROFILE, BUILTIN_VERSION,
};
use schemars::schema_for;
use serde_json::{json, Value};

use crate::artifacts::Artifact;
use crate::schema_helpers::merge_schema;

const ROOT: &str = "protocol/openengine-cluster/v1";

#[must_use]
pub fn worker_schema() -> Value {
    let mut root = serde_json::to_value(schema_for!(WorkerDescriptor)).unwrap();
    for (name, component) in [
        (
            "WorkerOutcome",
            serde_json::to_value(schema_for!(WorkerOutcome)).unwrap(),
        ),
        (
            "LegacyShipRequest",
            serde_json::to_value(schema_for!(LegacyShipRequest)).unwrap(),
        ),
        (
            "LegacyShipResult",
            serde_json::to_value(schema_for!(LegacyShipResult)).unwrap(),
        ),
    ] {
        merge_schema(&mut root, name, component);
    }
    root
}

#[must_use]
pub fn with_worker_components(mut document: Value) -> Value {
    let schemas = document["components"]["schemas"]
        .as_object_mut()
        .expect("OpenRPC components.schemas must be an object");
    for (name, schema) in [
        ("WorkerDescriptor", json!({ "$ref": "worker.schema.json" })),
        (
            "WorkerOutcome",
            json!({ "$ref": "worker.schema.json#/$defs/WorkerOutcome" }),
        ),
        (
            "LegacyShipRequest",
            json!({ "$ref": "worker.schema.json#/$defs/LegacyShipRequest" }),
        ),
        (
            "LegacyShipResult",
            json!({ "$ref": "worker.schema.json#/$defs/LegacyShipResult" }),
        ),
    ] {
        schemas.insert(name.to_owned(), schema);
    }
    document
}

#[must_use]
pub fn worker_fixture_artifacts() -> Vec<Artifact> {
    let acp = descriptor("mock.acp@1", "acp", "1", "openengine.worker.acp/v1");
    let a2a = descriptor("mock.a2a@1", "a2a", "1.0", "openengine.worker.a2a/1.0");
    let mut legacy = descriptor(
        "legacy.zeroshot.ship@1",
        "legacy_zeroshot",
        "1",
        "legacy.zeroshot.ship/v1",
    );
    legacy["graphProfiles"] = json!(["openengine.graph.single-worker/v1"]);
    legacy["contract"]["input"] = serde_json::to_value(legacy_ship_request_payload_type()).unwrap();
    legacy["contract"]["output"] = serde_json::to_value(legacy_ship_result_payload_type()).unwrap();
    let mut builtin = descriptor(
        "mock.builtin@1",
        "builtin",
        BUILTIN_VERSION,
        BUILTIN_PROFILE,
    );
    builtin["credentialRequirements"] = json!([]);

    let mut artifacts =
        positive_worker_artifacts(acp.clone(), a2a, legacy.clone(), builtin.clone());
    artifacts.extend(negative_contract_artifacts(&acp, &legacy, &builtin));
    artifacts.extend(negative_secret_artifacts(&acp));
    artifacts.extend(negative_outcome_artifacts());
    artifacts.extend(compatibility_artifacts(&acp));
    artifacts
}

fn positive_worker_artifacts(
    acp: Value,
    a2a: Value,
    legacy: Value,
    builtin: Value,
) -> Vec<Artifact> {
    vec![
        json_artifact("positive/acp-v1.json", acp.clone()),
        json_artifact("positive/a2a-1.0.json", a2a),
        json_artifact("positive/legacy-zeroshot-ship-v1.json", legacy),
        json_artifact("positive/builtin-v1.json", builtin.clone()),
        json_artifact(
            "positive/policy-refusal.json",
            json!({
                "status": "error", "code": "refusal", "reason": "policy_denied"
            }),
        ),
        json_artifact(
            "positive/artifact-receipt.json",
            json!({
                "artifactId": "worker-result", "sha256": "a".repeat(64), "byteLength": 42,
                "mediaType": "application/json", "typeId": "openengine.result@1",
                "producer": { "node": "worker", "worker": "mock.acp@1" },
                "lineage": { "generation": 1, "runId": "run-1", "attempt": 1 },
                "redaction": "internal"
            }),
        ),
        json_artifact(
            "mock/acp-input-request.json",
            json!({
                "profile": "openengine.worker.acp/v1", "version": "1",
                "normalized": { "status": "error", "code": "refusal", "reason": "interactive_input_required" }
            }),
        ),
        json_artifact(
            "mock/a2a-auth-required.json",
            json!({
                "profile": "openengine.worker.a2a/1.0", "version": "1.0",
                "normalized": { "status": "error", "code": "refusal", "reason": "authentication_required" }
            }),
        ),
    ]
}

fn negative_contract_artifacts(acp: &Value, legacy: &Value, builtin: &Value) -> Vec<Artifact> {
    let mut artifacts = negative_descriptor_artifacts(
        acp,
        vec![
            (
                "unsupported-version",
                "UNSUPPORTED_WORKER_BINDING",
                "/binding/version",
                json!("2"),
            ),
            (
                "empty-profiles",
                "EMPTY_GRAPH_PROFILES",
                "/graphProfiles",
                json!([]),
            ),
            (
                "duplicate-profiles",
                "DUPLICATE_GRAPH_PROFILES",
                "/graphProfiles",
                json!(["openengine.graph.full/v1", "openengine.graph.full/v1"]),
            ),
            (
                "unknown-error",
                "UNKNOWN_WORKER_ERROR",
                "/contract/errors",
                json!(["unknown"]),
            ),
            (
                "empty-artifact-types",
                "EMPTY_ARTIFACT_TYPES",
                "/artifactProfile/allowedTypeIds",
                json!([]),
            ),
            (
                "missing-runtime-error",
                "INCOMPLETE_WORKER_ERRORS",
                "/contract/errors",
                json!(["timeout", "crash", "malformed"]),
            ),
            (
                "duplicate-credentials",
                "DUPLICATE_CREDENTIAL_REQUIREMENTS",
                "/credentialRequirements",
                json!(["credential.test@1", "credential.test@1"]),
            ),
        ],
    );
    artifacts.extend(negative_descriptor_artifacts(
        legacy,
        vec![
            (
                "legacy-wrong-worker",
                "INVALID_LEGACY_BINDING",
                "/worker",
                json!("mock.legacy@1"),
            ),
            (
                "legacy-wrong-profile",
                "INVALID_LEGACY_BINDING",
                "/graphProfiles",
                json!(["openengine.graph.full/v1"]),
            ),
            (
                "legacy-wrong-contract",
                "INVALID_LEGACY_BINDING",
                "/contract/output",
                json!({ "kind": "string" }),
            ),
        ],
    ));
    artifacts.extend(negative_descriptor_artifacts(
        builtin,
        vec![
            (
                "builtin-wrong-version",
                "UNSUPPORTED_WORKER_BINDING",
                "/binding/version",
                json!("2"),
            ),
            (
                "builtin-wrong-profile",
                "UNSUPPORTED_WORKER_BINDING",
                "/binding/profile",
                json!("openengine.worker.builtin/v2"),
            ),
            (
                "builtin-nonempty-credentials",
                "INVALID_BUILTIN_BINDING",
                "/credentialRequirements",
                json!(["credential.test@1"]),
            ),
        ],
    ));
    artifacts
}

fn negative_secret_artifacts(acp: &Value) -> Vec<Artifact> {
    negative_descriptor_artifacts(
        acp,
        vec![
            ("command", "FORBIDDEN_FIELD", "/command", json!("execute")),
            (
                "endpoint",
                "FORBIDDEN_FIELD",
                "/endpoint",
                json!("https://example.invalid"),
            ),
            (
                "credential-value",
                "FORBIDDEN_FIELD",
                "/credentialValue",
                json!("secret"),
            ),
            (
                "bearer-token",
                "FORBIDDEN_FIELD",
                "/bearerToken",
                json!("secret"),
            ),
            ("api-token", "FORBIDDEN_FIELD", "/apiToken", json!("secret")),
            (
                "signed-url",
                "FORBIDDEN_FIELD",
                "/signedUrl",
                json!("https://signed.invalid"),
            ),
            ("inline-bytes", "FORBIDDEN_FIELD", "/bytes", json!("AA==")),
            (
                "filesystem-path",
                "FORBIDDEN_FIELD",
                "/path",
                json!("/tmp/secret"),
            ),
            (
                "callback",
                "FORBIDDEN_FIELD",
                "/callback",
                json!("prompt-user"),
            ),
        ],
    )
}

fn negative_descriptor_artifacts(
    base: &Value,
    vectors: Vec<(&str, &str, &str, Value)>,
) -> Vec<Artifact> {
    vectors
        .into_iter()
        .map(|(name, expected_code, pointer, replacement)| {
            let mut document = base.clone();
            set_pointer(&mut document, pointer, replacement);
            json_artifact(
                &format!("negative/{name}.json"),
                json!({
                    "fixtureKind": "descriptor",
                    "expectedCode": expected_code,
                    "document": document
                }),
            )
        })
        .collect()
}

fn negative_outcome_artifacts() -> Vec<Artifact> {
    [
        (
            "timeout-policy-reason",
            json!({ "status": "error", "code": "timeout", "reason": "policy_denied" }),
        ),
        (
            "malformed-auth-reason",
            json!({
                "status": "error", "code": "malformed", "reason": "authentication_required"
            }),
        ),
        (
            "refusal-malformed-reason",
            json!({ "status": "error", "code": "refusal", "reason": "malformed_result" }),
        ),
    ]
    .into_iter()
    .map(|(name, document)| {
        json_artifact(
            &format!("negative/{name}.json"),
            json!({
                "fixtureKind": "outcome",
                "expectedCode": "INVALID_FAILURE_PAIR",
                "document": document
            }),
        )
    })
    .collect()
}

fn compatibility_artifacts(acp: &Value) -> Vec<Artifact> {
    let step_graph = compatibility_graph(false);
    let verifier_graph = compatibility_graph(true);
    let mut step = acp.clone();
    step["contract"]["input"] = json!({ "kind": "number" });
    step["contract"]["output"] = json!({ "kind": "integer" });
    let mut verifier = step.clone();
    verifier["worker"] = json!("mock.verifier@1");
    verifier["contract"]["verifier"] = json!({
        "signals": { "verdict": ["accepted"] },
        "diagnostic": { "kind": "integer" }
    });

    let cases = [
        (
            "compatibility-input",
            "INPUT",
            step_graph.clone(),
            mutate(&step, "/contract/input", json!({ "kind": "string" })),
        ),
        (
            "compatibility-output",
            "OUTPUT",
            step_graph.clone(),
            mutate(&step, "/contract/output", json!({ "kind": "string" })),
        ),
        (
            "compatibility-step-verifier",
            "VERIFIER_CONTRACT",
            step_graph,
            mutate(
                &step,
                "/contract/verifier",
                json!({
                    "signals": { "verdict": ["accepted"] },
                    "diagnostic": { "kind": "integer" }
                }),
            ),
        ),
        (
            "compatibility-signal-field",
            "SIGNAL_FIELD",
            verifier_graph.clone(),
            mutate(
                &verifier,
                "/contract/verifier/signals",
                json!({ "missing": ["accepted"] }),
            ),
        ),
        (
            "compatibility-signal-labels",
            "SIGNAL_LABELS",
            verifier_graph.clone(),
            mutate(
                &verifier,
                "/contract/verifier/signals",
                json!({ "verdict": ["undeclared"] }),
            ),
        ),
        (
            "compatibility-diagnostic",
            "DIAGNOSTIC",
            verifier_graph,
            mutate(
                &verifier,
                "/contract/verifier/diagnostic",
                json!({ "kind": "string" }),
            ),
        ),
    ];

    cases
        .into_iter()
        .map(|(name, expected_code, graph, descriptor)| {
            let requested_worker = graph["root"]["worker"].clone();
            json_artifact(
                &format!("negative/{name}.json"),
                json!({
                    "fixtureKind": "compatibility",
                    "expectedCode": expected_code,
                    "graph": graph,
                    "registry": [{
                        "requestedWorker": requested_worker,
                        "descriptor": descriptor
                    }]
                }),
            )
        })
        .collect()
}

fn compatibility_graph(verifier: bool) -> Value {
    let worker = if verifier {
        "mock.verifier@1"
    } else {
        "mock.acp@1"
    };
    let mut root = json!({
        "kind": if verifier { "verifier" } else { "step" },
        "name": if verifier { "verify" } else { "work" },
        "worker": worker,
        "input": { "kind": "integer" },
        "output": { "kind": "number" },
        "inputBindings": [],
        "writeBindings": [],
        "timeoutMs": 10,
        "attempts": 1
    });
    if verifier {
        root["signals"] = json!({ "verdict": ["accepted", "rejected"] });
        root["diagnostic"] = json!({ "kind": "number" });
    }
    json!({
        "profile": "openengine.graph.full/v1",
        "initialInput": { "kind": "null" },
        "policy": { "policy": "policy.strict@1", "default": "deny" },
        "root": root
    })
}

fn mutate(base: &Value, pointer: &str, replacement: Value) -> Value {
    let mut value = base.clone();
    set_pointer(&mut value, pointer, replacement);
    value
}

fn descriptor(worker: &str, protocol: &str, version: &str, profile: &str) -> Value {
    json!({
        "worker": worker,
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": { "protocol": protocol, "version": version, "profile": profile },
        "contract": { "input": { "kind": "string" }, "output": { "kind": "string" },
            "verifier": null, "errors": ["timeout", "crash", "malformed", "refusal"] },
        "capabilityPolicy": { "autonomy": "strict", "permissionPolicy": "policy.strict@1" },
        "artifactProfile": { "allowedTypeIds": ["openengine.result@1"],
            "allowedMediaTypes": ["application/json"], "minimumRedaction": "internal" },
        "credentialRequirements": ["credential.test@1"]
    })
}

fn set_pointer(document: &mut Value, pointer: &str, value: Value) {
    let mut segments = pointer.strip_prefix('/').unwrap().split('/').peekable();
    let mut current = document;
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            current[segment] = value;
            return;
        }
        current = &mut current[segment];
    }
}

fn json_artifact(suffix: &str, value: Value) -> Artifact {
    let mut bytes = serde_json::to_vec_pretty(&value).unwrap();
    bytes.push(b'\n');
    Artifact {
        relative_path: format!("{ROOT}/fixtures/workers/{suffix}"),
        bytes,
    }
}
