use super::*;

/// Regression test: cancelling a subscription on a run that never publishes again used to leak
/// its streaming task and channel forever. The task is parked inside `next_live`'s
/// `receiver.recv().await` whenever it is idle, and dropping the old `WatchHandle` on cancel never
/// woke it -- nothing rechecks `WatchEventStream`'s cancelled flag until the stream's next poll,
/// which never comes for an idle run. A leaked task only surfaces at shutdown: `serve_ndjson`
/// waits out the full `SHUTDOWN_GRACE_PERIOD` before force-aborting whatever tasks remain, so
/// shutdown taking close to that grace period (rather than resolving promptly) is the symptom.
#[tokio::test]
async fn cancelling_an_idle_subscription_releases_its_task_promptly() {
    let (_store, mut harness) = empty_watch_harness(8);

    let subscription_id = open_watch(&mut harness, 1).await;

    // Cancel while idle: no event is ever published on this run, so the streaming task is parked
    // awaiting the next live event with nothing left to ever wake it via the old flag-only design.
    write_line(&mut harness.write, &cancel_line(&subscription_id)).await;
    // A subsequent unary request on the same connection only answers after the read loop has
    // already processed (and synchronously applied) the preceding cancel line.
    write_line(&mut harness.write, &request_line(2, "get", json!({}))).await;
    let sync_response = read_value(&mut harness.read).await;
    assert_eq!(sync_response.assert_at("id"), 2);
    assert!(sync_response.get("result").is_some(), "{sync_response}");

    let started = tokio::time::Instant::now();
    shut_down(harness).await;
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(150),
        "shutdown took {elapsed:?}, close to or exceeding SHUTDOWN_GRACE_PERIOD -- the cancelled \
         idle subscription's task was likely never woken and had to be force-aborted instead of \
         exiting on its own"
    );
}
