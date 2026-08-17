use super::*;

pub(super) fn validate_fault(fault: &EngineFault) -> Result<(), FaultError> {
    if fault.summary.len() > MAX_FAULT_SUMMARY_BYTES {
        return Err(FaultError::SummaryTooLong);
    }
    if fault.sources.len() > MAX_FAULT_SOURCES {
        return Err(FaultError::TooManySources);
    }
    let canonical = EngineFault::from_sources(fault.sources.clone())?;
    if fault.summary != canonical.summary {
        return Err(FaultError::InvalidSafeSummary);
    }
    if !fault.has_same_semantics(&canonical) {
        return Err(FaultError::InvalidFaultSemantics);
    }
    Ok(())
}
