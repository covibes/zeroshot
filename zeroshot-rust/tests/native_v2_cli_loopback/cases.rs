use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn shipped_cli_reaches_one_target_controller_over_http_and_websocket() {
    if !cli_prerequisites_available() {
        return;
    }
    let host = LoopbackHost::start().await;
    let root = temp_root();
    let config = root.path("config");
    let (runtime, graph, input) = write_fixture_files(&root);
    let binary = env!("CARGO_BIN_EXE_zeroshot-rust");
    let (stdout, stderr) = run_cli_command(
        cli_command(CliInvocation {
            script: &shell_script(),
            label: "acceptance",
            binary,
            origin: &host.origin,
            config: &config,
            runtime: &runtime,
            graph: &graph,
            input: &input,
            extra: None,
            source_revision: Some(TEST_SOURCE_REVISION),
        }),
        Duration::from_secs(60),
        "shipped CLI acceptance",
    )
    .await;
    assert!(stderr.contains("ABCD-EFGH"), "device code was not surfaced");
    let run_id = stdout
        .lines()
        .find_map(|line| line.strip_prefix("RUN_ID="))
        .assert_value_with("run ID marker");
    assert!(stdout.contains("DETACHED={\"runId\":"));
    assert!(stdout.contains("LIST={\"runs\":"));
    assert!(stdout.contains("ACTIVE={\"runId\":"));
    assert!(stdout.contains("WATCH={\"subscriptionId\":"));
    assert!(stdout.contains("\"phase\":\"queued\""));
    assert!(stdout.contains("LOGS={\"subscriptionId\":"));
    assert!(stdout.contains("acceptance-live-output"));
    assert!(stdout.contains("ATTACH={\"subscriptionId\":"));
    assert!(stdout.contains("\"type\":\"working\""));
    assert!(stdout.contains("FORCED={\"runId\":"));
    assert!(stdout.contains("TERMINAL={\"runId\":"));
    assert!(stdout.contains("\"phase\":\"finished\""));
    assert!(stdout.matches(run_id).count() >= 8);
    assert!(!stdout.contains("capsule"));

    let registry = std::fs::read_to_string(config.join("targets.json")).assert_value();
    for forbidden in ["control-token", "refresh-token", "oecp-token", "capsule"] {
        assert!(!registry.contains(forbidden));
    }
    assert!(Path::new(&config).join("targets.json").is_file());
}

#[tokio::test(flavor = "multi_thread")]
async fn shipped_cli_drives_direct_and_ci_feedback_delivery_to_confirmed_merge() {
    if !cli_prerequisites_available() {
        return;
    }
    for (scenario, name, expected_repairs, expected_reviews) in [
        (DeliveryScenario::NoCi, "no-ci", 0, 1),
        (DeliveryScenario::CiFailureThenMerge, "ci-feedback", 1, 2),
    ] {
        let root = temp_root();
        let fixture = DeliveryFixture::new(&root, name);
        let source_revision = fixture.base_revision.clone();
        let authority = Arc::new(DeliveryAuthority::new(fixture.remote.clone(), scenario));
        let repairs = Arc::new(AtomicUsize::new(0));
        let allocator = Arc::new(DeliveryAllocator {
            fixture,
            authority: authority.clone(),
            repairs: repairs.clone(),
            lifecycle: ImmediateAllocator::default(),
        });
        let host = LoopbackHost::start_with_factory(Arc::new(FixedAllocatorFactory {
            allocator,
            delivery_policy: DeliveryPolicy::Required,
        }))
        .await;
        let config = root.path(&format!("{name}-config"));
        let (runtime, graph, input) = write_delivery_fixture_files(&root);
        let binary = env!("CARGO_BIN_EXE_zeroshot-rust");
        let submission_key = format!("delivery-{name}");
        let mut command = cli_command(CliInvocation {
            script: &delivery_shell_script(),
            label: name,
            binary,
            origin: &host.origin,
            config: &config,
            runtime: &runtime,
            graph: &graph,
            input: &input,
            extra: Some(&submission_key),
            source_revision: Some(&source_revision),
        });
        command.env(GITHUB_TOKEN_ENV, "test-token");
        let (stdout, stderr) = run_cli_command(
            command,
            Duration::from_secs(60),
            &format!("shipped CLI {name} delivery acceptance"),
        )
        .await;
        assert!(stderr.contains("ABCD-EFGH"));
        assert!(stdout.contains("DELIVERY={\"runId\":"));
        assert!(
            stdout.contains("\"terminalResult\":{\"status\":\"succeeded\""),
            "delivery run did not succeed\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );
        assert!(stdout.contains("\"mode\":\"merge\""));
        assert!(stdout.contains("\"outcome\":\"merged\""));
        assert_eq!(repairs.load(Ordering::SeqCst), expected_repairs);
        assert_eq!(authority.reviews.load(Ordering::SeqCst), expected_reviews);
        assert_eq!(authority.merge_requests.load(Ordering::SeqCst), 1);
        assert!(authority.inspections.load(Ordering::SeqCst) >= expected_reviews);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn shipped_cli_observes_capsule_loss_as_terminal_without_replacement() {
    if !cli_prerequisites_available() {
        return;
    }
    let allocator = Arc::new(ImmediateAllocator::default());
    let host = LoopbackHost::start_with_factory(Arc::new(FixedAllocatorFactory {
        allocator: allocator.clone(),
        delivery_policy: DeliveryPolicy::Required,
    }))
    .await;
    let root = temp_root();
    let config = root.path("loss-config");
    let (runtime, graph, input) = write_fixture_files(&root);
    let binary = env!("CARGO_BIN_EXE_zeroshot-rust");
    let command = cli_command(CliInvocation {
        script: &loss_shell_script(),
        label: "loss-acceptance",
        binary,
        origin: &host.origin,
        config: &config,
        runtime: &runtime,
        graph: &graph,
        input: &input,
        extra: None,
        source_revision: Some(TEST_SOURCE_REVISION),
    });
    let acceptance = tokio::spawn(run_cli_command(
        command,
        Duration::from_secs(60),
        "shipped CLI capsule-loss acceptance",
    ));
    tokio::time::timeout(Duration::from_secs(10), async {
        while !allocator.signal_loss() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .assert_value_with("capsule was not allocated before the deadline");
    let (stdout, stderr) = acceptance.await.assert_value();
    assert!(stderr.contains("ABCD-EFGH"));
    assert!(stdout.contains("LOST={\"runId\":"));
    assert!(stdout.contains("\"phase\":\"finished\""));
    assert!(stdout.contains("\"reason\":\"runtime_lost\""));
    assert_eq!(allocator.losses.lock().assert_value().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "manual live provider acceptance; requires root, network, provider/GitHub CLIs, and credentials"]
async fn shipped_cli_runs_one_real_production_provider_lane() {
    let lane = LiveLane::from_environment();
    let scenario = LiveScenario::from_environment();
    let root = temp_root();
    let hosting = live_hosting_config(&root, lane);
    let host =
        LoopbackHost::start_with_factory(Arc::new(ProductionTargetControllerFactory::new(hosting)))
            .await;
    let config = root.path("live-config");
    let (runtime, graph, input) = write_live_fixture_files(&root, lane, scenario);
    let binary = env!("CARGO_BIN_EXE_zeroshot-rust");
    let mut command = cli_command(CliInvocation {
        script: &live_shell_script(),
        label: "live-acceptance",
        binary,
        origin: &host.origin,
        config: &config,
        runtime: &runtime,
        graph: &graph,
        input: &input,
        extra: Some(lane.sentinel()),
        source_revision: None,
    });
    for name in [
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CODEX_API_KEY",
        GITHUB_TOKEN_ENV,
    ] {
        command.env_remove(name);
    }
    let context = format!("shipped CLI live acceptance for {lane:?}/{scenario:?}");
    let (stdout, stderr) = run_cli_command(command, Duration::from_secs(15 * 60), &context).await;
    assert!(stderr.contains("ABCD-EFGH"), "device code was not surfaced");
    assert!(stdout.contains("LIVE={\"runId\":"));
    assert!(stdout.contains("\"phase\":\"finished\""));
    assert!(
        stdout.contains("\"terminalResult\":{\"status\":\"succeeded\""),
        "live run did not succeed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(stdout.contains(&format!("\"mode\":\"{}\"", scenario.mode())));
    assert!(stdout.contains(&format!("\"outcome\":\"{}\"", scenario.expected_outcome())));
    if scenario == LiveScenario::OutputCorrection {
        assert!(
            stdout.contains("NOT_JSON"),
            "invalid first output was absent"
        );
        assert!(
            stdout.matches("Codex turn started").count() >= 2,
            "correction did not run as a second turn in the Codex session"
        );
    }
    if scenario == LiveScenario::CiRepair {
        assert!(
            stdout.contains("required CI checks failed"),
            "delivery never observed the required CI failure"
        );
    }
    assert!(!stdout.contains("capsule"));
}

use openengine_cluster_testkit::assertions::{AssertValue};
