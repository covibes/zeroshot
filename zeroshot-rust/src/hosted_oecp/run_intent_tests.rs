use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::run_intent::{
    decode_submission, digest_bytes, RunIntentExecutor, RunIntentIdentity, RunIntentLookup,
    RunIntentStatus, RunIntentSubmission, RunIntentSubmitError,
};
use super::run_intent_test_support::{
    encoded_envelope, envelope, get_request, hosted_authority, http_exchange, put_request,
    response_json, response_status, CAPABILITY, INTENT_ID,
};
use super::server::RUN_INTENT_PORT;

#[test]
fn v2_is_closed_credential_free_and_digest_checked_before_parsing() {
    let valid = envelope();
    let encoded = serde_json::to_string(&valid).expect("fixture serializes");
    for forbidden in ["credentials", "environment", "authorityOverride", "apiKey"] {
        assert!(!encoded.contains(forbidden));
    }

    let body = encoded_envelope();
    let wrong = RunIntentIdentity::new(INTENT_ID.to_owned(), format!("sha256:{}", "a".repeat(64)));
    assert_eq!(
        decode_submission(wrong, b"{not json")
            .err()
            .expect("digest is checked first"),
        "digest_mismatch"
    );

    for field in [
        "credentials",
        "environment",
        "authority",
        "authorityOverride",
    ] {
        let mut invalid = valid.clone();
        invalid
            .as_object_mut()
            .expect("envelope object")
            .insert(field.to_owned(), json!({ "token": "secret" }));
        assert_invalid(invalid);
    }
    let mut old = valid.clone();
    old["version"] = json!("zeroshot.run-intent/v1");
    assert_invalid(old);

    for field in [
        "repository",
        "baseRevision",
        "provider",
        "model",
        "modelLevel",
        "endpoint",
        "runtimeProfiles",
        "isolationProfile",
        "providerProfile",
        "credentials",
        "environment",
        "authority",
        "authorityOverride",
    ] {
        let mut input_authority = valid.clone();
        input_authority["input"][field] = json!("client-owned");
        assert_invalid(input_authority);
    }

    let mut graph_secret = valid;
    graph_secret["graph"]["root"]["credentials"] = json!({"token": "secret"});
    assert_invalid(graph_secret);

    let decoded = decode_submission(
        RunIntentIdentity::new(INTENT_ID.to_owned(), digest_bytes(&body)),
        &body,
    )
    .expect("closed v2 envelope remains valid");
    let authority = hosted_authority();
    let request = decoded
        .input
        .hosted_request(&authority)
        .expect("server authority completes the job input");
    assert_eq!(request.repository, authority.repository());
    assert_eq!(request.provider, authority.provider());
    assert_eq!(request.model_level, authority.model_level());
}

fn assert_invalid(value: Value) {
    let body = serde_json::to_vec(&value).expect("invalid fixture serializes");
    let identity = RunIntentIdentity::new(INTENT_ID.to_owned(), digest_bytes(&body));
    assert_eq!(
        decode_submission(identity, &body)
            .err()
            .expect("shape must be rejected"),
        "invalid_run_intent"
    );
}

#[derive(Default)]
struct FakeExecutor {
    submitted: AtomicUsize,
    status: Mutex<Option<RunIntentStatus>>,
}

#[async_trait]
impl RunIntentExecutor for FakeExecutor {
    async fn submit(
        &self,
        _submission: RunIntentSubmission,
    ) -> Result<RunIntentStatus, RunIntentSubmitError> {
        self.submitted.fetch_add(1, Ordering::SeqCst);
        Ok(self
            .status
            .lock()
            .await
            .clone()
            .unwrap_or(RunIntentStatus::Running))
    }

    async fn lookup(&self, _identity: &RunIntentIdentity) -> RunIntentLookup {
        self.status
            .lock()
            .await
            .clone()
            .map(RunIntentLookup::Found)
            .unwrap_or(RunIntentLookup::NotFound)
    }
}

#[tokio::test]
async fn internal_http_put_and_get_match_zero_cloud_status_algebra() {
    assert_eq!(RUN_INTENT_PORT, 8_084);
    let fake = Arc::new(FakeExecutor::default());
    let executor: Arc<dyn RunIntentExecutor> = fake.clone();
    let body = encoded_envelope();
    let digest = digest_bytes(&body);
    let response = http_exchange(
        Arc::clone(&executor),
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(response_status(&response), 202);
    assert_eq!(response_json(&response), json!({"state": "running"}));
    assert_eq!(fake.submitted.load(Ordering::SeqCst), 1);

    *fake.status.lock().await = Some(RunIntentStatus::Succeeded(json!({
        "status": "succeeded",
        "summary": "done",
        "artifacts": []
    })));
    let response = http_exchange(executor, get_request(INTENT_ID, &digest)).await;
    assert_eq!(response_status(&response), 200);
    assert_eq!(response_json(&response)["state"], "succeeded");
}

#[tokio::test]
async fn http_rejects_digest_mismatch_without_submitting() {
    let fake = Arc::new(FakeExecutor::default());
    let executor: Arc<dyn RunIntentExecutor> = fake.clone();
    let body = encoded_envelope();
    let wrong_digest = format!("sha256:{}", "a".repeat(64));
    let response = http_exchange(executor, put_request(INTENT_ID, &wrong_digest, &body)).await;
    assert_eq!(response_status(&response), 409);
    assert_eq!(
        response_json(&response),
        json!({"state": "failed", "error_code": "digest_mismatch"})
    );
    assert_eq!(fake.submitted.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn http_rejects_wrong_runtime_capability_without_submitting() {
    let fake = Arc::new(FakeExecutor::default());
    let executor: Arc<dyn RunIntentExecutor> = fake.clone();
    let body = encoded_envelope();
    let digest = digest_bytes(&body);
    let request = String::from_utf8(put_request(INTENT_ID, &digest, &body))
        .expect("request is UTF-8")
        .replace(CAPABILITY, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
        .into_bytes();
    let response = http_exchange(executor, request).await;
    assert_eq!(response_status(&response), 401);
    assert_eq!(fake.submitted.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn http_rejects_signed_content_length_without_submitting() {
    let fake = Arc::new(FakeExecutor::default());
    let executor: Arc<dyn RunIntentExecutor> = fake.clone();
    let body = encoded_envelope();
    let digest = digest_bytes(&body);
    let request = String::from_utf8(put_request(INTENT_ID, &digest, &body))
        .expect("request is UTF-8")
        .replace(
            &format!("Content-Length: {}", body.len()),
            &format!("Content-Length: +{}", body.len()),
        )
        .into_bytes();
    let response = http_exchange(executor, request).await;
    assert_eq!(response_status(&response), 400);
    assert_eq!(fake.submitted.load(Ordering::SeqCst), 0);
}
