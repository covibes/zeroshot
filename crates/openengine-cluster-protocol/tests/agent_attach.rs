#[path = "support/assert_value.rs"]
mod assert_value;
#[path = "support/capability.rs"]
mod capability;
#[path = "support/closed_notification.rs"]
mod closed_notification;
#[path = "support/json_insert.rs"]
mod json_insert;
#[path = "support/json_read.rs"]
mod json_read;
#[path = "support/wire.rs"]
mod wire;

mod observation_support {
    pub(super) use super::assert_value::AssertValue;
    pub(super) use super::{capability, closed_notification, json_read, wire};
}

#[path = "observation/agent_attach.rs"]
mod agent_attach;
#[path = "observation/logs.rs"]
mod logs;
