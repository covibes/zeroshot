use super::*;

#[test]
fn every_engine_category_has_a_causal_product_mapping() {
    for (class, code, exit, daemon_status) in ENGINE_CASES {
        let fault = factory().create(ModuleEvidence::new(
            FaultModule::Provider,
            FaultContext::Execution,
            class,
        ));
        let projected = ProductError::from_engine_fault(&fault).assert_value();
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
            ProductError::from_protocol_error(&protocol_error(domain, "private")).assert_value();
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
            ProductError::from_protocol_error(&error)
                .assert_value()
                .code(),
            ProductErrorCode::InvalidInput
        );
    }
    let method = JsonRpcError {
        code: METHOD_NOT_FOUND,
        message: "private method name".to_owned(),
        data: None,
    };
    assert_eq!(
        ProductError::from_protocol_error(&method)
            .assert_value()
            .code(),
        ProductErrorCode::UnsupportedCapability
    );
    let internal = JsonRpcError {
        code: INTERNAL_ERROR,
        message: "private provider failure".to_owned(),
        data: None,
    };
    assert_eq!(
        ProductError::from_protocol_error(&internal)
            .assert_value()
            .code(),
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
        let projected = ProductError::from_backend_error(&error).assert_value();
        assert_eq!(projected.code(), expected);
        let output = String::from_utf8(projected.render_json().assert_value()).assert_value();
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
            .assert_value_with(&format!("missing product error fixture for {code:?}"));
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
        let first_json = product.render_json().assert_value();
        let second_json = product.render_json().assert_value();
        assert_eq!(first_json, second_json, "{:?}", product.code());
        assert_eq!(ProductError::decode_json(&first_json), Ok(product));

        let first_text = product.render_text().assert_value();
        let second_text = product.render_text().assert_value();
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
    .assert_value();
    assert_eq!(
        product.render_json().assert_value(),
        concat!(
            "{\"code\":\"idempotency_conflict\",",
            "\"message\":\"The idempotency key was already used for another request.\",",
            "\"action\":\"use_new_idempotency_key\"}"
        )
        .as_bytes()
    );
    assert_eq!(
        product.render_text().assert_value(),
        concat!(
            "error[idempotency_conflict]: ",
            "The idempotency key was already used for another request.\n",
            "action: use_new_idempotency_key\n"
        )
    );
    assert_eq!(
        serde_json::to_string(&product.daemon_control()).assert_value(),
        concat!(
            "{\"status\":\"conflict\",\"code\":\"idempotency_conflict\",",
            "\"message\":\"The idempotency key was already used for another request.\",",
            "\"action\":\"use_new_idempotency_key\"}"
        )
    );
}

#[test]
fn strict_decoders_reject_unknown_fields_and_semantic_mutations() {
    let product = ProductError::from_protocol_error(&protocol_error(
        IDEMPOTENCY_REUSE,
        "discarded diagnostic",
    ))
    .assert_value();
    let encoded = product.render_json().assert_value();
    let mut value: Value = serde_json::from_slice(&encoded).assert_value();
    value
        .as_object_mut()
        .assert_value()
        .insert("unknown".to_owned(), json!("secret"));
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&value).assert_value()),
        Err(ProductErrorProjectionError::InvalidEncoding)
    );

    let mut value: Value = serde_json::from_slice(&encoded).assert_value();
    *value.get_mut("message").assert_value() = json!("A different but plausible safe message.");
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&value).assert_value()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );

    let mut value: Value = serde_json::from_slice(&encoded).assert_value();
    *value.get_mut("action").assert_value() = json!(ProductErrorAction::RefreshState);
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&value).assert_value()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );

    let text = product.render_text().assert_value();
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
    let exact = json!({
        "code": "invalid_input",
        "message": "m".repeat(MAX_PRODUCT_ERROR_MESSAGE_BYTES),
        "action": "repair_input"
    });
    let plus_one = json!({
        "code": "invalid_input",
        "message": "m".repeat(MAX_PRODUCT_ERROR_MESSAGE_BYTES + 1),
        "action": "repair_input"
    });
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&exact).assert_value()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&plus_one).assert_value()),
        Err(ProductErrorProjectionError::MessageTooLong)
    );
    let exact_action = json!({
        "code": "invalid_input",
        "message": "The request did not satisfy the product contract.",
        "action": "a".repeat(MAX_PRODUCT_ERROR_ACTION_BYTES)
    });
    let plus_one_action = json!({
        "code": "invalid_input",
        "message": "The request did not satisfy the product contract.",
        "action": "a".repeat(MAX_PRODUCT_ERROR_ACTION_BYTES + 1)
    });
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&exact_action).assert_value()),
        Err(ProductErrorProjectionError::InvalidSemantics)
    );
    assert_eq!(
        ProductError::decode_json(&serde_json::to_vec(&plus_one_action).assert_value()),
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
        .with_diagnostic(
            RawDiagnostic::new(RedactionMarker::ProviderText, first_raw).assert_value(),
        ),
    );
    let second_fault = factory().create(
        ModuleEvidence::new(
            FaultModule::Provider,
            FaultContext::Execution,
            EvidenceClass::ProcessExited,
        )
        .with_diagnostic(
            RawDiagnostic::new(RedactionMarker::ProviderText, second_raw).assert_value(),
        ),
    );
    let first = ProductError::from_engine_fault(&first_fault).assert_value();
    let second = ProductError::from_engine_fault(&second_fault).assert_value();
    assert_eq!(first, second);

    let first_protocol =
        ProductError::from_protocol_error(&protocol_error(GENERATION_CONFLICT, first_raw))
            .assert_value();
    let second_protocol =
        ProductError::from_protocol_error(&protocol_error(GENERATION_CONFLICT, second_raw))
            .assert_value();
    assert_eq!(first_protocol, second_protocol);

    for output in [
        first.render_text().assert_value(),
        String::from_utf8(first.render_json().assert_value()).assert_value(),
        serde_json::to_string(&first.daemon_control()).assert_value(),
        first_protocol.render_text().assert_value(),
        String::from_utf8(first_protocol.render_json().assert_value()).assert_value(),
        serde_json::to_string(&first_protocol.daemon_control()).assert_value(),
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
