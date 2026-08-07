use std::sync::Arc;

use openengine_cluster_protocol::{ApplyParams, GetParams, IdempotencyKey, Phase};
use openengine_cluster_server::{ClusterBackend, ConnectionContext};
use serde_json::json;

use super::run_intent::digest_bytes;
use super::run_intent_test_support::{
    assert_http_replay_and_conflicts, credential_request, direct_input, encoded_envelope, envelope,
    graph, put_request, response_json, response_status, tcp_http_exchange, wait_for_http_not_found,
    wait_for_http_terminal, wait_for_http_terminal_response, HostedServerHarness, TestServices,
    CAPABILITY, INTENT_ID,
};

#[tokio::test]
async fn credential_install_is_authenticated_generic_and_exact_replay_idempotent() {
    let harness = HostedServerHarness::start().await;
    let body = serde_json::to_vec(&json!({
        "githubToken": "git-canary",
        "repository": "the-open-engine/zeroshot",
        "baseRevision": "a".repeat(40),
        "runtime": {
            "provider": "future-provider",
            "executable": "future-cli",
            "model": "future/model",
            "command": "future-cli-wrapper",
            "environment": {
                "FUTURE_PROVIDER_TOKEN": "provider-canary",
                "FUTURE_PROVIDER_ENDPOINT": "https://models.example"
            },
            "files": {".config/future/config.json": "{\"enabled\":true}"},
            "settings": {"defaultProvider": "future-provider"}
        }
    }))
    .expect("credential bundle serializes");

    for _ in 0..2 {
        let response = tcp_http_exchange(
            harness.control_address,
            credential_request(CAPABILITY, &body),
        )
        .await;
        assert_eq!(response_status(&response), 204);
    }

    let mut different = body.clone();
    different.push(b' ');
    let conflict = tcp_http_exchange(
        harness.control_address,
        credential_request(CAPABILITY, &different),
    )
    .await;
    assert_eq!(response_status(&conflict), 409);

    let unauthorized = tcp_http_exchange(
        harness.control_address,
        credential_request("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", &body),
    )
    .await;
    assert_eq!(response_status(&unauthorized), 401);
    harness.shutdown().await;
}

#[tokio::test]
async fn queue_reuses_backend_admission_worker_and_finalization_path() {
    let harness = HostedServerHarness::start().await;
    let body = encoded_envelope();
    let digest = digest_bytes(&body);
    let accepted = tcp_http_exchange(
        harness.control_address,
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(
        response_status(&accepted),
        202,
        "unexpected response: {}",
        response_json(&accepted)
    );
    assert_eq!(response_json(&accepted), json!({"state": "running"}));

    let direct_conflict = harness
        .backend
        .apply(
            &ConnectionContext::default(),
            ApplyParams {
                graph: graph(),
                input: Some(direct_input()),
                dry_run: false,
                if_generation: None,
                idempotency_key: Some(
                    IdempotencyKey::new("direct-after-queue").expect("idempotency key"),
                ),
            },
        )
        .await
        .expect_err("queue and direct paths share one backend admission");
    assert_eq!(
        direct_conflict.code,
        openengine_cluster_protocol::RUN_CONFLICT
    );

    assert_http_replay_and_conflicts(harness.control_address, &body).await;
    let terminal = wait_for_http_terminal(harness.control_address, &digest).await;
    assert_eq!(terminal["state"], "succeeded");
    assert_eq!(
        terminal["result"],
        json!({
            "artifacts": [],
            "summary": "Hosted worker completed",
            "status": "succeeded"
        })
    );
    let serialized = serde_json::to_string(&terminal).expect("terminal response serializes");
    for authority in [
        "the-open-engine/zeroshot",
        "zeroshot/hosted-",
        "pullRequestUrl",
        "headRevision",
        "codex",
        "level2",
    ] {
        assert!(!serialized.contains(authority));
    }
    assert_eq!(harness.services.delivery_calls(), 1);

    let replayed = tcp_http_exchange(
        harness.control_address,
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(response_status(&replayed), 200);
    assert_eq!(response_json(&replayed), terminal);
    assert_eq!(harness.services.delivery_calls(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn queue_rejects_worker_frame_overflow_before_acceptance() {
    let harness = HostedServerHarness::start().await;
    let mut oversized = envelope();
    oversized["input"]["prompt"] = json!("x".repeat(70 * 1_024));
    let body = serde_json::to_vec(&oversized).expect("oversized fixture serializes");
    let digest = digest_bytes(&body);
    let response = tcp_http_exchange(
        harness.control_address,
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(response_status(&response), 400);
    assert_eq!(
        response_json(&response),
        json!({"state": "failed", "error_code": "invalid_run_intent"})
    );
    let state = harness
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("backend remains available after rejection");
    assert_eq!(state.status.phase, Phase::Empty);
    assert!(state.status.current_run_id.is_none());
    assert!(!harness.worker.pids_path().exists());
    harness.shutdown().await;
}

#[tokio::test]
async fn queue_retries_after_transient_precommit_readiness_failure() {
    let services = Arc::new(TestServices::default());
    services.set_worktree_ready(false);
    let harness = HostedServerHarness::start_with_services(Arc::clone(&services)).await;
    let body = encoded_envelope();
    let digest = digest_bytes(&body);
    let accepted = tcp_http_exchange(
        harness.control_address,
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(response_status(&accepted), 202);
    wait_for_http_not_found(harness.control_address, &digest).await;

    services.set_worktree_ready(true);
    let retried = tcp_http_exchange(
        harness.control_address,
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(response_status(&retried), 202);
    let terminal = wait_for_http_terminal(harness.control_address, &digest).await;
    assert_eq!(terminal["state"], "succeeded", "{terminal}");
    assert_eq!(services.delivery_calls(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn deterministic_worker_failure_is_terminal_and_not_retryable() {
    let harness = HostedServerHarness::start_with_worker("bad-result").await;
    let body = encoded_envelope();
    let digest = digest_bytes(&body);
    let accepted = tcp_http_exchange(
        harness.control_address,
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(response_status(&accepted), 202);

    let terminal = wait_for_http_terminal_response(harness.control_address, &digest).await;
    assert_eq!(response_status(&terminal), 422);
    assert_eq!(
        response_json(&terminal),
        json!({"state": "failed", "error_code": "malformed"})
    );
    assert_eq!(harness.services.delivery_calls(), 0);

    let replay = tcp_http_exchange(
        harness.control_address,
        put_request(INTENT_ID, &digest, &body),
    )
    .await;
    assert_eq!(response_status(&replay), 422);
    harness.shutdown_after_runtime_failure().await;
}
