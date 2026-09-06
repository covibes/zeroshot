use super::*;

const MAX_FAILURE_ITEM_CHARS: usize = 1_024;
const MAX_FAILED_CHECK_LOGS: usize = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RequiredChecks {
    Absent,
    Pending,
    Passed,
}

enum RequiredCheckOutcome {
    Passed,
    Pending,
    Failed {
        diagnostic: String,
        job_id: Option<u64>,
    },
}

struct CheckRunEvidence<'a> {
    conclusion: Option<&'a str>,
    details_url: Option<&'a str>,
    job_id: Option<u64>,
}

pub(super) struct RequiredCheckEvidence {
    pub(super) checks: RequiredChecks,
    pub(super) failures: Vec<String>,
    pub(super) failed_job_ids: Vec<u64>,
}

pub(super) fn classify_required_checks(contexts: &[CheckContextWire]) -> RequiredCheckEvidence {
    let mut checks = RequiredChecks::Absent;
    let mut failures = Vec::new();
    let mut failed_job_ids = Vec::new();
    for context in contexts {
        match required_check_outcome(context) {
            Some(RequiredCheckOutcome::Passed) if checks == RequiredChecks::Absent => {
                checks = RequiredChecks::Passed;
            }
            Some(RequiredCheckOutcome::Passed) | None => {}
            Some(RequiredCheckOutcome::Pending) => checks = RequiredChecks::Pending,
            Some(RequiredCheckOutcome::Failed { diagnostic, job_id }) => {
                failures.push(diagnostic);
                failed_job_ids.extend(job_id);
            }
        }
    }
    failed_job_ids.truncate(MAX_FAILED_CHECK_LOGS);
    RequiredCheckEvidence {
        checks,
        failures,
        failed_job_ids,
    }
}

fn required_check_outcome(context: &CheckContextWire) -> Option<RequiredCheckOutcome> {
    match context {
        CheckContextWire::CheckRun {
            is_required: false, ..
        }
        | CheckContextWire::StatusContext {
            is_required: false, ..
        } => None,
        CheckContextWire::CheckRun {
            name,
            status,
            conclusion,
            details_url,
            database_id,
            ..
        } => Some(check_run_outcome(
            name,
            status,
            CheckRunEvidence {
                conclusion: conclusion.as_deref(),
                details_url: details_url.as_deref(),
                job_id: *database_id,
            },
        )),
        CheckContextWire::StatusContext {
            context,
            state,
            description,
            target_url,
            ..
        } => Some(status_context_outcome(
            context,
            state,
            description.as_deref(),
            target_url.as_deref(),
        )),
    }
}

fn check_run_outcome(
    name: &str,
    status: &str,
    evidence: CheckRunEvidence<'_>,
) -> RequiredCheckOutcome {
    if status != "COMPLETED" {
        return RequiredCheckOutcome::Pending;
    }
    let conclusion = evidence.conclusion.unwrap_or_default();
    if matches!(conclusion, "SUCCESS" | "NEUTRAL" | "SKIPPED") {
        return RequiredCheckOutcome::Passed;
    }
    if matches!(
        conclusion,
        "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STALE" | "STARTUP_FAILURE"
    ) {
        return RequiredCheckOutcome::Failed {
            diagnostic: failure_item(name, conclusion, None, evidence.details_url),
            job_id: evidence.job_id,
        };
    }
    RequiredCheckOutcome::Pending
}

fn status_context_outcome(
    context: &str,
    state: &str,
    description: Option<&str>,
    target_url: Option<&str>,
) -> RequiredCheckOutcome {
    match state {
        "SUCCESS" => RequiredCheckOutcome::Passed,
        "ERROR" | "FAILURE" => RequiredCheckOutcome::Failed {
            diagnostic: failure_item(context, state, description, target_url),
            job_id: None,
        },
        _ => RequiredCheckOutcome::Pending,
    }
}

pub(super) fn failure_diagnostic(failures: Vec<String>) -> String {
    let detail = failures
        .into_iter()
        .map(|failure| format!("- {failure}"))
        .collect::<Vec<_>>()
        .join("\n");
    bounded_text(
        &format!("Required CI checks failed:\n{detail}"),
        MAX_FAILURE_DIAGNOSTIC_CHARS,
    )
}

fn failure_item(
    name: &str,
    conclusion: &str,
    description: Option<&str>,
    url: Option<&str>,
) -> String {
    let mut item = format!("{} concluded {}", one_line(name), one_line(conclusion));
    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        item.push_str(": ");
        item.push_str(&one_line(description));
    }
    if let Some(url) = url.filter(|value| !value.trim().is_empty()) {
        item.push_str(" (");
        item.push_str(&one_line(url));
        item.push(')');
    }
    bounded_text(&item, MAX_FAILURE_ITEM_CHARS)
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
