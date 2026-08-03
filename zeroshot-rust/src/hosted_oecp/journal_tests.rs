use std::sync::Arc;
use std::sync::atomic::Ordering;

use openengine_cluster_protocol::{RunId, WatchEvent};
use openengine_cluster_server::admission::StoreError;
use openengine_cluster_server::watch::{
    ObservationStore, SubscribeRequest, WatchEventStream, WatchStreamItem,
};

use super::journal::{EventJournal, MAX_JOURNAL_EVENTS, MAX_JOURNAL_SUBSCRIBERS};

#[tokio::test]
async fn replay_to_live_handoff_resumes_strictly_after_cursor() {
    let journal = Arc::new(EventJournal::new());
    let run_id = RunId::new("run-live");
    let first = journal
        .publish_with(run_id.clone(), |_| WatchEvent::Bookmark)
        .expect("first event");
    let resolved = journal
        .subscribe(
            SubscribeRequest {
                run_id: Some(run_id.clone()),
                from_cursor: Some(first),
            },
            4,
        )
        .await
        .expect("live subscription");
    let (mut stream, _handle) = WatchEventStream::new(journal.clone(), resolved);
    let second = journal
        .publish_with(run_id, |_| WatchEvent::Bookmark)
        .expect("second event");

    let Some(WatchStreamItem::Record(record)) = stream.next().await else {
        panic!("live event must be delivered")
    };
    assert_eq!(record.cursor, second);
}

#[tokio::test]
async fn closed_task_rejects_reconnect_and_subscriber_capacity_is_fixed() {
    let journal = EventJournal::new();
    let run_id = RunId::new("run-bounds");
    journal
        .publish_with(run_id.clone(), |_| WatchEvent::Bookmark)
        .expect("first event");
    let mut subscriptions = Vec::new();
    for _ in 0..MAX_JOURNAL_SUBSCRIBERS {
        subscriptions.push(
            journal
                .subscribe(
                    SubscribeRequest {
                        run_id: Some(run_id.clone()),
                        from_cursor: None,
                    },
                    usize::MAX,
                )
                .await
                .expect("bounded subscriber"),
        );
    }
    assert!(matches!(
        journal
            .subscribe(
                SubscribeRequest {
                    run_id: Some(run_id.clone()),
                    from_cursor: None,
                },
                1,
            )
            .await,
        Err(StoreError::Internal(_))
    ));

    drop(subscriptions);
    journal.close();
    assert!(matches!(
        journal
            .subscribe(
                SubscribeRequest {
                    run_id: Some(run_id),
                    from_cursor: None,
                },
                1,
            )
            .await,
        Err(StoreError::RunGone { .. })
    ));
}

#[tokio::test]
async fn event_and_slow_consumer_bounds_fail_closed() {
    let journal = EventJournal::new();
    let run_id = RunId::new("run-event-bound");
    let resolved = journal
        .subscribe(
            SubscribeRequest {
                run_id: None,
                from_cursor: None,
            },
            1,
        )
        .await
        .expect("bounded subscription");

    for _ in 0..MAX_JOURNAL_EVENTS {
        journal
            .publish_with(run_id.clone(), |_| WatchEvent::Bookmark)
            .expect("event within fixed journal capacity");
    }
    assert!(resolved.overflowed.load(Ordering::Acquire));
    assert!(matches!(
        journal.publish_with(run_id, |_| WatchEvent::Bookmark),
        Err(StoreError::Internal(_))
    ));
}
