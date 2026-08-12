#[path = "support/native_execution.rs"]
pub mod native_execution;
#[path = "support/native_pi.rs"]
pub mod native_pi;
#[path = "support/native_pi_predecessor.rs"]
pub mod native_pi_predecessor;
#[path = "support/native_process.rs"]
pub mod native_process;
#[path = "support/native_recovery.rs"]
pub mod native_recovery;

use native_pi::{FakeMode, PiFixture, PROMPT, RESPONSE};
use native_pi_predecessor::seed_codex_terminal;
use native_process::{
    apply_params, assert_finished_failure, assert_one_deduped, assert_running, concurrent_apply,
    initialize_and_get_finished, rpc_domain_code, TempState,
};
use openengine_cluster_protocol::{
    ApplyParams, GetParams, Phase, PlanParams, TerminalResult, GENERATION_CONFLICT,
    IDEMPOTENCY_REUSE,
};
use serde_json::json;

fn apply_request(key: &str) -> ApplyParams {
    apply_params(
        zeroshot_engine::native_pi_foreground_graph(),
        json!({ "prompt": PROMPT }),
        key,
    )
}

fn successful_response(terminal: &TerminalResult) -> &str {
    let TerminalResult::Succeeded { output } = terminal else {
        panic!("expected successful Pi result: {terminal:?}");
    };
    output["response"].as_str().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pi_overflow_compaction_can_retry_before_settlement() {
    let fixture = PiFixture::new("pi-compaction", FakeMode::COMPACTION);
    let (process, client) = fixture.spawn("pi-compaction", true);
    client.initialize().await.unwrap();
    client.apply(apply_request("pi-compaction")).await.unwrap();
    let result = client.get(GetParams::default()).await.unwrap();
    assert_eq!(
        successful_response(result.terminal_result.as_ref().unwrap()),
        RESPONSE
    );
    assert_eq!(fixture.invocation_count(), 1);
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pi_process_turn_uses_exact_private_contract_and_restarts_without_a_second_invocation() {
    let fixture = PiFixture::new("pi-foreground", FakeMode::SUCCESS);
    let (process, client) = fixture.spawn("pi-foreground", true);
    client.initialize().await.unwrap();
    assert!(
        std::fs::read_dir(fixture.state.path())
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with("native-pi-")),
        "opening and planning must leave the Pi runtime dormant"
    );
    let plan = client
        .plan(PlanParams {
            graph: zeroshot_engine::native_pi_foreground_graph(),
        })
        .await
        .unwrap();
    assert!(plan.ok, "{:#?}", plan.diagnostics);
    let request = apply_request("pi-once");
    client.apply(request.clone()).await.unwrap();
    let before = client.get(GetParams::default()).await.unwrap();
    assert_eq!(before.status.phase, Phase::Finished);
    assert_eq!(
        successful_response(before.terminal_result.as_ref().unwrap()),
        RESPONSE
    );
    assert_eq!(fixture.invocation_count(), 1);
    assert_eq!(
        std::fs::read_dir(fixture.borrowed_workspace.path())
            .unwrap()
            .count(),
        1,
        "Pi must not mutate the borrowed workspace"
    );
    drop(client);
    process.join_success().await;

    let (restart, restart_client) = fixture.spawn("pi-foreground", true);
    assert_eq!(
        restart_client.initialize().await.unwrap().status.phase,
        Phase::Finished
    );
    assert_eq!(
        restart_client.get(GetParams::default()).await.unwrap(),
        before
    );
    assert!(restart_client.apply(request).await.unwrap().deduped);
    assert_eq!(fixture.invocation_count(), 1);
    drop(restart_client);
    restart.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unavailable_pi_contract_rejects_before_dispatch() {
    for mode in [
        FakeMode::BAD_VERSION,
        FakeMode::MISSING_FLAG,
        FakeMode::MISSING_MODEL,
    ] {
        let label = format!("pi-preflight-{}", mode.label());
        let fixture = PiFixture::new(&label, mode);
        let (process, client) = fixture.spawn(&label, true);
        client.initialize().await.unwrap();
        assert!(client.apply(apply_request("preflight")).await.is_err());
        assert_running(&client).await;
        assert_eq!(fixture.invocation_count(), 0);
        drop(client);
        process.join_success().await;
    }

    let fixture = PiFixture::new("pi-preflight-credential", FakeMode::SUCCESS);
    let (process, client) = fixture.spawn("pi-preflight-credential", false);
    client.initialize().await.unwrap();
    assert!(
        client
            .apply(apply_request("missing-credential"))
            .await
            .is_err()
    );
    assert_eq!(fixture.invocation_count(), 0);
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_or_nonterminal_pi_streams_settle_closed_failures() {
    for mode in [
        FakeMode::UNKNOWN_EVENT,
        FakeMode::TRUNCATED,
        FakeMode::TRAILING,
        FakeMode::NO_SESSION,
        FakeMode::INCOMPLETE,
        FakeMode::TOOL_MESSAGE,
        FakeMode::TOOL_MESSAGE_START,
        FakeMode::TOOL_AGENT_END,
        FakeMode::MALFORMED_USAGE,
        FakeMode::ERROR,
        FakeMode::ABORTED,
        FakeMode::DEFERRED,
    ] {
        let label = format!("pi-output-{}", mode.label());
        let fixture = PiFixture::new(&label, mode);
        let (process, client) = fixture.spawn(&label, true);
        client.initialize().await.unwrap();
        client.apply(apply_request("closed-failure")).await.unwrap();
        assert_finished_failure(&client).await;
        assert_eq!(fixture.invocation_count(), 1);
        drop(client);
        process.join_success().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_pi_applies_share_one_provider_authority() {
    let fixture = PiFixture::new("pi-concurrent", FakeMode::SUCCESS);
    let (process, client) = fixture.spawn("pi-concurrent", true);
    client.initialize().await.unwrap();
    let (first, second) = concurrent_apply(&client, apply_request("same-key")).await;
    assert_one_deduped(&first, &second);

    let mut reuse = apply_request("same-key");
    reuse.input = Some(json!({ "prompt": "different" }));
    assert_eq!(
        rpc_domain_code(&client.apply(reuse).await.unwrap_err()),
        Some(IDEMPOTENCY_REUSE)
    );
    assert_eq!(
        rpc_domain_code(
            &client
                .apply(apply_request("distinct-key"))
                .await
                .unwrap_err()
        ),
        Some(GENERATION_CONFLICT)
    );
    assert_eq!(fixture.invocation_count(), 1);
    drop(client);
    process.join_success().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn codex_only_predecessor_reopens_and_still_reverifies_its_artifact() {
    let clean = TempState::new("pi-codex-predecessor");
    let (clean_artifact, _) = seed_codex_terminal(&clean, "pi-codex-predecessor").await;
    let (process, client) = native_process::spawn(clean.path(), "pi-codex-predecessor");
    let result = initialize_and_get_finished(&client).await;
    assert_eq!(
        result.terminal_result,
        Some(TerminalResult::Succeeded {
            output: json!({
                "summary": "seeded predecessor",
                "validationArtifact": clean_artifact
            })
        })
    );
    drop(client);
    process.join_success().await;

    let corrupt = TempState::new("pi-codex-predecessor-corrupt");
    let (artifact, root) = seed_codex_terminal(&corrupt, "pi-codex-predecessor-corrupt").await;
    let digest = artifact.sha256.as_str();
    std::fs::write(
        root.join("blobs/sha256").join(&digest[..2]).join(digest),
        b"corrupt",
    )
    .unwrap();
    let (process, client) = native_process::spawn(corrupt.path(), "pi-codex-predecessor-corrupt");
    assert!(client.initialize().await.is_err());
    drop(client);
    assert!(
        process
            .join_failure()
            .await
            .contains("execution state is invalid")
    );
}
