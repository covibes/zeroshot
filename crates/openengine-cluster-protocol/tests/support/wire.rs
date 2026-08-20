use std::fmt::Debug;

use serde::{de::DeserializeOwned, Serialize};

use crate::{assert_value::AssertValue, json_insert::json_insert};

pub(super) fn assert_wire_round_trip_and_rejects_inserted_field<T>(
    value: &T,
    expected: serde_json::Value,
    forbidden_field: &str,
    forbidden_value: serde_json::Value,
) where
    T: Debug + DeserializeOwned + PartialEq + Serialize,
{
    let wire = serde_json::to_value(value).assert_value();
    assert_eq!(wire, expected);
    let round_tripped: T = serde_json::from_value(wire).assert_value();
    assert_eq!(round_tripped, *value);

    let mut malformed = serde_json::to_value(value).assert_value();
    json_insert(&mut malformed, "", forbidden_field, forbidden_value);
    assert!(serde_json::from_value::<T>(malformed).is_err());
}
