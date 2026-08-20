use std::io::Write;
use std::time::Duration;

use openengine_cluster_protocol::{RunAttachParams, SubscriptionCloseReason};

use super::super::{
    CliOutcome, CliSubscription, CliSubscriptionItem, DetachSignal, NativeV2CliBackend,
    NativeV2CliError,
};

use super::write_json;

pub(super) struct RoutedAttach<'a> {
    pub(super) target: Option<&'a str>,
    pub(super) params: RunAttachParams,
}

pub(super) async fn follow_attach<B, S, W>(
    backend: &B,
    route: RoutedAttach<'_>,
    signal: &mut S,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    S: DetachSignal,
    W: Write,
{
    let RoutedAttach { target, params } = route;
    loop {
        let mut subscription = tokio::select! {
            () = signal.wait() => return Ok(CliOutcome::Detached),
            result = backend.run_attach(target, params.clone()) => match result {
                Ok(subscription) => subscription,
                Err(NativeV2CliError::Disconnected) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
                Err(error) => return Err(error),
            },
        };
        loop {
            let item = tokio::select! {
                () = signal.wait() => return Ok(CliOutcome::Detached),
                item = subscription.next() => item,
            };
            match item {
                Ok(Some(CliSubscriptionItem::Event(event))) => write_json(output, &event)?,
                Ok(Some(CliSubscriptionItem::Closed {
                    reason: SubscriptionCloseReason::Done,
                })) => return Ok(CliOutcome::Completed),
                Ok(Some(CliSubscriptionItem::Closed {
                    reason: SubscriptionCloseReason::SlowConsumer,
                }))
                | Ok(None)
                | Err(NativeV2CliError::Disconnected) => break,
                Err(error) => return Err(error),
            }
        }
        tokio::select! {
            () = signal.wait() => return Ok(CliOutcome::Detached),
            () = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}
