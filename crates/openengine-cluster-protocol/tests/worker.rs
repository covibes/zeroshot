#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/json_insert.rs"]
mod json_insert;

#[path = "support/json_mut.rs"]
mod json_mut;

#[path = "support/json_read.rs"]
mod json_read;

use assert_value::AssertValue;
use openengine_cluster_protocol::{
    legacy_ship_request_payload_type, legacy_ship_result_payload_type, GraphProfile,
    LegacyShipRequest, WorkerDescriptor, WorkerFailureReason, WorkerOutcome, WorkerProtocolBinding,
    ACP_PROFILE, ACP_VERSION, BUILTIN_PROFILE, BUILTIN_VERSION, LEGACY_ZEROSHOT_WORKER,
    RUNTIME_WORKER_ERRORS,
};
use serde_json::json;

fn descriptor() -> serde_json::Value {
    json!({
        "worker": "mock.acp@1",
        "graphProfiles": ["openengine.graph.full/v1"],
        "binding": { "protocol": "acp", "version": ACP_VERSION, "profile": ACP_PROFILE },
        "contract": {
            "input": { "kind": "string" },
            "output": { "kind": "string" },
            "verifier": null,
            "errors": ["timeout", "crash", "malformed", "refusal"]
        },
        "capabilityPolicy": {
            "autonomy": "strict",
            "permissionPolicy": "policy.strict@1"
        },
        "artifactProfile": {
            "allowedTypeIds": ["openengine.result@1"],
            "allowedMediaTypes": ["application/json"],
            "minimumRedaction": "internal"
        },
        "credentialRequirements": ["credential.mock@1"]
    })
}

fn descriptor_validator() -> jsonschema::Validator {
    let schema = serde_json::to_value(schemars::schema_for!(WorkerDescriptor)).assert_value();
    jsonschema::validator_for(&schema).assert_value()
}

fn assert_valid_descriptor(value: &serde_json::Value, validator: &jsonschema::Validator) {
    assert!(serde_json::from_value::<WorkerDescriptor>(value.clone()).is_ok());
    assert!(validator.is_valid(value));
}

fn assert_invalid_descriptor(value: &serde_json::Value, validator: &jsonschema::Validator) {
    assert!(serde_json::from_value::<WorkerDescriptor>(value.clone()).is_err());
    assert!(!validator.is_valid(value));
}

fn assert_descriptor_mutations_rejected(
    base: &serde_json::Value,
    validator: &jsonschema::Validator,
    mutations: impl IntoIterator<Item = (&'static str, serde_json::Value)>,
) {
    for (pointer, replacement) in mutations {
        let mut invalid = base.clone();
        *json_mut::json_at_mut(&mut invalid, pointer) = replacement;
        assert_invalid_descriptor(&invalid, validator);
    }
}

fn legacy_descriptor() -> serde_json::Value {
    let mut legacy = descriptor();
    *json_mut::json_at_mut(&mut legacy, "/worker") = json!(LEGACY_ZEROSHOT_WORKER);
    *json_mut::json_at_mut(&mut legacy, "/graphProfiles") =
        json!([GraphProfile::SingleWorker.as_str()]);
    *json_mut::json_at_mut(&mut legacy, "/binding") =
        serde_json::to_value(WorkerProtocolBinding::legacy_zeroshot_ship_v1()).assert_value();
    *json_mut::json_at_mut(&mut legacy, "/contract/input") =
        serde_json::to_value(legacy_ship_request_payload_type().assert_value()).assert_value();
    *json_mut::json_at_mut(&mut legacy, "/contract/output") =
        serde_json::to_value(legacy_ship_result_payload_type().assert_value()).assert_value();
    legacy
}

#[test]
fn bindings_are_exact_and_descriptor_fields_are_closed() {
    let validator = descriptor_validator();
    assert_valid_descriptor(&descriptor(), &validator);

    for (field, value) in [
        ("command", json!("curl example")),
        ("endpoint", json!("https://example.invalid")),
        ("token", json!("secret")),
        ("credentialValue", json!("secret")),
        ("callback", json!("ask-user")),
        ("path", json!("/tmp/secret")),
    ] {
        let mut rejected = descriptor();
        json_insert::json_insert(&mut rejected, "", field, value);
        assert_invalid_descriptor(&rejected, &validator);
    }

    let mut unsupported = descriptor();
    *json_mut::json_at_mut(&mut unsupported, "/binding/version") = json!("2");
    assert_invalid_descriptor(&unsupported, &validator);
    assert_eq!(WorkerProtocolBinding::acp_v1().version, ACP_VERSION);
}

#[test]
fn descriptor_rejects_empty_duplicate_sets_and_nonopaque_handles() {
    let validator = descriptor_validator();
    assert_descriptor_mutations_rejected(
        &descriptor(),
        &validator,
        [
            ("/graphProfiles", json!([])),
            ("/contract/errors", json!([])),
            ("/artifactProfile/allowedTypeIds", json!([])),
        ],
    );
    let mut duplicate = descriptor();
    *json_mut::json_at_mut(&mut duplicate, "/graphProfiles") =
        json!(["openengine.graph.full/v1", "openengine.graph.full/v1"]);
    assert_invalid_descriptor(&duplicate, &validator);

    let mut duplicate_credentials = descriptor();
    *json_mut::json_at_mut(&mut duplicate_credentials, "/credentialRequirements") =
        json!(["credential.mock@1", "credential.mock@1"]);
    assert_invalid_descriptor(&duplicate_credentials, &validator);

    let mut incomplete_errors = descriptor();
    *json_mut::json_at_mut(&mut incomplete_errors, "/contract/errors") =
        json!(["timeout", "crash", "malformed"]);
    assert_invalid_descriptor(&incomplete_errors, &validator);

    for handle in ["raw-token", "env/API_TOKEN", "https://credentials.invalid"] {
        let mut rejected = descriptor();
        *json_mut::json_at_mut(&mut rejected, "/credentialRequirements") = json!([handle]);
        assert_invalid_descriptor(&rejected, &validator);
    }
}

#[test]
fn descriptor_schema_matches_legacy_cross_field_validation() {
    let validator = descriptor_validator();
    let legacy = legacy_descriptor();
    assert_valid_descriptor(&legacy, &validator);

    assert_descriptor_mutations_rejected(
        &legacy,
        &validator,
        [
            ("/worker", json!("wrong.legacy@1")),
            ("/graphProfiles", json!([GraphProfile::Full.as_str()])),
            ("/contract/input", json!({ "kind": "string" })),
            ("/contract/output", json!({ "kind": "string" })),
            (
                "/contract/errors",
                json!(["crash", "timeout", "malformed", "refusal"]),
            ),
        ],
    );

    let mut mismatched_identity = descriptor();
    *json_mut::json_at_mut(&mut mismatched_identity, "/worker") = json!(LEGACY_ZEROSHOT_WORKER);
    assert_invalid_descriptor(&mismatched_identity, &validator);
}

#[test]
fn builtin_binding_round_trips_and_rejects_invalid_variants() {
    let mut builtin = descriptor();
    *json_mut::json_at_mut(&mut builtin, "/worker") = json!("mock.builtin@1");
    *json_mut::json_at_mut(&mut builtin, "/binding") =
        serde_json::to_value(WorkerProtocolBinding::builtin_v1()).assert_value();
    *json_mut::json_at_mut(&mut builtin, "/credentialRequirements") = json!([]);

    let validator = descriptor_validator();
    assert_valid_descriptor(&builtin, &validator);

    assert_descriptor_mutations_rejected(
        &builtin,
        &validator,
        [
            ("/binding/version", json!("2")),
            ("/binding/profile", json!("openengine.worker.builtin/v2")),
            ("/credentialRequirements", json!(["credential.mock@1"])),
        ],
    );

    assert_eq!(WorkerProtocolBinding::builtin_v1().version, BUILTIN_VERSION);
    assert_eq!(WorkerProtocolBinding::builtin_v1().profile, BUILTIN_PROFILE);
}

#[test]
fn strict_autonomy_has_only_typed_fail_closed_outcomes() {
    for (outcome, reason) in [
        (WorkerOutcome::policy_refusal(), "policy_denied"),
        (
            WorkerOutcome::interactive_refusal(),
            "interactive_input_required",
        ),
        (
            WorkerOutcome::authentication_refusal(),
            "authentication_required",
        ),
    ] {
        let value = serde_json::to_value(outcome).assert_value();
        assert_eq!(
            json_read::json_at(&value, "/status")
                .as_str()
                .assert_value(),
            "error"
        );
        assert_eq!(
            json_read::json_at(&value, "/code").as_str().assert_value(),
            "refusal"
        );
        assert_eq!(
            json_read::json_at(&value, "/reason")
                .as_str()
                .assert_value(),
            reason
        );
        assert!(value.get("callback").is_none());
    }
    let malformed = serde_json::to_value(WorkerOutcome::malformed()).assert_value();
    assert_eq!(
        json_read::json_at(&malformed, "/code")
            .as_str()
            .assert_value(),
        "malformed"
    );

    let schema = serde_json::to_value(schemars::schema_for!(WorkerOutcome)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();
    for code in RUNTIME_WORKER_ERRORS {
        let outcome = WorkerOutcome::declared_failure(code);
        let value = serde_json::to_value(&outcome).assert_value();
        assert!(validator.is_valid(&value));
        assert_eq!(
            serde_json::from_value::<WorkerOutcome>(value).assert_value(),
            outcome
        );
    }
    for invalid in [
        json!({ "status": "error", "code": "timeout", "reason": "policy_denied" }),
        json!({ "status": "error", "code": "malformed", "reason": "authentication_required" }),
        json!({ "status": "error", "code": "refusal", "reason": "malformed_result" }),
    ] {
        assert!(serde_json::from_value::<WorkerOutcome>(invalid.clone()).is_err());
        assert!(!validator.is_valid(&invalid));
    }

    let invalid_rust_value = WorkerOutcome::Error {
        code: openengine_cluster_protocol::WorkerErrorCode::Timeout,
        reason: WorkerFailureReason::PolicyDenied,
    };
    assert!(serde_json::to_value(invalid_rust_value).is_err());
}

#[test]
fn legacy_ship_contract_is_single_worker_and_source_consistent() {
    let legacy = legacy_descriptor();
    let validator = descriptor_validator();
    assert_valid_descriptor(&legacy, &validator);
    assert_descriptor_mutations_rejected(
        &legacy,
        &validator,
        [
            ("/contract/input", json!({ "kind": "string" })),
            ("/contract/output", json!({ "kind": "string" })),
            (
                "/contract/errors",
                json!(["crash", "timeout", "malformed", "refusal"]),
            ),
            ("/graphProfiles", json!([GraphProfile::Full.as_str()])),
        ],
    );

    let base = json!({
        "source": "issue",
        "issue": "649",
        "prompt": null,
        "artifacts": [],
        "isolationProfile": "isolation.worktree@1",
        "providerProfile": "provider.default@1",
        "repository": "the-open-engine/zeroshot",
        "provider": "codex",
        "modelLevel": "level2"
    });
    assert!(serde_json::from_value::<LegacyShipRequest>(base.clone()).is_ok());
    let mut inconsistent = base;
    *json_mut::json_at_mut(&mut inconsistent, "/prompt") = json!("also prompt");
    assert!(serde_json::from_value::<LegacyShipRequest>(inconsistent.clone()).is_err());
    let schema = serde_json::to_value(schemars::schema_for!(LegacyShipRequest)).assert_value();
    assert!(
        !jsonschema::validator_for(&schema)
            .assert_value()
            .is_valid(&inconsistent)
    );

    let errors = serde_json::from_value::<WorkerDescriptor>(descriptor())
        .assert_value()
        .contract
        .errors;
    assert_eq!(errors, RUNTIME_WORKER_ERRORS);
}
