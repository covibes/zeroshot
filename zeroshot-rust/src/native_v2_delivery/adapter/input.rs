use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeliveryInput {
    issue_number: String,
}

pub(super) fn source_issue(input: &Value) -> Result<Option<GitHubSourceIssue>, DeliveryStop> {
    if input.is_null() {
        return Ok(None);
    }
    let input: DeliveryInput = serde_json::from_value(input.clone())
        .map_err(|_| DeliveryStop::Outcome(WorkerOutcome::malformed()))?;
    let number = input
        .issue_number
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0 && number.to_string() == input.issue_number)
        .ok_or_else(|| DeliveryStop::Outcome(WorkerOutcome::malformed()))?;
    Ok(Some(GitHubSourceIssue { number }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_null_or_one_canonical_positive_issue_number() {
        assert_eq!(source_issue(&Value::Null).ok(), Some(None));
        assert_eq!(
            source_issue(&json!({"issueNumber":"208"})).ok(),
            Some(Some(GitHubSourceIssue { number: 208 }))
        );
        for malformed in [
            json!({}),
            json!({"issueNumber":208}),
            json!({"issueNumber":"0"}),
            json!({"issueNumber":"0208"}),
            json!({"issueNumber":"208","extra":true}),
        ] {
            assert!(source_issue(&malformed).is_err());
        }
    }
}
