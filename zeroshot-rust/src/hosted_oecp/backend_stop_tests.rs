use super::*;

async fn wait_for_dispatch(fixture: &RuntimeFixture, expected: DispatchState) {
    for _ in 0..100 {
        let get = fixture
            .backend
            .get(&ConnectionContext::default(), GetParams::default())
            .await
            .expect("get pending stop");
        if get
            .status
            .operational
            .as_ref()
            .is_some_and(|status| status.dispatch_state == expected)
        {
            assert_eq!(get.status.phase, Phase::Running);
            return;
        }
        sleep(Duration::from_millis(2)).await;
    }
    panic!("expected stop dispatch state was not observed");
}

#[tokio::test]
async fn concurrent_apply_replay_spawns_and_delivers_once() {
    let fixture = RuntimeFixture::new(10_000);
    let params = apply("hosted-concurrent-apply-1");
    let first_context = ConnectionContext::default();
    let second_context = ConnectionContext::default();
    let (first, second) = tokio::join!(
        fixture.backend.apply(&first_context, params.clone()),
        fixture.backend.apply(&second_context, params),
    );
    let first = first.expect("first concurrent apply");
    let second = second.expect("second concurrent apply");
    assert_eq!(first.run_id, second.run_id);
    assert_ne!(first.deduped, second.deduped);
    fixture
        .backend
        .stop(
            &ConnectionContext::default(),
            StopParams {
                mode: StopMode::Force,
                if_generation: first.generation.expect("committed generation"),
                idempotency_key: IdempotencyKey::new("hosted-concurrent-stop")
                    .expect("stop idempotency key"),
            },
        )
        .await
        .expect("concurrent apply run stops");
    assert_eq!(fixture.proxy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn shutdown_cancels_the_live_worker_before_returning() {
    let fixture = RuntimeFixture::new(10_000);
    fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-shutdown-1"))
        .await
        .expect("apply starts real worker");
    fixture
        .backend
        .shutdown()
        .await
        .expect("host shutdown cleanup");

    let result = fixture
        .backend
        .get(&ConnectionContext::default(), GetParams::default())
        .await
        .expect("get after shutdown");
    assert_eq!(result.status.phase, Phase::Finished);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    assert!(!fixture.delivery.ordering_failed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn force_stop_reaps_before_delivery_and_returns_one_receipt() {
    let fixture = RuntimeFixture::new(10_000);
    let applied = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-stop-1"))
        .await
        .expect("apply starts real worker");
    let (_watch_receipt, mut stream, _watch_handle) = fixture
        .backend
        .watch(&ConnectionContext::default(), WatchParams::default(), 16)
        .await
        .expect("stop watcher");
    let stop_params = StopParams {
        mode: StopMode::Force,
        if_generation: applied.generation.expect("committed generation"),
        idempotency_key: IdempotencyKey::new("hosted-stop-receipt").expect("stop idempotency key"),
    };
    let stopped = fixture
        .backend
        .stop(&ConnectionContext::default(), stop_params.clone())
        .await
        .expect("force stop completes");
    assert_eq!(stopped.phase, Phase::Finished);
    assert_eq!(stopped.effective_mode, StopMode::Force);
    let mut stop_outcome = None;
    let mut finished_stop_mode = None;
    let mut saw_force_stopping = false;
    for _ in 0..6 {
        let item = timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("stop event deadline")
            .expect("stop watch remains live through Finished");
        let WatchStreamItem::Record(record) = item else {
            panic!("stop watch must not overflow")
        };
        match record.event {
            WatchEvent::Phase { status, admission } if admission.is_none() => {
                assert_eq!(status.at_cursor.as_ref(), Some(&record.cursor));
                saw_force_stopping |= status
                    .operational
                    .is_some_and(|value| value.dispatch_state == DispatchState::ForceStopping);
            }
            WatchEvent::NodeEnd { outcome, .. } => stop_outcome = Some(outcome),
            WatchEvent::Finished { stop_mode, .. } => {
                finished_stop_mode = stop_mode;
                break;
            }
            _ => {}
        }
    }
    assert_eq!(
        stop_outcome.and_then(|outcome| outcome.error_code()),
        Some(WorkerErrorCode::Refusal)
    );
    assert_eq!(finished_stop_mode, Some(StopMode::Force));
    assert!(saw_force_stopping);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
    assert!(!fixture.delivery.ordering_failed.load(Ordering::SeqCst));
    let replayed = fixture
        .backend
        .stop(&ConnectionContext::default(), stop_params)
        .await
        .expect("same stop replays");
    assert_eq!(replayed.run_id, stopped.run_id);
    assert!(replayed.deduped);
    assert_eq!(fixture.delivery.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn drain_publishes_dispatch_state_and_preserves_worker_outcome() {
    let fixture = RuntimeFixture::new(150);
    let (_receipt, mut stream, _handle) = fixture
        .backend
        .watch(&ConnectionContext::default(), WatchParams::default(), 16)
        .await
        .expect("watch before drain");
    let applied = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-drain"))
        .await
        .expect("apply");
    let drain = stop_params(
        StopMode::Drain,
        applied.generation.expect("generation"),
        "hosted-drain-stop",
    );
    let backend = fixture.backend.clone();
    let drain_task =
        tokio::spawn(async move { backend.stop(&ConnectionContext::default(), drain).await });
    wait_for_dispatch(&fixture, DispatchState::Draining).await;
    let stopped = drain_task
        .await
        .expect("drain task")
        .expect("drain completes");
    assert_eq!(stopped.accepted_mode, StopMode::Drain);
    assert_eq!(stopped.effective_mode, StopMode::Drain);
    assert!(!stopped.deduped);

    let mut saw_draining = false;
    let mut node_error = None;
    loop {
        let WatchStreamItem::Record(record) = timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("drain event deadline")
            .expect("drain watch item")
        else {
            panic!("drain watch overflowed")
        };
        match record.event {
            WatchEvent::Phase { status, admission } if admission.is_none() => {
                assert_eq!(status.at_cursor.as_ref(), Some(&record.cursor));
                saw_draining |= status
                    .operational
                    .is_some_and(|value| value.dispatch_state == DispatchState::Draining);
            }
            WatchEvent::NodeEnd { outcome, .. } => node_error = outcome.error_code(),
            WatchEvent::Finished { final_status, .. } => {
                assert_eq!(final_status.at_cursor.as_ref(), Some(&record.cursor));
                assert_eq!(stopped.at_cursor, record.cursor);
                break;
            }
            _ => {}
        }
    }
    assert!(saw_draining);
    assert_eq!(node_error, None);
}

#[tokio::test]
async fn fresh_force_escalates_drain_without_key_aliases_or_downgrade() {
    let fixture = RuntimeFixture::new(10_000);
    let applied = fixture
        .backend
        .apply(
            &ConnectionContext::default(),
            apply("hosted-escalation-apply"),
        )
        .await
        .expect("apply");
    let generation = applied.generation.expect("generation");
    let drain = stop_params(StopMode::Drain, generation, "hosted-escalation-drain");
    let force = stop_params(StopMode::Force, generation, "hosted-escalation-force");
    let backend = fixture.backend.clone();
    let drain_for_task = drain.clone();
    let drain_task = tokio::spawn(async move {
        backend
            .stop(&ConnectionContext::default(), drain_for_task)
            .await
    });
    wait_for_dispatch(&fixture, DispatchState::Draining).await;
    let backend = fixture.backend.clone();
    let force_for_task = force.clone();
    let force_task = tokio::spawn(async move {
        backend
            .stop(&ConnectionContext::default(), force_for_task)
            .await
    });
    let drained = drain_task
        .await
        .expect("drain task")
        .expect("drain receipt");
    let forced = force_task
        .await
        .expect("force task")
        .expect("force receipt");
    assert_eq!(drained.accepted_mode, StopMode::Drain);
    assert_eq!(drained.effective_mode, StopMode::Force);
    assert_eq!(forced.accepted_mode, StopMode::Force);
    assert_eq!(forced.effective_mode, StopMode::Force);
    assert!(!drained.deduped);
    assert!(!forced.deduped);
    assert!(
        fixture
            .backend
            .stop(&ConnectionContext::default(), drain.clone())
            .await
            .expect("exact drain replay")
            .deduped
    );
    assert!(
        fixture
            .backend
            .stop(&ConnectionContext::default(), force)
            .await
            .expect("exact force replay")
            .deduped
    );
    assert!(
        fixture
            .backend
            .stop(
                &ConnectionContext::default(),
                stop_params(StopMode::Drain, generation, "hosted-downgrade"),
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn stop_key_cannot_alias_the_committed_apply_key() {
    let fixture = RuntimeFixture::new(10_000);
    let applied = fixture
        .backend
        .apply(&ConnectionContext::default(), apply("hosted-key-domain"))
        .await
        .expect("apply");
    let generation = applied.generation.expect("generation");
    let aliased = fixture
        .backend
        .stop(
            &ConnectionContext::default(),
            stop_params(StopMode::Force, generation, "hosted-key-domain"),
        )
        .await;
    assert!(aliased.is_err());
    fixture
        .backend
        .stop(
            &ConnectionContext::default(),
            stop_params(StopMode::Force, generation, "hosted-key-domain-stop"),
        )
        .await
        .expect("distinct stop key");
}
