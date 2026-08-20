use super::*;

impl FakeBackend {
    pub(in super::super) fn with_permanent_reopen_watch_error() -> Self {
        Self {
            permanent_reopen_watch: true,
            ..Self::default()
        }
    }
}

pub(super) fn permanent_reopen_watch(
    backend: &FakeBackend,
    params: &RunWatchParams,
    attempt: usize,
) -> Option<Result<FakeSubscription<CliRunWatchEventNotification>, NativeV2CliError>> {
    if !backend.permanent_reopen_watch {
        return None;
    }
    if attempt > 1 {
        return Some(Err(NativeV2CliError::Protocol(
            "hosted watch authorization rejected".to_owned(),
        )));
    }
    Some(Ok(FakeSubscription::items(vec![watch_event(
        params,
        "watch-1",
        "cloud:1",
        json!({"phase":"queued"}),
    )])))
}

pub(super) fn queued_watch(
    params: &RunWatchParams,
    attempt: usize,
) -> FakeSubscription<CliRunWatchEventNotification> {
    if attempt == 1 {
        return FakeSubscription::disconnect_after(vec![watch_event(
            params,
            "watch-queued",
            "cloud:1",
            json!({"phase":"queued"}),
        )]);
    }
    FakeSubscription::items(vec![
        watch_event(
            params,
            "watch-admitted",
            "cloud:2",
            json!({"phase":"admitted"}),
        ),
        watch_event(
            params,
            "watch-admitted",
            "cloud:3",
            json!({
                "phase":"finished",
                "terminalResult":{"status":"succeeded","output":null}
            }),
        ),
    ])
}

fn watch_event(
    params: &RunWatchParams,
    subscription_id: &str,
    cursor: &str,
    status: Value,
) -> CliSubscriptionItem<CliRunWatchEventNotification> {
    CliSubscriptionItem::Event(
        serde_json::from_value(json!({
            "subscriptionId":subscription_id,
            "runId":params.run_id,
            "title":"Repair checkout",
            "source":source(),
            "size":"standard",
            "cursor":cursor,
            "status":status
        }))
        .assert_value(),
    )
}
