use super::*;
#[tokio::test]
async fn cancelled_connection_cannot_strand_reserved_admission() {
    let mut fixture = RuntimeFixture::new(10_000);
    let gate = Arc::new(GatedWorktree::default());
    fixture.backend.worktree = gate.clone();
    let cancellation = CancellationSignal::default();
    let mut context = ConnectionContext::default();
    context.cancellation = cancellation.clone();
    let backend = fixture.backend.clone();
    let apply_task = tokio::spawn(async move {
        backend
            .apply(&context, apply("hosted-cancelled-reservation"))
            .await
    });
    gate.entered.notified().await;
    cancellation.cancel();
    apply_task.abort();
    gate.allow();

    for _ in 0..100 {
        let get = fixture
            .backend
            .get(&ConnectionContext::default(), GetParams::default())
            .await
            .expect("get after cancellation");
        if get.status.phase == Phase::Empty && get.spec.is_none() {
            let applied = fixture
                .backend
                .apply(
                    &ConnectionContext::default(),
                    apply("hosted-after-cancelled-reservation"),
                )
                .await
                .expect("cleared reservation admits one run");
            fixture
                .backend
                .stop(
                    &ConnectionContext::default(),
                    stop_params(
                        StopMode::Force,
                        applied.generation.expect("generation"),
                        "hosted-after-cancel-stop",
                    ),
                )
                .await
                .expect("cleanup admitted worker");
            return;
        }
        sleep(Duration::from_millis(10)).await;
    }
    panic!("cancelled reservation remained Admitting");
}

#[tokio::test]
async fn launch_boundary_only_restores_empty_before_a_possible_process() {
    let mut prelaunch = RuntimeFixture::new(10_000);
    prelaunch.backend.worker_command.program = "/definitely/missing/hosted-worker".to_owned();
    prelaunch
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("hosted-definite-prelaunch"),
        )
        .await
        .expect_err("missing executable is a definite pre-launch failure");
    let empty = prelaunch
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("get after pre-launch failure");
    assert_eq!(empty.status.phase, Phase::Empty);
    assert!(empty.status.current_run_id.is_none());
    assert_eq!(prelaunch.proxy.calls.load(Ordering::SeqCst), 0);

    let mut possible_launch = RuntimeFixture::new(10_000);
    possible_launch.backend.worker_command = possible_launch._worker.command("bad-start", 0);
    possible_launch
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("hosted-possible-launch"),
        )
        .await
        .expect_err("invalid start receipt fails apply");
    let consumed = possible_launch
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect_err("possible launch fails terminally without fake Finished");
    assert_eq!(consumed.code, "FINALIZATION_FAILED");
    assert_eq!(possible_launch.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(possible_launch.worktree.calls.load(Ordering::SeqCst), 1);
    assert_eq!(possible_launch.delivery.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn oversized_start_frame_is_rejected_before_process_or_run_commit() {
    let fixture = RuntimeFixture::new(10_000);
    let mut params = apply("hosted-oversized-prelaunch");
    params.input.as_mut().expect("seed input")["prompt"] = json!("x".repeat(70 * 1024));
    fixture
        .backend
        .apply(&ConnectionContext::default(), params)
        .await
        .expect_err("oversized worker start frame is rejected before launch");

    let get = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("get after oversized prelaunch rejection");
    assert_eq!(get.status.phase, Phase::Empty);
    assert!(get.status.current_run_id.is_none());
    assert!(!fixture._worker.pids_path().exists());
    assert_eq!(fixture.worktree.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn malformed_start_delivery_failure_never_fakes_finished() {
    let mut fixture = RuntimeFixture::with_faults(10_000, false, true);
    fixture.backend.worker_command = fixture._worker.command("bad-start", 0);
    let (mut stream, _handle) = watch_fixture(&fixture).await;
    fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("hosted-malformed-delivery-failure"),
        )
        .await
        .expect_err("invalid start receipt fails after trusted delivery attempt");

    let mut events = Vec::new();
    loop {
        let item = timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("failed-start watch close deadline");
        let Some(item) = item else {
            break;
        };
        let WatchStreamItem::Record(record) = item else {
            panic!("hosted watch must not overflow")
        };
        events.push(record.event);
    }
    assert_eq!(events.len(), 3);
    let WatchEvent::NodeEnd { outcome, .. } = &events[2] else {
        panic!("third event is NodeEnd")
    };
    assert_eq!(outcome.error_code(), Some(WorkerErrorCode::Malformed));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, WatchEvent::Finished { .. }))
    );
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 0);
    assert!(!fixture.delivery.observed_mutation.load(Ordering::SeqCst));
    let get_error = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect_err("failed trusted delivery is not projected as Finished");
    assert_eq!(get_error.code, "FINALIZATION_FAILED");
}

#[tokio::test]
async fn dry_run_cas_diff_is_deterministic_and_mutation_free() {
    let fixture = RuntimeFixture::new(25);
    assert_empty_dry_run(&fixture).await;
    assert_committed_dry_run(&fixture).await;
}

async fn assert_empty_dry_run(fixture: &RuntimeFixture) {
    let before = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("empty get");
    let dry = dry_params(graph(10_000), Generation::new(0).expect("empty generation"));
    let first = fixture
        .backend
        .apply(&ConnectionContext::default(), dry.clone())
        .await
        .expect("dry run");
    let second = fixture
        .backend
        .apply(&ConnectionContext::default(), dry)
        .await
        .expect("deterministic dry run");
    assert_eq!(first, second);
    let diff = first.diff.expect("dry run diff");
    assert_eq!(diff.added.len(), 1);
    assert!(diff.removed.is_empty());
    assert!(diff.changed.is_empty());
    assert!(
        fixture
            .backend
            .apply(
                &ConnectionContext::default(),
                dry_params(graph(10_000), Generation::new(1).expect("stale generation")),
            )
            .await
            .is_err()
    );
    let after = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("get after dry runs");
    assert_eq!(before.spec, after.spec);
    assert_eq!(before.status, after.status);
    assert_eq!(before.at_cursor, after.at_cursor);
}

async fn assert_committed_dry_run(fixture: &RuntimeFixture) {
    let applied = fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("hosted-dry-run-generation"),
        )
        .await
        .expect("commit one run");
    fixture.wait_finished().await;
    let generation = applied.generation.expect("committed generation");
    let before = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("committed get");
    let matching = fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            dry_params(graph(10_000), generation),
        )
        .await
        .expect("matching generation dry run");
    assert!(matching.diff.expect("matching diff").is_empty());
    let changed = fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            dry_params(graph(9_999), generation),
        )
        .await
        .expect("changed graph dry run");
    assert_eq!(changed.diff.expect("changed diff").changed.len(), 1);
    let after = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("get after committed dry runs");
    assert_eq!(before.spec, after.spec);
    assert_eq!(before.status, after.status);
    assert_eq!(before.at_cursor, after.at_cursor);
}

fn dry_params(graph: GraphSpec, generation: Generation) -> ApplyParams {
    ApplyParams {
        graph,
        input: None,
        dry_run: true,
        if_generation: Some(generation),
        idempotency_key: None,
    }
}

#[tokio::test]
async fn phase_statuses_are_stamped_with_their_durable_record_cursor() {
    let fixture = RuntimeFixture::new(25);
    let (_receipt, mut stream, _handle) = fixture
        .backend
        .watch(&ConnectionContext::default(), WatchParams::default(), 16)
        .await
        .expect("watch before apply");
    fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("hosted-stamped-cursors"),
        )
        .await
        .expect("apply");
    loop {
        let WatchStreamItem::Record(record) = timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("cursor event deadline")
            .expect("watch item")
        else {
            panic!("cursor watch overflowed")
        };
        match record.event {
            WatchEvent::Phase { status, .. } => {
                assert_eq!(status.at_cursor.as_ref(), Some(&record.cursor));
            }
            WatchEvent::Finished { final_status, .. } => {
                assert_eq!(final_status.at_cursor.as_ref(), Some(&record.cursor));
                let get = fixture
                    .backend
                    .get(&ConnectionContext::default(), GetParams::default())
                    .await
                    .expect("terminal get");
                assert_eq!(get.at_cursor.as_ref(), Some(&record.cursor));
                break;
            }
            _ => {}
        }
    }
}
#[tokio::test]
async fn canonical_watch_is_ordered_bounded_and_secret_free() {
    let fixture = RuntimeFixture::new(25);
    let events = apply_and_collect(&fixture, "hosted-events-1").await;
    assert_eq!(events.len(), 4);
    assert!(matches!(events[0], WatchEvent::Phase { .. }));
    assert!(matches!(events[1], WatchEvent::NodeBegin { .. }));
    assert!(matches!(events[2], WatchEvent::NodeEnd { .. }));
    assert!(matches!(events[3], WatchEvent::Finished { .. }));
    let encoded = serde_json::to_string(&events).expect("events serialize");
    assert!(!encoded.contains("OPENROUTER_INPUT_CANARY"));
    assert!(!encoded.contains("OPENROUTER_STDERR_CANARY"));
    assert!(!encoded.contains("OPENROUTER_RESULT_CANARY"));
    let reconnect = match fixture
        .backend
        .watch(&ConnectionContext::default(), WatchParams::default(), 16)
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("finished live task accepted reconnect"),
    };
    assert_eq!(reconnect.code, GONE);
}
#[tokio::test]
async fn fixed_authority_mismatches_do_not_allocate_or_consume_the_run() {
    let fixture = RuntimeFixture::new(25);
    for (field, value, code, key) in [
        (
            "repository",
            json!("other/repository"),
            "HOSTED_REPOSITORY_MISMATCH",
            "authority-repository",
        ),
        (
            "provider",
            json!("claude"),
            "HOSTED_PROVIDER_MISMATCH",
            "authority-provider",
        ),
        (
            "modelLevel",
            json!("level3"),
            "HOSTED_PROVIDER_MISMATCH",
            "authority-model",
        ),
    ] {
        let mut params = apply(key);
        params.input.as_mut().unwrap()[field] = value;
        let error = fixture
            .backend
            .apply(&ConnectionContext::default(), params)
            .await
            .expect_err("authority mismatch must fail before allocation");
        assert_eq!(error.code, code);
        assert!(!fixture._worker.pids_path().exists());
        let state = fixture
            .backend
            .get(&ConnectionContext::default(), GetParams::default())
            .await
            .expect("rejected authority leaves capsule empty");
        assert_eq!(state.status.phase, Phase::Empty);
    }

    let accepted = fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("authority-valid-after-rejections"),
        )
        .await
        .expect("valid authority remains admissible");
    assert_eq!(accepted.phase, Phase::Running);
    fixture.wait_finished().await;
}

#[tokio::test]
async fn artifact_source_is_rejected_before_worker_allocation() {
    let fixture = RuntimeFixture::new(25);
    let mut params = apply("artifact-source-rejected");
    let input = params.input.as_mut().expect("input");
    input["source"] = json!("artifact");
    input.as_object_mut().expect("record").remove("prompt");
    input["artifacts"] = json!([{
        "artifactId": "artifact-123",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "byteLength": 42,
        "mediaType": "application/json",
        "typeId": "openengine.result@1",
        "producer": { "node": "work", "worker": "legacy.zeroshot.ship@1" },
        "lineage": { "generation": 7, "runId": "run-9", "attempt": 1 },
        "redaction": "internal"
    }]);
    let error = fixture
        .backend
        .apply(&ConnectionContext::default(), params)
        .await
        .expect_err("artifact input must fail before allocation");
    assert_eq!(error.code, "HOSTED_ARTIFACT_UNSUPPORTED");
    assert!(!fixture._worker.pids_path().exists());
    let state = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("artifact rejection leaves capsule empty");
    assert_eq!(state.status.phase, Phase::Empty);
}

#[tokio::test]
async fn process_result_is_delivered_once_after_cleanup_and_tree_death() {
    let fixture = RuntimeFixture::new(25);
    let first = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-apply-1"))
        .await
        .expect("apply starts real worker");
    assert_eq!(first.phase, Phase::Running);
    fixture.wait_finished().await;

    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    assert!(!fixture.delivery.ordering_failed.load(Ordering::SeqCst));

    let replay = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-apply-1"))
        .await
        .expect("same apply replays");
    assert_eq!(replay.run_id, first.run_id);
    assert!(replay.deduped);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    let mut reused = apply("hosted-apply-1");
    reused.input = Some(json!({
        "source": "prompt",
        "prompt": "different request",
        "artifacts": [],
        "isolationProfile": "isolation.prepared-worktree@1",
        "providerProfile": "provider.hosted-direct@1",
        "repository": "the-open-engine/zeroshot",
        "provider": "codex",
        "modelLevel": "level2"
    }));
    let reuse_error = fixture
        .backend
        .apply(&ConnectionContext::default(), reused)
        .await
        .expect_err("same key with different parameters is rejected");
    assert_eq!(
        reuse_error.code,
        openengine_cluster_protocol::IDEMPOTENCY_REUSE
    );

    let conflict = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-apply-2"))
        .await
        .expect_err("distinct second apply is rejected");
    assert_eq!(conflict.code, openengine_cluster_protocol::RUN_CONFLICT);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
}
