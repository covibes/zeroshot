//! Conformance tests for the closed, bounded, backend-neutral `BackendFault` projection: every
//! string/collection field and the final encoded JSON are bounded, malformed or semantically
//! inconsistent projections fail closed on both serialize and deserialize, and no field can carry
//! raw diagnostics.

#[path = "support/assert_value.rs"]
mod assert_value;

#[path = "support/json_insert.rs"]
mod json_insert;

#[path = "support/json_mut.rs"]
mod json_mut;

#[path = "support/json_read.rs"]
mod json_read;

use assert_value::AssertValue;

use openengine_cluster_protocol::{
    BackendFault, BoundedString256, FaultAction, FaultCode, FaultConsequence,
    FaultRetryDisposition, FaultSeverity, FaultSourceFrame, MAX_FAULT_ENCODED_BYTES,
    MAX_FAULT_SOURCE_FRAMES,
};
use serde_json::json;

fn fault() -> BackendFault {
    BackendFault {
        event_id: BoundedString256::new("evt-1").assert_value(),
        execution_ref: Some(BoundedString256::new("exec-1").assert_value()),
        code: FaultCode::Unavailable,
        consequence: FaultConsequence::TurnFailed,
        retry: FaultRetryDisposition::RetryableAfterBackoff,
        action: FaultAction::Retry,
        severity: FaultSeverity::Error,
        summary: BoundedString256::new("upstream worker unavailable").assert_value(),
        source: vec![FaultSourceFrame {
            component: BoundedString256::new("worker-dispatch").assert_value(),
        }],
    }
}

fn fault_with_source_lengths(lengths: &[usize]) -> BackendFault {
    BackendFault {
        summary: BoundedString256::new("s").assert_value(),
        source: lengths
            .iter()
            .map(|&len| FaultSourceFrame {
                component: BoundedString256::new("a".repeat(len)).assert_value(),
            })
            .collect(),
        ..fault()
    }
}

#[test]
fn backend_fault_round_trips_through_json() {
    let value = serde_json::to_value(fault()).assert_value();
    assert_eq!(
        value,
        json!({
            "eventId": "evt-1",
            "executionRef": "exec-1",
            "code": "unavailable",
            "consequence": "turn_failed",
            "retry": "retryable_after_backoff",
            "action": "retry",
            "severity": "error",
            "summary": "upstream worker unavailable",
            "source": [{"component": "worker-dispatch"}]
        })
    );
    assert_eq!(
        serde_json::from_value::<BackendFault>(value).assert_value(),
        fault()
    );
}

#[test]
fn execution_ref_is_omitted_when_absent_and_optional_on_the_wire() {
    let mut without_ref = fault();
    without_ref.execution_ref = None;
    let value = serde_json::to_value(without_ref.clone()).assert_value();
    assert!(value.get("executionRef").is_none());
    assert_eq!(
        serde_json::from_value::<BackendFault>(value).assert_value(),
        without_ref
    );
}

#[test]
fn backend_fault_rejects_unknown_fields_and_unknown_enum_strings() {
    let mut value = serde_json::to_value(fault()).assert_value();
    json_insert::json_insert(&mut value, "", "extra", json!("not allowed"));
    assert!(serde_json::from_value::<BackendFault>(value).is_err());

    for field in ["code", "consequence", "retry", "action", "severity"] {
        let mut value = serde_json::to_value(fault()).assert_value();
        json_insert::json_insert(&mut value, "", field, json!("not-a-real-variant"));
        assert!(
            serde_json::from_value::<BackendFault>(value).is_err(),
            "accepted an unknown {field} variant"
        );
    }

    let mut bad_frame = serde_json::to_value(fault()).assert_value();
    *json_mut::json_at_mut(&mut bad_frame, "/source") =
        json!([{"component": "x", "path": "/etc/passwd"}]);
    assert!(serde_json::from_value::<BackendFault>(bad_frame).is_err());
}

#[test]
fn backend_fault_has_no_field_capable_of_carrying_bytes_urls_paths_or_arbitrary_maps() {
    for field in [
        "bytes",
        "signedUrl",
        "path",
        "url",
        "headers",
        "command",
        "sessionId",
    ] {
        let mut value = serde_json::to_value(fault()).assert_value();
        json_insert::json_insert(&mut value, "", field, json!("forbidden"));
        assert!(
            serde_json::from_value::<BackendFault>(value).is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn event_id_and_summary_are_bounded_to_256_characters() {
    let schema = serde_json::to_value(schemars::schema_for!(BackendFault)).assert_value();
    let validator = jsonschema::validator_for(&schema).assert_value();

    for field in ["eventId", "summary"] {
        let mut at_limit = serde_json::to_value(fault()).assert_value();
        json_insert::json_insert(&mut at_limit, "", field, json!("e".repeat(256)));
        assert!(
            serde_json::from_value::<BackendFault>(at_limit.clone()).is_ok(),
            "256 characters must be accepted for {field}"
        );
        assert!(validator.is_valid(&at_limit));

        let mut over_limit = serde_json::to_value(fault()).assert_value();
        json_insert::json_insert(&mut over_limit, "", field, json!("e".repeat(257)));
        assert!(
            serde_json::from_value::<BackendFault>(over_limit.clone()).is_err(),
            "257 characters must be rejected for {field}"
        );
        assert!(!validator.is_valid(&over_limit));
    }
}

#[test]
fn source_is_bounded_to_max_fault_source_frames() {
    let at_limit = fault_with_source_lengths(&[1; MAX_FAULT_SOURCE_FRAMES]);
    assert!(at_limit.validate().is_ok());
    assert!(serde_json::to_value(at_limit).is_ok());

    let over_limit = fault_with_source_lengths(&[1; MAX_FAULT_SOURCE_FRAMES + 1]);
    assert!(over_limit.validate().is_err());
    assert!(serde_json::to_value(over_limit).is_err());

    // BackendFault::serialize refuses to emit an over-limit value at all, so independently prove
    // deserialization also rejects one by constructing the raw wire shape directly.
    let mut value = serde_json::to_value(fault()).assert_value();
    *json_mut::json_at_mut(&mut value, "/source") = json!(
        (0..MAX_FAULT_SOURCE_FRAMES + 1)
            .map(|_| json!({"component": "a"}))
            .collect::<Vec<_>>()
    );
    assert!(serde_json::from_value::<BackendFault>(value).is_err());
}

/// A fault with `frame_count` full 256-char source frames (bulk padding, coarse) and a `summary`
/// extended by `summary_extra` characters beyond its 1-char baseline (fine tuning, one byte per
/// character). Two independent padding dimensions are needed because opening a new source frame
/// costs its own fixed JSON overhead in addition to its content, so frame-count alone cannot land
/// on an arbitrary exact byte target -- only `summary`, which is always present regardless of
/// frame count, can close the remainder one byte at a time.
fn fault_with_frames_and_summary_extra(frame_count: usize, summary_extra: usize) -> BackendFault {
    assert!(summary_extra <= 255, "summary is bounded to 256 characters");
    let summary = format!("s{}", "x".repeat(summary_extra));
    BackendFault {
        summary: BoundedString256::new(summary).assert_value(),
        source: (0..frame_count)
            .map(|_| FaultSourceFrame {
                component: BoundedString256::new("a".repeat(256)).assert_value(),
            })
            .collect(),
        ..fault()
    }
}

#[test]
fn encoded_json_is_bounded_and_a_single_extra_byte_tips_it_over() {
    let target = MAX_FAULT_ENCODED_BYTES;

    // Grow full source frames while the encoded size stays within the limit.
    let mut frame_count = 0usize;
    while frame_count < MAX_FAULT_SOURCE_FRAMES {
        let grown = serde_json::to_vec(&fault_with_frames_and_summary_extra(frame_count + 1, 0))
            .ok()
            .map(|bytes| bytes.len());
        match grown {
            Some(len) if len <= target => frame_count += 1,
            _ => break,
        }
    }
    let base_len = serde_json::to_vec(&fault_with_frames_and_summary_extra(frame_count, 0))
        .assert_value_with("full frames alone must stay within the limit")
        .len();
    let leftover = target - base_len;
    assert!(
        leftover <= 254,
        "test fixture needs more than one summary character of headroom; leftover={leftover}"
    );

    let at_limit = fault_with_frames_and_summary_extra(frame_count, leftover);
    let encoded =
        serde_json::to_vec(&at_limit).assert_value_with("value at the exact limit must serialize");
    assert_eq!(encoded.len(), MAX_FAULT_ENCODED_BYTES);
    assert!(at_limit.validate().is_ok());

    // Padding `summary` by one more character while shrinking nothing else must now exceed the
    // limit and fail closed on both serialize and deserialize.
    let mut wire = serde_json::to_value(at_limit.clone()).assert_value();
    let mut over_summary = json_read::json_at(&wire, "/summary")
        .as_str()
        .assert_value()
        .to_owned();
    over_summary.push('x');
    *json_mut::json_at_mut(&mut wire, "/summary") = json!(over_summary.clone());
    assert!(serde_json::from_value::<BackendFault>(wire).is_err());

    let mut over_limit = at_limit;
    over_limit.summary = BoundedString256::new(over_summary).assert_value();
    assert!(over_limit.validate().is_err());
    assert!(serde_json::to_vec(&over_limit).is_err());
}

#[test]
fn action_retry_is_inconsistent_with_retry_not_retryable_on_both_directions() {
    let mut inconsistent = fault();
    inconsistent.action = FaultAction::Retry;
    inconsistent.retry = FaultRetryDisposition::NotRetryable;
    assert!(inconsistent.validate().is_err());
    assert!(serde_json::to_value(inconsistent.clone()).is_err());

    let mut value = serde_json::to_value(fault()).assert_value();
    *json_mut::json_at_mut(&mut value, "/action") = json!("retry");
    *json_mut::json_at_mut(&mut value, "/retry") = json!("not_retryable");
    assert!(serde_json::from_value::<BackendFault>(value).is_err());
}
