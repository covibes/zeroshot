use openengine_cluster_protocol::{RunAttachEventNotification, RunAttachParams};
use openengine_cluster_testkit::assertions::AssertValue;
use serde_json::json;

use super::super::CliSubscriptionItem;

#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub(super) enum AttachBehavior {
    #[default]
    Done,
    Disconnect,
    EndOfStream,
    SlowConsumer,
    ProtocolError,
}

pub(super) fn attach_event(
    params: &RunAttachParams,
    attempt: usize,
    text: &str,
) -> CliSubscriptionItem<RunAttachEventNotification> {
    CliSubscriptionItem::Event(
        serde_json::from_value(json!({
            "subscriptionId":format!("attach-{attempt}"),
            "runId":params.run_id.as_str(),
            "execution":params.execution.as_str(),
            "event":{"type":"output","text":text}
        }))
        .assert_value(),
    )
}
