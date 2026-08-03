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
        .expect("get after possible launch");
    assert_eq!(consumed.status.phase, Phase::Finished);
    assert!(consumed.status.current_run_id.is_some());
    assert_eq!(possible_launch.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(possible_launch.delivery.calls.load(Ordering::SeqCst), 0);
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
