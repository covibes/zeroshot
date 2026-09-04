use crate::execution::process::ProcessSessionOutput;
use crate::native_v2_runner::NodeRunnerError;

use super::process_failure_detail;

pub(super) const MAX_PROVIDER_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const DIAGNOSTIC_TRUNCATION_MARKER: &str = " ... [middle truncated] ... ";
const TRUNCATED_STDERR_DETAIL_PREFIX: &str = "stderr (truncated tail): ";

pub(crate) fn safe_provider_text(text: &str, redactions: &[String]) -> String {
    let mut ordered = redactions
        .iter()
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    ordered.dedup();
    let redacted = ordered.iter().fold(text.to_owned(), |safe, value| {
        safe.replace(value, "[REDACTED]")
    });
    redact_stderr_boundary(redacted, &ordered).replace('\0', "\u{fffd}")
}

fn redact_stderr_boundary(mut text: String, redactions: &[&str]) -> String {
    let boundaries = text
        .match_indices(TRUNCATED_STDERR_DETAIL_PREFIX)
        .map(|(index, _)| index + TRUNCATED_STDERR_DETAIL_PREFIX.len())
        .collect::<Vec<_>>();
    for boundary in boundaries.into_iter().rev() {
        let Some(tail) = text.get(boundary..) else {
            continue;
        };
        let replacement_bytes = tail
            .chars()
            .take_while(|character| *character == '\u{fffd}')
            .map(char::len_utf8)
            .sum::<usize>();
        let Some(candidate) = tail.get(replacement_bytes..) else {
            continue;
        };
        let Some(secret_bytes) = redactions
            .iter()
            .filter_map(|secret| leading_secret_suffix_bytes(candidate, secret))
            .max()
        else {
            continue;
        };
        let Some(end) = boundary
            .checked_add(replacement_bytes)
            .and_then(|value| value.checked_add(secret_bytes))
        else {
            continue;
        };
        if text.get(boundary..end).is_some() {
            text.replace_range(boundary..end, "[REDACTED]");
        }
    }
    text
}

fn leading_secret_suffix_bytes(candidate: &str, secret: &str) -> Option<usize> {
    secret
        .char_indices()
        .skip(1)
        .filter_map(|(start, _)| secret.get(start..))
        .filter(|suffix| candidate.starts_with(suffix))
        .map(str::len)
        .max()
}

pub(crate) fn provider_failure_diagnostic(
    provider: &str,
    detail: Option<&str>,
    output: Option<&ProcessSessionOutput>,
    redactions: &[String],
) -> String {
    let mut details = detail
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(process) = output {
        let process_detail = match process_failure_detail(process, false, true) {
            Ok(detail) => detail,
            Err(NodeRunnerError::Cancelled) => Some("provider process was cancelled".to_owned()),
            Err(_) => None,
        };
        if let Some(process_detail) = process_detail {
            details.push(process_detail);
        }
    }
    let detail = if details.is_empty() {
        "execution failed without provider detail".to_owned()
    } else {
        details.join("; ")
    };
    let detail = sanitize_control_characters(&safe_provider_text(&detail, redactions));
    bounded_provider_diagnostic(format!("{provider} provider failure: {}", detail.trim()))
}

fn sanitize_control_characters(detail: &str) -> String {
    detail
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn bounded_provider_diagnostic(diagnostic: String) -> String {
    if diagnostic.len() <= MAX_PROVIDER_DIAGNOSTIC_BYTES {
        return diagnostic;
    }
    let content_bytes =
        MAX_PROVIDER_DIAGNOSTIC_BYTES.saturating_sub(DIAGNOSTIC_TRUNCATION_MARKER.len());
    let prefix = utf8_prefix(&diagnostic, content_bytes / 2);
    let suffix = utf8_suffix(&diagnostic, content_bytes.saturating_sub(prefix.len()));
    format!("{prefix}{DIAGNOSTIC_TRUNCATION_MARKER}{suffix}")
}

fn utf8_prefix(value: &str, maximum_bytes: usize) -> String {
    let mut bytes = 0;
    value
        .chars()
        .take_while(|character| {
            let next = bytes + character.len_utf8();
            if next > maximum_bytes {
                false
            } else {
                bytes = next;
                true
            }
        })
        .collect()
}

fn utf8_suffix(value: &str, maximum_bytes: usize) -> String {
    let mut bytes = 0;
    let mut characters = value
        .chars()
        .rev()
        .take_while(|character| {
            let next = bytes + character.len_utf8();
            if next > maximum_bytes {
                false
            } else {
                bytes = next;
                true
            }
        })
        .collect::<Vec<_>>();
    characters.reverse();
    characters.into_iter().collect()
}
