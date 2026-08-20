use std::fmt::Debug;

use serde::{de::DeserializeOwned, Serialize};

use crate::wire::assert_wire_round_trip_and_rejects_inserted_field;

pub(super) fn assert_done_closed_notification<T>(value: &T)
where
    T: Debug + DeserializeOwned + PartialEq + Serialize,
{
    assert_wire_round_trip_and_rejects_inserted_field(
        value,
        serde_json::json!({ "subscriptionId": "sub-1", "reason": "done" }),
        "lastDeliveredCursor",
        serde_json::json!("cursor-7"),
    );
}
