use serde_json::Value;

pub(super) fn record_count(count: usize, kind: &str) -> String {
    format!(
        "{count} {kind} JSONL record{}",
        if count == 1 { "" } else { "s" }
    )
}

pub(super) fn combine_failure_detail(diagnostic: &str, process_failure: Option<&str>) -> String {
    process_failure.map_or_else(
        || diagnostic.to_owned(),
        |process| format!("{}; {}", diagnostic.trim(), process.trim()),
    )
}

pub(super) fn error_list(value: Option<&Value>) -> Option<String> {
    let errors = value?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|error| !error.trim().is_empty())
        .collect::<Vec<_>>();
    (!errors.is_empty()).then(|| errors.join("; "))
}
