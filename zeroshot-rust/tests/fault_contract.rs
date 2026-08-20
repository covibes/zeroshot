use async_trait::async_trait;
use openengine_cluster_protocol::{
    ClusterStatus, GetParams, GetResult, InitializeParams, InitializeResult, ServerCapabilities,
    INTERNAL_ERROR, INTERNAL_ERROR_CODE,
};
use openengine_cluster_server::{
    BackendError, BackendErrorKind, ClusterBackend, ConnectionContext, Dispatcher,
};
use serde_json::{json, Value};
use zeroshot_engine::fault::{
    BoundedFaultSummary, EngineFault, EvidenceClass, FaultCode, FaultContext, FaultError,
    FaultFactory, FaultModule, FaultSeverity, ModuleEvidence, RawDiagnostic, RedactionMarker,
    RetryDisposition, SafeSourceFrame, UserAction, MAX_ENGINE_FAULT_BYTES,
    MAX_EPHEMERAL_DIAGNOSTIC_BYTES, MAX_FAULT_SOURCES, MAX_FAULT_SUMMARY_BYTES,
};
use zeroshot_engine::observability::NoopObservationSink;
use zeroshot_engine::product_errors::ProductError;

const MODULES: [FaultModule; 7] = [
    FaultModule::Engine,
    FaultModule::Storage,
    FaultModule::Worker,
    FaultModule::Provider,
    FaultModule::Workspace,
    FaultModule::Source,
    FaultModule::Credential,
];
const CONTEXTS: [FaultContext; 7] = [
    FaultContext::Configuration,
    FaultContext::Admission,
    FaultContext::Execution,
    FaultContext::Settlement,
    FaultContext::Recovery,
    FaultContext::Cleanup,
    FaultContext::Observation,
];
const CLASSES: [EvidenceClass; 10] = [
    EvidenceClass::Unavailable,
    EvidenceClass::ResourceExhausted,
    EvidenceClass::Timeout,
    EvidenceClass::PermissionDenied,
    EvidenceClass::AuthenticationRequired,
    EvidenceClass::MalformedExternalData,
    EvidenceClass::IntegrityFailure,
    EvidenceClass::ProcessExited,
    EvidenceClass::SessionLost,
    EvidenceClass::InvariantViolation,
];

const GOLDEN_EXECUTION_FAULTS: [(EvidenceClass, &str); 10] = [
    (
        EvidenceClass::Unavailable,
        r#"{"code":"unavailable","consequence":"execution_interrupted","retryDisposition":"retry_after_backoff","userAction":"retry_later","severity":"error","summary":"A required engine resource is unavailable.","sources":[{"module":"worker","context":"execution","evidenceClass":"unavailable"}]}"#,
    ),
    (
        EvidenceClass::ResourceExhausted,
        r#"{"code":"resource_exhausted","consequence":"execution_interrupted","retryDisposition":"retry_after_backoff","userAction":"free_resources","severity":"error","summary":"A required engine resource is exhausted.","sources":[{"module":"worker","context":"execution","evidenceClass":"resource_exhausted"}]}"#,
    ),
    (
        EvidenceClass::Timeout,
        r#"{"code":"timeout","consequence":"execution_interrupted","retryDisposition":"retry_after_backoff","userAction":"retry_later","severity":"warning","summary":"A native engine operation timed out.","sources":[{"module":"worker","context":"execution","evidenceClass":"timeout"}]}"#,
    ),
    (
        EvidenceClass::PermissionDenied,
        r#"{"code":"permission_denied","consequence":"execution_interrupted","retryDisposition":"retry_after_user_action","userAction":"grant_permission","severity":"error","summary":"A required engine permission was denied.","sources":[{"module":"worker","context":"execution","evidenceClass":"permission_denied"}]}"#,
    ),
    (
        EvidenceClass::AuthenticationRequired,
        r#"{"code":"authentication_required","consequence":"execution_interrupted","retryDisposition":"retry_after_user_action","userAction":"authenticate","severity":"error","summary":"Authentication is required for a native engine operation.","sources":[{"module":"worker","context":"execution","evidenceClass":"authentication_required"}]}"#,
    ),
    (
        EvidenceClass::MalformedExternalData,
        r#"{"code":"malformed_external_data","consequence":"execution_interrupted","retryDisposition":"retry_after_user_action","userAction":"repair_external_data","severity":"error","summary":"External data did not satisfy the native engine contract.","sources":[{"module":"worker","context":"execution","evidenceClass":"malformed_external_data"}]}"#,
    ),
    (
        EvidenceClass::IntegrityFailure,
        r#"{"code":"integrity_failure","consequence":"execution_interrupted","retryDisposition":"do_not_retry","userAction":"contact_support","severity":"critical","summary":"Native engine integrity verification failed.","sources":[{"module":"worker","context":"execution","evidenceClass":"integrity_failure"}]}"#,
    ),
    (
        EvidenceClass::ProcessExited,
        r#"{"code":"process_exited","consequence":"execution_interrupted","retryDisposition":"retry_after_backoff","userAction":"restart_operation","severity":"error","summary":"A required native process exited unexpectedly.","sources":[{"module":"worker","context":"execution","evidenceClass":"process_exited"}]}"#,
    ),
    (
        EvidenceClass::SessionLost,
        r#"{"code":"session_lost","consequence":"execution_interrupted","retryDisposition":"do_not_retry","userAction":"contact_support","severity":"error","summary":"A lost native engine session terminated the affected execution.","sources":[{"module":"worker","context":"execution","evidenceClass":"session_lost"}]}"#,
    ),
    (
        EvidenceClass::InvariantViolation,
        r#"{"code":"invariant_violation","consequence":"execution_interrupted","retryDisposition":"do_not_retry","userAction":"contact_support","severity":"critical","summary":"A native engine invariant was violated.","sources":[{"module":"worker","context":"execution","evidenceClass":"invariant_violation"}]}"#,
    ),
];

fn factory() -> FaultFactory<'static> {
    static SINK: NoopObservationSink = NoopObservationSink;
    FaultFactory::new(&SINK)
}

fn fault() -> EngineFault {
    factory().create(ModuleEvidence::new(
        FaultModule::Provider,
        FaultContext::Execution,
        EvidenceClass::Timeout,
    ))
}

#[test]
fn every_closed_evidence_triple_is_deterministic() {
    for module in MODULES {
        for context in CONTEXTS {
            for class in CLASSES {
                let evidence = ModuleEvidence::new(module, context, class);
                let first = factory().create(evidence.clone());
                let second = factory().create(evidence);
                assert_eq!(first, second, "{module:?}/{context:?}/{class:?}");
                assert_eq!(first.sources().len(), 1);
                assert_eq!(first.sources().assert_at(0).module(), module);
                assert_eq!(first.sources().assert_at(0).context(), context);
                assert_eq!(first.sources().assert_at(0).evidence_class(), class);
                assert!(first.summary().len() <= MAX_FAULT_SUMMARY_BYTES);
                assert!(first.encode_json().assert_value().len() <= MAX_ENGINE_FAULT_BYTES);
                let projected = ProductError::from_engine_fault(&first).assert_value();
                let command = projected.render_text().assert_value();
                let control = serde_json::to_string(&projected.daemon_control()).assert_value();
                assert!(!command.contains("\nsources:"));
                assert!(!control.contains("\"sources\""));
            }
        }
    }
}

#[test]
fn canonical_fault_encodings_are_exhaustive_and_byte_compatible() {
    for (class, golden) in GOLDEN_EXECUTION_FAULTS {
        let fault = factory().create(ModuleEvidence::new(
            FaultModule::Worker,
            FaultContext::Execution,
            class,
        ));
        assert_eq!(
            fault.encode_json().assert_value(),
            golden.as_bytes(),
            "encoded fixture drifted for {class:?}"
        );
        assert_eq!(
            EngineFault::decode_json(golden.as_bytes()).assert_value(),
            fault,
            "golden fixture failed canonical decode for {class:?}"
        );
    }
}

#[test]
fn session_loss_is_identically_non_retryable_for_every_source_context() {
    const SUMMARY: &str = "A lost native engine session terminated the affected execution.";

    for module in MODULES {
        for context in CONTEXTS {
            let fault = factory().create(ModuleEvidence::new(
                module,
                context,
                EvidenceClass::SessionLost,
            ));
            assert_eq!(fault.code(), FaultCode::SessionLost);
            assert_eq!(fault.retry_disposition(), RetryDisposition::DoNotRetry);
            assert_eq!(fault.user_action(), UserAction::ContactSupport);
            assert_eq!(fault.severity(), FaultSeverity::Error);
            assert_eq!(fault.summary(), SUMMARY);
            let encoded = fault.encode_json().assert_value();
            assert_eq!(
                EngineFault::decode_json(&encoded).assert_value(),
                fault,
                "{module:?}/{context:?}"
            );
            let mut legacy_retry: Value = serde_json::from_slice(&encoded).assert_value();
            *legacy_retry.get_mut("retryDisposition").assert_value() = json!("retry_after_backoff");
            assert_eq!(
                EngineFault::decode_json(&serde_json::to_vec(&legacy_retry).assert_value()),
                Err(FaultError::InvalidFaultSemantics),
                "legacy retry semantics decoded for {module:?}/{context:?}"
            );
        }
    }
}

#[test]
fn raw_content_cannot_change_fault_semantics_or_safe_text() {
    let first_raw = "bearer top-secret-one at /Users/alice/private";
    let second_raw = "https://example.invalid/?token=top-secret-two";
    let first = factory().create(
        ModuleEvidence::new(
            FaultModule::Provider,
            FaultContext::Execution,
            EvidenceClass::ProcessExited,
        )
        .with_diagnostic(
            RawDiagnostic::new(RedactionMarker::ProviderText, first_raw).assert_value(),
        ),
    );
    let second = factory().create(
        ModuleEvidence::new(
            FaultModule::Provider,
            FaultContext::Execution,
            EvidenceClass::ProcessExited,
        )
        .with_diagnostic(
            RawDiagnostic::new(RedactionMarker::ProviderText, second_raw).assert_value(),
        ),
    );

    assert_eq!(first, second);
    let encoded = String::from_utf8(first.encode_json().assert_value()).assert_value();
    assert!(!encoded.contains(first_raw));
    assert!(!encoded.contains(second_raw));
    assert!(!first.summary().contains("top-secret"));
}

#[test]
fn every_sensitive_category_is_replaced_wholesale() {
    let fixtures = [
        (RedactionMarker::Credential, "sk-live-credential"),
        (RedactionMarker::Path, "/Users/alice/.ssh/id_ed25519"),
        (
            RedactionMarker::Url,
            "https://user:pass@example.invalid/private",
        ),
        (RedactionMarker::Header, "Authorization: Bearer raw-token"),
        (
            RedactionMarker::StandardError,
            "stderr: password=raw-secret",
        ),
        (RedactionMarker::RawFrame, "frame containing raw payload"),
        (
            RedactionMarker::ProviderText,
            "provider returned private prose",
        ),
        (RedactionMarker::ToolArgument, "--token raw-tool-argument"),
        (RedactionMarker::ToolResult, "raw tool result with secret"),
        (RedactionMarker::SessionIdentifier, "session-private-123"),
        (
            RedactionMarker::NestedCause,
            "nested cause: credential leaked",
        ),
        (
            RedactionMarker::UnknownText,
            "unknown untrusted free-form text",
        ),
    ];

    for (marker, secret) in fixtures {
        let diagnostic = RawDiagnostic::new(marker, secret).assert_value();
        let debug = format!("{diagnostic:?}");
        assert!(!debug.contains(secret));
        assert!(debug.contains("<redacted>"));

        let fault = factory().create(
            ModuleEvidence::new(
                FaultModule::Engine,
                FaultContext::Observation,
                EvidenceClass::InvariantViolation,
            )
            .with_diagnostic(diagnostic),
        );
        let encoded = String::from_utf8(fault.encode_json().assert_value()).assert_value();
        assert!(!encoded.contains(secret));
        assert!(!encoded.contains("redacted"));
    }
}

#[test]
fn bounds_accept_exact_limits_and_reject_limit_plus_one() {
    let exact_summary: &'static str =
        Box::leak("s".repeat(MAX_FAULT_SUMMARY_BYTES).into_boxed_str());
    let oversized_summary: &'static str =
        Box::leak("s".repeat(MAX_FAULT_SUMMARY_BYTES + 1).into_boxed_str());
    assert_eq!(
        BoundedFaultSummary::from_engine_owned(exact_summary)
            .assert_value()
            .as_str()
            .len(),
        MAX_FAULT_SUMMARY_BYTES
    );
    assert_eq!(
        BoundedFaultSummary::from_engine_owned(oversized_summary),
        Err(FaultError::SummaryTooLong)
    );

    let exact_diagnostic = "d".repeat(MAX_EPHEMERAL_DIAGNOSTIC_BYTES);
    let oversized_diagnostic = "d".repeat(MAX_EPHEMERAL_DIAGNOSTIC_BYTES + 1);
    assert_eq!(
        RawDiagnostic::new(RedactionMarker::UnknownText, &exact_diagnostic)
            .assert_value()
            .ephemeral()
            .original_bytes() as usize,
        MAX_EPHEMERAL_DIAGNOSTIC_BYTES
    );
    assert_eq!(
        RawDiagnostic::new(RedactionMarker::UnknownText, &oversized_diagnostic),
        Err(FaultError::DiagnosticTooLong)
    );

    let original = fault();
    let mut value = serde_json::to_value(&original).assert_value();
    let frame = serde_json::to_value(SafeSourceFrame::new(
        FaultModule::Provider,
        FaultContext::Execution,
        EvidenceClass::Timeout,
    ))
    .assert_value();
    *value.get_mut("sources").assert_value() = Value::Array(vec![frame.clone(); MAX_FAULT_SOURCES]);
    let exact_sources = serde_json::to_vec(&value).assert_value();
    assert_eq!(
        EngineFault::decode_json(&exact_sources)
            .assert_value()
            .sources()
            .len(),
        MAX_FAULT_SOURCES
    );
    *value.get_mut("sources").assert_value() = Value::Array(vec![frame; MAX_FAULT_SOURCES + 1]);
    assert_eq!(
        EngineFault::decode_json(&serde_json::to_vec(&value).assert_value()),
        Err(FaultError::TooManySources)
    );

    let encoded = original.encode_json().assert_value();
    let mut exact_encoding = encoded;
    exact_encoding.resize(MAX_ENGINE_FAULT_BYTES, b' ');
    assert!(EngineFault::decode_json(&exact_encoding).is_ok());
    exact_encoding.push(b' ');
    assert_eq!(
        EngineFault::decode_json(&exact_encoding),
        Err(FaultError::EncodedFaultTooLong)
    );
}

#[test]
fn decoding_revalidates_summary_sources_payload_and_unknown_fields() {
    let encoded = fault().encode_json().assert_value();
    assert_eq!(EngineFault::decode_json(&encoded).assert_value(), fault());

    let mut value: Value = serde_json::from_slice(&encoded).assert_value();
    *value.get_mut("summary").assert_value() =
        Value::String("provider-authored summary".to_owned());
    assert_eq!(
        EngineFault::decode_json(&serde_json::to_vec(&value).assert_value()),
        Err(FaultError::InvalidSafeSummary)
    );

    let mut value: Value = serde_json::from_slice(&encoded).assert_value();
    value.as_object_mut().assert_value().insert(
        "metadata".to_owned(),
        json!({"credential": "must-not-enter"}),
    );
    assert_eq!(
        EngineFault::decode_json(&serde_json::to_vec(&value).assert_value()),
        Err(FaultError::InvalidEncoding)
    );

    let mut value: Value = serde_json::from_slice(&encoded).assert_value();
    value
        .pointer_mut("/sources/0")
        .assert_value()
        .as_object_mut()
        .assert_value()
        .insert("credential".to_owned(), json!("secret-value"));
    assert_eq!(
        EngineFault::decode_json(&serde_json::to_vec(&value).assert_value()),
        Err(FaultError::InvalidEncoding)
    );
}

#[test]
fn decoding_rejects_empty_sources_and_forged_semantics() {
    let encoded = fault().encode_json().assert_value();

    let mut empty_sources: Value = serde_json::from_slice(&encoded).assert_value();
    *empty_sources.get_mut("sources").assert_value() = Value::Array(Vec::new());
    assert_eq!(
        EngineFault::decode_json(&serde_json::to_vec(&empty_sources).assert_value()),
        Err(FaultError::MissingPrimarySource)
    );

    let forged_fields = [
        ("code", json!("invariant_violation")),
        ("consequence", json!("configuration_blocked")),
        ("retryDisposition", json!("do_not_retry")),
        ("userAction", json!("authenticate")),
        ("severity", json!("critical")),
    ];
    for (field, forged_value) in forged_fields {
        let mut forged: Value = serde_json::from_slice(&encoded).assert_value();
        forged
            .as_object_mut()
            .assert_value()
            .insert(field.to_owned(), forged_value);
        assert_eq!(
            EngineFault::decode_json(&serde_json::to_vec(&forged).assert_value()),
            Err(FaultError::InvalidFaultSemantics),
            "decoder accepted forged {field}"
        );
    }
}

#[derive(Clone)]
struct FaultBackend;

#[async_trait]
impl ClusterBackend for FaultBackend {
    async fn initialize(
        &self,
        _context: &ConnectionContext,
        _params: InitializeParams,
    ) -> Result<InitializeResult, BackendError> {
        Ok(InitializeResult::new(
            ServerCapabilities::default(),
            ClusterStatus::empty(),
        ))
    }

    async fn get(
        &self,
        _context: &ConnectionContext,
        _params: GetParams,
    ) -> Result<GetResult, BackendError> {
        Err(fault().into())
    }
}

#[tokio::test]
async fn internal_projection_is_opaque_and_has_no_details() {
    let fault = fault();
    let direct: BackendError = (&fault).into();
    assert_eq!(direct.kind, BackendErrorKind::Internal);
    assert_eq!(direct.code, INTERNAL_ERROR_CODE);
    assert_eq!(direct.message, "Internal error");
    assert_eq!(direct.details, None);

    let response = Dispatcher::new(FaultBackend, ConnectionContext::default())
        .dispatch(&json!({"jsonrpc": "2.0", "id": 7, "method": "get", "params": {}}).to_string())
        .await;
    let response_json: Value = serde_json::from_str(&response).assert_value();
    assert_eq!(
        response_json.pointer("/error/code").assert_value(),
        INTERNAL_ERROR
    );
    assert_eq!(
        response_json.pointer("/error/message").assert_value(),
        "Internal error"
    );
    assert_eq!(
        response_json.pointer("/error/data/code").assert_value(),
        INTERNAL_ERROR_CODE
    );
    assert!(
        !response_json
            .pointer("/error/data")
            .assert_value()
            .as_object()
            .assert_value()
            .contains_key("details")
    );
    assert!(!response.contains(fault.summary()));
    assert!(!response.contains("provider"));
}

use openengine_cluster_testkit::assertions::{AssertAt, AssertValue};
