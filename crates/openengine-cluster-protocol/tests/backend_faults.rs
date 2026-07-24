//! Conformance tests for the closed, bounded, backend-neutral `BackendFault` projection: every
//! string/collection field and the final encoded JSON are bounded, malformed or semantically
//! inconsistent projections fail closed on both serialize and deserialize, and no field can carry
//! raw diagnostics.

use openengine_cluster_protocol::{
    BackendFault, BoundedString256, FaultAction, FaultCode, FaultConsequence,
    FaultRetryDisposition, FaultSeverity, FaultSourceFrame, MAX_FAULT_ENCODED_BYTES,
    MAX_FAULT_SOURCE_FRAMES,
};
use serde_json::json;

fn fault() -> BackendFault {
    BackendFault {
        event_id: BoundedString256::new("evt-1").unwrap(),
        execution_ref: Some(BoundedString256::new("exec-1").unwrap()),
        code: FaultCode::Unavailable,
        consequence: FaultConsequence::TurnFailed,
        retry: FaultRetryDisposition::RetryableAfterBackoff,
        action: FaultAction::Retry,
        severity: FaultSeverity::Error,
        summary: BoundedString256::new("upstream worker unavailable").unwrap(),
        source: vec![FaultSourceFrame {
            component: BoundedString256::new("worker-dispatch").unwrap(),
        }],
    }
}

fn fault_with_source_lengths(lengths: &[usize]) -> BackendFault {
    BackendFault {
        summary: BoundedString256::new("s").unwrap(),
        source: lengths
            .iter()
            .map(|&len| FaultSourceFrame {
                component: BoundedString256::new("a".repeat(len)).unwrap(),
            })
            .collect(),
        ..fault()
    }
}

#[test]
fn backend_fault_round_trips_through_json() {
    let value = serde_json::to_value(fault()).unwrap();
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
        serde_json::from_value::<BackendFault>(value).unwrap(),
        fault()
    );
}

#[test]
fn execution_ref_is_omitted_when_absent_and_optional_on_the_wire() {
    let mut without_ref = fault();
    without_ref.execution_ref = None;
    let value = serde_json::to_value(without_ref.clone()).unwrap();
    assert!(value.get("executionRef").is_none());
    assert_eq!(
        serde_json::from_value::<BackendFault>(value).unwrap(),
        without_ref
    );
}

#[test]
fn backend_fault_rejects_unknown_fields_and_unknown_enum_strings() {
    let mut value = serde_json::to_value(fault()).unwrap();
    value["extra"] = json!("not allowed");
    assert!(serde_json::from_value::<BackendFault>(value).is_err());

    for field in ["code", "consequence", "retry", "action", "severity"] {
        let mut value = serde_json::to_value(fault()).unwrap();
        value[field] = json!("not-a-real-variant");
        assert!(
            serde_json::from_value::<BackendFault>(value).is_err(),
            "accepted an unknown {field} variant"
        );
    }

    let mut bad_frame = serde_json::to_value(fault()).unwrap();
    bad_frame["source"] = json!([{"component": "x", "path": "/etc/passwd"}]);
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
        let mut value = serde_json::to_value(fault()).unwrap();
        value[field] = json!("forbidden");
        assert!(
            serde_json::from_value::<BackendFault>(value).is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn event_id_and_summary_are_bounded_to_256_characters() {
    let schema = serde_json::to_value(schemars::schema_for!(BackendFault)).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();

    for field in ["eventId", "summary"] {
        let mut at_limit = serde_json::to_value(fault()).unwrap();
        at_limit[field] = json!("e".repeat(256));
        assert!(
            serde_json::from_value::<BackendFault>(at_limit.clone()).is_ok(),
            "256 characters must be accepted for {field}"
        );
        assert!(validator.is_valid(&at_limit));

        let mut over_limit = serde_json::to_value(fault()).unwrap();
        over_limit[field] = json!("e".repeat(257));
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
    let mut value = serde_json::to_value(fault()).unwrap();
    value["source"] = json!(
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
        summary: BoundedString256::new(summary).unwrap(),
        source: (0..frame_count)
            .map(|_| FaultSourceFrame {
                component: BoundedString256::new("a".repeat(256)).unwrap(),
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
        .expect("full frames alone must stay within the limit")
        .len();
    let leftover = target - base_len;
    assert!(
        leftover <= 254,
        "test fixture needs more than one summary character of headroom; leftover={leftover}"
    );

    let at_limit = fault_with_frames_and_summary_extra(frame_count, leftover);
    let encoded = serde_json::to_vec(&at_limit).expect("value at the exact limit must serialize");
    assert_eq!(encoded.len(), MAX_FAULT_ENCODED_BYTES);
    assert!(at_limit.validate().is_ok());

    // Padding `summary` by one more character while shrinking nothing else must now exceed the
    // limit and fail closed on both serialize and deserialize.
    let mut wire = serde_json::to_value(at_limit.clone()).unwrap();
    let mut over_summary = wire["summary"].as_str().unwrap().to_owned();
    over_summary.push('x');
    wire["summary"] = json!(over_summary.clone());
    assert!(serde_json::from_value::<BackendFault>(wire).is_err());

    let mut over_limit = at_limit;
    over_limit.summary = BoundedString256::new(over_summary).unwrap();
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

    let mut value = serde_json::to_value(fault()).unwrap();
    value["action"] = json!("retry");
    value["retry"] = json!("not_retryable");
    assert!(serde_json::from_value::<BackendFault>(value).is_err());
}
