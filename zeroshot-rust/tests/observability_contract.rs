use zeroshot_engine::fault::{
    EvidenceClass, FaultCode, FaultConsequence, FaultContext, FaultFactory, FaultModule,
    FaultSeverity, ModuleEvidence, RawDiagnostic, RedactionMarker,
};
use zeroshot_engine::observability::{
    CounterMetricName, HistogramMetricName, InMemoryObservationSink, NoopObservationSink,
    ObservationModule, ObservationOperation, ObservationOutcome, ObservationSink,
    OperationObservation,
};

#[test]
fn fault_creation_emits_exactly_one_bounded_typed_observation() {
    let sink = InMemoryObservationSink::default();
    let secret = "credential=private-value session=session-private";
    let fault = FaultFactory::new(&sink).create(
        ModuleEvidence::new(
            FaultModule::Credential,
            FaultContext::Configuration,
            EvidenceClass::AuthenticationRequired,
        )
        .with_diagnostic(RawDiagnostic::new(RedactionMarker::Credential, secret).unwrap()),
    );

    let snapshot = sink.snapshot();
    assert_eq!(snapshot.faults_total, 1);
    assert_eq!(snapshot.diagnostics_redacted_total, 1);
    assert_eq!(snapshot.operations_total, 0);
    assert_eq!(snapshot.faults.len(), 1);
    assert_eq!(snapshot.fault_size_bytes.len(), 1);
    assert_eq!(
        snapshot.fault_size_bytes[0] as usize,
        fault.encode_json().unwrap().len()
    );
    let record = snapshot.faults[0];
    assert_eq!(record.module, ObservationModule::Credential);
    assert_eq!(record.operation, ObservationOperation::Configuration);
    assert_eq!(record.outcome, ObservationOutcome::Faulted);
    assert_eq!(record.fault_code, fault.code());
    assert_eq!(record.consequence, fault.consequence());
    assert_eq!(record.severity, fault.severity());
    assert!(record.diagnostic_redacted);
    assert!(!format!("{snapshot:?}").contains(secret));
}

#[test]
fn session_loss_observation_is_terminal_typed_and_identifier_free() {
    let sink = InMemoryObservationSink::default();
    let identifier = "private-node-session-42";
    let fault = FaultFactory::new(&sink).create(
        ModuleEvidence::new(
            FaultModule::Worker,
            FaultContext::Execution,
            EvidenceClass::SessionLost,
        )
        .with_diagnostic(
            RawDiagnostic::new(RedactionMarker::SessionIdentifier, identifier).unwrap(),
        ),
    );

    let snapshot = sink.snapshot();
    assert_eq!(snapshot.faults_total, 1);
    assert_eq!(snapshot.diagnostics_redacted_total, 1);
    assert_eq!(snapshot.faults.len(), 1);
    assert_eq!(
        snapshot.fault_size_bytes,
        vec![fault.encode_json().unwrap().len() as u16]
    );
    let record = snapshot.faults[0];
    assert_eq!(record.module, ObservationModule::Worker);
    assert_eq!(record.operation, ObservationOperation::Execution);
    assert_eq!(record.outcome, ObservationOutcome::Faulted);
    assert_eq!(record.fault_code, FaultCode::SessionLost);
    assert_eq!(record.consequence, FaultConsequence::ExecutionInterrupted);
    assert_eq!(record.severity, FaultSeverity::Error);
    assert!(record.diagnostic_redacted);
    let observed = format!("{snapshot:?}");
    assert!(!observed.contains(identifier));
    assert!(!observed.contains("RetryAfter"));
}

#[test]
fn diagnostic_content_cannot_change_observation_dimensions() {
    let first_sink = InMemoryObservationSink::default();
    let second_sink = InMemoryObservationSink::default();
    let classify = |sink: &InMemoryObservationSink, raw: &str| {
        FaultFactory::new(sink).create(
            ModuleEvidence::new(
                FaultModule::Provider,
                FaultContext::Execution,
                EvidenceClass::ProcessExited,
            )
            .with_diagnostic(RawDiagnostic::new(RedactionMarker::ProviderText, raw).unwrap()),
        )
    };
    classify(&first_sink, "provider secret one");
    classify(&second_sink, "provider secret two");
    assert_eq!(first_sink.snapshot(), second_sink.snapshot());
}

#[test]
fn operation_recording_uses_only_fixed_dimensions_and_histogram() {
    let sink = InMemoryObservationSink::default();
    sink.record_operation(OperationObservation {
        module: ObservationModule::Storage,
        operation: ObservationOperation::Settlement,
        outcome: ObservationOutcome::Succeeded,
        duration_ms: 37,
    });
    sink.record_operation(OperationObservation {
        module: ObservationModule::Worker,
        operation: ObservationOperation::Cleanup,
        outcome: ObservationOutcome::Cancelled,
        duration_ms: 41,
    });

    let expected = sink.snapshot();
    assert_eq!(expected.operations_total, 2);
    assert_eq!(expected.operation_duration_ms, vec![37, 41]);
    assert_eq!(expected.operations.len(), 2);
    assert_eq!(sink.snapshot(), expected, "snapshots must be deterministic");
}

#[test]
fn metric_vocabulary_is_closed_and_exact() {
    assert_eq!(
        CounterMetricName::ALL.map(CounterMetricName::as_str),
        [
            "operations_total",
            "faults_total",
            "diagnostics_redacted_total"
        ]
    );
    assert_eq!(
        HistogramMetricName::ALL.map(HistogramMetricName::as_str),
        ["operation_duration_ms", "fault_size_bytes"]
    );
}

#[test]
fn no_op_sink_accepts_typed_records_without_state_or_global_installation() {
    let sink = NoopObservationSink;
    sink.record_operation(OperationObservation {
        module: ObservationModule::Engine,
        operation: ObservationOperation::Observation,
        outcome: ObservationOutcome::Succeeded,
        duration_ms: 0,
    });
    let fault = FaultFactory::new(&sink).create(ModuleEvidence::new(
        FaultModule::Engine,
        FaultContext::Observation,
        EvidenceClass::Unavailable,
    ));
    assert!(!fault.encode_json().unwrap().is_empty());
}
