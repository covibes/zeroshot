use std::collections::BTreeSet;

use openengine_cluster_protocol::{
    DomainErrorData, JsonRpcError, APPLICATION_ERROR, CANCELLED, GENERATION_CONFLICT, GONE,
    GRAPH_INVALID, IDEMPOTENCY_REUSE, INTERNAL_ERROR, INTERNAL_ERROR_CODE, INVALID_PARAMS,
    INVALID_PHASE, INVALID_REQUEST, METHOD_NOT_FOUND, NOT_FOUND, NO_RETRYABLE_FRONTIER,
    PARSE_ERROR, RUN_CONFLICT, SCHEMA_VIOLATION, SLOW_CONSUMER, UNSUPPORTED_PROTOCOL_VERSION,
};
use openengine_cluster_server::{BackendError, BackendErrorKind, SERVER_BUSY};
use serde_json::{json, Value};
use zeroshot_engine::fault::{
    EvidenceClass, FaultContext, FaultFactory, FaultModule, ModuleEvidence, RawDiagnostic,
    RedactionMarker,
};
use zeroshot_engine::observability::NoopObservationSink;
use zeroshot_engine::product_errors::{
    DaemonControlStatus, ProductError, ProductErrorAction, ProductErrorCode,
    ProductErrorProjectionError, MAX_PRODUCT_ERROR_ACTION_BYTES, MAX_PRODUCT_ERROR_JSON_BYTES,
    MAX_PRODUCT_ERROR_MESSAGE_BYTES, MAX_PRODUCT_ERROR_TEXT_BYTES,
};

const ENGINE_CASES: [(EvidenceClass, ProductErrorCode, u8, DaemonControlStatus); 10] = [
    (
        EvidenceClass::Unavailable,
        ProductErrorCode::Unavailable,
        6,
        DaemonControlStatus::Unavailable,
    ),
    (
        EvidenceClass::ResourceExhausted,
        ProductErrorCode::ResourceExhausted,
        6,
        DaemonControlStatus::ResourceExhausted,
    ),
    (
        EvidenceClass::Timeout,
        ProductErrorCode::Timeout,
        6,
        DaemonControlStatus::DeadlineExceeded,
    ),
    (
        EvidenceClass::PermissionDenied,
        ProductErrorCode::PermissionDenied,
        5,
        DaemonControlStatus::PermissionDenied,
    ),
    (
        EvidenceClass::AuthenticationRequired,
        ProductErrorCode::AuthenticationRequired,
        5,
        DaemonControlStatus::Unauthenticated,
    ),
    (
        EvidenceClass::MalformedExternalData,
        ProductErrorCode::MalformedExternalData,
        1,
        DaemonControlStatus::InvalidArgument,
    ),
    (
        EvidenceClass::IntegrityFailure,
        ProductErrorCode::IntegrityFailure,
        1,
        DaemonControlStatus::Internal,
    ),
    (
        EvidenceClass::ProcessExited,
        ProductErrorCode::ProcessExited,
        1,
        DaemonControlStatus::Unavailable,
    ),
    (
        EvidenceClass::SessionLost,
        ProductErrorCode::SessionLost,
        1,
        DaemonControlStatus::Internal,
    ),
    (
        EvidenceClass::InvariantViolation,
        ProductErrorCode::InvariantViolation,
        1,
        DaemonControlStatus::Internal,
    ),
];

const PROTOCOL_CASES: [(&str, ProductErrorCode, u8, DaemonControlStatus); 14] = [
    (
        GRAPH_INVALID,
        ProductErrorCode::InvalidInput,
        2,
        DaemonControlStatus::InvalidArgument,
    ),
    (
        SCHEMA_VIOLATION,
        ProductErrorCode::InvalidInput,
        2,
        DaemonControlStatus::InvalidArgument,
    ),
    (
        GENERATION_CONFLICT,
        ProductErrorCode::GenerationConflict,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        RUN_CONFLICT,
        ProductErrorCode::RunConflict,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        IDEMPOTENCY_REUSE,
        ProductErrorCode::IdempotencyConflict,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        INVALID_PHASE,
        ProductErrorCode::InvalidState,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        NO_RETRYABLE_FRONTIER,
        ProductErrorCode::InvalidState,
        4,
        DaemonControlStatus::Conflict,
    ),
    (
        CANCELLED,
        ProductErrorCode::Cancelled,
        6,
        DaemonControlStatus::Cancelled,
    ),
    (
        NOT_FOUND,
        ProductErrorCode::NotFound,
        3,
        DaemonControlStatus::NotFound,
    ),
    (
        GONE,
        ProductErrorCode::Gone,
        3,
        DaemonControlStatus::NotFound,
    ),
    (
        SLOW_CONSUMER,
        ProductErrorCode::SlowConsumer,
        6,
        DaemonControlStatus::ResourceExhausted,
    ),
    (
        SERVER_BUSY,
        ProductErrorCode::ResourceExhausted,
        6,
        DaemonControlStatus::ResourceExhausted,
    ),
    (
        UNSUPPORTED_PROTOCOL_VERSION,
        ProductErrorCode::UnsupportedCapability,
        7,
        DaemonControlStatus::Unsupported,
    ),
    (
        INTERNAL_ERROR_CODE,
        ProductErrorCode::Internal,
        1,
        DaemonControlStatus::Internal,
    ),
];

const EXPECTED_SEMANTICS: [(ProductErrorCode, &str, ProductErrorAction); 21] = [
    (
        ProductErrorCode::Unavailable,
        "A required engine resource is unavailable.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::ResourceExhausted,
        "A required engine resource is exhausted.",
        ProductErrorAction::FreeResources,
    ),
    (
        ProductErrorCode::Timeout,
        "A native engine operation timed out.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::PermissionDenied,
        "A required engine permission was denied.",
        ProductErrorAction::GrantPermission,
    ),
    (
        ProductErrorCode::AuthenticationRequired,
        "Authentication is required for a native engine operation.",
        ProductErrorAction::Authenticate,
    ),
    (
        ProductErrorCode::MalformedExternalData,
        "External data did not satisfy the native engine contract.",
        ProductErrorAction::RepairInput,
    ),
    (
        ProductErrorCode::IntegrityFailure,
        "Native engine integrity verification failed.",
        ProductErrorAction::ContactSupport,
    ),
    (
        ProductErrorCode::ProcessExited,
        "A required native process exited unexpectedly.",
        ProductErrorAction::RestartOperation,
    ),
    (
        ProductErrorCode::SessionLost,
        "A lost native engine session terminated the affected execution.",
        ProductErrorAction::ContactSupport,
    ),
    (
        ProductErrorCode::InvariantViolation,
        "A native engine invariant was violated.",
        ProductErrorAction::ContactSupport,
    ),
    (
        ProductErrorCode::InvalidInput,
        "The request did not satisfy the product contract.",
        ProductErrorAction::RepairInput,
    ),
    (
        ProductErrorCode::UnsupportedCapability,
        "The requested capability is not supported.",
        ProductErrorAction::UseSupportedCapability,
    ),
    (
        ProductErrorCode::GenerationConflict,
        "The cluster generation changed before the request was applied.",
        ProductErrorAction::RefreshState,
    ),
    (
        ProductErrorCode::RunConflict,
        "The active run changed before the request was applied.",
        ProductErrorAction::RefreshState,
    ),
    (
        ProductErrorCode::IdempotencyConflict,
        "The idempotency key was already used for another request.",
        ProductErrorAction::UseNewIdempotencyKey,
    ),
    (
        ProductErrorCode::InvalidState,
        "The requested operation is not valid in the current state.",
        ProductErrorAction::RefreshState,
    ),
    (
        ProductErrorCode::Cancelled,
        "The requested operation was cancelled.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::NotFound,
        "The requested product resource was not found.",
        ProductErrorAction::VerifyReference,
    ),
    (
        ProductErrorCode::Gone,
        "The requested product resource is no longer available.",
        ProductErrorAction::StartNewOperation,
    ),
    (
        ProductErrorCode::SlowConsumer,
        "The control consumer exceeded its bounded delivery capacity.",
        ProductErrorAction::RetryLater,
    ),
    (
        ProductErrorCode::Internal,
        "The native product could not complete the operation.",
        ProductErrorAction::ContactSupport,
    ),
];

fn factory() -> FaultFactory<'static> {
    static SINK: NoopObservationSink = NoopObservationSink;
    FaultFactory::new(&SINK)
}

fn protocol_error(domain_code: &str, diagnostic: &str) -> JsonRpcError {
    JsonRpcError {
        code: APPLICATION_ERROR,
        message: diagnostic.to_owned(),
        data: Some(DomainErrorData {
            code: domain_code.to_owned(),
            details: Some(json!({
                "diagnostic": diagnostic,
                "path": "/home/private/project",
                "url": "https://user:credential@example.invalid/control",
                "command": ["provider", "--session", "secret-session"],
                "stderr": "Bearer secret-token"
            })),
        }),
    }
}

fn all_products() -> Vec<ProductError> {
    let mut products = ENGINE_CASES
        .into_iter()
        .map(|(class, _, _, _)| {
            let fault = factory().create(ModuleEvidence::new(
                FaultModule::Provider,
                FaultContext::Execution,
                class,
            ));
            ProductError::from_engine_fault(&fault).unwrap()
        })
        .collect::<Vec<_>>();
    products.extend(PROTOCOL_CASES.into_iter().map(|(domain, _, _, _)| {
        ProductError::from_protocol_error(&protocol_error(domain, "discarded diagnostic")).unwrap()
    }));
    products
}

#[test]
fn every_engine_category_has_a_causal_product_mapping() {
    for (class, code, exit, daemon_status) in ENGINE_CASES {
        let fault = factory().create(ModuleEvidence::new(
            FaultModule::Provider,
            FaultContext::Execution,
            class,
        ));
        let projected = ProductError::from_engine_fault(&fault).unwrap();
        assert_eq!(projected.code(), code, "{class:?}");
        assert_eq!(projected.exit_status(), exit, "{class:?}");
        assert_eq!(projected.daemon_status(), daemon_status, "{class:?}");
        assert_eq!(projected.daemon_control().code(), code);
        assert_eq!(projected.daemon_control().message(), projected.message());
        assert_eq!(projected.daemon_control().action(), projected.action());
    }
}

#[test]
fn every_authoritative_protocol_domain_category_has_a_causal_mapping() {
    for (domain, code, exit, daemon_status) in PROTOCOL_CASES {
        let projected =
            ProductError::from_protocol_error(&protocol_error(domain, "private")).unwrap();
        assert_eq!(projected.code(), code, "{domain}");
        assert_eq!(projected.exit_status(), exit, "{domain}");
        assert_eq!(projected.daemon_status(), daemon_status, "{domain}");
        assert_eq!(projected.daemon_control().status(), daemon_status);
    }
}

#[test]
fn json_rpc_validation_and_capability_categories_are_closed() {
    for numeric_code in [PARSE_ERROR, INVALID_REQUEST, INVALID_PARAMS] {
        let error = JsonRpcError {
            code: numeric_code,
            message: "discard me".to_owned(),
            data: None,
        };
        assert_eq!(
            ProductError::from_protocol_error(&error).unwrap().code(),
            ProductErrorCode::InvalidInput
        );
    }
    let method = JsonRpcError {
        code: METHOD_NOT_FOUND,
        message: "private method name".to_owned(),
        data: None,
    };
    assert_eq!(
        ProductError::from_protocol_error(&method).unwrap().code(),
        ProductErrorCode::UnsupportedCapability
    );
    let internal = JsonRpcError {
        code: INTERNAL_ERROR,
        message: "private provider failure".to_owned(),
        data: None,
    };
    assert_eq!(
        ProductError::from_protocol_error(&internal).unwrap().code(),
        ProductErrorCode::Internal
    );

    for error in [
        JsonRpcError {
            code: APPLICATION_ERROR,
            message: "missing category".to_owned(),
            data: None,
        },
        protocol_error("FUTURE_PRIVATE_CATEGORY", "private"),
        JsonRpcError {
            code: -31_234,
            message: "unknown numeric".to_owned(),
            data: None,
        },
    ] {
        assert_eq!(
            ProductError::from_protocol_error(&error),
            Err(ProductErrorProjectionError::UnknownProtocolError)
        );
    }
}

#[test]
fn backend_protocol_errors_remain_protocol_errors_and_ignore_private_fields() {
    let cases = [
        (
            BackendError {
                kind: BackendErrorKind::InvalidParams,
                code: "PRIVATE_VALIDATION_CODE".to_owned(),
                message: "credential=secret".to_owned(),
                details: Some(json!({"stderr": "private"})),
            },
            ProductErrorCode::InvalidInput,
        ),
        (
            BackendError::application(
                GENERATION_CONFLICT,
                "private current state",
                Some(json!({"currentRunId": "secret-session"})),
            ),
            ProductErrorCode::GenerationConflict,
        ),
        (
            BackendError::new("PRIVATE_INTERNAL_CODE", "provider stderr and command"),
            ProductErrorCode::Internal,
        ),
    ];
    for (error, expected) in cases {
        let projected = ProductError::from_backend_error(&error).unwrap();
        assert_eq!(projected.code(), expected);
        let output = String::from_utf8(projected.render_json().unwrap()).unwrap();
        assert!(!output.contains(&error.code));
        assert!(!output.contains(&error.message));
    }
    let unknown = BackendError::application("PRIVATE", "secret", Some(Value::Null));
    assert_eq!(
        ProductError::from_backend_error(&unknown),
        Err(ProductErrorProjectionError::UnknownProtocolError)
    );
}

#[test]
fn every_product_code_has_independent_canonical_message_and_action() {
    let expected_codes = EXPECTED_SEMANTICS
        .iter()
        .map(|(code, _, _)| *code)
        .collect::<BTreeSet<_>>();
    assert_eq!(expected_codes, ProductErrorCode::ALL.into_iter().collect());

    let products = all_products();
    for (code, expected_message, expected_action) in EXPECTED_SEMANTICS {
        let product = products
            .iter()
            .find(|product| product.code() == code)
            .unwrap_or_else(|| panic!("missing product error fixture for {code:?}"));
        assert_eq!(product.message(), expected_message, "{code:?}");
        assert_eq!(product.action(), expected_action, "{code:?}");
    }
}

#[test]
fn renderers_are_deterministic_strict_and_round_trip_every_code() {
    let products = all_products();
    let codes = products
        .iter()
        .map(|product| product.code())
        .collect::<BTreeSet<_>>();
    assert_eq!(codes, ProductErrorCode::ALL.into_iter().collect());

    for product in products {
        let first_json = product.render_json().unwrap();
        let second_json = product.render_json().unwrap();
        assert_eq!(first_json, second_json, "{:?}", product.code());
        assert_eq!(ProductError::decode_json(&first_json), Ok(product));

        let first_text = product.render_text().unwrap();
        let second_text = product.render_text().unwrap();
        assert_eq!(first_text, second_text, "{:?}", product.code());
        assert_eq!(ProductError::decode_text(&first_text), Ok(product));
        assert!(product.exit_status() > 0);
        assert!(product.message().len() <= MAX_PRODUCT_ERROR_MESSAGE_BYTES);
        assert!(product.action().as_str().len() <= MAX_PRODUCT_ERROR_ACTION_BYTES);
        assert!(first_json.len() <= MAX_PRODUCT_ERROR_JSON_BYTES);
        assert!(first_text.len() <= MAX_PRODUCT_ERROR_TEXT_BYTES);
    }
}

#[test]
fn command_and_daemon_renderings_have_stable_golden_bytes() {
    let product = ProductError::from_protocol_error(&protocol_error(
        IDEMPOTENCY_REUSE,
        "discarded diagnostic",
    ))
    .unwrap();
    assert_eq!(
        product.render_json().unwrap(),
        br#"{"code":"idempotency_conflict","message":"The idempotency key was already used for another request.","action":"use_new_idempotency_key"}"#
    );
    assert_eq!(
        product.render_text().unwrap(),
        "error[idempotency_conflict]: The idempotency key was already used for another request.\naction: use_new_idempotency_key\n"
    );
    assert_eq!(
        serde_json::to_string(&product.daemon_control()).unwrap(),
        r#"{"status":"conflict","code":"idempotency_conflict","message":"The idempotency key was already used for another request.","action":"use_new_idempotency_key"}"#
    );
}

#[test]
fn strict_decoders_reject_unknown_fields_and_semantic_mutations() {
    let product = ProductError::from_protocol_error(&protocol_error(
        IDEMPOTENCY_REUSE,
        "discarded diagnostic",
    ))
    .unwrap();
    let encoded = product.render_json().unwrap();
    let mut value: Value = serde_json::from_slice(&encoded).unwrap();
    value["unknown"] = json!("secret");
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&value).unwrap()),
        Err(ProductErrorProjectionError::InvalidEncoding)
    );

    let mut value: Value = serde_json::from_slice(&encoded).unwrap();
    value["message"] = json!("A different but plausible safe message.");
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&value).unwrap()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );

    let mut value: Value = serde_json::from_slice(&encoded).unwrap();
    value["action"] = json!(ProductErrorAction::RefreshState);
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&value).unwrap()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );

    let text = product.render_text().unwrap();
    assert_eq!(
        ProductError::decode_text(&text.replace("The idempotency key", "The request key")),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );
    assert_eq!(
        ProductError::decode_text(&(text + "extra\n")),
        Err(ProductErrorProjectionError::InvalidEncoding)
    );
}

#[test]
fn exact_bounds_and_limit_plus_one_fail_closed_without_truncation() {
    let exact = json!({"code": "invalid_input", "message": "m".repeat(MAX_PRODUCT_ERROR_MESSAGE_BYTES), "action": "repair_input"});
    let plus_one = json!({"code": "invalid_input", "message": "m".repeat(MAX_PRODUCT_ERROR_MESSAGE_BYTES + 1), "action": "repair_input"});
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&exact).unwrap()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&plus_one).unwrap()),
        Err(ProductErrorProjectionError::MessageTooLong)
    );
    let exact_action = json!({"code": "invalid_input", "message": "The request did not satisfy the product contract.", "action": "a".repeat(MAX_PRODUCT_ERROR_ACTION_BYTES)});
    let plus_one_action = json!({"code": "invalid_input", "message": "The request did not satisfy the product contract.", "action": "a".repeat(MAX_PRODUCT_ERROR_ACTION_BYTES + 1)});
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&exact_action).unwrap()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&plus_one_action).unwrap()),
        Err(ProductErrorProjectionError::ActionTooLong)
    );

    assert_eq!(
        ProductError::decode_json(&vec![b' '; MAX_PRODUCT_ERROR_JSON_BYTES]),
        Err(ProductErrorProjectionError::InvalidEncoding)
    );
    assert_eq!(
        ProductError::decode_json(&vec![b' '; MAX_PRODUCT_ERROR_JSON_BYTES + 1]),
        Err(ProductErrorProjectionError::JsonTooLong)
    );
    let exact_text = "x".repeat(MAX_PRODUCT_ERROR_TEXT_BYTES);
    let plus_one_text = "x".repeat(MAX_PRODUCT_ERROR_TEXT_BYTES + 1);
    assert_eq!(
        ProductError::decode_text(&exact_text),
        Err(ProductErrorProjectionError::InvalidEncoding)
    );
    assert_eq!(
        ProductError::decode_text(&plus_one_text),
        Err(ProductErrorProjectionError::TextTooLong)
    );
}

#[test]
fn raw_diagnostic_mutation_cannot_change_or_enter_command_or_control_output() {
    let first_raw = "provider=alpha credential=secret-one /private/first stderr";
    let second_raw = "https://user:secret-two@example.invalid session=private command";
    let first_fault = factory().create(
        ModuleEvidence::new(
            FaultModule::Provider,
            FaultContext::Execution,
            EvidenceClass::ProcessExited,
        )
        .with_diagnostic(RawDiagnostic::new(RedactionMarker::ProviderText, first_raw).unwrap()),
    );
    let second_fault = factory().create(
        ModuleEvidence::new(
            FaultModule::Provider,
            FaultContext::Execution,
            EvidenceClass::ProcessExited,
        )
        .with_diagnostic(RawDiagnostic::new(RedactionMarker::ProviderText, second_raw).unwrap()),
    );
    let first = ProductError::from_engine_fault(&first_fault).unwrap();
    let second = ProductError::from_engine_fault(&second_fault).unwrap();
    assert_eq!(first, second);

    let first_protocol =
        ProductError::from_protocol_error(&protocol_error(GENERATION_CONFLICT, first_raw)).unwrap();
    let second_protocol =
        ProductError::from_protocol_error(&protocol_error(GENERATION_CONFLICT, second_raw))
            .unwrap();
    assert_eq!(first_protocol, second_protocol);

    for output in [
        first.render_text().unwrap(),
        String::from_utf8(first.render_json().unwrap()).unwrap(),
        serde_json::to_string(&first.daemon_control()).unwrap(),
        first_protocol.render_text().unwrap(),
        String::from_utf8(first_protocol.render_json().unwrap()).unwrap(),
        serde_json::to_string(&first_protocol.daemon_control()).unwrap(),
    ] {
        for forbidden in [
            first_raw,
            second_raw,
            "secret-one",
            "secret-two",
            "/private/first",
            "example.invalid",
            "stderr",
            "session=",
            "credential=",
        ] {
            assert!(!output.contains(forbidden), "leaked {forbidden}: {output}");
        }
    }
}
