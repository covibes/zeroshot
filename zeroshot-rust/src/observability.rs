use std::sync::{Arc, Mutex};

use crate::fault::{FaultCode, FaultConsequence, FaultSeverity};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ObservationModule {
    Engine,
    Storage,
    Worker,
    Provider,
    Workspace,
    Source,
    Credential,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ObservationOperation {
    Configuration,
    Admission,
    Execution,
    Settlement,
    Recovery,
    Cleanup,
    Observation,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ObservationOutcome {
    Succeeded,
    Faulted,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum CounterMetricName {
    OperationsTotal,
    FaultsTotal,
    DiagnosticsRedactedTotal,
}

impl CounterMetricName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OperationsTotal => "operations_total",
            Self::FaultsTotal => "faults_total",
            Self::DiagnosticsRedactedTotal => "diagnostics_redacted_total",
        }
    }

    pub const ALL: [Self; 3] = [
        Self::OperationsTotal,
        Self::FaultsTotal,
        Self::DiagnosticsRedactedTotal,
    ];
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum HistogramMetricName {
    OperationDurationMs,
    FaultSizeBytes,
}

impl HistogramMetricName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OperationDurationMs => "operation_duration_ms",
            Self::FaultSizeBytes => "fault_size_bytes",
        }
    }

    pub const ALL: [Self; 2] = [Self::OperationDurationMs, Self::FaultSizeBytes];
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationObservation {
    pub module: ObservationModule,
    pub operation: ObservationOperation,
    pub outcome: ObservationOutcome,
    pub duration_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FaultObservation {
    pub module: ObservationModule,
    pub operation: ObservationOperation,
    pub outcome: ObservationOutcome,
    pub fault_code: FaultCode,
    pub consequence: FaultConsequence,
    pub severity: FaultSeverity,
    pub fault_size_bytes: u16,
    pub diagnostic_redacted: bool,
}

pub trait ObservationSink: Send + Sync {
    fn record_operation(&self, observation: OperationObservation);
    fn record_fault(&self, observation: FaultObservation);
}

impl<T> ObservationSink for Arc<T>
where
    T: ObservationSink + ?Sized,
{
    fn record_operation(&self, observation: OperationObservation) {
        (**self).record_operation(observation);
    }

    fn record_fault(&self, observation: FaultObservation) {
        (**self).record_fault(observation);
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoopObservationSink;

impl ObservationSink for NoopObservationSink {
    fn record_operation(&self, _observation: OperationObservation) {}

    fn record_fault(&self, _observation: FaultObservation) {}
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ObservationSnapshot {
    pub operations_total: u64,
    pub faults_total: u64,
    pub diagnostics_redacted_total: u64,
    pub operation_duration_ms: Vec<u64>,
    pub fault_size_bytes: Vec<u16>,
    pub operations: Vec<OperationObservation>,
    pub faults: Vec<FaultObservation>,
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryObservationSink {
    state: Arc<Mutex<ObservationSnapshot>>,
}

impl InMemoryObservationSink {
    #[must_use]
    pub fn snapshot(&self) -> ObservationSnapshot {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl ObservationSink for InMemoryObservationSink {
    fn record_operation(&self, observation: OperationObservation) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.operations_total = state.operations_total.saturating_add(1);
        state.operation_duration_ms.push(observation.duration_ms);
        state.operations.push(observation);
    }

    fn record_fault(&self, observation: FaultObservation) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.faults_total = state.faults_total.saturating_add(1);
        if observation.diagnostic_redacted {
            state.diagnostics_redacted_total = state.diagnostics_redacted_total.saturating_add(1);
        }
        state.fault_size_bytes.push(observation.fault_size_bytes);
        state.faults.push(observation);
    }
}
